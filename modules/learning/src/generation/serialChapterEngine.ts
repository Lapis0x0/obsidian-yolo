import { formatCardBody } from '../domain/cardFormat'
import type { LearningVaultReadApi } from '../domain/learningVaultReadApi'
import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'

import { LearningGenerationAbortError } from './abortError'
import {
  assertKnowledgeUnchanged,
  buildCardsContent,
  createCardUuid,
  extractMarkdownBody,
} from './cardGenerator'
import type {
  LearningGenerationActivity,
  LearningGenerationHost,
  LearningGenerationTool,
  LearningWorkspaceScope,
} from './host'
import {
  type ChapterWriteTarget,
  appendKnowledgePointDraft,
  createKnowledgePointUuid,
  markChapterKnowledgeComplete,
} from './projectWriter'
import {
  CARD_GENERATOR_PROMPT,
  KNOWLEDGE_POINT_GENERATOR_PROMPT,
  buildCardStagePrompt,
  buildKnowledgePointStagePrompt,
} from './prompts'
import type {
  CardGenerationEvent,
  CardGenerationResult,
  GeneratedCard,
  OutlineChapter,
} from './types'

/** Total invalid `emit_*` calls tolerated within a single run before it is aborted. */
const MAX_TOOL_REJECTIONS = 8
/** Infrastructure-error retries for a single stage (3 attempts total). */
const MAX_INFRA_RETRIES = 2

/** A chapter's knowledge or card stage failed after exhausting the error ladder. */
export class ChapterGenerationError extends Error {
  constructor(
    message: string,
    public readonly stage: 'knowledge' | 'cards',
  ) {
    super(message)
    this.name = 'ChapterGenerationError'
  }
}

/** The run was aborted because the model exceeded the invalid-emit budget. */
class RunValidationLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunValidationLimitError'
  }
}

export type ChapterKnowledgePoint = { uuid: string; title: string }

export type ChapterGenerationOutcome = {
  knowledgePoints: ChapterKnowledgePoint[]
  cardResult: CardGenerationResult | null
}

export type RunChapterGenerationOptions = {
  host: LearningGenerationHost
  modelId?: string
  projectTopic: string
  projectGoal: string
  outputLanguage: string
  level: string
  /** The full outline (all chapters), used for rolling context in the knowledge-point prompt. */
  outline: readonly OutlineChapter[]
  chapterIndex: number
  target: ChapterWriteTarget
  projectPath: string
  /** Knowledge-point titles already generated for earlier chapters, in chapter order. */
  priorChapterKnowledgeTitles: readonly {
    chapterTitle: string
    titles: readonly string[]
  }[]
  workspaceScope?: LearningWorkspaceScope
  referenceDir?: string
  generateCards: boolean
  /** Project-wide set of card UUIDs already in use; mutated as new cards are assigned. */
  usedCardUuids: Set<string>
  vault: LearningVaultReadApi
  writer: LearningVaultWriteApi
  abortSignal?: AbortSignal
  activities: {
    knowledgePoints(detail: string): LearningGenerationActivity
    cards(detail: string): LearningGenerationActivity
  }
  runId: string
  projectId: string
  onKnowledgePoint?: (event: {
    chapterIndex: number
    chapterTitle: string
    kpIndex: number
    kpId: string
    title: string
  }) => void
  onCard?: (event: CardGenerationEvent) => void
  /** Overridable for tests; defaults to capped exponential backoff. */
  retryDelayMs?: (attempt: number) => number
  /**
   * Resume support: when set, the knowledge stage is skipped entirely and
   * these already-persisted knowledge points are used directly for the card
   * stage. Used when a chapter's knowledge.md is complete but its cards.md
   * is missing or was never generated.
   */
  resumeKnowledgePoints?: ChapterKnowledgePoint[]
}

/**
 * Runs one chapter's two sequential agent sessions: knowledge points, then
 * (if enabled) cards derived from them. Knowledge points are written to
 * `knowledge.md` as they are emitted; cards are cached in memory and written
 * to `cards.md` once, after the card run finishes successfully.
 *
 * Throws {@link LearningGenerationAbortError} when `abortSignal` fires, or
 * {@link ChapterGenerationError} when a stage fails after exhausting the
 * infrastructure-retry and tool-rejection budgets. Either way, knowledge
 * points already written to disk are left in place except for the specific
 * run being reset before an infra retry (see `onBeforeRetry` below).
 */
