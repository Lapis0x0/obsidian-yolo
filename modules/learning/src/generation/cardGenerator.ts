import { dump as dumpYaml } from 'js-yaml'
import { v4 as uuidv4 } from 'uuid'

import { formatCardBody, parseCardBody } from '../domain/cardFormat'
import {
  type LearningVaultReadApi,
  normalizeLearningVaultPath,
} from '../domain/learningVaultReadApi'
import type { LearningVaultFileSnapshot } from '../domain/learningVaultWriteApi'

import { LearningGenerationAbortError } from './abortError'
import {
  type ChapterDebugData,
  PhaseDebugCollector,
  emitChaptersDebugLog,
} from './debugLog'
import type {
  LearningGenerationActivity,
  LearningGenerationAssistantMessage,
  LearningGenerationHost,
  LearningGenerationMessage,
  LearningGenerationUserMessage,
  LearningWorkspaceScope,
} from './host'
import { CARD_GENERATOR_PROMPT, buildCardPrompt } from './prompts'
import type {
  CardDraft,
  CardGenerationEvent,
  CardGenerationResult,
  GeneratedCard,
  GenerationProgress,
  OutlineChapter,
} from './types'

const KNOWLEDGE_POINT_UUID_RE = /<!--\s*kp:([0-9a-fA-F]{8})\s*-->/g
const CARD_HEADING_RE = /^##[ \t]+([^\r\n]+)$/gm
const CARD_KP_UUID_RE = /<!--\s*kp:([0-9a-fA-F]{8})\s*-->/
const WRITTEN_CARD_COMMENT_RE =
  /<!--\s*card:([0-9a-fA-F]{8})(?:\s+kp:([0-9a-fA-F]{8}))?\s*-->/
export const CARD_END_MARKER = '<!--yolo-card-end-->'

type WrittenCardEntry = CardDraft & { cardUuid: string; block: string }
type WrittenCardValidation = {
  valid: WrittenCardEntry[]
  invalid: Array<{ cardUuid: string; block: string; errors: string[] }>
  discardedCount: number
}

export type GenerateCardsForChapterOptions = {
  host: LearningGenerationHost
  modelId?: string
  chapterIndex: number
  projectTopic: string
  chapterTitle: string
  chapterContract: string
  knowledgePath: string
  cardsPath: string
  level: string
  usedCardUuids: Set<string>
  workspaceScope?: LearningWorkspaceScope
  abortSignal?: AbortSignal
  activity?: LearningGenerationActivity
  onProgress?: (delta: string, fullText: string) => void
  runId: string
  projectId: string
  chapterId: string
  onCard?: (event: CardGenerationEvent) => void
}

