import type { App } from 'obsidian'

import { LearningRuntime } from './learningRuntime'
import type { LearningStatsService } from './learningStatsService'
import type { LearningSrsStore } from './srs/srsStore'

const createRuntime = (
  overrides: {
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
})
