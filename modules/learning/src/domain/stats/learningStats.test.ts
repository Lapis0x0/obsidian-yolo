import type {
  LearningVaultFile,
  LearningVaultReadApi,
} from '../learningVaultReadApi'
import type { SrsCardState, SrsProjectState } from '../srs/srsTypes'
import type { Project } from '../types'

import { loadLearningProjectStats } from './learningStats'
import type { LearningStatsCalculationSrsPort } from './ports'

const makeFile = (path: string, ctime: number, mtime: number) =>
  ({
    kind: 'file',
    path,
    name: path.split('/').at(-1) ?? '',
    ctime,
    mtime,
  }) satisfies LearningVaultFile

const cardState = (
  due: string,
  lastReview: string,
  stability: number,
): SrsCardState => ({
  due,
  stability,
  difficulty: 5,
  elapsedDays: 1,
  scheduledDays: 1,
  learningSteps: 0,
  reps: 1,
  lapses: 0,
  state: 2,
  lastReview,
  introducedAt: lastReview,
})

function createFixture(kind: Project['kind'] = 'outline') {
  const index = makeFile('Learning/test/index.md', 100, 200)
  const cards = makeFile('Learning/test/chapter/cards.md', 150, 300)
  const files = new Map([
    [index.path, index],
    [cards.path, cards],
  ])
  const contents = new Map([
    [
      cards.path,
      kind === 'cards'
        ? '## A <!--card:aaaaaaaa-->\n\nfront A\n\n---\n\nback A\n\n## B <!--card:bbbbbbbb-->\n\nfront B\n\n---\n\nback B'
        : '## A <!--card:aaaaaaaa kp:11111111-->\n\nfront A\n\n---\n\nback A\n\n## B <!--card:bbbbbbbb kp:22222222-->\n\nfront B\n\n---\n\nback B',
    ],
  ])
  const vault = {
    getEntry: (path: string) => files.get(path) ?? null,
    listChildren: () => [],
    listMarkdownFiles: () => [...files.values()],
    exists: async (path: string) => files.has(path),
    readText: async (path: string) => contents.get(path) ?? '',
    readBinary: async () => new ArrayBuffer(0),
    onCreate: () => () => undefined,
    onModify: () => () => undefined,
    onDelete: () => () => undefined,
    onRename: () => () => undefined,
  } satisfies LearningVaultReadApi
  const project: Project =
    kind === 'cards'
      ? {
          kind,
          id: 'Learning/test',
          slug: 'test',
          topic: 'Test',
          goal: 'Test',
          status: 'studying',
          folderPath: 'Learning/test',
          indexFilePath: index.path,
          chapters: [
            {
              id: 'Learning/test/chapter',
              projectId: 'Learning/test',
              slug: 'chapter',
              title: 'Chapter',
              folderPath: 'Learning/test/chapter',
              cardsFilePath: cards.path,
            },
          ],
          knowledgePoints: [],
        }
      : {
          kind,
          id: 'Learning/test',
          slug: 'test',
          topic: 'Test',
          goal: 'Test',
          status: 'studying',
          folderPath: 'Learning/test',
          indexFilePath: index.path,
          chapters: [
            {
              id: 'Learning/test/chapter',
              projectId: 'Learning/test',
              slug: 'chapter',
              title: 'Chapter',
              folderPath: 'Learning/test/chapter',
              knowledgePointIds: ['point-a', 'point-b'],
            },
          ],
          knowledgePoints: [
            {
              id: 'point-a',
              uuid: '11111111',
              projectId: 'Learning/test',
              chapterId: 'Learning/test/chapter',
              title: 'A',
              knowledgeFilePath: 'Learning/test/chapter/knowledge.md',
              relations: [],
              hasCards: true,
              hasExercises: false,
              mtime: 300,
            },
            {
              id: 'point-b',
              uuid: '22222222',
              projectId: 'Learning/test',
              chapterId: 'Learning/test/chapter',
              title: 'B',
              knowledgeFilePath: 'Learning/test/chapter/knowledge.md',
              relations: [],
              hasCards: true,
              hasExercises: false,
              mtime: 300,
            },
          ],
        }
  return { vault, project, cards, contents, files }
}

const createSrs = (
  state: SrsProjectState,
): LearningStatsCalculationSrsPort => ({
  getEffectiveProjectState: jest.fn(async () => state),
  getCardRetrievability: jest.fn((card) => card.stability),
})

