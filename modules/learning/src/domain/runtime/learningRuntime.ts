import type { ProjectEventBus } from '../projectEventBus'
import { getTotalDueCards } from '../stats/learningStatsService'

import {
  LearningNavigation,
  type LearningNavigationHandler,
  type LearningNavigationPort,
  type LearningNavigationTarget,
} from './learningNavigation'
import type {
  LearningRuntimePorts,
  LearningRuntimeSrsPort,
  LearningStatsServicePort,
} from './ports'

export const LEARNING_REVIEW_REMINDER_ID = 'reminder:learning-review'

export class LearningRuntime<
  Srs extends LearningRuntimeSrsPort,
  Stats extends LearningStatsServicePort,
> {
  private readonly ports: LearningRuntimePorts<Srs, Stats>
  private readonly navigation: LearningNavigationPort
  private srsStore: Srs | null = null
  private statsService: Stats | null = null
  private unsubscribeStats: (() => void) | null = null
  private eventBus: ProjectEventBus | null = null
  private readonly generationControllers = new Set<AbortController>()
  private disposed = false

  constructor(ports: LearningRuntimePorts<Srs, Stats>) {
    this.ports = ports
    this.navigation = ports.navigation ?? new LearningNavigation()
  }

  getSrsStore(): Srs {
    this.assertActive()
    if (!this.srsStore) this.srsStore = this.ports.createSrsStore()
    return this.srsStore
  }

  getStatsService(): Stats {
    this.assertActive()
    if (!this.statsService) {
      this.statsService = this.ports.createStatsService(this.getSrsStore())
    }
    return this.statsService
  }

  startStats(): void {
    const statsService = this.getStatsService()
    if (!this.unsubscribeStats && this.ports.background) {
      this.unsubscribeStats = statsService.subscribe((snapshot) => {
        const dueCards = getTotalDueCards(snapshot)
        if (dueCards === 0) {
          this.ports.background?.remove(LEARNING_REVIEW_REMINDER_ID)
          return
        }
        const translate =
          this.ports.translate ?? ((_keyPath, fallback) => fallback)
        this.ports.background?.upsert({
          id: LEARNING_REVIEW_REMINDER_ID,
          kind: 'learning-review',
          title: translate('statusBar.learningReviewTitle', 'YOLO Learning'),
          detail: translate(
            'statusBar.learningReviewDetail',
            '{count} cards to review',
          ).replace('{count}', String(dueCards)),
          summary: translate(
            'statusBar.learningReviewLabel',
            'YOLO Learning: {count} cards due today',
          ).replace('{count}', String(dueCards)),
          icon: 'graduation-cap',
          status: 'reminder',
          updatedAt: this.ports.clock.now(),
          action: this.ports.openLearningHome
            ? { type: 'callback', run: this.ports.openLearningHome }
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
    if (!this.disposed) this.eventBus = bus
  }

  getEventBus(): ProjectEventBus | null {
    return this.eventBus
  }

  setNavigationHandler(handler: LearningNavigationHandler | null): void {
    this.navigation.setHandler(handler)
  }

  queueNavigation(target: LearningNavigationTarget): void {
    this.navigation.queue(target)
  }

  flushNavigation(): void {
    this.navigation.flush()
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
    this.ports.background?.remove(LEARNING_REVIEW_REMINDER_ID)
    this.statsService?.dispose()
    this.statsService = null
    this.eventBus = null
    this.navigation.dispose()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Learning runtime has been disposed')
  }
}
