import { App, TFile, normalizePath } from 'obsidian'

import {
  CardFileFormatError,
  parseCardFile,
  scanProjectCards,
} from './cardFile'
import type { LearningSrsStore } from './srs/srsStore'
import type { SrsCardState } from './srs/srsTypes'
import type { CardChapter, Project } from './types'

export const LEARNING_TARGET_RETENTION = 0.9
export const MEMORY_RETENTION_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000

export type LearningProjectAction = {
  kind: 'learn' | 'review'
  knowledgePointTitle: string
  started: boolean
}

export type LearningProjectStats = {
  totalCards: number
  targetCards: number
  targetCardProgress: number
  estimatedRetention: number
  dueCards: number
  lastStudiedAt: number | null
  createdAt: number
  lastActiveAt: number
  nextDueAt: number | null
  nextAction: LearningProjectAction | null
}

export async function loadLearningProjectStats({
  app,
  project,
  srsStore,
  now,
}: {
  app: App
  project: Project
  srsStore: LearningSrsStore
  now: Date
}): Promise<LearningProjectStats> {
  const cardUuids = new Set<string>()
  const cardPointUuids = new Map<string, string>()
  const cardUuidsByPoint = new Map<string, string[]>()
  const pointByUuid = new Map(
    project.knowledgePoints.map((point) => [point.uuid, point]),
  )

  for (const chapter of project.chapters) {
    const path = normalizePath(
      project.kind === 'cards'
        ? (chapter as CardChapter).cardsFilePath
        : `${chapter.folderPath}/cards.md`,
    )
    const file = app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) continue

    const parsed =
      project.kind === 'cards'
        ? parseCardFile(await app.vault.cachedRead(file), {
            mode: 'chapter-direct',
            path: file.path,
          })
        : parseCardFile(await app.vault.cachedRead(file), file.path)
    if (!parsed.complete)
      throw new CardFileFormatError(file.path, parsed.errors)

    for (const entry of parsed.cards) {
      if (project.kind === 'cards') {
        if (cardUuids.has(entry.cardUuid)) {
          throw new CardFileFormatError(file.path, [
            { path: file.path, message: `card UUID 重复：${entry.cardUuid}` },
          ])
        }
        cardUuids.add(entry.cardUuid)
        cardPointUuids.set(entry.cardUuid, chapter.id)
        const chapterCards = cardUuidsByPoint.get(chapter.id) ?? []
        chapterCards.push(entry.cardUuid)
        cardUuidsByPoint.set(chapter.id, chapterCards)
        continue
      }
      if (entry.kpUuid === null) {
        throw new CardFileFormatError(file.path, parsed.errors)
      }
      const point = pointByUuid.get(entry.kpUuid)
      if (!point || point.chapterId !== chapter.id) {
        throw new CardFileFormatError(file.path, [
          {
            path: file.path,
            line: entry.startLine,
            message: !point
              ? `卡片引用了不存在的知识点：${entry.kpUuid}`
              : `卡片知识点不属于当前章节：${entry.kpUuid}`,
          },
        ])
      }
      if (cardUuids.has(entry.cardUuid)) {
        throw new CardFileFormatError(file.path, [
          { path: file.path, message: `card UUID 重复：${entry.cardUuid}` },
        ])
      }
      cardUuids.add(entry.cardUuid)
      cardPointUuids.set(entry.cardUuid, entry.kpUuid)
      const pointCardUuids = cardUuidsByPoint.get(entry.kpUuid) ?? []
      pointCardUuids.push(entry.cardUuid)
      cardUuidsByPoint.set(entry.kpUuid, pointCardUuids)
    }
  }

  const projectScan = await scanProjectCards(
    app,
    project.folderPath,
    project.chapters.map((chapter) =>
      project.kind === 'cards'
        ? (chapter as CardChapter).cardsFilePath
        : `${chapter.folderPath}/cards.md`,
    ),
  )
  if (!projectScan.complete) {
    throw new CardFileFormatError(project.folderPath, projectScan.errors)
  }

  const projectState = await srsStore.getProjectState(project.slug)
  const suspended = new Set(projectState.suspended ?? [])
  suspended.forEach((uuid) => cardUuids.delete(uuid))
  const horizon = new Date(now.getTime() + MEMORY_RETENTION_HORIZON_MS)
  const nowMs = now.getTime()
  let retrievabilityTotal = 0
  let targetCards = 0
  let dueCards = 0
  const dueCardEntries: { cardUuid: string; dueAt: number }[] = []
  let lastStudiedAt: number | null = null
  let nextDueAt: number | null = null

  for (const cardUuid of cardUuids) {
    const state = projectState.cards[cardUuid]
    if (!state) continue

    const retrievability = srsStore.getCardRetrievability(state, horizon)
    retrievabilityTotal += retrievability
    if (retrievability >= LEARNING_TARGET_RETENTION) targetCards += 1

    const dueAt = new Date(state.due).getTime()
    if (dueAt <= nowMs) {
      dueCards += 1
      dueCardEntries.push({ cardUuid, dueAt })
    } else if (nextDueAt === null || dueAt < nextDueAt) nextDueAt = dueAt

    const reviewedAt = resolveReviewedAt(state)
    if (
      reviewedAt !== null &&
      (lastStudiedAt === null || reviewedAt > lastStudiedAt)
    ) {
      lastStudiedAt = reviewedAt
    }
  }

  const totalCards = cardUuids.size
  const averageRetention =
    totalCards === 0 ? 0 : retrievabilityTotal / totalCards
  const projectFiles = app.vault
    .getMarkdownFiles()
    .filter(
      (file) =>
        file.path === project.indexFilePath ||
        file.path.startsWith(`${project.folderPath}/`),
    )
  const indexFile = app.vault.getAbstractFileByPath(project.indexFilePath)
  const createdAt = indexFile instanceof TFile ? indexFile.stat.ctime : 0
  const lastModifiedAt = projectFiles.reduce(
    (latest, file) => Math.max(latest, file.stat.mtime),
    createdAt,
  )
  const nextAction = resolveNextAction({
    project,
    projectCards: projectState.cards,
    cardPointUuids,
    cardUuidsByPoint,
    dueCardEntries,
    suspended,
  })

  return {
    totalCards,
    targetCards,
    targetCardProgress:
      totalCards === 0 ? 0 : Math.round((targetCards / totalCards) * 100),
    estimatedRetention: Math.round(averageRetention * 100),
    dueCards,
    lastStudiedAt,
    createdAt,
    lastActiveAt: Math.max(lastModifiedAt, lastStudiedAt ?? 0),
    nextDueAt,
    nextAction,
  }
}