export async function generateChapterSerially(
  options: RunChapterGenerationOptions,
): Promise<ChapterGenerationOutcome> {
  const {
    host,
    modelId,
    projectTopic,
    projectGoal,
    outputLanguage,
    level,
    outline,
    chapterIndex,
    target,
    projectPath,
    priorChapterKnowledgeTitles,
    workspaceScope,
    referenceDir,
    generateCards,
    usedCardUuids,
    vault,
    writer,
    abortSignal,
    activities,
    runId,
    projectId,
    onKnowledgePoint,
    onCard,
    retryDelayMs,
    resumeKnowledgePoints,
  } = options

  throwIfAborted(abortSignal)

  let knowledgePoints: ChapterKnowledgePoint[]
  if (resumeKnowledgePoints) {
    // Resume: the knowledge stage already completed in an earlier run (its
    // knowledge.md is marked `complete: true` on disk) — only the card stage
    // needs to run.
    knowledgePoints = resumeKnowledgePoints
  } else {
    const baselineSnapshot = await host.vaultWriter.readTextSnapshot(
      target.knowledgePath,
    )
    if (!baselineSnapshot) {
      throw new ChapterGenerationError(
        `Knowledge file not found: ${target.knowledgePath}`,
        'knowledge',
      )
    }
    const baselineContent = baselineSnapshot.content

    const knowledgePrompt = buildKnowledgePointStagePrompt({
      projectTopic,
      projectGoal,
      outline,
      chapterIndex,
      outputLanguage,
      level,
      priorChapterKnowledgeTitles,
      referenceDir,
    })

    try {
      knowledgePoints = await withInfraRetry(
        () =>
          attemptKnowledgeStage({
            host,
            modelId,
            activity: activities.knowledgePoints(target.chapterTitle),
            prompt: knowledgePrompt,
            chapter: target,
            projectPath,
            vault,
            writer,
            workspaceScope,
            abortSignal,
            onKnowledgePoint: (event) =>
              onKnowledgePoint?.({
                ...event,
                chapterIndex,
                chapterTitle: target.chapterTitle,
              }),
          }),
        {
          abortSignal,
          retryDelayMs,
          onBeforeRetry: () =>
            writer.writeText(target.knowledgePath, baselineContent),
        },
      )
    } catch (error) {
      if (error instanceof LearningGenerationAbortError) throw error
      throw new ChapterGenerationError(errorMessage(error), 'knowledge')
    }
    await markChapterKnowledgeComplete({
      vault,
      writer,
      knowledgePath: target.knowledgePath,
    })
  }

  if (!generateCards) {
    return { knowledgePoints, cardResult: null }
  }

  throwIfAborted(abortSignal)
  const knowledgeSnapshot = await host.vaultWriter.readTextSnapshot(
    target.knowledgePath,
  )
  if (!knowledgeSnapshot) {
    throw new ChapterGenerationError(
      `Knowledge file disappeared: ${target.knowledgePath}`,
      'cards',
    )
  }

  const cardPrompt = buildCardStagePrompt({
    chapterTitle: target.chapterTitle,
    chapterContract: outline[chapterIndex]?.contract ?? '',
    knowledgeMdBody: extractMarkdownBody(knowledgeSnapshot.content),
    knowledgePoints,
    level,
  })
  const validKpIds = new Set(knowledgePoints.map((point) => point.uuid))

  let cards: GeneratedCard[]
  try {
    cards = await withInfraRetry(
      () =>
        attemptCardStage({
          host,
          modelId,
          activity: activities.cards(target.chapterTitle),
          prompt: cardPrompt,
          abortSignal,
          validKpIds,
          usedCardUuids,
          runId,
          projectId,
          chapterId: target.chapterPath,
          chapterIndex,
          onCard,
        }),
      { abortSignal, retryDelayMs },
    )
  } catch (error) {
    if (error instanceof LearningGenerationAbortError) throw error
    throw new ChapterGenerationError(errorMessage(error), 'cards')
  }

  throwIfAborted(abortSignal)
  try {
    await assertKnowledgeUnchanged(host, knowledgeSnapshot)
  } catch (error) {
    throw new ChapterGenerationError(errorMessage(error), 'cards')
  }
  const cardResult = await writeChapterCards({ host, target, cards })
  return { knowledgePoints, cardResult }
}