export async function generateCardsForChapter({
  host,
  modelId,
  chapterIndex,
  projectTopic,
  chapterTitle,
  chapterContract,
  knowledgePath,
  cardsPath,
  level,
  usedCardUuids,
  workspaceScope,
  abortSignal,
  activity,
  onProgress,
  runId,
  projectId,
  chapterId,
  onCard,
}: GenerateCardsForChapterOptions): Promise<{
  cards: GeneratedCard[]
  status: 'generated' | 'partial'
  discardedCount: number
  debugData: ChapterDebugData
}> {
  if (host.vault.getEntry(knowledgePath)?.kind !== 'file') {
    throw new Error(`Knowledge file not found: ${knowledgePath}`)
  }
  const knowledgeSnapshot =
    await host.vaultWriter.readTextSnapshot(knowledgePath)
  if (!knowledgeSnapshot)
    throw new Error(`Knowledge file not found: ${knowledgePath}`)
  const validKpUuids = extractKnowledgePointUuids(knowledgeSnapshot.content)
  if (validKpUuids.size === 0) {
    throw new Error(
      `Knowledge file has no valid knowledge points: ${knowledgePath}`,
    )
  }

  const prompt = buildCardPrompt({
    projectTopic,
    chapterTitle,
    chapterContract,
    knowledgeMdContent: extractMarkdownBody(knowledgeSnapshot.content),
    cardsFilePath: cardsPath,
    level,
  })
  const cardWorkspaceScope = buildCardWorkspaceScope(workspaceScope, cardsPath)
  const debug = new PhaseDebugCollector()
  const assignedDrafts: GeneratedCard[] = []
  const streamParser = new CardStreamParser(validKpUuids, (draft) => {
    const card = assignCardUuid(draft, usedCardUuids)
    const cardIndex = assignedDrafts.length
    assignedDrafts.push(card)
    onCard?.({
      runId,
      projectId,
      chapterId,
      chapterIndex,
      cardIndex,
      cardUuid: card.cardUuid,
      card,
    })
  })

  const runStream = async (
    request: { prompt: string } | { messages: LearningGenerationMessage[] },
    consumeCards = false,
  ): Promise<{ text: string; error?: Error; aborted?: true }> => {
    let accumulated = ''
    let completedText = ''
    let aborted = false
    try {
      for await (const event of host.agent.stream({
        ...request,
        modelId,
        systemPromptOverride: CARD_GENERATOR_PROMPT,
        capability: 'edit-vault',
        workspaceScope: cardWorkspaceScope,
        activity,
        abortSignal,
      })) {
        if (event.type === 'text') {
          accumulated = event.text || accumulated + event.delta
          if (consumeCards) streamParser.push(event.delta)
          onProgress?.(event.delta, accumulated)
        }
        if (event.type === 'tool') debug.recordToolCall(event)
        if (event.type === 'completed') completedText = event.text
        if (event.type === 'aborted') {
          aborted = true
          throw new LearningGenerationAbortError(
            `Card generation aborted: ${chapterTitle}`,
          )
        }
        if (event.type === 'error') throw new Error(event.message)
      }
    } catch (error) {
      if (consumeCards) streamParser.finish()
      return {
        text: completedText || accumulated,
        error: error instanceof Error ? error : new Error(String(error)),
        ...(aborted ? { aborted: true as const } : {}),
      }
    }
    if (consumeCards) streamParser.finish()
    return { text: completedText || accumulated }
  }

  const firstUserMessage: LearningGenerationUserMessage = {
    role: 'user',
    id: `card-gen-${chapterIndex}-req-1`,
    promptContent: prompt,
  }
  const firstRun = await runStream({ messages: [firstUserMessage] }, true)
  if (firstRun.aborted) {
    throw (
      firstRun.error ??
      new LearningGenerationAbortError('Card generation was aborted')
    )
  }
  throwIfAborted(abortSignal)
  if (assignedDrafts.length === 0) {
    if (firstRun.error) throw firstRun.error
    throw new Error(`No card drafts generated for chapter: ${chapterTitle}`)
  }

  await assertKnowledgeUnchanged(host, knowledgeSnapshot)
  const cardsTransaction = await createCardsFile(
    host,
    cardsPath,
    chapterTitle,
    assignedDrafts,
  )
  const createdCards = cardsTransaction.snapshot
  const expectedCardUuids = new Set(
    assignedDrafts.map((draft) => draft.cardUuid),
  )
  let cardsSnapshot = createdCards
  let cleanupExpected: LearningVaultFileSnapshot | null = createdCards

  try {
    await assertKnowledgeUnchanged(host, knowledgeSnapshot)
    let finalOutput = firstRun.text
    let validation = validateWrittenCards(
      parseWrittenCardEntries(cardsSnapshot.content),
      expectedCardUuids,
      validKpUuids,
    )
    if (validation.invalid.length > 0 && !abortSignal?.aborted) {
      const beforeRetry = cardsSnapshot
      const assistant: LearningGenerationAssistantMessage = {
        role: 'assistant',
        id: `card-gen-${chapterIndex}-resp-1`,
        content: firstRun.text,
      }
      const retry: LearningGenerationUserMessage = {
        role: 'user',
        id: `card-gen-${chapterIndex}-req-2`,
        promptContent: buildValidationRetryPrompt(
          validation.invalid,
          validKpUuids,
          cardsPath,
        ),
      }
      let retryAborted = false
      try {
        const retryRun = await runStream({
          messages: [firstUserMessage, assistant, retry],
        })
        retryAborted = retryRun.aborted === true
        finalOutput = retryRun.text
        if (retryRun.error) throw retryRun.error
      } catch (error) {
        if (retryAborted) throw error
        console.error('[YOLO] Failed to correct generated cards:', error)
      }
      cardsSnapshot = await readCurrentCardsSnapshot(
        host,
        cardsPath,
        createdCards,
      )
      if (cardsSnapshot.content !== beforeRetry.content) cleanupExpected = null
      if (abortSignal?.aborted)
        throw new Error(`Card generation aborted: ${chapterTitle}`)
      await assertKnowledgeUnchanged(host, knowledgeSnapshot)
      validation = validateWrittenCards(
        parseWrittenCardEntries(cardsSnapshot.content),
        expectedCardUuids,
        validKpUuids,
      )
    }

    const discardedCount =
      validation.discardedCount + streamParser.discardedCount
    if (validation.valid.length === 0) {
      throw new Error(`No valid cards remained for chapter: ${chapterTitle}`)
    }
    if (discardedCount > 0 && cleanupExpected) {
      const updated = await host.vaultWriter.replaceTextIfUnchanged(
        cardsSnapshot,
        buildCardsContent(
          chapterTitle,
          validation.valid.map((entry) => entry.block),
        ),
      )
      if (!updated) throw cardsFileChangedError(cardsPath)
      cardsSnapshot = updated
      cleanupExpected = updated
    }
    const finalCards = validation.valid.map(toGeneratedCard)
    if (abortSignal?.aborted)
      throw new Error(`Card generation aborted: ${chapterTitle}`)
    const collected = debug.finalize()
    return {
      cards: finalCards,
      status: firstRun.error || discardedCount > 0 ? 'partial' : 'generated',
      discardedCount,
      debugData: {
        chapterIndex,
        chapterTitle,
        ...collected,
        outputLength: finalOutput.length,
        output: finalOutput,
        count: finalCards.length,
      },
    }
  } catch (error) {
    if (!cleanupExpected) throw cleanupIncompleteError(error, cardsPath)
    let reverted: LearningVaultFileSnapshot | null
    try {
      reverted = cardsTransaction.creationReceipt
        ? await host.vaultWriter.revertOwnedCreatedTextIfUnchanged(
            cardsTransaction.creationReceipt,
            cleanupExpected,
            cardsTransaction.fallbackContent,
          )
        : await host.vaultWriter.replaceTextIfUnchanged(
            cleanupExpected,
            cardsTransaction.fallbackContent,
          )
    } catch (cleanupError) {
      throw cleanupIncompleteError(error, cardsPath, cleanupError)
    }
    if (!reverted) throw cleanupIncompleteError(error, cardsPath)
    throw error
  }
}

