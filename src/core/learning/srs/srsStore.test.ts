import type { App } from 'obsidian'

import { ObsidianLearningSrsStorage } from './obsidianLearningSrsStorage'
import { LearningSrsStore } from './srsStore'

function createApp(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles))
  const directories = new Set<string>()
  const adapter = {
    exists: jest.fn(async (path: string) =>
      Promise.resolve(files.has(path) || directories.has(path)),
    ),
    mkdir: jest.fn(async (path: string) => {
      directories.add(path)
    }),
    read: jest.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`Missing file: ${path}`)
      return content
    }),
    write: jest.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
  const app = { vault: { adapter } } as unknown as App
  return { app, adapter, files }
}

const createStore = (app: App): LearningSrsStore =>
  new LearningSrsStore(new ObsidianLearningSrsStorage(app, () => null))

describe('LearningSrsStore', () => {
  it('stores project state under the configured YOLO root', async () => {
    const { app, files } = createApp()
    const store = new LearningSrsStore(
      new ObsidianLearningSrsStorage(app, () => ({
        yolo: { baseDir: 'Config/YOLO' },
      })),
    )

    await store.reviewCard(
      'project',
      'aaaaaaaa',
      'good',
      new Date('2026-07-10T12:00:00.000Z'),
    )

    expect(
      files.has('Config/YOLO/.yolo_json_db/learning-srs/project.json'),
    ).toBe(true)
    expect(files.has('YOLO/.yolo_json_db/learning-srs/project.json')).toBe(
      false,
    )
  })

  it('invalidates cached project state when the configured root changes', async () => {
    const { app, files } = createApp()
    let baseDir = 'Config/First'
    const store = new LearningSrsStore(
      new ObsidianLearningSrsStorage(app, () => ({ yolo: { baseDir } })),
    )
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt)

    baseDir = 'Config/Second'
    await expect(store.getProjectState('project')).resolves.toEqual({
      version: 3,
      cards: {},
      suspended: [],
      pausedAt: null,
      lastStudiedAt: null,
    })
    await store.reviewCard('project', 'bbbbbbbb', 'good', reviewedAt)

    expect(
      JSON.parse(
        files.get('Config/Second/.yolo_json_db/learning-srs/project.json') ??
          '',
      ).cards,
    ).toEqual(expect.objectContaining({ bbbbbbbb: expect.any(Object) }))
    expect(
      JSON.parse(
        files.get('Config/First/.yolo_json_db/learning-srs/project.json') ?? '',
      ).cards,
    ).toEqual(expect.objectContaining({ aaaaaaaa: expect.any(Object) }))
  })

  it('serializes concurrent reviews without losing card state', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')

    await Promise.all([
      store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt),
      store.reviewCard('project', 'bbbbbbbb', 'hard', reviewedAt),
    ])

    const state = await store.getProjectState('project')
    expect(Object.keys(state.cards).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(state.cards.aaaaaaaa.introducedAt).toBe(reviewedAt.toISOString())
    expect(state.cards.bbbbbbbb.introducedAt).toBe(reviewedAt.toISOString())
    expect(state.lastStudiedAt).toBe(reviewedAt.toISOString())
  })

  it('reviews multiple cards in one project write', async () => {
    const { app, adapter } = createApp()
    const store = createStore(app)
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')

    await store.reviewCards(
      'project',
      ['aaaaaaaa', 'bbbbbbbb'],
      'easy',
      reviewedAt,
    )

    const state = await store.getProjectState('project')
    expect(Object.keys(state.cards).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(state.cards.aaaaaaaa.introducedAt).toBe(reviewedAt.toISOString())
    expect(state.cards.bbbbbbbb.introducedAt).toBe(reviewedAt.toISOString())
    expect(state.lastStudiedAt).toBe(reviewedAt.toISOString())
    expect(adapter.write).toHaveBeenCalledTimes(1)
  })

  it('does not expose a failed write through the cache', async () => {
    const { app, adapter } = createApp()
    const store = createStore(app)
    adapter.write.mockRejectedValueOnce(new Error('write failed'))

    await expect(
      store.reviewCard(
        'project',
        'aaaaaaaa',
        'good',
        new Date('2026-07-10T12:00:00.000Z'),
      ),
    ).rejects.toThrow('write failed')

    await expect(store.getProjectState('project')).resolves.toEqual({
      version: 3,
      cards: {},
      suspended: [],
      pausedAt: null,
      lastStudiedAt: null,
    })
  })

  it('notifies subscribers once after each successful project mutation', async () => {
    const { app, adapter } = createApp()
    const store = createStore(app)
    const subscriber = jest.fn()
    const unsubscribe = store.subscribe(subscriber)
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')

    await store.reviewCards(
      'project',
      ['aaaaaaaa', 'bbbbbbbb'],
      'good',
      reviewedAt,
    )
    await store.suspendCards('project', ['aaaaaaaa'])
    await store.suspendCards('project', ['aaaaaaaa'])
    adapter.write.mockRejectedValueOnce(new Error('write failed'))
    await expect(
      store.reviewCard('project', 'bbbbbbbb', 'easy', reviewedAt),
    ).rejects.toThrow('write failed')

    expect(subscriber).toHaveBeenCalledTimes(2)
    expect(subscriber).toHaveBeenNthCalledWith(1, { projectSlug: 'project' })
    expect(subscriber).toHaveBeenNthCalledWith(2, { projectSlug: 'project' })

    unsubscribe()
    await store.resumeCards('project', ['aaaaaaaa'])
    expect(subscriber).toHaveBeenCalledTimes(2)
  })

  it('preserves learning steps across store reloads', async () => {
    const { app } = createApp()
    const firstStore = createStore(app)
    const introducedAt = new Date('2026-07-10T12:00:00.000Z')
    const firstReview = await firstStore.reviewCard(
      'project',
      'aaaaaaaa',
      'good',
      introducedAt,
    )
    expect(firstReview.card.state).toBe(1)
    expect(firstReview.card.learningSteps).toBe(1)

    const reloadedStore = createStore(app)
    const secondReview = await reloadedStore.reviewCard(
      'project',
      'aaaaaaaa',
      'good',
      new Date(firstReview.card.due),
    )
    expect(secondReview.card.state).toBe(2)
    expect(secondReview.card.learningSteps).toBe(0)
  })

  it.each([
    ['damaged JSON', '{'],
    ['unsupported version', JSON.stringify({ version: 4, cards: {} })],
  ])('rejects %s without overwriting the file', async (_, content) => {
    const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const { app, adapter, files } = createApp({ [path]: content })
    const store = createStore(app)

    await expect(store.getProjectState('project')).rejects.toThrow()
    expect(adapter.write).not.toHaveBeenCalled()
    expect(files.get(path)).toBe(content)
  })

  it('counts introductions by local calendar day', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const now = new Date(2026, 6, 10, 23, 30)
    await store.reviewCard('project', 'aaaaaaaa', 'good', now)

    await expect(store.getTodayIntroducedCount('project', now)).resolves.toBe(1)
    await expect(
      store.getTodayIntroducedCount('project', new Date(2026, 6, 11, 0, 30)),
    ).resolves.toBe(0)
  })

  it('deduplicates concurrent initial project loads', async () => {
    const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const { app, adapter } = createApp({
      [path]: JSON.stringify({ version: 1, cards: {} }),
    })
    const store = createStore(app)

    await Promise.all([
      store.getProjectState('project'),
      store.getTodayIntroducedCount(
        'project',
        new Date('2026-07-10T12:00:00.000Z'),
      ),
    ])

    expect(adapter.read).toHaveBeenCalledTimes(1)
  })

  it('rejects memory states that ts-fsrs cannot schedule', async () => {
    const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const { app } = createApp({
      [path]: JSON.stringify({
        version: 1,
        cards: {
          aaaaaaaa: {
            due: '2026-07-11T12:00:00.000Z',
            stability: 0,
            difficulty: 11,
            elapsedDays: 1,
            scheduledDays: 1,
            learningSteps: 0,
            reps: 1,
            lapses: 0,
            state: 2,
            lastReview: '2026-07-10T12:00:00.000Z',
            introducedAt: '2026-07-10T12:00:00.000Z',
          },
        },
      }),
    })
    const store = createStore(app)

    await expect(store.getProjectState('project')).rejects.toThrow(
      'SRS 记忆状态无效',
    )
  })

  it('accepts review cards with remaining long learning steps', async () => {
    const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const state = {
      version: 1,
      cards: {
        aaaaaaaa: {
          due: '2026-07-11T12:00:00.000Z',
          stability: 1,
          difficulty: 5,
          elapsedDays: 1,
          scheduledDays: 1,
          learningSteps: 1,
          reps: 1,
          lapses: 0,
          state: 2,
          lastReview: '2026-07-10T12:00:00.000Z',
          introducedAt: '2026-07-10T12:00:00.000Z',
        },
      },
    }
    const { app } = createApp({ [path]: JSON.stringify(state) })
    const store = createStore(app)

    await expect(store.getProjectState('project')).resolves.toEqual({
      ...state,
      version: 3,
      suspended: [],
      pausedAt: null,
      lastStudiedAt: '2026-07-10T12:00:00.000Z',
    })
  })

  it('removes cards and skips writes when nothing changes', async () => {
    const { app, adapter } = createApp()
    const store = createStore(app)
    const now = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', now)
    await store.reviewCard('project', 'bbbbbbbb', 'good', now)
    adapter.write.mockClear()

    await store.removeCards('project', ['aaaaaaaa', 'cccccccc'])
    expect(Object.keys((await store.getProjectState('project')).cards)).toEqual(
      ['bbbbbbbb'],
    )
    expect(adapter.write).toHaveBeenCalledTimes(1)

    await store.removeCards('project', ['aaaaaaaa'])
    expect(adapter.write).toHaveBeenCalledTimes(1)
  })

  it('prunes orphaned cards without exposing failed writes in cache', async () => {
    const { app, adapter } = createApp()
    const store = createStore(app)
    const now = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', now)
    await store.reviewCard('project', 'bbbbbbbb', 'good', now)
    adapter.write.mockRejectedValueOnce(new Error('prune failed'))

    await expect(
      store.pruneOrphanedCards('project', new Set(['aaaaaaaa'])),
    ).rejects.toThrow('prune failed')
    expect(
      Object.keys((await store.getProjectState('project')).cards).sort(),
    ).toEqual(['aaaaaaaa', 'bbbbbbbb'])

    adapter.write.mockClear()
    await store.pruneOrphanedCards('project', new Set(['aaaaaaaa', 'bbbbbbbb']))
    expect(adapter.write).not.toHaveBeenCalled()
  })

  it('migrates v1 deterministically and caches only after persistence succeeds', async () => {
    const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const { app, adapter, files } = createApp({
      [path]: JSON.stringify({ version: 1, cards: {} }),
    })
    const store = createStore(app)

    await expect(store.getProjectState('project')).resolves.toEqual({
      version: 3,
      cards: {},
      suspended: [],
      pausedAt: null,
      lastStudiedAt: null,
    })
    expect(JSON.parse(files.get(path)!)).toEqual({
      version: 3,
      cards: {},
      suspended: [],
      pausedAt: null,
      lastStudiedAt: null,
    })
    expect(adapter.write).toHaveBeenCalledTimes(1)

    const failed = createApp({
      [path]: JSON.stringify({ version: 1, cards: {} }),
    })
    failed.adapter.write.mockRejectedValueOnce(new Error('migration failed'))
    const failedStore = createStore(failed.app)
    await expect(failedStore.getProjectState('project')).rejects.toThrow(
      'migration failed',
    )
    await expect(failedStore.getProjectState('project')).resolves.toEqual({
      version: 3,
      cards: {},
      suspended: [],
      pausedAt: null,
      lastStudiedAt: null,
    })
    expect(failed.adapter.read).toHaveBeenCalledTimes(2)
  })

  it('suspends new and learned cards, resumes without changing due, and filters queues', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const now = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', now)
    const due = (await store.getProjectState('project')).cards.aaaaaaaa.due

    await store.suspendCards('project', ['aaaaaaaa', 'bbbbbbbb', 'bbbbbbbb'])
    expect(await store.getSuspendedCardUuids('project')).toEqual(
      new Set(['aaaaaaaa', 'bbbbbbbb']),
    )
    await expect(store.isCardSuspended('project', 'bbbbbbbb')).resolves.toBe(
      true,
    )
    await expect(
      store.getDueCardUuids('project', new Date('2030-01-01T00:00:00.000Z')),
    ).resolves.toEqual(new Set())
    await expect(store.getTodayIntroducedCount('project', now)).resolves.toBe(0)

    await store.resumeCards('project', ['aaaaaaaa'])
    expect((await store.getProjectState('project')).cards.aaaaaaaa.due).toBe(
      due,
    )
    await expect(
      store.getDueCardUuids('project', new Date('2030-01-01T00:00:00.000Z')),
    ).resolves.toEqual(new Set(['aaaaaaaa']))
  })

  it('rejects scheduling and single or batch reviews for suspended cards', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const now = new Date('2026-07-10T12:00:00.000Z')
    await store.suspendCards('project', ['aaaaaaaa'])

    await expect(
      store.reviewCard('project', 'aaaaaaaa', 'good', now),
    ).rejects.toThrow('暂停卡片不能评分或计算排程：aaaaaaaa')
    await expect(
      store.reviewCards('project', ['bbbbbbbb', 'aaaaaaaa'], 'good', now),
    ).rejects.toThrow('暂停卡片不能评分或计算排程：aaaaaaaa')
    await expect(
      store.getCardScheduling('project', 'aaaaaaaa', now),
    ).rejects.toThrow('暂停卡片不能评分或计算排程：aaaaaaaa')
    expect((await store.getProjectState('project')).cards).toEqual({})
  })

  it('removes and prunes suspended UUIDs even when they have no card state', async () => {
    const { app } = createApp()
    const store = createStore(app)
    await store.suspendCards('project', ['aaaaaaaa', 'bbbbbbbb'])

    await store.removeCards('project', ['aaaaaaaa'])
    await expect(store.getSuspendedCardUuids('project')).resolves.toEqual(
      new Set(['bbbbbbbb']),
    )
    await store.pruneOrphanedCards('project', new Set())
    await expect(store.getSuspendedCardUuids('project')).resolves.toEqual(
      new Set(),
    )
  })

  it('fully validates v2 suspended data and deduplicates persisted UUIDs', async () => {
    const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const valid = createApp({
      [path]: JSON.stringify({
        version: 2,
        cards: {},
        suspended: ['bbbbbbbb', 'aaaaaaaa', 'aaaaaaaa'],
      }),
    })
    await expect(
      createStore(valid.app).getProjectState('project'),
    ).resolves.toEqual({
      version: 3,
      cards: {},
      suspended: ['aaaaaaaa', 'bbbbbbbb'],
      pausedAt: null,
      lastStudiedAt: null,
    })

    for (const [suspended, message] of [
      [undefined, 'SRS 暂停卡片'],
      [['invalid'], 'SRS 卡片 UUID 无效'],
      [[123], 'SRS 暂停卡片'],
    ] as const) {
      const invalid = createApp({
        [path]: JSON.stringify({ version: 2, cards: {}, suspended }),
      })
      await expect(
        createStore(invalid.app).getProjectState('project'),
      ).rejects.toThrow(message)
    }
  })

  it.each([1, 2] as const)(
    'migrates v%s and derives the latest studied time from card reviews',
    async (version) => {
      const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
      const cards = {
        aaaaaaaa: {
          due: '2026-07-14T12:00:00.000Z',
          stability: 1,
          difficulty: 5,
          elapsedDays: 1,
          scheduledDays: 1,
          learningSteps: 0,
          reps: 1,
          lapses: 0,
          state: 2,
          lastReview: '2026-07-10T12:00:00.000Z',
          introducedAt: '2026-07-10T12:00:00.000Z',
        },
        bbbbbbbb: {
          due: '2026-07-15T12:00:00.000Z',
          stability: 1,
          difficulty: 5,
          elapsedDays: 1,
          scheduledDays: 1,
          learningSteps: 0,
          reps: 1,
          lapses: 0,
          state: 2,
          lastReview: '2026-07-12T12:00:00.000Z',
          introducedAt: '2026-07-11T12:00:00.000Z',
        },
      }
      const source = {
        version,
        cards,
        ...(version === 2 ? { suspended: ['aaaaaaaa'] } : {}),
      }
      const { app, files } = createApp({ [path]: JSON.stringify(source) })

      await expect(
        createStore(app).getProjectState('project'),
      ).resolves.toEqual({
        version: 3,
        cards,
        suspended: version === 2 ? ['aaaaaaaa'] : [],
        pausedAt: null,
        lastStudiedAt: '2026-07-12T12:00:00.000Z',
      })
      expect(JSON.parse(files.get(path)!)).toEqual(
        expect.objectContaining({
          version: 3,
          pausedAt: null,
          lastStudiedAt: '2026-07-12T12:00:00.000Z',
        }),
      )
    },
  )

  it('strictly validates v3 project timestamps', async () => {
    const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
    for (const state of [
      { version: 3, cards: {}, suspended: [], lastStudiedAt: null },
      { version: 3, cards: {}, suspended: [], pausedAt: null },
      {
        version: 3,
        cards: {},
        suspended: [],
        pausedAt: '2026-07-10',
        lastStudiedAt: null,
      },
      {
        version: 3,
        cards: {},
        suspended: [],
        pausedAt: null,
        lastStudiedAt: 123,
      },
    ]) {
      const { app, adapter } = createApp({ [path]: JSON.stringify(state) })
      await expect(createStore(app).getProjectState('project')).rejects.toThrow(
        'SRS 日期字段',
      )
      expect(adapter.write).not.toHaveBeenCalled()
    }
  })

  it('freezes effective scheduling and shifts every card timestamp on resume', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt)
    const before = await store.getProjectState('project')
    const beforeCard = before.cards.aaaaaaaa

    await store.pauseProject('project', new Date('2026-07-10T13:00:00.000Z'))
    const effective = await store.getEffectiveProjectState(
      'project',
      new Date('2026-07-10T15:00:00.000Z'),
    )
    expect(effective.cards.aaaaaaaa).toEqual({
      ...beforeCard,
      due: new Date(
        new Date(beforeCard.due).getTime() + 2 * 60 * 60 * 1000,
      ).toISOString(),
      lastReview: '2026-07-10T14:00:00.000Z',
      introducedAt: '2026-07-10T14:00:00.000Z',
    })
    expect((await store.getProjectState('project')).cards.aaaaaaaa).toEqual(
      beforeCard,
    )

    await store.resumeProject('project', new Date('2026-07-10T16:00:00.000Z'))
    const resumed = await store.getProjectState('project')
    expect(resumed.pausedAt).toBeNull()
    expect(resumed.lastStudiedAt).toBe(reviewedAt.toISOString())
    expect(resumed.cards.aaaaaaaa).toEqual({
      ...beforeCard,
      due: new Date(
        new Date(beforeCard.due).getTime() + 3 * 60 * 60 * 1000,
      ).toISOString(),
      lastReview: '2026-07-10T15:00:00.000Z',
      introducedAt: '2026-07-10T15:00:00.000Z',
    })
  })

  it('makes repeated pause and resume calls idempotent', async () => {
    const { app, adapter } = createApp()
    const store = createStore(app)
    await store.pauseProject('project', new Date('2026-07-10T12:00:00.000Z'))
    await store.pauseProject('project', new Date('2026-07-11T12:00:00.000Z'))
    expect((await store.getProjectState('project')).pausedAt).toBe(
      '2026-07-10T12:00:00.000Z',
    )
    expect(adapter.write).toHaveBeenCalledTimes(1)

    await store.resumeProject('project', new Date('2026-07-12T12:00:00.000Z'))
    await store.resumeProject('project', new Date('2026-07-13T12:00:00.000Z'))
    expect(await store.isProjectPaused('project')).toBe(false)
    expect(adapter.write).toHaveBeenCalledTimes(2)
  })

  it('clamps a resume before the pause time to zero shift', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt)
    const before = (await store.getProjectState('project')).cards.aaaaaaaa
    await store.pauseProject('project', new Date('2026-07-12T12:00:00.000Z'))
    await store.resumeProject('project', new Date('2026-07-11T12:00:00.000Z'))

    const resumed = await store.getProjectState('project')
    expect(resumed.pausedAt).toBeNull()
    expect(resumed.cards.aaaaaaaa).toEqual(before)
    expect(resumed.lastStudiedAt).toBe(reviewedAt.toISOString())
  })

  it('rejects project scheduling and reviews and removes paused projects from queues', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const now = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', now)
    await store.pauseProject('project', now)

    await expect(
      store.reviewCard('project', 'aaaaaaaa', 'good', now),
    ).rejects.toThrow('暂停项目不能评分或计算排程')
    await expect(
      store.reviewCards('project', ['aaaaaaaa'], 'good', now),
    ).rejects.toThrow('暂停项目不能评分或计算排程')
    await expect(
      store.getCardScheduling('project', 'aaaaaaaa', now),
    ).rejects.toThrow('暂停项目不能评分或计算排程')
    await expect(
      store.getDueCardUuids('project', new Date('2030-01-01T00:00:00.000Z')),
    ).resolves.toEqual(new Set())
    await expect(store.getTodayIntroducedCount('project', now)).resolves.toBe(0)
  })

  it('does not expose failed pause or resume writes through the cache', async () => {
    const { app, adapter } = createApp()
    const store = createStore(app)
    const pausedAt = new Date('2026-07-10T12:00:00.000Z')
    adapter.write.mockRejectedValueOnce(new Error('pause failed'))
    await expect(store.pauseProject('project', pausedAt)).rejects.toThrow(
      'pause failed',
    )
    await expect(store.isProjectPaused('project')).resolves.toBe(false)

    await store.reviewCard('project', 'aaaaaaaa', 'good', pausedAt)
    await store.pauseProject('project', pausedAt)
    const paused = await store.getProjectState('project')
    adapter.write.mockRejectedValueOnce(new Error('resume failed'))
    await expect(
      store.resumeProject('project', new Date('2026-07-11T12:00:00.000Z')),
    ).rejects.toThrow('resume failed')
    await expect(store.getProjectState('project')).resolves.toEqual(paused)
  })

  it('orders concurrent pause, resume, and review mutations through the write queue', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const pausedAt = new Date('2026-07-10T12:00:00.000Z')
    const pause = store.pauseProject('project', pausedAt)
    const blockedReview = store.reviewCard(
      'project',
      'aaaaaaaa',
      'good',
      pausedAt,
    )
    await pause
    await expect(blockedReview).rejects.toThrow('暂停项目')

    const resumedAt = new Date('2026-07-11T12:00:00.000Z')
    const reviewedAt = new Date('2026-07-11T13:00:00.000Z')
    const resume = store.resumeProject('project', resumedAt)
    const review = store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt)
    await Promise.all([resume, review])
    expect((await store.getProjectState('project')).lastStudiedAt).toBe(
      reviewedAt.toISOString(),
    )
  })

  it('keeps the latest real study time when reviews arrive out of order', async () => {
    const { app } = createApp()
    const store = createStore(app)
    const latest = new Date('2026-07-11T12:00:00.000Z')
    const earlier = new Date('2026-07-10T12:00:00.000Z')

    await store.reviewCard('project', 'aaaaaaaa', 'good', latest)
    await store.reviewCard('project', 'bbbbbbbb', 'good', earlier)

    expect((await store.getProjectState('project')).lastStudiedAt).toBe(
      latest.toISOString(),
    )
  })
})