async function attemptKnowledgeStage({
  host,
  modelId,
  activity,
  prompt,
  chapter,
  projectPath,
  vault,
  writer,
  workspaceScope,
  abortSignal,
  onKnowledgePoint,
}: {
  host: LearningGenerationHost
  modelId?: string
  activity?: LearningGenerationActivity
  prompt: string
  chapter: ChapterWriteTarget
  projectPath: string
  vault: LearningVaultReadApi
  writer: LearningVaultWriteApi
  workspaceScope?: LearningWorkspaceScope
  abortSignal?: AbortSignal
  onKnowledgePoint?: (event: {
    kpIndex: number
    kpId: string
    title: string
  }) => void
}): Promise<ChapterKnowledgePoint[]> {
  const runController = new AbortController()
  const forwardAbort = () => runController.abort()
  if (abortSignal?.aborted) runController.abort()
  else abortSignal?.addEventListener('abort', forwardAbort, { once: true })

  let rejectionCount = 0
  let rejectionLimitHit = false
  const knowledgePoints: ChapterKnowledgePoint[] = []

  const tool: LearningGenerationTool = {
    name: 'emit_knowledge_point',
    description:
      'Emit one knowledge point for the current chapter. Call once per knowledge point, in order.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short, specific title for the knowledge point.',
        },
        body: {
          type: 'string',
          description:
            'The knowledge point body, in the required output language.',
        },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    handler: async (input) => {
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const body = typeof input.body === 'string' ? input.body.trim() : ''
      if (!title || !body) {
        rejectionCount += 1
        if (rejectionCount > MAX_TOOL_REJECTIONS) {
          rejectionLimitHit = true
          runController.abort()
        }
        return {
          content: 'Both "title" and "body" must be non-empty strings.',
          isError: true,
        }
      }
      const uuid = createKnowledgePointUuid()
      await appendKnowledgePointDraft({
        vault,
        writer,
        projectPath,
        chapter,
        point: { title, body },
        uuid,
      })
      const kpIndex = knowledgePoints.length
      knowledgePoints.push({ uuid, title })
      onKnowledgePoint?.({ kpIndex, kpId: uuid, title })
      return { content: JSON.stringify({ kpId: uuid }) }
    },
  }

  try {
    for await (const event of host.agent.stream({
      prompt,
      modelId,
      systemPromptOverride: KNOWLEDGE_POINT_GENERATOR_PROMPT,
      capability: workspaceScope?.enabled ? 'readonly-vault' : 'none',
      workspaceScope,
      activity,
      tools: [tool],
      abortSignal: runController.signal,
    })) {
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'aborted') {
        if (rejectionLimitHit) {
          throw new RunValidationLimitError(
            `Chapter "${chapter.chapterTitle}" exceeded ${MAX_TOOL_REJECTIONS} invalid emit_knowledge_point calls`,
          )
        }
        throw new LearningGenerationAbortError(
          `Knowledge point generation aborted: ${chapter.chapterTitle}`,
        )
      }
    }
  } finally {
    abortSignal?.removeEventListener('abort', forwardAbort)
  }

  if (knowledgePoints.length === 0) {
    throw new Error(
      `No knowledge points were emitted for chapter: ${chapter.chapterTitle}`,
    )
  }
  return knowledgePoints
}