export type CardGenerationChapter = OutlineChapter & {
  chapterId?: string
  knowledgePath: string
  cardsPath: string
}

export type GenerateCardsParallelOptions = {
  host: LearningGenerationHost
  modelId?: string
  projectTopic: string
  projectPath: string
  chapters: CardGenerationChapter[]
  level: string
  workspaceScope?: LearningWorkspaceScope
  abortSignal?: AbortSignal
  activity?: LearningGenerationActivity
  onChapterProgress?: (progress: GenerationProgress) => void
  runId?: string
  projectId?: string
  onCard?: (event: CardGenerationEvent) => void
  onChapterSettled?: (result: CardGenerationResult) => void
}

export async function generateCardsParallel({
  host,
  modelId,
  projectTopic,
  projectPath,
  chapters,
  level,
  workspaceScope,
  abortSignal,
  activity,
  onChapterProgress,
  runId,
  projectId,
  onCard,
  onChapterSettled,
}: GenerateCardsParallelOptions): Promise<CardGenerationResult[]> {
  const chapterDebugData: ChapterDebugData[] = []
  const usedCardUuids = await collectExistingCardUuids(host.vault, projectPath)
  const resolvedRunId = runId ?? `card-generation-${Date.now()}`
  const resolvedProjectId = projectId ?? projectPath
  const tasks = chapters.map(async (chapter, chapterIndex) => {
    let result: CardGenerationResult
    if (
      await shouldSkipExistingCardsFile(host, chapter.cardsPath, chapter.title)
    ) {
      result = {
        chapterIndex,
        chapterTitle: chapter.title,
        cards: [],
        status: 'skipped',
        discardedCount: 0,
      }
      onChapterSettled?.(result)
      return result
    }
    onChapterProgress?.({
      chapterIndex,
      chapterTitle: chapter.title,
      status: 'generating',
    })
    try {
      const generated = await generateCardsForChapter({
        host,
        modelId,
        chapterIndex,
        projectTopic,
        chapterTitle: chapter.title,
        chapterContract: chapter.contract,
        knowledgePath: chapter.knowledgePath,
        cardsPath: chapter.cardsPath,
        level,
        usedCardUuids,
        workspaceScope,
        abortSignal,
        activity,
        runId: resolvedRunId,
        projectId: resolvedProjectId,
        chapterId: chapter.chapterId ?? chapter.cardsPath,
        onCard,
      })
      chapterDebugData.push(generated.debugData)
      onChapterProgress?.({
        chapterIndex,
        chapterTitle: chapter.title,
        status: 'completed',
      })
      result = {
        chapterIndex,
        chapterTitle: chapter.title,
        cards: generated.cards,
        status: generated.status,
        discardedCount: generated.discardedCount,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onChapterProgress?.({
        chapterIndex,
        chapterTitle: chapter.title,
        status: 'error',
        error: message,
      })
      result = {
        chapterIndex,
        chapterTitle: chapter.title,
        cards: [],
        status: 'failed',
        discardedCount: 0,
        error: message,
      }
    }
    onChapterSettled?.(result)
    return result
  })
  const results = await Promise.all(tasks)
  if (!abortSignal?.aborted) {
    emitChaptersDebugLog(host, chapterDebugData, 'card-generator', 'cards')
  }
  return results
}

export function parseCardDrafts(markdown: string): CardDraft[] {
  const headings = [...markdown.matchAll(CARD_HEADING_RE)]
  return headings.map((heading, index) => {
    const start = heading.index ?? 0
    const nextStart = headings[index + 1]?.index ?? markdown.length
    const block = markdown.slice(start, nextStart).trim()
    const titleLine = heading[1]?.trim() ?? ''
    const kpMatch = titleLine.match(CARD_KP_UUID_RE)
    const bodyStart = block.indexOf('\n')
    const body = bodyStart === -1 ? '' : block.slice(bodyStart + 1).trim()
    const sides = parseCardBody(body)
    return {
      title: titleLine.replace(CARD_KP_UUID_RE, '').trim(),
      kpUuid: kpMatch?.[1]?.toLowerCase() ?? '',
      front: sides?.front ?? '',
      back: sides?.back ?? '',
      startLine: markdown.slice(0, start).split('\n').length,
    }
  })
}

export function parseWrittenCardEntries(content: string): WrittenCardEntry[] {
  const headings = [...content.matchAll(CARD_HEADING_RE)]
  return headings.map((heading, index) => {
    const start = heading.index ?? 0
    const nextStart = headings[index + 1]?.index ?? content.length
    const block = content.slice(start, nextStart).trim()
    const titleLine = heading[1]?.trim() ?? ''
    const comment = titleLine.match(WRITTEN_CARD_COMMENT_RE)
    const bodyStart = block.indexOf('\n')
    const sides = parseCardBody(
      bodyStart === -1 ? '' : block.slice(bodyStart + 1).trim(),
    )
    return {
      cardUuid: comment?.[1]?.toLowerCase() ?? '',
      kpUuid: comment?.[2]?.toLowerCase() ?? '',
      title: titleLine.replace(WRITTEN_CARD_COMMENT_RE, '').trim(),
      front: sides?.front ?? '',
      back: sides?.back ?? '',
      startLine: content.slice(0, start).split('\n').length,
      block,
    }
  })
}

export function validateWrittenCards(
  entries: WrittenCardEntry[],
  expectedCardUuids: Set<string>,
  validKpUuids: Set<string>,
): WrittenCardValidation {
  const entriesByUuid = new Map<string, WrittenCardEntry[]>()
  for (const entry of entries) {
    entriesByUuid.set(entry.cardUuid, [
      ...(entriesByUuid.get(entry.cardUuid) ?? []),
      entry,
    ])
  }
  const valid: WrittenCardEntry[] = []
  const invalid: WrittenCardValidation['invalid'] = []
  for (const cardUuid of expectedCardUuids) {
    const matches = entriesByUuid.get(cardUuid) ?? []
    if (matches.length !== 1) {
      invalid.push({
        cardUuid,
        block: matches[0]?.block ?? '',
        errors: [
          matches.length === 0
            ? 'missing this card UUID'
            : 'duplicate card UUID',
        ],
      })
      continue
    }
    const entry = matches[0]
    const errors: string[] = []
    if (!entry.title) errors.push('missing title')
    if (!entry.kpUuid) errors.push('missing kp UUID')
    else if (!validKpUuids.has(entry.kpUuid)) {
      errors.push(`kp:${entry.kpUuid} does not belong to this chapter`)
    }
    if (!entry.front) errors.push('missing front content before the separator')
    if (!entry.back) errors.push('missing back content after the separator')
    if (errors.length) invalid.push({ cardUuid, block: entry.block, errors })
    else valid.push(entry)
  }
  const unexpectedCount = entries.filter(
    (entry) => !expectedCardUuids.has(entry.cardUuid),
  ).length
  return {
    valid,
    invalid,
    discardedCount: invalid.length + unexpectedCount,
  }
}

export class CardStreamParser {
  private pending = ''
  private block = ''
  discardedCount = 0

  constructor(
    private readonly validKpUuids: Set<string>,
    private readonly onCard: (draft: CardDraft) => void,
  ) {}

  push(delta: string): void {
    this.pending += delta
    let newlineIndex = this.pending.indexOf('\n')
    while (newlineIndex !== -1) {
      const rawLine = this.pending.slice(0, newlineIndex)
      this.pending = this.pending.slice(newlineIndex + 1)
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === CARD_END_MARKER) this.publishBlock()
      else this.block += `${line}\n`
      newlineIndex = this.pending.indexOf('\n')
    }
  }

  finish(): void {
    const line = this.pending.endsWith('\r')
      ? this.pending.slice(0, -1)
      : this.pending
    if (line === CARD_END_MARKER) this.publishBlock()
    this.pending = ''
    this.block = ''
  }

  private publishBlock(): void {
    const drafts = parseCardDrafts(this.block)
    this.block = ''
    if (drafts.length !== 1) {
      this.discardedCount += 1
      return
    }
    const draft = drafts[0]
    if (
      draft.title &&
      draft.front &&
      draft.back &&
      this.validKpUuids.has(draft.kpUuid)
    ) {
      this.onCard(draft)
    } else {
      this.discardedCount += 1
    }
  }
}

