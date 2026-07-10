import type { App } from 'obsidian'

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

describe('LearningSrsStore', () => {
  it('serializes concurrent reviews without losing card state', async () => {
    const { app } = createApp()
    const store = new LearningSrsStore(app)
    const reviewedAt = new Date('2026-07-10T12:00:00.000Z')

    await Promise.all([
      store.reviewCard('project', 'aaaaaaaa', 'good', reviewedAt),
      store.reviewCard('project', 'bbbbbbbb', 'hard', reviewedAt),
    ])

    const state = await store.getProjectState('project')
    expect(Object.keys(state.cards).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(state.cards.aaaaaaaa.introducedAt).toBe(reviewedAt.toISOString())
    expect(state.cards.bbbbbbbb.introducedAt).toBe(reviewedAt.toISOString())
  })

  it('does not expose a failed write through the cache', async () => {
    const { app, adapter } = createApp()
    const store = new LearningSrsStore(app)
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
      version: 1,
      cards: {},
    })
  })

  it('preserves learning steps across store reloads', async () => {
    const { app } = createApp()
    const firstStore = new LearningSrsStore(app)
    const introducedAt = new Date('2026-07-10T12:00:00.000Z')
    const firstReview = await firstStore.reviewCard(
      'project',
      'aaaaaaaa',
      'good',
      introducedAt,
    )
    expect(firstReview.card.state).toBe(1)
    expect(firstReview.card.learningSteps).toBe(1)

    const reloadedStore = new LearningSrsStore(app)
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
    ['unsupported version', JSON.stringify({ version: 2, cards: {} })],
  ])('rejects %s without overwriting the file', async (_, content) => {
    const path = 'YOLO/.yolo_json_db/learning-srs/project.json'
    const { app, adapter, files } = createApp({ [path]: content })
    const store = new LearningSrsStore(app)

    await expect(store.getProjectState('project')).rejects.toThrow()
    expect(adapter.write).not.toHaveBeenCalled()
    expect(files.get(path)).toBe(content)
  })

  it('counts introductions by local calendar day', async () => {
    const { app } = createApp()
    const store = new LearningSrsStore(app)
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
    const store = new LearningSrsStore(app)

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
    const store = new LearningSrsStore(app)

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
    const store = new LearningSrsStore(app)

    await expect(store.getProjectState('project')).resolves.toEqual(state)
  })
})
