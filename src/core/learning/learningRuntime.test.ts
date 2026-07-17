import type { App } from 'obsidian'

import type { BackgroundActivity } from '../background/backgroundActivityRegistry'

import { LearningRuntime } from './learningRuntime'
import type {
  LearningStatsService,
  LearningStatsSnapshot,
} from './learningStatsService'
import type { LearningSrsStore } from './srs/srsStore'

const createRuntime = (
  overrides: {
    backgroundActivities?: {
      upsert(activity: BackgroundActivity): void
      remove(id: string): void
    }
    openLearningHome?: () => void
    translate?: (keyPath: string, fallback: string) => string
    createSrsStore?: () => LearningSrsStore
    createStatsService?: (store: LearningSrsStore) => LearningStatsService
  } = {},
) =>
  new LearningRuntime({
    app: {} as App,
    getSettings: () => null,
    getLearningBaseDir: () => 'YOLO/learning',
    ...overrides,
  })

describe('LearningRuntime', () => {
  it('holds pending navigation until a handler is registered', () => {
    const runtime = createRuntime()
    const first = { type: 'home' } as const
    const second = {
      type: 'project',
      projectId: 'project',
      tab: '卡片',
      cardMode: '学习',
    } as const
    const handler = jest.fn()

    runtime.queueNavigation(first)
    runtime.queueNavigation(second)
    runtime.flushNavigation()
    expect(handler).not.toHaveBeenCalled()

    runtime.setNavigationHandler(handler)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(second)

    runtime.setNavigationHandler(null)
    runtime.setNavigationHandler(handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('tracks and releases generation controllers', () => {
    const runtime = createRuntime()
    const tracked = new AbortController()
    const released = new AbortController()
    runtime.trackGeneration(tracked)
    runtime.trackGeneration(released)
    runtime.releaseGeneration(released)

    runtime.dispose()

    expect(tracked.signal.aborted).toBe(true)
    expect(released.signal.aborted).toBe(false)
  })

  it('lazily creates stable SRS and stats service identities', () => {
    const srsStore = {} as LearningSrsStore
    const statsService = {} as LearningStatsService
    const createSrsStore = jest.fn(() => srsStore)
    const createStatsService = jest.fn(() => statsService)
    const runtime = createRuntime({ createSrsStore, createStatsService })

    expect(createSrsStore).not.toHaveBeenCalled()
    expect(createStatsService).not.toHaveBeenCalled()
    expect(runtime.getSrsStore()).toBe(srsStore)
    expect(runtime.getSrsStore()).toBe(srsStore)
    expect(runtime.getStatsService()).toBe(statsService)
    expect(runtime.getStatsService()).toBe(statsService)
    expect(createSrsStore).toHaveBeenCalledTimes(1)
    expect(createStatsService).toHaveBeenCalledTimes(1)
    expect(createStatsService).toHaveBeenCalledWith(srsStore)
  })

  it('disposes stats and synchronously aborts tracked generation once', () => {
    const disposeStats = jest.fn()
    const statsService = {
      dispose: disposeStats,
    } as unknown as LearningStatsService
    const runtime = createRuntime({
      createSrsStore: () => ({}) as LearningSrsStore,
      createStatsService: () => statsService,
    })
    const controller = new AbortController()
    runtime.getStatsService()
    runtime.trackGeneration(controller)

    runtime.dispose()

    expect(controller.signal.aborted).toBe(true)
    expect(disposeStats).toHaveBeenCalledTimes(1)
    runtime.dispose()
    expect(disposeStats).toHaveBeenCalledTimes(1)

    const lateController = new AbortController()
    runtime.trackGeneration(lateController)
    expect(lateController.signal.aborted).toBe(true)
  })

  it('uses the initialized SRS store to serialize base-dir work', async () => {
    const runExclusive = jest.fn(async <R>(operation: () => Promise<R>) =>
      operation(),
    )
    const runtime = createRuntime({
      createSrsStore: () => ({ runExclusive }) as unknown as LearningSrsStore,
    })
    const operation = jest.fn(async () => 'migrated')

    expect(await runtime.runExclusiveIfSrsInitialized(operation)).toBe(
      'migrated',
    )
    expect(runExclusive).not.toHaveBeenCalled()

    runtime.getSrsStore()
    expect(await runtime.runExclusiveIfSrsInitialized(operation)).toBe(
      'migrated',
    )
    expect(runExclusive).toHaveBeenCalledTimes(1)
  })

  it('publishes and removes its review reminder through the background sink', () => {
    const upsert = jest.fn()
    const remove = jest.fn()
    const unsubscribe = jest.fn()
    const openLearningHome = jest.fn()
    const startStats = jest.fn()
    const disposeStats = jest.fn()
    let publishStats: (snapshot: LearningStatsSnapshot) => void = () => {
      throw new Error('Stats subscriber was not registered')
    }
    const statsService = {
      subscribe: jest.fn(
        (subscriber: (snapshot: LearningStatsSnapshot) => void) => {
          publishStats = subscriber
          subscriber(createStatsSnapshot(0))
          return unsubscribe
        },
      ),
      start: startStats,
      dispose: disposeStats,
    } as unknown as LearningStatsService
    const runtime = createRuntime({
      backgroundActivities: { upsert, remove },
      openLearningHome,
      translate: (_keyPath, fallback) => `translated:${fallback}`,
      createSrsStore: () => ({}) as LearningSrsStore,
      createStatsService: () => statsService,
    })

    runtime.startStats()
    expect(remove).toHaveBeenCalledWith('reminder:learning-review')
    expect(startStats).toHaveBeenCalledTimes(1)

    publishStats(createStatsSnapshot(4))
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reminder:learning-review',
        kind: 'learning-review',
        title: 'translated:YOLO Learning',
        detail: 'translated:4 cards to review',
        summary: 'translated:YOLO Learning: 4 cards due today',
        icon: 'graduation-cap',
        status: 'reminder',
      }),
    )
    const reminder = upsert.mock.lastCall?.[0] as BackgroundActivity
    if (reminder.action?.type !== 'callback') {
      throw new Error('Expected a callback reminder action')
    }
    reminder.action.run()
    expect(openLearningHome).toHaveBeenCalledTimes(1)

    publishStats(createStatsSnapshot(0))
    expect(remove).toHaveBeenCalledTimes(2)

    runtime.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(3)
    expect(disposeStats).toHaveBeenCalledTimes(1)
  })
})

function createStatsSnapshot(dueCards: number): LearningStatsSnapshot {
  return {
    projects: [],
    byProject: new Map([
      [
        'project',
        {
          paused: false,
          totalCards: dueCards,
          targetCards: dueCards,
          targetCardProgress: 0,
          estimatedRetention: 0,
          dueCards,
          lastStudiedAt: null,
          createdAt: 0,
          lastActiveAt: 0,
          nextDueAt: null,
          nextAction: null,
        },
      ],
    ]),
    pausedProjectIds: new Set(),
    failedProjectIds: new Set(),
    loading: false,
  }
}
