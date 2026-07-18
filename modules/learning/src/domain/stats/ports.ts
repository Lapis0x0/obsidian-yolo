import type { ScanResult } from '../projectScanner'
import type { SrsCardState, SrsProjectState } from '../srs/srsTypes'

export type SrsProjectMutation = { projectSlug: string }

export type LearningStatsCalculationSrsPort = {
  getEffectiveProjectState(
    projectSlug: string,
    at: Date,
  ): Promise<SrsProjectState>
  getCardRetrievability(card: SrsCardState, at: Date): number
}

export type LearningStatsSrsPort = LearningStatsCalculationSrsPort & {
  isProjectPaused(projectSlug: string): Promise<boolean>
  subscribe(listener: (mutation: SrsProjectMutation) => void): () => void
}

export type LearningProjectScannerPort = {
  scanProjects(baseDir: string): Promise<ScanResult>
}

export type LearningProjectSourcePort = {
  getLearningBaseDir(): string
  scanProjects(): Promise<ScanResult>
}

export type LearningTimerHandle = number | object

export type LearningClockPort = {
  now(): Date
  setTimeout(callback: () => void, delayMs: number): LearningTimerHandle
  clearTimeout(handle: LearningTimerHandle): void
}

export type LearningFocusPort = {
  subscribeFocus(listener: () => void): () => void
}

export type LearningVisibilityPort = {
  subscribeVisible(listener: () => void): () => void
}

export type LearningLifecyclePorts = {
  clock: LearningClockPort
  focus: LearningFocusPort
  visibility: LearningVisibilityPort
}