function buildCardWorkspaceScope(
  scope: LearningWorkspaceScope | undefined,
  cardsPath: string,
): LearningWorkspaceScope {
  return {
    enabled: true,
    include: [
      ...new Set([
        ...(scope?.enabled ? scope.include : []),
        normalizeLearningVaultPath(cardsPath),
      ]),
    ],
    exclude: scope?.enabled ? scope.exclude : [],
  }
}

function extractKnowledgePointUuids(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(KNOWLEDGE_POINT_UUID_RE)].map((match) =>
      (match[1] ?? '').toLowerCase(),
    ),
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Card generation aborted')
}

async function readCurrentCardsSnapshot(
  host: LearningGenerationHost,
  cardsPath: string,
  created: LearningVaultFileSnapshot,
): Promise<LearningVaultFileSnapshot> {
  const current = await host.vaultWriter.readTextSnapshot(cardsPath)
  if (!current || current.identity !== created.identity) {
    throw cardsFileChangedError(cardsPath)
  }
  return current
}

function cardsFileChangedError(cardsPath: string): Error {
  return new Error(`Cards file changed concurrently: ${cardsPath}`)
}

function cleanupIncompleteError(
  error: unknown,
  cardsPath: string,
  cleanupError?: unknown,
): Error {
  return new Error(
    `Card generation failed and cleanup was incomplete: ${cardsPath}; original error: ${errorMessage(error)}${cleanupError ? `; cleanup error: ${errorMessage(cleanupError)}` : ''}`,
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? 'Unknown error'
  } catch {
    return 'Unknown error'
  }
}