describe('loadLearningProjectStats', () => {
  it('calculates due, retention, activity, and the next review action', async () => {
    const { vault, project } = createFixture()
    const result = await loadLearningProjectStats({
      vault,
      project,
      srsStore: createSrs({
        version: 3,
        cards: {
          aaaaaaaa: cardState(
            '2026-07-11T12:00:00.000Z',
            '2026-07-10T12:00:00.000Z',
            0.95,
          ),
          bbbbbbbb: cardState(
            '2026-07-15T12:00:00.000Z',
            '2026-07-10T12:00:00.000Z',
            0.45,
          ),
        },
        suspended: [],
        pausedAt: null,
        lastStudiedAt: '2026-07-12T11:00:00.000Z',
      }),
      now: new Date('2026-07-12T12:00:00.000Z'),
    })

    expect(result).toEqual({
      paused: false,
      totalCards: 2,
      targetCards: 1,
      targetCardProgress: 50,
      estimatedRetention: 70,
      dueCards: 1,
      lastStudiedAt: new Date('2026-07-12T11:00:00.000Z').getTime(),
      createdAt: 100,
      lastActiveAt: new Date('2026-07-12T11:00:00.000Z').getTime(),
      nextDueAt: new Date('2026-07-15T12:00:00.000Z').getTime(),
      nextAction: {
        kind: 'review',
        knowledgePointTitle: 'A',
        started: true,
      },
    })
  })

  it('recommends the first point with unintroduced cards', async () => {
    const { vault, project } = createFixture()
    const result = await loadLearningProjectStats({
      vault,
      project,
      srsStore: createSrs({
        version: 3,
        cards: {
          aaaaaaaa: cardState(
            '2026-07-15T12:00:00.000Z',
            '2026-07-10T12:00:00.000Z',
            0.95,
          ),
        },
        suspended: [],
        pausedAt: null,
        lastStudiedAt: null,
      }),
      now: new Date('2026-07-12T12:00:00.000Z'),
    })

    expect(result.nextAction).toEqual({
      kind: 'learn',
      knowledgePointTitle: 'B',
      started: false,
    })
  })

  it('supports chapter-direct projects and excludes suspended cards', async () => {
    const { vault, project } = createFixture('cards')
    const result = await loadLearningProjectStats({
      vault,
      project,
      srsStore: createSrs({
        version: 3,
        cards: {},
        suspended: ['bbbbbbbb'],
        pausedAt: null,
        lastStudiedAt: null,
      }),
      now: new Date('2026-07-12T12:00:00.000Z'),
    })

    expect(result.totalCards).toBe(1)
    expect(result.nextAction).toEqual({
      kind: 'learn',
      knowledgePointTitle: 'Chapter',
      started: false,
    })
  })

  it('rejects duplicate UUIDs and invalid undeclared cards files', async () => {
    const { vault, project, cards, contents, files } = createFixture()
    contents.set(
      cards.path,
      '## A <!--card:aaaaaaaa kp:11111111-->\n\nfront\n\n---\n\nback\n\n## A <!--card:aaaaaaaa kp:11111111-->\n\nfront\n\n---\n\nback',
    )
    await expect(
      loadLearningProjectStats({
        vault,
        project,
        srsStore: createSrs({
          version: 3,
          cards: {},
          suspended: [],
          pausedAt: null,
          lastStudiedAt: null,
        }),
        now: new Date(),
      }),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'card UUID 重复：aaaaaaaa' }),
      ]),
    })

    contents.set(cards.path, '')
    const orphan = makeFile('Learning/test/orphan/cards.md', 1, 1)
    files.set(orphan.path, orphan)
    contents.set(
      orphan.path,
      '## Invalid <!--card:not-a-uuid kp:11111111-->\n\nfront\n\n---\n\nback',
    )
    await expect(
      loadLearningProjectStats({
        vault,
        project,
        srsStore: createSrs({
          version: 3,
          cards: {},
          suspended: [],
          pausedAt: null,
          lastStudiedAt: null,
        }),
        now: new Date(),
      }),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ path: orphan.path }),
      ]),
    })
  })

  it('freezes paused due times and preserves real study time', async () => {
    const { vault, project } = createFixture()
    const pausedAt = new Date('2026-07-12T12:00:00.000Z')
    const baseState: SrsProjectState = {
      version: 3,
      cards: {
        aaaaaaaa: cardState(
          '2026-07-15T12:00:00.000Z',
          '2026-07-10T12:00:00.000Z',
          0.95,
        ),
      },
      suspended: [],
      pausedAt: pausedAt.toISOString(),
      lastStudiedAt: '2026-07-10T12:00:00.000Z',
    }
    const srsStore: LearningStatsCalculationSrsPort = {
      getEffectiveProjectState: jest.fn(async (_slug, at) => {
        const shift = at.getTime() - pausedAt.getTime()
        return {
          ...baseState,
          cards: {
            aaaaaaaa: {
              ...baseState.cards.aaaaaaaa,
              due: new Date(
                new Date(baseState.cards.aaaaaaaa.due).getTime() + shift,
              ).toISOString(),
            },
          },
        }
      }),
      getCardRetrievability: () => 0.95,
    }
    const first = await loadLearningProjectStats({
      vault,
      project,
      srsStore,
      now: pausedAt,
    })
    const later = await loadLearningProjectStats({
      vault,
      project,
      srsStore,
      now: new Date('2026-08-12T12:00:00.000Z'),
    })

    expect(first.nextDueAt).toBe(later.nextDueAt)
    expect(later.paused).toBe(true)
    expect(later.lastStudiedAt).toBe(
      new Date('2026-07-10T12:00:00.000Z').getTime(),
    )
  })
})