function resolveNextAction({
  project,
  projectCards,
  cardPointUuids,
  cardUuidsByPoint,
  dueCardEntries,
  suspended,
}: {
  project: Project
  projectCards: Record<string, SrsCardState>
  cardPointUuids: Map<string, string>
  cardUuidsByPoint: Map<string, string[]>
  dueCardEntries: { cardUuid: string; dueAt: number }[]
  suspended: ReadonlySet<string>
}): LearningProjectAction | null {
  if (project.kind === 'cards') {
    const firstDueCard = dueCardEntries.reduce<
      { cardUuid: string; dueAt: number } | undefined
    >(
      (earliest, entry) =>
        !earliest || entry.dueAt < earliest.dueAt ? entry : earliest,
      undefined,
    )
    if (firstDueCard) {
      const chapterId = cardPointUuids.get(firstDueCard.cardUuid)
      const chapter = project.chapters.find((item) => item.id === chapterId)
      return {
        kind: 'review',
        knowledgePointTitle: chapter?.title ?? project.topic,
        started: true,
      }
    }
    for (const chapter of project.chapters) {
      const chapterCardUuids = (cardUuidsByPoint.get(chapter.id) ?? []).filter(
        (uuid) => !suspended.has(uuid),
      )
      if (chapterCardUuids.length === 0) continue
      const introduced = chapterCardUuids.filter(
        (uuid) => projectCards[uuid],
      ).length
      if (introduced === chapterCardUuids.length) continue
      return {
        kind: 'learn',
        knowledgePointTitle: chapter.title,
        started: introduced > 0,
      }
    }
    return null
  }
  const pointByUuid = new Map(
    project.knowledgePoints.map((point) => [point.uuid, point]),
  )
  const firstDueCard = dueCardEntries.reduce<
    { cardUuid: string; dueAt: number } | undefined
  >(
    (earliest, entry) =>
      !earliest || entry.dueAt < earliest.dueAt ? entry : earliest,
    undefined,
  )

  if (firstDueCard) {
    const pointUuid = cardPointUuids.get(firstDueCard.cardUuid)
    const point = pointUuid ? pointByUuid.get(pointUuid) : undefined
    if (point && pointUuid) {
      return {
        kind: 'review',
        knowledgePointTitle: point.title,
        started: true,
      }
    }
  }

  for (const point of project.knowledgePoints) {
    const pointCardUuids = (cardUuidsByPoint.get(point.uuid) ?? []).filter(
      (uuid) => !suspended.has(uuid),
    )
    if (pointCardUuids.length === 0) continue
    const introducedCards = pointCardUuids.filter(
      (cardUuid) => projectCards[cardUuid],
    ).length
    if (introducedCards === pointCardUuids.length) continue
    return {
      kind: 'learn',
      knowledgePointTitle: point.title,
      started: introducedCards > 0,
    }
  }

  return null
}

function resolveReviewedAt(state: SrsCardState): number | null {
  if (!state.lastReview) return null
  const timestamp = new Date(state.lastReview).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}
