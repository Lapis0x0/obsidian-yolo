import type { App } from 'obsidian'

import type { BackgroundActivitySink } from '../background/backgroundActivityRegistry'
import type { YoloSettingsLike } from '../paths/yoloManagedData'

import type {
  LearningNavigationHandler,
  LearningNavigationTarget,
} from './learningNavigation'
import { LearningStatsService, getTotalDueCards } from './learningStatsService'
import { createObsidianLearningVaultReadApi } from './obsidianLearningVaultReadApi'
import type { ProjectEventBus } from './projectEventBus'
import { ObsidianLearningSrsStorage } from './srs/obsidianLearningSrsStorage'
import { LearningSrsStore } from './srs/srsStore'

type LearningRuntimeOptions = {
  app: App
  getSettings: () => YoloSettingsLike | null
  getLearningBaseDir: () => string
  backgroundActivities?: BackgroundActivitySink
  openLearningHome?: () => void
  translate?: (keyPath: string, fallback: string) => string
  createSrsStore?: () => LearningSrsStore
  createStatsService?: (srsStore: LearningSrsStore) => LearningStatsService
}

export class LearningRuntime {
  private static readonly REVIEW_REMINDER_ID = 'reminder:learning-review'

  private readonly createSrsStore: () => LearningSrsStore
  private readonly createStatsService: (
    srsStore: LearningSrsStore,
  ) => LearningStatsService
  private readonly backgroundActivities?: BackgroundActivitySink
  private readonly openLearningHome?: () => void
  private readonly translate: (keyPath: string, fallback: string) => string
  private srsStore: LearningSrsStore | null = null
  private statsService: LearningStatsService | null = null
  private unsubscribeStats: (() => void) | null = null
  private eventBus: ProjectEventBus | null = null
  private navigationHandler: LearningNavigationHandler | null = null
  private pendingNavigation: LearningNavigationTarget | null = null
  private readonly generationControllers = new Set<AbortController>()
  private disposed = false

  constructor({
    app,
    getSettings,
    getLearningBaseDir,
    backgroundActivities,
    openLearningHome,
    translate = (_keyPath, fallback) => fallback,
    createSrsStore = () =>
      new LearningSrsStore(new ObsidianLearningSrsStorage(app, getSettings)),
    createStatsService = (srsStore) =>
      new LearningStatsService({
        vault: createObsidianLearningVaultReadApi(app),
        getLearningBaseDir,
        srsStore,
      }),
  }: LearningRuntimeOptions) {
    this.createSrsStore = createSrsStore
    this.createStatsService = createStatsService
    this.backgroundActivities = backgroundActivities
    this.openLearningHome = openLearningHome
    this.translate = translate
  }

  getSrsStore(): LearningSrsStore {
    this.assertActive()
    if (!this.srsStore) this.srsStore = this.createSrsStore()
    return this.srsStore
  }

  getStatsService(): LearningStatsService {
    this.assertActive()
    if (!this.statsService) {
      this.statsService = this.createStatsService(this.getSrsStore())
    }
    return this.statsService
  }

  startStats(): void {
    const statsService = this.getStatsService()
    if (!this.unsubscribeStats && this.backgroundActivities) {
      this.unsubscribeStats = statsService.subscribe((snapshot) => {
        const dueCards = getTotalDueCards(snapshot)
        if (dueCards === 0) {
          this.backgroundActivities?.remove(LearningRuntime.REVIEW_REMINDER_ID)
          return
        }
        this.backgroundActivities?.upsert({
          id: LearningRuntime.REVIEW_REMINDER_ID,
          kind: 'learning-review',
          title: this.translate(
            'statusBar.learningReviewTitle',
            'YOLO Learning',
          ),
          detail: this.translate(
            'statusBar.learningReviewDetail',
            '{count} cards to review',
          ).replace('{count}', String(dueCards)),
          summary: this.translate(
            'statusBar.learningReviewLabel',
            'YOLO Learning: {count} cards due today',
          ).replace('{count}', String(dueCards)),
          icon: 'graduation-cap',
          status: 'reminder',
          updatedAt: Date.now(),
          action: this.openLearningHome
            ? { type: 'callback', run: this.openLearningHome }
            : undefined,
        })
      })
    }
    statsService.start()
  }

  restartStats(): void {
    this.statsService?.restart()
  }

  runExclusiveIfSrsInitialized<R>(operation: () => Promise<R>): Promise<R> {
    return this.srsStore ? this.srsStore.runExclusive(operation) : operation()
  }

  setEventBus(bus: ProjectEventBus | null): void {
    if (this.disposed) return
    this.eventBus = bus
  }

  getEventBus(): ProjectEventBus | null {
    return this.eventBus
  }

  setNavigationHandler(handler: LearningNavigationHandler | null): void {
    if (this.disposed) return
    this.navigationHandler = handler
    this.flushNavigation()
  }

  queueNavigation(target: LearningNavigationTarget): void {
    if (this.disposed) return
    this.pendingNavigation = target
  }

  flushNavigation(): void {
    if (this.disposed || !this.navigationHandler || !this.pendingNavigation) {
      return
    }
    const target = this.pendingNavigation
    this.pendingNavigation = null
    this.navigationHandler(target)
  }

  trackGeneration(controller: AbortController): void {
    if (this.disposed) {
      controller.abort()
      return
    }
    this.generationControllers.add(controller)
  }

  releaseGeneration(controller: AbortController): void {
    this.generationControllers.delete(controller)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.generationControllers) controller.abort()
    this.generationControllers.clear()
    this.unsubscribeStats?.()
    this.unsubscribeStats = null
    this.backgroundActivities?.remove(LearningRuntime.REVIEW_REMINDER_ID)
    this.statsService?.dispose()
    this.statsService = null
    this.eventBus = null
    this.navigationHandler = null
    this.pendingNavigation = null
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Learning runtime has been disposed')
  }
}
