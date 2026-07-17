import type { App } from 'obsidian'

import type { YoloSettingsLike } from '../paths/yoloManagedData'

import type {
  LearningNavigationHandler,
  LearningNavigationTarget,
} from './learningNavigation'
import { LearningStatsService } from './learningStatsService'
import { createObsidianLearningVaultReadApi } from './obsidianLearningVaultReadApi'
import type { ProjectEventBus } from './projectEventBus'
import { ObsidianLearningSrsStorage } from './srs/obsidianLearningSrsStorage'
import { LearningSrsStore } from './srs/srsStore'

type LearningRuntimeOptions = {
  app: App
  getSettings: () => YoloSettingsLike | null
  getLearningBaseDir: () => string
  createSrsStore?: () => LearningSrsStore
  createStatsService?: (srsStore: LearningSrsStore) => LearningStatsService
}

export class LearningRuntime {
  private readonly createSrsStore: () => LearningSrsStore
  private readonly createStatsService: (
    srsStore: LearningSrsStore,
  ) => LearningStatsService
  private srsStore: LearningSrsStore | null = null
  private statsService: LearningStatsService | null = null
  private eventBus: ProjectEventBus | null = null
  private navigationHandler: LearningNavigationHandler | null = null
  private pendingNavigation: LearningNavigationTarget | null = null
  private readonly generationControllers = new Set<AbortController>()
  private disposed = false

  constructor({
    app,
    getSettings,
    getLearningBaseDir,
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
    this.getStatsService().start()
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
