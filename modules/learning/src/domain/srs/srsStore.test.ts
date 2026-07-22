import type { SrsStorage, SrsStorageReadResult } from './srsStorage'
import { LearningSrsStore, replaySrsEvents } from './srsStore'
import type { SrsProjectState } from './srsTypes'

const EMPTY_STATE: SrsProjectState = {
  version: 3,
  cards: {},
  suspended: [],
  pausedAt: null,
  lastStudiedAt: null,
}

class MemorySrsStorage implements SrsStorage {
  readonly files = new Map<string, string>()
  locationKey = 'root-a'
  failNextWrite: Error | null = null

  readonly ensureRoot = jest.fn(async () => this.locationKey)
  readonly read = jest.fn(
    async (projectSlug: string): Promise<SrsStorageReadResult | null> => {
      const path = await this.ensure(projectSlug)
      const content = this.files.get(path)
      return content === undefined ? null : { path, content }
    },
  )
  readonly write = jest.fn(async (projectSlug: string, content: string) => {
    if (this.failNextWrite) {
      const error = this.failNextWrite
      this.failNextWrite = null
      throw error
    }
    const path = await this.ensure(projectSlug)
    this.files.set(path, content)
    return path
  })
  readonly writeProjectStateAtPath = jest.fn(
    async (_projectSlug: string, path: string, content: string) => {
      if (this.failNextWrite) {
        const error = this.failNextWrite
        this.failNextWrite = null
        throw error
      }
      this.files.set(path, content)
    },
  )
  readonly remove = jest.fn(async (projectSlug: string) =>
    this.files.delete(await this.ensure(projectSlug)),
  )
  readonly existsProjectStateAtPath = jest.fn(
    async (_projectSlug: string, path: string) => this.files.has(path),
  )
  readonly removeProjectStateAtPath = jest.fn(
    async (_projectSlug: string, path: string) => this.files.delete(path),
  )

  constructor(initialFiles: Record<string, string> = {}) {
    Object.entries(initialFiles).forEach(([path, content]) =>
      this.files.set(path, content),
    )
  }

  getLocationKey(): string {
    return this.locationKey
  }

  async ensure(projectSlug: string): Promise<string> {
    return `${this.locationKey}/learning-srs/${projectSlug}.json`
  }

  async exists(projectSlug: string): Promise<boolean> {
    return this.files.has(await this.ensure(projectSlug))
  }
}

const createStore = (storage = new MemorySrsStorage()) => ({
  storage,
  store: new LearningSrsStore(storage),
})

