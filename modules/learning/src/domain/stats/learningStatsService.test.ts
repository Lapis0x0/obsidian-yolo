import type { LearningVaultReadApi } from '../learningVaultReadApi'
import type { Project } from '../types'

import type { LearningProjectStats } from './learningStats'
import { LearningStatsService, getTotalDueCards } from './learningStatsService'
import type {
  LearningLifecyclePorts,
  LearningStatsSrsPort,
  SrsProjectMutation,
} from './ports'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function project(slug: string): Project {
  return {
    kind: 'cards',
    id: `Learning/${slug}`,
    slug,
    topic: slug,
    goal: slug,
    status: 'studying',
    folderPath: `Learning/${slug}`,
    indexFilePath: `Learning/${slug}/index.md`,
    chapters: [],
    knowledgePoints: [],
  }
}

function stats(dueCards: number, nextDueAt: number | null = null) {
  return {
    paused: false,
    totalCards: dueCards,
    targetCards: 0,
    targetCardProgress: 0,
    estimatedRetention: 0,
    dueCards,
    lastStudiedAt: null,
    createdAt: 0,
    lastActiveAt: 0,
    nextDueAt,
    nextAction: null,
  } satisfies LearningProjectStats
}

function createFixture(initialProjects: Project[]) {
  let mutationSubscriber: ((mutation: SrsProjectMutation) => void) | null = null
  const vaultDisposers: jest.Mock[] = []
  const subscribeVault = jest.fn(() => {
    const dispose = jest.fn()
    vaultDisposers.push(dispose)
    return dispose
  })
  const vault = {
    onCreate: subscribeVault,
    onModify: subscribeVault,
    onDelete: subscribeVault,
    onRename: subscribeVault,
  } as unknown as LearningVaultReadApi
  const isProjectPaused = jest.fn(async (_projectSlug: string) => false)
  const srsStore = {
    getEffectiveProjectState: jest.fn(),
    getCardRetrievability: jest.fn(),
    isProjectPaused,
    subscribe: jest.fn((listener) => {
      mutationSubscriber = listener
      return () => {
        mutationSubscriber = null
      }
    }),
  } satisfies LearningStatsSrsPort
  const cleanups: jest.Mock[] = []
  const subscribeLifecycle = jest.fn(() => {
    const cleanup = jest.fn()
    cleanups.push(cleanup)
    return cleanup
  })
  const setTimeout = jest.fn(() => ({ timer: true }))
  const clearTimeout = jest.fn()
  const lifecycle: LearningLifecyclePorts = {
    clock: {
      now: () => new Date('2026-07-12T12:00:00.000Z'),
      setTimeout,
      clearTimeout,
    },
    focus: { subscribeFocus: subscribeLifecycle },
    visibility: { subscribeVisible: subscribeLifecycle },
  }
  let projects = initialProjects
  const projectSource = {
    getLearningBaseDir: jest.fn(() => 'Learning'),
    scanProjects: jest.fn(async () => ({ projects })),
  }

  return {
    vault,
    vaultDisposers,
    srsStore,
    isProjectPaused,
    lifecycle,
    cleanups,
    setTimeout,
    clearTimeout,
    projectSource,
    setProjects: (next: Project[]) => {
      projects = next
    },
    emitMutation: (projectSlug: string) =>
      mutationSubscriber?.({ projectSlug }),
  }
}

