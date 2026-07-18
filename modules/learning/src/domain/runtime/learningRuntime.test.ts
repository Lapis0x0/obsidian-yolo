import type { LearningStatsSnapshot } from '../stats/learningStatsService'

import { LEARNING_REVIEW_REMINDER_ID, LearningRuntime } from './learningRuntime'
import type { LearningRuntimeSrsPort, LearningStatsServicePort } from './ports'

type Srs = LearningRuntimeSrsPort
type Stats = LearningStatsServicePort

const snapshot = (dueCards: number): LearningStatsSnapshot => ({
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
})

const createRuntime = (
  overrides: Partial<
    ConstructorParameters<typeof LearningRuntime<Srs, Stats>>[0]
  > = {},
) =>
  new LearningRuntime<Srs, Stats>({
    createSrsStore: () => ({
      runExclusive: async (operation) => operation(),
    }),
    createStatsService: () => ({
      getSnapshot: () => snapshot(0),
      subscribe: () => () => undefined,
      start: () => undefined,
      restart: () => undefined,
      dispose: () => undefined,
    }),
    clock: { now: () => 123 },
    ...overrides,
  })

describe('LearningRuntime', () => {
  it('holds only the latest navigation until a handler is registered', () => {
    const runtime = createRuntime()
    const handler = jest.fn()
    runtime.queueNavigation({ type: 'home' })
    runtime.queueNavigation({
      type: 'project',
      projectId: 'project',
      tab: '卡片',
      cardMode: '学习',
    })

    runtime.flushNavigation()
    expect(handler).not.toHaveBeenCalled()
    runtime.setNavigationHandler(handler)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'project', projectId: 'project' }),
    )
    runtime.setNavigationHandler(null)
    runtime.setNavigationHandler(handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('lazily creates stable SRS and stats identities', () => {
    const srs = { runExclusive: jest.fn() }
    const stats = {
      getSnapshot: jest.fn(),
      subscribe: jest.fn(),
      start: jest.fn(),
      restart: jest.fn(),
      dispose: jest.fn(),
    }
    const createSrsStore = jest.fn(() => srs)
    const createStatsService = jest.fn(() => stats)
    const runtime = createRuntime({ createSrsStore, createStatsService })

    expect(runtime.getSrsStore()).toBe(srs)
    expect(runtime.getSrsStore()).toBe(srs)
    expect(runtime.getStatsService()).toBe(stats)
    expect(runtime.getStatsService()).toBe(stats)
    expect(createSrsStore).toHaveBeenCalledTimes(1)
    expect(createStatsService).toHaveBeenCalledWith(srs)
  })

  it('serializes work only after SRS initialization', async () => {
    const runExclusive = jest.fn()
    const srsStore: LearningRuntimeSrsPort = {
      runExclusive: async <R>(operation: () => Promise<R>) => {
        runExclusive()
        return operation()
      },
    }
    const runtime = createRuntime({ createSrsStore: () => srsStore })
    const operation = jest.fn(async () => 'migrated')

    await expect(runtime.runExclusiveIfSrsInitialized(operation)).resolves.toBe(
      'migrated',
    )
    expect(runExclusive).not.toHaveBeenCalled()
    runtime.getSrsStore()
    await runtime.runExclusiveIfSrsInitialized(operation)
    expect(runExclusive).toHaveBeenCalledTimes(1)
  })

  it('tracks, releases, and synchronously aborts generation controllers', () => {
    const runtime = createRuntime()
    const tracked = new AbortController()
    const released = new AbortController()
    runtime.trackGeneration(tracked)
    runtime.trackGeneration(released)
    runtime.releaseGeneration(released)

    runtime.dispose()
    runtime.dispose()

    expect(tracked.signal.aborted).toBe(true)
    expect(released.signal.aborted).toBe(false)
    const late = new AbortController()
    runtime.trackGeneration(late)
    expect(late.signal.aborted).toBe(true)
  })

  it('publishes the stable review reminder and cleans it up', () => {
    const upsert = jest.fn()
    const remove = jest.fn()
    const unsubscribe = jest.fn()
    const dispose = jest.fn()
    const openLearningHome = jest.fn()
    let publish: (value: LearningStatsSnapshot) => void = () => undefined
    const runtime = createRuntime({
      background: { upsert, remove },
      openLearningHome,
      translate: (_key, fallback) => `translated:${fallback}`,
      createStatsService: () => ({
        getSnapshot: () => snapshot(0),
        subscribe: (listener) => {
          publish = listener
          listener(snapshot(0))
          return unsubscribe
        },
        start: jest.fn(),
        restart: jest.fn(),
        dispose,
      }),
    })

    runtime.startStats()
    publish(snapshot(4))

    expect(remove).toHaveBeenCalledWith(LEARNING_REVIEW_REMINDER_ID)
    expect(upsert).toHaveBeenCalledWith({
      id: LEARNING_REVIEW_REMINDER_ID,
      kind: 'learning-review',
      title: 'translated:YOLO Learning',
      detail: 'translated:4 cards to review',
      summary: 'translated:YOLO Learning: 4 cards due today',
      icon: 'graduation-cap',
      status: 'reminder',
      updatedAt: 123,
      action: { type: 'callback', run: openLearningHome },
    })
    upsert.mock.lastCall?.[0].action.run()
    expect(openLearningHome).toHaveBeenCalledTimes(1)

    publish(snapshot(0))
    runtime.dispose()
    expect(remove).toHaveBeenCalledTimes(3)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