describe('LearningSrsStore module domain', () => {
  it('uses the project slug as storage identity for existence, paths, and deletion', async () => {
    const { storage, store } = createStore()
    storage.files.set('root-a/learning-srs/project-one.json', '{}')

    await expect(store.hasPersistedProjectState('project-one')).resolves.toBe(
      true,
    )
    await expect(store.hasPersistedProjectState('project-two')).resolves.toBe(
      false,
    )
    await expect(store.getProjectStateFilePath('project-one')).resolves.toBe(
      'root-a/learning-srs/project-one.json',
    )

    await store.deleteProjectState('project-one')
    expect(storage.remove).toHaveBeenCalledWith('project-one')
    expect(storage.files.has('root-a/learning-srs/project-one.json')).toBe(
      false,
    )
  })

  it('delegates explicit-path lifecycle operations without resolving the active root', async () => {
    const { storage, store } = createStore()
    const path = 'old-root/learning-srs/project.json'
    storage.files.set(path, JSON.stringify(EMPTY_STATE))

    await expect(
      store.hasPersistedProjectStateAtPath('project', path),
    ).resolves.toBe(true)
    await store.initializeProjectStateAtPath('project', path, EMPTY_STATE)
    expect(storage.writeProjectStateAtPath).toHaveBeenCalledWith(
      'project',
      path,
      JSON.stringify(EMPTY_STATE, null, 2),
    )
    await store.deletePersistedProjectStateAtPath('project', path)
    expect(storage.files.has(path)).toBe(false)
  })

  it('invalidates project caches when the storage location key changes', async () => {
    const { storage, store } = createStore()
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt)

    storage.locationKey = 'root-b'
    await expect(store.getProjectState('project')).resolves.toEqual(EMPTY_STATE)
    await store.reviewCard('project', 'bbbbbbbb', 'good', reviewedAt)

    expect(
      JSON.parse(storage.files.get('root-a/learning-srs/project.json') ?? '')
        .cards,
    ).toEqual(expect.objectContaining({ aaaaaaaa: expect.any(Object) }))
    expect(
      JSON.parse(storage.files.get('root-b/learning-srs/project.json') ?? '')
        .cards,
    ).toEqual(expect.objectContaining({ bbbbbbbb: expect.any(Object) }))
    expect(storage.ensureRoot).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent reviews and writes a batch atomically', async () => {
    const { storage, store } = createStore()
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')

    await Promise.all([
      store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt),
      store.reviewCard('project', 'bbbbbbbb', 'hard', reviewedAt),
    ])
    storage.write.mockClear()
    await store.reviewCards(
      'project',
      ['cccccccc', 'dddddddd'],
      'easy',
      reviewedAt,
    )

    const state = await store.getProjectState('project')
    expect(Object.keys(state.cards).sort()).toEqual([
      'aaaaaaaa',
      'bbbbbbbb',
      'cccccccc',
      'dddddddd',
    ])
    expect(storage.write).toHaveBeenCalledTimes(1)
    expect(state.lastStudiedAt).toBe(reviewedAt.toISOString())
  })

  it('does not publish failed writes into cache and keeps the queue usable', async () => {
    const { storage, store } = createStore()
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')
    storage.failNextWrite = new Error('write failed')

    await expect(
      store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt),
    ).rejects.toThrow('write failed')
    await expect(store.getProjectState('project')).resolves.toEqual(EMPTY_STATE)

    await store.reviewCard('project', 'bbbbbbbb', 'good', reviewedAt)
    expect(
      (await store.getProjectState('project')).cards.bbbbbbbb,
    ).toBeDefined()
  })

  it('emits once after successful mutations and isolates subscriber failures', async () => {
    const { store } = createStore()
    const throwing = jest.fn(() => {
      throw new Error('subscriber failed')
    })
    const subscriber = jest.fn()
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    const unsubscribeThrowing = store.subscribe(throwing)
    const unsubscribe = store.subscribe(subscriber)

    await store.suspendCards('project', ['aaaaaaaa'])
    await store.suspendCards('project', ['aaaaaaaa'])
    expect(subscriber).toHaveBeenCalledTimes(1)
    expect(subscriber).toHaveBeenCalledWith({ projectSlug: 'project' })
    expect(consoleError).toHaveBeenCalledTimes(1)

    unsubscribeThrowing()
    unsubscribe()
    await store.resumeCards('project', ['aaaaaaaa'])
    expect(subscriber).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('preserves FSRS scheduling fields across reloads', async () => {
    const storage = new MemorySrsStorage()
    const firstStore = new LearningSrsStore(storage)
    const introducedAt = new Date('2026-07-10T12:00:00.000Z')
    const first = await firstStore.reviewCard(
      'project',
      'aaaaaaaa',
      'good',
      introducedAt,
    )
    expect(first.card).toEqual(
      expect.objectContaining({ state: 1, learningSteps: 1 }),
    )

    const reloaded = new LearningSrsStore(storage)
    const second = await reloaded.reviewCard(
      'project',
      'aaaaaaaa',
      'good',
      new Date(first.card.due),
    )
    expect(second.card).toEqual(
      expect.objectContaining({ state: 2, learningSteps: 0 }),
    )
    const scheduling = await reloaded.getCardScheduling(
      'project',
      'aaaaaaaa',
      new Date(second.card.due),
    )
    expect(scheduling.good.due).toBeInstanceOf(Date)
    expect(reloaded.getCardRetrievability(second.card, new Date())).toEqual(
      expect.any(Number),
    )
  })

  it.each([
    ['damaged JSON', '{'],
    ['unsupported version', JSON.stringify({ version: 4, cards: {} })],
  ])('rejects %s without overwriting persisted content', async (_, content) => {
    const path = 'root-a/learning-srs/project.json'
    const { storage, store } = createStore(
      new MemorySrsStorage({ [path]: content }),
    )

    await expect(store.getProjectState('project')).rejects.toThrow()
    expect(storage.write).not.toHaveBeenCalled()
    expect(storage.files.get(path)).toBe(content)
  })

  it('deduplicates concurrent initial reads', async () => {
    const path = 'root-a/learning-srs/project.json'
    const { storage, store } = createStore(
      new MemorySrsStorage({
        [path]: JSON.stringify({ version: 1, cards: {} }),
      }),
    )

    await Promise.all([
      store.getProjectState('project'),
      store.getTodayIntroducedCount('project', new Date()),
    ])
    expect(storage.read).toHaveBeenCalledTimes(1)
  })

  it('migrates v1 and v2 to the unchanged v3 JSON schema', async () => {
    for (const source of [
      { version: 1, cards: {} },
      {
        version: 2,
        cards: {},
        suspended: ['bbbbbbbb', 'aaaaaaaa', 'aaaaaaaa'],
      },
    ]) {
      const path = 'root-a/learning-srs/project.json'
      const { storage, store } = createStore(
        new MemorySrsStorage({ [path]: JSON.stringify(source) }),
      )
      const expected = {
        ...EMPTY_STATE,
        suspended:
          source.version === 2 ? ['aaaaaaaa', 'bbbbbbbb'] : ([] as string[]),
      }

      await expect(store.getProjectState('project')).resolves.toEqual(expected)
      expect(JSON.parse(storage.files.get(path) ?? '')).toEqual(expected)
      expect(storage.write).toHaveBeenCalledTimes(1)
    }
  })

  it('derives lastStudiedAt during migration and retries after migration write failure', async () => {
    const path = 'root-a/learning-srs/project.json'
    const card = {
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
      introducedAt: '2026-07-09T12:00:00.000Z',
    }
    const storage = new MemorySrsStorage({
      [path]: JSON.stringify({ version: 1, cards: { aaaaaaaa: card } }),
    })
    storage.failNextWrite = new Error('migration failed')
    const store = new LearningSrsStore(storage)

    await expect(store.getProjectState('project')).rejects.toThrow(
      'migration failed',
    )
    await expect(store.getProjectState('project')).resolves.toEqual({
      ...EMPTY_STATE,
      cards: { aaaaaaaa: card },
      lastStudiedAt: card.lastReview,
    })
    expect(storage.read).toHaveBeenCalledTimes(2)
  })

  it('strictly validates migration and v3 project fields', async () => {
    const invalidStates = [
      { version: 2, cards: {}, suspended: undefined },
      { version: 2, cards: {}, suspended: ['invalid'] },
      { version: 3, cards: {}, suspended: [], lastStudiedAt: null },
      { version: 3, cards: {}, suspended: [], pausedAt: null },
      {
        version: 3,
        cards: {},
        suspended: [],
        pausedAt: '2026-07-10',
        lastStudiedAt: null,
      },
    ]

    for (const state of invalidStates) {
      const storage = new MemorySrsStorage({
        'root-a/learning-srs/project.json': JSON.stringify(state),
      })
      await expect(
        new LearningSrsStore(storage).getProjectState('project'),
      ).rejects.toThrow()
      expect(storage.write).not.toHaveBeenCalled()
    }
  })

  it('suspends, resumes, filters, removes, and prunes card identities', async () => {
    const { store } = createStore()
    const now = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCards('project', ['aaaaaaaa', 'bbbbbbbb'], 'good', now)
    const due = (await store.getProjectState('project')).cards.aaaaaaaa.due
    await store.suspendCards('project', ['aaaaaaaa', 'cccccccc', 'cccccccc'])

    await expect(store.getSuspendedCardUuids('project')).resolves.toEqual(
      new Set(['aaaaaaaa', 'cccccccc']),
    )
    await expect(store.isCardSuspended('project', 'aaaaaaaa')).resolves.toBe(
      true,
    )
    await expect(
      store.getDueCardUuids('project', new Date('2030-01-01')),
    ).resolves.toEqual(new Set(['bbbbbbbb']))
    await expect(store.getTodayIntroducedCount('project', now)).resolves.toBe(1)

    await store.resumeCards('project', ['aaaaaaaa'])
    expect((await store.getProjectState('project')).cards.aaaaaaaa.due).toBe(
      due,
    )
    await store.removeCards('project', ['aaaaaaaa', 'cccccccc'])
    await store.pruneOrphanedCards('project', new Set())
    await expect(store.getProjectState('project')).resolves.toEqual({
      ...EMPTY_STATE,
      lastStudiedAt: now.toISOString(),
    })
  })

  it('rejects reviews and scheduling for suspended cards', async () => {
    const { store } = createStore()
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
  })

  it('freezes effective scheduling and shifts every card timestamp on resume', async () => {
    const { store } = createStore()
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt)
    const before = (await store.getProjectState('project')).cards.aaaaaaaa

    await store.pauseProject('project', new Date('2026-07-10T13:00:00.000Z'))
    const effective = await store.getEffectiveProjectState(
      'project',
      new Date('2026-07-10T15:00:00.000Z'),
    )
    expect(effective.cards.aaaaaaaa).toEqual({
      ...before,
      due: new Date(
        new Date(before.due).getTime() + 2 * 60 * 60 * 1000,
      ).toISOString(),
      lastReview: '2026-07-10T14:00:00.000Z',
      introducedAt: '2026-07-10T14:00:00.000Z',
    })
    expect((await store.getProjectState('project')).cards.aaaaaaaa).toEqual(
      before,
    )

    await store.resumeProject('project', new Date('2026-07-10T16:00:00.000Z'))
    const resumed = await store.getProjectState('project')
    expect(resumed.pausedAt).toBeNull()
    expect(resumed.lastStudiedAt).toBe(reviewedAt.toISOString())
    expect(resumed.cards.aaaaaaaa.introducedAt).toBe('2026-07-10T15:00:00.000Z')
  })

  it('makes pause/resume idempotent and excludes paused projects from work', async () => {
    const { storage, store } = createStore()
    const now = new Date('2026-07-10T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', now)
    storage.write.mockClear()
    await store.pauseProject('project', now)
    await store.pauseProject('project', new Date('2026-07-11'))

    await expect(store.isProjectPaused('project')).resolves.toBe(true)
    await expect(
      store.getDueCardUuids('project', new Date('2030-01-01')),
    ).resolves.toEqual(new Set())
    await expect(store.getTodayIntroducedCount('project', now)).resolves.toBe(0)
    await expect(
      store.reviewCard('project', 'aaaaaaaa', 'good', now),
    ).rejects.toThrow('暂停项目不能评分或计算排程')

    await store.resumeProject('project', new Date('2026-07-11T12:00:00.000Z'))
    await store.resumeProject('project', new Date('2026-07-12'))
    expect(storage.write).toHaveBeenCalledTimes(2)
  })

  it('orders concurrent pause, resume, and review mutations', async () => {
    const { store } = createStore()
    const pausedAt = new Date('2026-07-10T12:00:00.000Z')
    const pause = store.pauseProject('project', pausedAt)
    const blocked = store.reviewCard('project', 'aaaaaaaa', 'good', pausedAt)
    await pause
    await expect(blocked).rejects.toThrow('暂停项目')

    const reviewedAt = new Date('2026-07-11T13:00:00.000Z')
    await Promise.all([
      store.resumeProject('project', new Date('2026-07-11T12:00:00.000Z')),
      store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt),
    ])
    expect((await store.getProjectState('project')).lastStudiedAt).toBe(
      reviewedAt.toISOString(),
    )
  })

  it('keeps the latest study timestamp when reviews arrive out of order', async () => {
    const { store } = createStore()
    const latest = new Date('2026-07-11T12:00:00.000Z')
    await store.reviewCard('project', 'aaaaaaaa', 'good', latest)
    await store.reviewCard(
      'project',
      'bbbbbbbb',
      'good',
      new Date('2026-07-10T12:00:00.000Z'),
    )
    expect((await store.getProjectState('project')).lastStudiedAt).toBe(
      latest.toISOString(),
    )
  })

  it('validates project slugs before crossing the storage port', async () => {
    const { storage, store } = createStore()
    for (const slug of ['', '.', '..', 'parent/project', 'parent\\project']) {
      await expect(store.getProjectState(slug)).rejects.toThrow(
        '无效的学习项目 slug',
      )
    }
    expect(storage.read).not.toHaveBeenCalled()
  })
})

describe('replaySrsEvents', () => {
  it('replays ratings chronologically without mutating the event list', () => {
    const introducedAt = new Date('2026-07-10T12:00:00.000Z')
    const events = [
      {
        reviewedAt: Date.parse('2026-07-11T12:00:00.000Z'),
        rating: 3 as const,
      },
      { reviewedAt: introducedAt.getTime(), rating: 3 as const },
    ]
    const original = [...events]

    const replayed = replaySrsEvents(events, introducedAt)
    const sortedReplay = replaySrsEvents([...events].reverse(), introducedAt)

    expect(replayed).toEqual(sortedReplay)
    expect(events).toEqual(original)
    expect(replayed).toEqual(
      expect.objectContaining({
        introducedAt: introducedAt.toISOString(),
        reps: 2,
        lastReview: '2026-07-11T12:00:00.000Z',
      }),
    )
  })
})
