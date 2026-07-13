import type { App, EventRef } from 'obsidian'

import type { LearningProjectStats } from './learningStats'
import { LearningStatsService, getTotalDueCards } from './learningStatsService'
import type { LearningSrsStore, SrsProjectMutation } from './srs/srsStore'
import type { Project } from './types'

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

function stats(dueCards: number): LearningProjectStats {
  return {
    totalCards: dueCards,
    targetCards: 0,
    targetCardProgress: 0,
    estimatedRetention: 0,
    dueCards,
    lastStudiedAt: null,
    createdAt: 0,
    lastActiveAt: 0,
    nextDueAt: null,
    nextAction: null,
  }
}

function createFixture(projects: Project[]) {
  const refs = new Set<EventRef>()
  const app = {
    vault: {
      on: jest.fn((_name: string, _callback: unknown) => {
        const ref = {} as EventRef
        refs.add(ref)
        return ref
      }),
      offref: jest.fn((ref: EventRef) => refs.delete(ref)),
    },
  } as unknown as App
  let mutationSubscriber: ((mutation: SrsProjectMutation) => void) | null = null
  const srsStore = {
    subscribe: jest.fn((subscriber) => {
      mutationSubscriber = subscriber
      return () => {
        mutationSubscriber = null
      }
    }),
  } as unknown as LearningSrsStore
  const scan = jest.fn(async () => ({ projects }))

  return {
    app,
    scan,
    srsStore,
    emitMutation: (projectSlug: string) => {
      const subscriber = mutationSubscriber as
        | ((mutation: SrsProjectMutation) => void)
        | null
      subscriber?.({ projectSlug })
    },
  }
}

describe('LearningStatsService', () => {
  it('sums successful projects while retaining failed project ids', async () => {
    const projects = [project('healthy'), project('broken')]
    const fixture = createFixture(projects)
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const service = new LearningStatsService({
      app: fixture.app,
      getLearningBaseDir: () => 'Learning',
      srsStore: fixture.srsStore,
      scan: fixture.scan,
      loadProjectStats: jest.fn(async ({ project: item }) => {
        if (item.slug === 'broken') throw new Error('broken project')
        return stats(4)
      }),
    })

    const snapshot = await service.refreshAll()

    expect(getTotalDueCards(snapshot)).toBe(4)
    expect(snapshot.failedProjectIds).toEqual(new Set(['Learning/broken']))
    expect(snapshot.loading).toBe(false)
    service.dispose()
    errorSpy.mockRestore()
  })

  it('refreshes only the mutated SRS project', async () => {
    const projects = [project('a'), project('b')]
    const fixture = createFixture(projects)
    const dueBySlug = new Map([
      ['a', 2],
      ['b', 3],
    ])
    const loadProjectStats = jest.fn(
      async ({ project: item }: { project: Project }) =>
        stats(dueBySlug.get(item.slug) ?? 0),
    )
    const service = new LearningStatsService({
      app: fixture.app,
      getLearningBaseDir: () => 'Learning',
      srsStore: fixture.srsStore,
      scan: fixture.scan,
      loadProjectStats,
    })
    await service.refreshAll()
    dueBySlug.set('a', 0)
    const updated = new Promise<void>((resolve) => {
      const unsubscribe = service.subscribe((snapshot) => {
        if (getTotalDueCards(snapshot) !== 3) return
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

  it('does not publish an old refresh after the learning root restarts', async () => {
    let baseDir = 'Old'
    const oldProject = project('old')
    const newProject = project('new')
    const fixture = createFixture([oldProject])
    const oldLoadStarted = deferred<boolean>()
    const oldLoad = deferred<LearningProjectStats>()
    const service = new LearningStatsService({
      app: fixture.app,
      getLearningBaseDir: () => baseDir,
      srsStore: fixture.srsStore,
      scan: jest.fn(async (_app, dir) => ({
        projects: dir === 'Old' ? [oldProject] : [newProject],
      })),
      loadProjectStats: jest.fn(async ({ project: item }) => {
        if (item.slug === 'old') {
          oldLoadStarted.resolve(true)
          return oldLoad.promise
        }
        return stats(7)
      }),
    })

    const staleRefresh = service.refreshAll()
    await oldLoadStarted.promise
    baseDir = 'New'
    const freshSnapshot = new Promise<void>((resolve) => {
      const unsubscribe = service.subscribe((snapshot) => {
        if (snapshot.projects[0]?.slug !== 'new') return
        unsubscribe()
        resolve()
      })
    })
    service.restart()
    await freshSnapshot
    oldLoad.resolve(stats(99))
    await staleRefresh

    expect(service.getSnapshot().projects.map(({ slug }) => slug)).toEqual([
      'new',
    ])
    expect(getTotalDueCards(service.getSnapshot())).toBe(7)
    service.dispose()
  })
})