function assignCardUuid(draft: CardDraft, used: Set<string>): GeneratedCard {
  let cardUuid = createCardUuid()
  while (used.has(cardUuid)) cardUuid = createCardUuid()
  used.add(cardUuid)
  return { ...draft, cardUuid }
}

function buildValidationRetryPrompt(
  invalid: WrittenCardValidation['invalid'],
  validKpUuids: Set<string>,
  cardsPath: string,
): string {
  const details = invalid
    .map(
      (entry) => `card UUID: ${entry.cardUuid}
Problem: ${entry.errors.join('; ')}
Current text:
${entry.block || '<this UUID has disappeared from the file>'}`,
    )
    .join('\n\n')
  return `cards.md has been written to: ${cardsPath}

The following cards are incorrectly formatted; use fs_edit to fix each one precisely:

${details}

Valid knowledge-point UUIDs for this chapter: ${[...validKpUuids].join(', ')}

Only modify the problematic cards above; do not rewrite the whole file, and do not add new cards.
Each card must keep its existing card UUID, and the final format of the title line must be:
## <card title> <!--card:<existing card UUID> kp:<valid knowledge point UUID>-->

Between the front and the back there must be exactly one line containing only ---, and the body must not contain another line consisting solely of ---. After fixing, do not output card bodies again.`
}