describe('LearningStatsService', () => {
  it('loads projects concurrently and retains per-project failures and pause state', async () => {
    const projects = [project('healthy'), project('broken')]
    const fixture = createFixture(projects)
    fixture.isProjectPaused.mockImplementation(
      async (slug) => slug === 'broken',
    )
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const service = new LearningStatsService({
      vault: fixture.vault,
      projects: fixture.projectSource,
      srsStore: fixture.srsStore,
      lifecycle: fixture.lifecycle,
      loadProjectStats: jest.fn(async ({ project: item }) => {
        if (item.slug === 'broken') throw new Error('broken project')
        return stats(4)
      }),
    })

    const result = await service.refreshAll()

    expect(getTotalDueCards(result)).toBe(4)
    expect(result.failedProjectIds).toEqual(new Set(['Learning/broken']))
    expect(result.pausedProjectIds).toEqual(new Set(['Learning/broken']))
    expect(result.loading).toBe(false)
    service.dispose()
    errorSpy.mockRestore()
  })

  it('refreshes only the project named by an SRS mutation', async () => {
    const fixture = createFixture([project('a'), project('b')])
    const due = new Map([
      ['a', 2],
      ['b', 3],
    ])
    const loadProjectStats = jest.fn(async ({ project: item }) =>
      stats(due.get(item.slug) ?? 0),
    )
    const service = new LearningStatsService({
      vault: fixture.vault,
      projects: fixture.projectSource,
      srsStore: fixture.srsStore,
      lifecycle: fixture.lifecycle,
      loadProjectStats,
    })
    await service.refreshAll()
    due.set('a', 0)
    const updated = new Promise<void>((resolve) => {
      const unsubscribe = service.subscribe((value) => {
        if (getTotalDueCards(value) !== 3) return
        unsubscribe()
        resolve()
      })
    })

    fixture.emitMutation('a')
    await updated

    expect(
      loadProjectStats.mock.calls.map(([input]) => input.project.slug),
    ).toEqual(['a', 'b', 'a'])
    service.dispose()
  })

  it('does not publish an old refresh after a root restart', async () => {
    const oldProject = project('old')
    const newProject = project('new')
    const fixture = createFixture([oldProject])
    const oldLoadStarted = deferred<undefined>()
    const oldLoad = deferred<LearningProjectStats>()
    const loadProjectStats = jest.fn(async ({ project: item }) => {
      if (item.slug === 'old') {
        oldLoadStarted.resolve(undefined)
        return oldLoad.promise
      }
      return stats(7)
    })
    const service = new LearningStatsService({
      vault: fixture.vault,
      projects: fixture.projectSource,
      srsStore: fixture.srsStore,
      lifecycle: fixture.lifecycle,
      loadProjectStats,
    })

    const stale = service.refreshAll()
    await oldLoadStarted.promise
    fixture.setProjects([newProject])
    const fresh = new Promise<void>((resolve) => {
      const unsubscribe = service.subscribe((value) => {
        if (value.projects[0]?.slug !== 'new') return
        unsubscribe()
        resolve()
      })
    })
    service.restart()
    await fresh
    oldLoad.resolve(stats(99))
    await stale

    expect(service.getSnapshot().projects.map(({ slug }) => slug)).toEqual([
      'new',
    ])
    expect(getTotalDueCards(service.getSnapshot())).toBe(7)
    service.dispose()
  })

  it('schedules the next active due boundary and cleans every subscription', async () => {
    const now = new Date('2026-07-12T12:00:00.000Z').getTime()
    const fixture = createFixture([project('due')])
    const service = new LearningStatsService({
      vault: fixture.vault,
      projects: fixture.projectSource,
      srsStore: fixture.srsStore,
      lifecycle: fixture.lifecycle,
      loadProjectStats: jest.fn(async () => stats(0, now + 5_000)),
    })

    await service.refreshAll()
    expect(fixture.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5_050)
    service.dispose()

    for (const cleanup of [...fixture.vaultDisposers, ...fixture.cleanups]) {
      expect(cleanup).toHaveBeenCalledTimes(1)
    }
    expect(fixture.clearTimeout).toHaveBeenCalled()
  })

  it('excludes paused project statistics from the global due total', () => {
    expect(
      getTotalDueCards({
        projects: [],
        byProject: new Map<string, LearningProjectStats>([
          ['active', stats(3)],
          ['paused', { ...stats(5), paused: true }],
        ]),
        pausedProjectIds: new Set(['paused']),
        failedProjectIds: new Set(),
        loading: false,
      }),
    ).toBe(3)
  })
})
