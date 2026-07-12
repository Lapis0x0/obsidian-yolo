import type {
  CardGenerationEvent,
  CardGenerationResult,
} from '../../core/learning/generation/types'
import type { Project } from '../../core/learning/types'

import type { Mastery } from './primitives'

export type WorkspaceCard = {
  id: string
  kpUuid: string
  pointId: string | null
  pointTitle: string
  chapterId: string
  chapterTitle: string
  front: string
  back: string
  mastery: Mastery
  dueAt: string | null
  srsState: import('../../core/learning/srs/srsTypes').SrsCardState | null
  filePath: string | null
  startLine: number
  sourceIndex: number
  preview: boolean
}

export type CardGenerationWorkspace = {
  runId: string
  projectId: string
  cards: CardGenerationEvent[]
  settled: CardGenerationResult[]
}

export type CardGenerationSummary = {
  outcome: 'success' | 'partial' | 'failed'
  chapterCount: number
  cardCount: number
  incompleteChapterCount: number
  skippedChapterCount: number
}

export function summarizeCardGeneration(
  results: CardGenerationResult[],
): CardGenerationSummary {
  const cardCount = results.reduce(
    (total, result) => total + result.cards.length,
    0,
  )
  const incompleteChapterCount = results.filter(
    (result) => result.status === 'partial' || result.status === 'failed',
  ).length
  const skippedChapterCount = results.filter(
    (result) => result.status === 'skipped',
  ).length
  const hasUsableChapter = results.some((result) => result.status !== 'failed')
  const outcome =
    results.length === 0 || !hasUsableChapter
      ? 'failed'
      : incompleteChapterCount > 0
        ? 'partial'
        : 'success'

  return {
    outcome,
    chapterCount: results.length,
    cardCount,
    incompleteChapterCount,
    skippedChapterCount,
  }
}

export function reconcilePreviewEvents(
  events: CardGenerationEvent[],
  result: CardGenerationResult,
): CardGenerationEvent[] {
  const finalUuids = new Set(result.cards.map((card) => card.cardUuid))
  return events.filter(
    (event) =>
      event.chapterIndex !== result.chapterIndex ||
      finalUuids.has(event.cardUuid),
  )
}

export function mergeDiskAndPreviewCards(
  diskCards: WorkspaceCard[],
  previews: WorkspaceCard[],
): WorkspaceCard[] {
  const diskUuids = new Set(diskCards.map((card) => card.id))
  return [...diskCards, ...previews.filter((card) => !diskUuids.has(card.id))]
}

export type CardGroup = {
  chapter: Project['chapters'][number]
  points: Array<{
    point: Project['knowledgePoints'][number]
    cards: WorkspaceCard[]
  }>
}

export function groupCardsByProjectOrder(
  project: Project,
  cards: WorkspaceCard[],
): CardGroup[] {
  return project.chapters.map((chapter) => ({
    chapter,
    points: chapter.knowledgePointIds
      .map((id) => project.knowledgePoints.find((point) => point.id === id))
      .filter((point): point is Project['knowledgePoints'][number] =>
        Boolean(point),
      )
      .map((point) => ({
        point,
        cards: cards.filter((card) => card.kpUuid === point.uuid),
      })),
  }))
}

export function calculateTargetFileIndex(
  targetKpUuid: string,
  visibleTargetIndex: number,
  chapterPointUuids: string[],
  fileCards: Array<{ id: string; kpUuid: string }>,
  movingCardUuids: Iterable<string>,
): number {
  const moving = new Set(movingCardUuids)
  const remaining = fileCards.filter((card) => !moving.has(card.id))
  const targetCards = remaining.filter((card) => card.kpUuid === targetKpUuid)
  const boundedIndex = Math.max(
    0,
    Math.min(visibleTargetIndex, targetCards.length),
  )
  const targetCard = targetCards[boundedIndex]
  if (targetCard)
    return remaining.findIndex((card) => card.id === targetCard.id)
  const lastTargetCard = targetCards.at(-1)
  if (lastTargetCard) {
    return remaining.findIndex((card) => card.id === lastTargetCard.id) + 1
  }
  const pointIndex = chapterPointUuids.indexOf(targetKpUuid)
  const nextPointUuids = new Set(chapterPointUuids.slice(pointIndex + 1))
  const nextIndex = remaining.findIndex((card) =>
    nextPointUuids.has(card.kpUuid),
  )
  return nextIndex < 0 ? remaining.length : nextIndex
}

export function isBrowseDragDisabled(input: {
  masteryFilter: string
  writeDisabled: boolean
  chapterGenerating: boolean
  preview: boolean
}): boolean {
  return (
    input.masteryFilter !== '全部' ||
    input.writeDisabled ||
    input.chapterGenerating ||
    input.preview
  )
}