async function assertKnowledgeUnchanged(
  host: LearningGenerationHost,
  expected: LearningVaultFileSnapshot,
): Promise<void> {
  const current = await host.vaultWriter.readTextSnapshot(expected.path)
  if (!current) throw new Error(`Knowledge file disappeared: ${expected.path}`)
  if (
    current.identity !== expected.identity ||
    current.content !== expected.content
  ) {
    throw new Error(
      `Knowledge file changed during generation: ${expected.path}`,
    )
  }
}

async function createCardsFile(
  host: LearningGenerationHost,
  cardsPath: string,
  chapterTitle: string,
  drafts: GeneratedCard[],
): Promise<{
  snapshot: LearningVaultFileSnapshot
  creationReceipt: LearningVaultFileSnapshot | null
  fallbackContent: string
}> {
  const blocks = drafts.map((draft) => {
    const title = draft.title.trim()
    const kpPart = draft.kpUuid ? ` kp:${draft.kpUuid.toLowerCase()}` : ''
    return `## ${title}${title ? ' ' : ''}<!--card:${draft.cardUuid}${kpPart}-->\n\n${formatCardBody(draft.front, draft.back)}`
  })
  const fallbackContent = buildCardsContent(chapterTitle, [])
  const content = buildCardsContent(chapterTitle, blocks)
  const created = await host.vaultWriter.createTextIfAbsent(cardsPath, content)
  if (created) {
    return { snapshot: created, creationReceipt: created, fallbackContent }
  }
  const existing = await host.vaultWriter.readTextSnapshot(cardsPath)
  if (!existing || existing.content !== fallbackContent) {
    throw new Error(`Cards file already exists: ${cardsPath}`)
  }
  const updated = await host.vaultWriter.replaceTextIfUnchanged(
    existing,
    content,
  )
  if (!updated) throw cardsFileChangedError(cardsPath)
  return { snapshot: updated, creationReceipt: null, fallbackContent }
}

async function shouldSkipExistingCardsFile(
  host: LearningGenerationHost,
  cardsPath: string,
  chapterTitle: string,
): Promise<boolean> {
  if (!host.vault.getEntry(cardsPath)) return false
  const existing = await host.vaultWriter.readTextSnapshot(cardsPath)
  return existing?.content !== buildCardsContent(chapterTitle, [])
}

function buildCardsContent(chapterTitle: string, blocks: string[]): string {
  const yaml = dumpYaml(
    { title: chapterTitle.trim() },
    { lineWidth: -1 },
  ).trimEnd()
  const header = `---\n${yaml}\n---\n`
  return blocks.length ? `${header}\n${blocks.join('\n\n')}\n` : header
}

function toGeneratedCard(entry: WrittenCardEntry): GeneratedCard {
  return {
    cardUuid: entry.cardUuid,
    title: entry.title,
    kpUuid: entry.kpUuid,
    front: entry.front,
    back: entry.back,
    startLine: entry.startLine,
  }
}

async function collectExistingCardUuids(
  vault: LearningVaultReadApi,
  projectPath: string,
): Promise<Set<string>> {
  const prefix = `${normalizeLearningVaultPath(projectPath.replace(/\/$/, ''))}/`
  const uuids = new Set<string>()
  const files = vault
    .listMarkdownFiles()
    .filter((file) => file.name === 'cards.md' && file.path.startsWith(prefix))
  for (const file of files) {
    const content = await vault.readText(file.path)
    for (const match of content.matchAll(
      /<!--\s*card:([0-9a-fA-F]{8})(?:\s+kp:[0-9a-fA-F]{8})?\s*-->/g,
    )) {
      uuids.add((match[1] ?? '').toLowerCase())
    }
  }
  return uuids
}

function createCardUuid(): string {
  return uuidv4().replace(/-/g, '').slice(0, 8)
}

function extractMarkdownBody(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}