async function attemptCardStage({
  host,
  modelId,
  activity,
  prompt,
  abortSignal,
  validKpIds,
  usedCardUuids,
  runId,
  projectId,
  chapterId,
  chapterIndex,
  onCard,
}: {
  host: LearningGenerationHost
  modelId?: string
  activity?: LearningGenerationActivity
  prompt: string
  abortSignal?: AbortSignal
  validKpIds: ReadonlySet<string>
  usedCardUuids: Set<string>
  runId: string
  projectId: string
  chapterId: string
  chapterIndex: number
  onCard?: (event: CardGenerationEvent) => void
}): Promise<GeneratedCard[]> {
  const runController = new AbortController()
  const forwardAbort = () => runController.abort()
  if (abortSignal?.aborted) runController.abort()
  else abortSignal?.addEventListener('abort', forwardAbort, { once: true })

  let rejectionCount = 0
  let rejectionLimitHit = false
  const cards: GeneratedCard[] = []

  const tool: LearningGenerationTool = {
    name: 'emit_card',
    description:
      'Emit one learning card for the current chapter. Call once per card, in order.',
    inputSchema: {
      type: 'object',
      properties: {
        kpId: {
          type: 'string',
          description:
            'The knowledge point id this card tests, copied verbatim from the "title -> kpId" list.',
        },
        title: { type: 'string' },
        front: { type: 'string', description: 'The question side.' },
        back: { type: 'string', description: 'The answer side.' },
      },
      required: ['kpId', 'title', 'front', 'back'],
      additionalProperties: false,
    },
    handler: (input) => {
      const kpId =
        typeof input.kpId === 'string' ? input.kpId.trim().toLowerCase() : ''
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const front = typeof input.front === 'string' ? input.front.trim() : ''
      const back = typeof input.back === 'string' ? input.back.trim() : ''
      const errors: string[] = []
      if (!title) errors.push('missing title')
      if (!kpId) errors.push('missing kpId')
      else if (!validKpIds.has(kpId)) {
        errors.push(`kpId "${kpId}" does not belong to this chapter`)
      }
      if (!front) errors.push('missing front')
      if (!back) errors.push('missing back')
      if (errors.length > 0) {
        rejectionCount += 1
        if (rejectionCount > MAX_TOOL_REJECTIONS) {
          rejectionLimitHit = true
          runController.abort()
        }
        return { content: errors.join('; '), isError: true }
      }
      const cardUuid = assignCardUuid(usedCardUuids)
      const card: GeneratedCard = {
        cardUuid,
        kpUuid: kpId,
        title,
        front,
        back,
        startLine: cards.length,
      }
      cards.push(card)
      onCard?.({
        runId,
        projectId,
        chapterId,
        chapterIndex,
        cardIndex: cards.length - 1,
        cardUuid,
        card,
      })
      return { content: JSON.stringify({ cardId: cardUuid }) }
    },
  }

  try {
    for await (const event of host.agent.stream({
      prompt,
      modelId,
      systemPromptOverride: CARD_GENERATOR_PROMPT,
      capability: 'none',
      activity,
      tools: [tool],
      abortSignal: runController.signal,
    })) {
      if (event.type === 'error') throw new Error(event.message)
      if (event.type === 'aborted') {
        if (rejectionLimitHit) {
          throw new RunValidationLimitError(
            `Exceeded ${MAX_TOOL_REJECTIONS} invalid emit_card calls`,
          )
        }
        throw new LearningGenerationAbortError('Card generation aborted')
      }
    }
  } finally {
    abortSignal?.removeEventListener('abort', forwardAbort)
  }

  if (cards.length === 0) {
    throw new Error('No cards were emitted for this chapter')
  }
  return cards
}

async function writeChapterCards({
  host,
  target,
  cards,
}: {
  host: LearningGenerationHost
  target: ChapterWriteTarget
  cards: GeneratedCard[]
}): Promise<CardGenerationResult> {
  const blocks = cards.map((card) => {
    const title = card.title.trim()
    const kpPart = card.kpUuid ? ` kp:${card.kpUuid.toLowerCase()}` : ''
    return `## ${title}${title ? ' ' : ''}<!--card:${card.cardUuid}${kpPart}-->\n\n${formatCardBody(card.front, card.back)}`
  })
  const content = buildCardsContent(target.chapterTitle, blocks)
  const created = await host.vaultWriter.createTextIfAbsent(
    target.cardsPath,
    content,
  )
  if (!created) {
    throw new ChapterGenerationError(
      `Cards file already exists: ${target.cardsPath}`,
      'cards',
    )
  }
  return {
    chapterIndex: target.chapterIndex,
    chapterTitle: target.chapterTitle,
    cards,
    status: 'generated',
    discardedCount: 0,
  }
}

async function withInfraRetry<T>(
  attempt: () => Promise<T>,
  options: {
    abortSignal?: AbortSignal
    onBeforeRetry?: () => Promise<unknown>
    retryDelayMs?: (attempt: number) => number
  },
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (error instanceof LearningGenerationAbortError) throw error
      if (error instanceof RunValidationLimitError) throw error
      if (options.abortSignal?.aborted) {
        throw new LearningGenerationAbortError('Generation aborted')
      }
      if (attemptIndex >= MAX_INFRA_RETRIES) throw error
      await options.onBeforeRetry?.()
      await delay(retryDelayMs(attemptIndex + 1))
    }
  }
}

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4000)
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assignCardUuid(used: Set<string>): string {
  let uuid = createCardUuid()
  while (used.has(uuid)) uuid = createCardUuid()
  used.add(uuid)
  return uuid
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new LearningGenerationAbortError('Generation aborted')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
