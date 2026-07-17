import { dump as dumpYaml } from 'js-yaml'
import { App, TFile, normalizePath } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { formatCardBody, parseCardBody } from '../cardFormat'

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

type AssignedCardDraft = GeneratedCard

type WrittenCardEntry = CardDraft & {
  cardUuid: string
  block: string
}

type WrittenCardValidation = {
  valid: WrittenCardEntry[]
  invalid: Array<{
    cardUuid: string
    block: string
    errors: string[]
  }>
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
  const knowledgeFile = host.app.vault.getAbstractFileByPath(knowledgePath)
  if (!(knowledgeFile instanceof TFile)) {
    throw new Error(`Knowledge file not found: ${knowledgePath}`)
  }

  const knowledgeSnapshot = await host.app.vault.read(knowledgeFile)
  const validKpUuids = extractKnowledgePointUuids(knowledgeSnapshot)
  if (validKpUuids.size === 0) {
    throw new Error(
      `Knowledge file has no valid knowledge points: ${knowledgePath}`,
    )
  }

  const prompt = buildCardPrompt({
    projectTopic,
    chapterTitle,
    chapterContract,
    knowledgeMdContent: extractMarkdownBody(knowledgeSnapshot),
    cardsFilePath: cardsPath,
    level,
  })
  const cardWorkspaceScope = buildCardWorkspaceScope(workspaceScope, cardsPath)
  const debug = new PhaseDebugCollector()
  const assignedDrafts: AssignedCardDraft[] = []
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
  ): Promise<{ text: string; error?: Error }> => {
    let accumulated = ''
    let completedText = ''
    const stream = host.agent.stream({
      ...request,
      modelId,
      systemPromptOverride: CARD_GENERATOR_PROMPT,
      capability: 'edit-vault',
      workspaceScope: cardWorkspaceScope,
      activity,
      abortSignal,
    })

    try {
      for await (const event of stream) {
        if (event.type === 'text') {
          accumulated = event.text || accumulated + event.delta
          if (consumeCards) streamParser.push(event.delta)
          onProgress?.(event.delta, accumulated)
        }
        if (event.type === 'tool') debug.recordToolCall(event)
        if (event.type === 'completed') completedText = event.text
        if (event.type === 'error') throw new Error(event.message)
      }
    } catch (error) {
      if (consumeCards) streamParser.finish()
      return {
        text: completedText || accumulated,
        error: error instanceof Error ? error : new Error(String(error)),
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
  const firstOutput = firstRun.text
  throwIfAborted(abortSignal)
  if (assignedDrafts.length === 0) {
    if (firstRun.error) throw firstRun.error
    throw new Error(`No card drafts generated for chapter: ${chapterTitle}`)
  }

  await assertKnowledgeUnchanged(host, knowledgeFile, knowledgeSnapshot)
  const cardsFile = await createCardsFile(
    host,
    cardsPath,
    chapterTitle,
    assignedDrafts,
  )
  try {
    await assertKnowledgeUnchanged(host, knowledgeFile, knowledgeSnapshot)
  } catch (error) {
    const ownedCardsFile = getOwnedCardsFile(host, cardsPath, cardsFile)
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Roll back only the file created by this generation transaction.
    await host.app.vault.delete(ownedCardsFile)
    throw error
  }
  const expectedCardUuids = new Set(
    assignedDrafts.map((draft) => draft.cardUuid),
  )

  let finalOutput = firstOutput
  let fileContent = await host.app.vault.read(cardsFile)
  let validation = validateWrittenCards(
    parseWrittenCardEntries(fileContent),
    expectedCardUuids,
    validKpUuids,
  )

  if (validation.invalid.length > 0 && !abortSignal?.aborted) {
    const firstAssistantMessage: LearningGenerationAssistantMessage = {
      role: 'assistant',
      id: `card-gen-${chapterIndex}-resp-1`,
      content: firstOutput,
    }
    const retryUserMessage: LearningGenerationUserMessage = {
      role: 'user',
      id: `card-gen-${chapterIndex}-req-2`,
      promptContent: buildValidationRetryPrompt(
        validation.invalid,
        validKpUuids,
        cardsPath,
      ),
    }
    try {
      const retryRun = await runStream({
        messages: [firstUserMessage, firstAssistantMessage, retryUserMessage],
      })
      finalOutput = retryRun.text
      if (retryRun.error) throw retryRun.error
    } catch (error) {
      console.error('[YOLO] Failed to correct generated cards:', error)
    }

    if (abortSignal?.aborted) {
      const ownedCardsFile = getOwnedCardsFile(host, cardsPath, cardsFile)
      // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Roll back an aborted generation transaction.
      await host.app.vault.delete(ownedCardsFile)
      throw new Error(`Card generation aborted: ${chapterTitle}`)
    }

    try {
      await assertKnowledgeUnchanged(host, knowledgeFile, knowledgeSnapshot)
    } catch (error) {
      const ownedCardsFile = getOwnedCardsFile(host, cardsPath, cardsFile)
      // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Remove only the transient file created by this generation transaction.
      await host.app.vault.delete(ownedCardsFile)
      throw error
    }
    const currentCardsFile = getOwnedCardsFile(host, cardsPath, cardsFile)
    fileContent = await host.app.vault.read(currentCardsFile)
    validation = validateWrittenCards(
      parseWrittenCardEntries(fileContent),
      expectedCardUuids,
      validKpUuids,
    )
  }

  const discardedCount = validation.discardedCount + streamParser.discardedCount
  if (validation.valid.length === 0) {
    const currentCardsFile = getOwnedCardsFile(host, cardsPath, cardsFile)
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- An empty generated artifact should not be moved into the user's trash.
    await host.app.vault.delete(currentCardsFile)
    throw new Error(`No valid cards remained for chapter: ${chapterTitle}`)
  }

  if (discardedCount > 0) {
    const currentCardsFile = getOwnedCardsFile(host, cardsPath, cardsFile)
    await host.app.vault.modify(
      currentCardsFile,
      buildCardsContent(
        chapterTitle,
        validation.valid.map((entry) => entry.block),
      ),
    )
  }

  const finalCards = validation.valid.map(toGeneratedCard)
  if (abortSignal?.aborted) {
    const ownedCardsFile = getOwnedCardsFile(host, cardsPath, cardsFile)
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Roll back an aborted generation transaction.
    await host.app.vault.delete(ownedCardsFile)
    throw new Error(`Card generation aborted: ${chapterTitle}`)
  }
  const collected = debug.finalize()
  return {
    cards: finalCards,
    status: firstRun.error || discardedCount > 0 ? 'partial' : 'generated',
    discardedCount,
    debugData: {
      chapterIndex,
      chapterTitle,
      startedAt: collected.startedAt,
      completedAt: collected.completedAt,
      toolCalls: collected.toolCalls,
      outputLength: finalOutput.length,
      output: finalOutput,
      count: finalCards.length,
    },
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
  const usedCardUuids = await collectExistingCardUuids(host.app, projectPath)
  const resolvedRunId = runId ?? `card-generation-${Date.now()}`
  const resolvedProjectId = projectId ?? projectPath
  const tasks = chapters.map(async (chapter, chapterIndex) => {
    let result: CardGenerationResult
    if (host.app.vault.getAbstractFileByPath(chapter.cardsPath)) {
      result = {
        chapterIndex,
        chapterTitle: chapter.title,
        cards: [],
        status: 'skipped' as const,
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
      const { cards, debugData, status, discardedCount } =
        await generateCardsForChapter({
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
      chapterDebugData.push(debugData)
      onChapterProgress?.({
        chapterIndex,
        chapterTitle: chapter.title,
        status: 'completed',
      })
      result = {
        chapterIndex,
        chapterTitle: chapter.title,
        cards,
        status,
        discardedCount,
      }
      onChapterSettled?.(result)
      return result
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
        status: 'failed' as const,
        discardedCount: 0,
        error: message,
      }
      onChapterSettled?.(result)
      return result
    }
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
    const commentMatch = titleLine.match(WRITTEN_CARD_COMMENT_RE)
    const bodyStart = block.indexOf('\n')
    const body = bodyStart === -1 ? '' : block.slice(bodyStart + 1).trim()
    const sides = parseCardBody(body)
    return {
      cardUuid: commentMatch?.[1]?.toLowerCase() ?? '',
      kpUuid: commentMatch?.[2]?.toLowerCase() ?? '',
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
    const existing = entriesByUuid.get(entry.cardUuid) ?? []
    existing.push(entry)
    entriesByUuid.set(entry.cardUuid, existing)
  }

  const valid: WrittenCardEntry[] = []
  const invalid: WrittenCardValidation['invalid'] = []
  for (const cardUuid of expectedCardUuids) {
    const matches = entriesByUuid.get(cardUuid) ?? []
    if (matches.length !== 1) {
      invalid.push({
        cardUuid,
        block: matches[0]?.block ?? '',
        errors: [matches.length === 0 ? '缺少该 card UUID' : 'card UUID 重复'],
      })
      continue
    }

    const entry = matches[0]
    const errors: string[] = []
    if (!entry.title) errors.push('缺少标题')
    if (!entry.kpUuid) {
      errors.push('缺少 kp UUID')
    } else if (!validKpUuids.has(entry.kpUuid)) {
      errors.push(`kp:${entry.kpUuid} 不属于本章`)
    }
    if (!entry.front) errors.push('分隔线前缺少正面内容')
    if (!entry.back) errors.push('分隔线后缺少背面内容')
    if (errors.length > 0) {
      invalid.push({ cardUuid, block: entry.block, errors })
    } else {
      valid.push(entry)
    }
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

function buildCardWorkspaceScope(
  workspaceScope: LearningWorkspaceScope | undefined,
  cardsPath: string,
): LearningWorkspaceScope {
  const include = workspaceScope?.enabled ? workspaceScope.include : []
  return {
    enabled: true,
    include: [...new Set([...include, normalizePath(cardsPath)])],
    exclude: workspaceScope?.enabled ? workspaceScope.exclude : [],
  }
}

function extractKnowledgePointUuids(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(KNOWLEDGE_POINT_UUID_RE)].map((match) =>
      (match[1] ?? '').toLowerCase(),
    ),
  )
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new Error('Card generation aborted')
  }
}

function getOwnedCardsFile(
  host: LearningGenerationHost,
  cardsPath: string,
  expectedFile: TFile,
): TFile {
  const currentFile = host.app.vault.getAbstractFileByPath(cardsPath)
  if (currentFile !== expectedFile) {
    throw new Error(`Cards file changed concurrently: ${cardsPath}`)
  }
  return expectedFile
}

function assignCardUuid(
  draft: CardDraft,
  usedCardUuids: Set<string>,
): AssignedCardDraft {
  let cardUuid = createCardUuid()
  while (usedCardUuids.has(cardUuid)) cardUuid = createCardUuid()
  usedCardUuids.add(cardUuid)
  return { ...draft, cardUuid }
}

function buildValidationRetryPrompt(
  invalid: WrittenCardValidation['invalid'],
  validKpUuids: Set<string>,
  cardsPath: string,
): string {
  const details = invalid
    .map(
      (entry) => `card UUID：${entry.cardUuid}
问题：${entry.errors.join('；')}
当前原文：
${entry.block || '<该 UUID 已从文件中消失>'}`,
    )
    .join('\n\n')

  return `cards.md 已写入以下路径：${cardsPath}

以下卡片格式不正确，请使用 fs_edit 逐个精确修正：

${details}

本章合法的知识点 UUID：${[...validKpUuids].join(', ')}

只允许修改上述有问题的卡片，不要重写整个文件，也不要新增卡片。
每张卡片必须保留现有 card UUID，标题行的最终格式必须是：
## <卡片标题> <!--card:<现有card UUID> kp:<合法的知识点UUID>-->

正面和背面之间必须有且只有一个独占一行的 ---，正文不得再包含独占一行的 ---。修正完成后不要再输出卡片正文。`
}

async function assertKnowledgeUnchanged(
  host: LearningGenerationHost,
  knowledgeFile: TFile,
  expectedContent: string,
): Promise<void> {
  const currentFile = host.app.vault.getAbstractFileByPath(knowledgeFile.path)
  if (!(currentFile instanceof TFile)) {
    throw new Error(`Knowledge file disappeared: ${knowledgeFile.path}`)
  }
  const currentContent = await host.app.vault.read(currentFile)
  if (currentContent !== expectedContent) {
    throw new Error(
      `Knowledge file changed during generation: ${knowledgeFile.path}`,
    )
  }
}

async function createCardsFile(
  host: LearningGenerationHost,
  cardsPath: string,
  chapterTitle: string,
  drafts: AssignedCardDraft[],
): Promise<TFile> {
  if (host.app.vault.getAbstractFileByPath(cardsPath)) {
    throw new Error(`Cards file already exists: ${cardsPath}`)
  }
  const blocks = drafts.map((draft) => {
    const title = draft.title.trim()
    const kpPart = draft.kpUuid ? ` kp:${draft.kpUuid.toLowerCase()}` : ''
    return `## ${title}${title ? ' ' : ''}<!--card:${draft.cardUuid}${kpPart}-->\n\n${formatCardBody(draft.front, draft.back)}`
  })
  return host.app.vault.create(
    cardsPath,
    buildCardsContent(chapterTitle, blocks),
  )
}

function buildCardsContent(chapterTitle: string, blocks: string[]): string {
  const yaml = dumpYaml(
    { title: `${chapterTitle} - 卡片` },
    { lineWidth: -1 },
  ).trimEnd()
  return `---\n${yaml}\n---\n\n${blocks.join('\n\n')}\n`
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
      if (line === CARD_END_MARKER) {
        this.publishBlock()
      } else {
        this.block += `${line}\n`
      }
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
      this.discardedCount++
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
      this.discardedCount++
    }
  }
}

async function collectExistingCardUuids(
  app: App,
  projectPath: string,
): Promise<Set<string>> {
  const normalizedProject = normalizePath(projectPath.replace(/\/$/, ''))
  const projectPrefix = `${normalizedProject}/`
  const uuids = new Set<string>()
  const cardFiles = app.vault
    .getMarkdownFiles()
    .filter(
      (file) => file.name === 'cards.md' && file.path.startsWith(projectPrefix),
    )
  for (const file of cardFiles) {
    const content = await app.vault.cachedRead(file)
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
