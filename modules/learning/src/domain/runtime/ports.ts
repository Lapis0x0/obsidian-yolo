import type { ProjectEventBus } from '../projectEventBus'
import type { LearningStatsSnapshot } from '../stats/learningStatsService'

import type {
  LearningNavigationHandler,
  LearningNavigationPort,
  LearningNavigationTarget,
} from './learningNavigation'

export type LearningRuntimeSrsPort = {
  runExclusive<R>(operation: () => Promise<R>): Promise<R>
}

export type LearningStatsServicePort = {
  getSnapshot(): LearningStatsSnapshot
  subscribe(listener: (snapshot: LearningStatsSnapshot) => void): () => void
  start(): void
  restart(): void
  dispose(): void
}

export type LearningReminderActivity = {
  id: string
  kind: 'learning-review'
  title: string
  detail: string
  summary: string
  icon: 'graduation-cap'
  status: 'reminder'
  updatedAt: number
  action?: { type: 'callback'; run: () => void }
}

export type LearningBackgroundPort = {
  upsert(activity: LearningReminderActivity): void
  remove(id: string): void
}

export type LearningRuntimeClockPort = {
  now(): number
}

export type LearningRuntimePorts<
  Srs extends LearningRuntimeSrsPort,
  Stats extends LearningStatsServicePort,
> = {
  createSrsStore(): Srs
  createStatsService(srsStore: Srs): Stats
  background?: LearningBackgroundPort
  navigation?: LearningNavigationPort
  openLearningHome?: () => void
  translate?: (keyPath: string, fallback: string) => string
  clock: LearningRuntimeClockPort
}

export type LearningRuntimeEventBus = ProjectEventBus
export type {
  LearningNavigationHandler,
  LearningNavigationPort,
  LearningNavigationTarget,
}
