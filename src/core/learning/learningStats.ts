import { App, TFile, normalizePath } from 'obsidian'

import {
  CardFileFormatError,
  parseCardFile,
  scanProjectCards,
} from './cardFile'
import type { LearningSrsStore } from './srs/srsStore'
import type { SrsCardState } from './srs/srsTypes'
import type { Project } from './types'

export const LEARNING_TARGET_RETENTION = 0.9
export const MEMORY_RETENTION_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000

export type LearningProjectStats = {
  totalCards: number
  targetCards: number
  targetCardProgress: number
  memoryProgress: number
  dueCards: number
  lastStudiedAt: number | null
  createdAt: number
  lastActiveAt: number
  nextDueAt: number | null
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
  const pointByUuid = new Map(
    project.knowledgePoints.map((point) => [point.uuid, point]),
  )

  for (const chapter of project.chapters) {
    const path = normalizePath(`${chapter.folderPath}/cards.md`)
    const file = app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) continue

    const parsed = parseCardFile(await app.vault.cachedRead(file), file.path)
    if (!parsed.complete)
      throw new CardFileFormatError(file.path, parsed.errors)

    for (const entry of parsed.cards) {
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
    }
  }

  const projectScan = await scanProjectCards(
    app,
    project.folderPath,
    project.chapters.map((chapter) => `${chapter.folderPath}/cards.md`),
  )
  if (!projectScan.complete) {
    throw new CardFileFormatError(project.folderPath, projectScan.errors)
  }

  const projectState = await srsStore.getProjectState(project.slug)
  const horizon = new Date(now.getTime() + MEMORY_RETENTION_HORIZON_MS)
  const nowMs = now.getTime()
  let retrievabilityTotal = 0
  let targetCards = 0
  let dueCards = 0
  let lastStudiedAt: number | null = null
  let nextDueAt: number | null = null

  for (const cardUuid of cardUuids) {
    const state = projectState.cards[cardUuid]
    if (!state) continue

    const retrievability = srsStore.getCardRetrievability(state, horizon)
    retrievabilityTotal += retrievability
    if (retrievability >= LEARNING_TARGET_RETENTION) targetCards += 1

    const dueAt = new Date(state.due).getTime()
    if (dueAt <= nowMs) dueCards += 1
    else if (nextDueAt === null || dueAt < nextDueAt) nextDueAt = dueAt

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

  return {
    totalCards,
    targetCards,
    targetCardProgress:
      totalCards === 0 ? 0 : Math.round((targetCards / totalCards) * 100),
    memoryProgress: Math.round(
      Math.min(averageRetention / LEARNING_TARGET_RETENTION, 1) * 100,
    ),
    dueCards,
    lastStudiedAt,
    createdAt,
    lastActiveAt: Math.max(lastModifiedAt, lastStudiedAt ?? 0),
    nextDueAt,
  }
}

function resolveReviewedAt(state: SrsCardState): number | null {
  if (!state.lastReview) return null
  const timestamp = new Date(state.lastReview).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}
