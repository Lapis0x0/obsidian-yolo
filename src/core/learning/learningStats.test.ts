import { loadLearningProjectStats } from './learningStats'
import type {
  LearningVaultFile,
  LearningVaultReadApi,
} from './learningVaultReadApi'
import type { LearningSrsStore } from './srs/srsStore'
import type { SrsCardState } from './srs/srsTypes'
import type { Project } from './types'

const CARD_A =
  '## A <!--card:aaaaaaaa kp:11111111-->\n\nfront A\n\n---\n\nback A'
const CARD_B =
  '## B <!--card:bbbbbbbb kp:22222222-->\n\nfront B\n\n---\n\nback B'
const CARD_C =
  '## C <!--card:cccccccc kp:22222222-->\n\nfront C\n\n---\n\nback C'

const makeFile = (
  path: string,
  ctime: number,
  mtime: number,
): LearningVaultFile => ({
  kind: 'file',
  path,
  name: path.split('/').at(-1) ?? '',
  ctime,
  mtime,
})

function createFixture() {
  const index = makeFile('learning/test/index.md', 100, 200)
  const cards = makeFile('learning/test/chapter/cards.md', 150, 300)
  const files = new Map([
    [index.path, index],
    [cards.path, cards],
  ])
  const content = new Map([[cards.path, `${CARD_A}\n\n${CARD_B}\n\n${CARD_C}`]])
  const vault = {
    getEntry: (path: string) => files.get(path) ?? null,
    listChildren: () => [],
    listMarkdownFiles: () => [...files.values()],
    readText: jest.fn(async (path: string) => content.get(path) ?? ''),
    onCreate: () => () => undefined,
    onModify: () => () => undefined,
    onDelete: () => () => undefined,
    onRename: () => () => undefined,
  } satisfies LearningVaultReadApi
  const project: Project = {
    kind: 'outline',
    id: 'learning/test',
    slug: 'test',
    topic: 'Test',
    goal: 'Build reliable tests',
    status: 'studying',
    folderPath: 'learning/test',
    indexFilePath: index.path,
    chapters: [
      {
        id: 'learning/test/chapter',
        projectId: 'learning/test',
        slug: 'chapter',
        title: 'Chapter',
        folderPath: 'learning/test/chapter',
        knowledgePointIds: ['point-a', 'point-b'],
      },
    ],
    knowledgePoints: [
      {
        id: 'point-a',
        uuid: '11111111',
        projectId: 'learning/test',
        chapterId: 'learning/test/chapter',
        title: 'A',
        knowledgeFilePath: 'learning/test/chapter/knowledge.md',
        relations: [],
        hasCards: true,
        hasExercises: false,
        mtime: 300,
      },
      {
        id: 'point-b',
        uuid: '22222222',
        projectId: 'learning/test',
        chapterId: 'learning/test/chapter',
        title: 'B',
        knowledgeFilePath: 'learning/test/chapter/knowledge.md',
        relations: [],
        hasCards: true,
        hasExercises: false,
        mtime: 300,
      },
    ],
  }
  return { vault, project, cards, content, files }
}

function state(
  due: string,
  lastReview: string,
  stability: number,
): SrsCardState {
  return {
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
  }
}

describe('loadLearningProjectStats', () => {
  it('calculates real card, due, retention, and activity statistics', async () => {
    const { vault, project } = createFixture()
    const projectState = {
      version: 3,
      cards: {
        aaaaaaaa: state(
          '2026-07-11T12:00:00.000Z',
          '2026-07-10T12:00:00.000Z',
          0.9,
        ),
        bbbbbbbb: state(
          '2026-07-15T12:00:00.000Z',
          '2026-07-12T12:00:00.000Z',
          0.45,
        ),
        orphaned: state(
          '2026-07-11T12:00:00.000Z',
          '2026-07-12T13:00:00.000Z',
          1,
        ),
      },
      suspended: [],
      pausedAt: null,
      lastStudiedAt: '2026-07-12T11:00:00.000Z',
    }
    const srsStore = {
      getEffectiveProjectState: jest.fn(async () => projectState),
      getCardRetrievability: jest.fn((card: SrsCardState) => card.stability),
    } as unknown as LearningSrsStore

    const result = await loadLearningProjectStats({
      vault,
      project,
      srsStore,
      now: new Date('2026-07-12T12:00:00.000Z'),
    })

    expect(result).toEqual({
      paused: false,
      totalCards: 3,
      targetCards: 1,
      targetCardProgress: 33,
      estimatedRetention: 45,
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

  it('selects the first knowledge point with unintroduced cards when no review is due', async () => {
    const { vault, project } = createFixture()
    const srsStore = {
      getEffectiveProjectState: jest.fn(async () => ({
        version: 3,
        cards: {
          aaaaaaaa: state(
            '2026-07-15T12:00:00.000Z',
            '2026-07-10T12:00:00.000Z',
            0.9,
          ),
        },
        suspended: [],
        pausedAt: null,
        lastStudiedAt: '2026-07-10T12:00:00.000Z',
      })),
      getCardRetrievability: jest.fn((card: SrsCardState) => card.stability),
    } as unknown as LearningSrsStore

    const result = await loadLearningProjectStats({
      vault,
      project,
      srsStore,
      now: new Date('2026-07-12T12:00:00.000Z'),
    })

    expect(result.nextAction).toEqual({
      kind: 'learn',
      knowledgePointTitle: 'B',
      started: false,
    })
  })

  it('rejects duplicate card UUIDs across chapter files', async () => {
    const { vault, project, cards, content } = createFixture()
    content.set(cards.path, `${CARD_A}\n\n${CARD_A}`)
    const srsStore = {
      getEffectiveProjectState: jest.fn(async () => ({
        version: 3,
        cards: {},
        suspended: [],
        pausedAt: null,
        lastStudiedAt: null,
      })),
      getCardRetrievability: jest.fn(),
    } as unknown as LearningSrsStore

    await expect(
      loadLearningProjectStats({
        vault,
        project,
        srsStore,
        now: new Date('2026-07-12T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'card UUID 重复：aaaaaaaa' }),
      ]),
    })
  })

  it('validates cards files outside declared chapter folders', async () => {
    const { vault, project, content, files } = createFixture()
    const unexpected = makeFile('learning/test/orphan/cards.md', 150, 300)
    files.set(unexpected.path, unexpected)
    content.set(
      unexpected.path,
      '## Invalid <!--card:not-a-uuid kp:11111111-->\n\nfront\n\n---\n\nback',
    )
    const srsStore = {
      getEffectiveProjectState: jest.fn(async () => ({
        version: 3,
        cards: {},
        suspended: [],
        pausedAt: null,
        lastStudiedAt: null,
      })),
      getCardRetrievability: jest.fn(),
    } as unknown as LearningSrsStore

    await expect(
      loadLearningProjectStats({
        vault,
        project,
        srsStore,
        now: new Date('2026-07-12T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ path: unexpected.path }),
      ]),
    })
  })

  it('loads chapter-direct cards projects without knowledge points', async () => {
    const { vault, project, cards, content } = createFixture()
    content.set(
      cards.path,
      '## A <!--card:aaaaaaaa-->\n\nfront A\n\n---\n\nback A\n\n## B <!--card:bbbbbbbb-->\n\nfront B\n\n---\n\nback B',
    )
    const cardsProject: Project = {
      ...project,
      kind: 'cards',
      chapters: [
        {
          id: project.chapters[0].id,
          projectId: project.id,
          slug: project.chapters[0].slug,
          title: project.chapters[0].title,
          folderPath: project.chapters[0].folderPath,
          cardsFilePath: cards.path,
        },
      ],
      knowledgePoints: [],
    }
    const srsStore = {
      getEffectiveProjectState: jest.fn(async () => ({
        version: 3,
        cards: {},
        suspended: ['bbbbbbbb'],
        pausedAt: null,
        lastStudiedAt: null,
      })),
      getCardRetrievability: jest.fn(),
    } as unknown as LearningSrsStore

    const result = await loadLearningProjectStats({
      vault,
      project: cardsProject,
      srsStore,
      now: new Date('2026-07-12T12:00:00.000Z'),
    })

    expect(result.totalCards).toBe(1)
    expect(result.dueCards).toBe(0)
    expect(result.nextAction).toEqual({
      kind: 'learn',
      knowledgePointTitle: 'Chapter',
      started: false,
    })
  })

  it('excludes suspended outline cards from counts and recommendations', async () => {
    const { vault, project } = createFixture()
    const srsStore = {
      getEffectiveProjectState: jest.fn(async () => ({
        version: 3,
        cards: {
          aaaaaaaa: state(
            '2026-07-11T12:00:00.000Z',
            '2026-07-10T12:00:00.000Z',
            0.9,
          ),
        },
        suspended: ['aaaaaaaa', 'cccccccc'],
        pausedAt: null,
        lastStudiedAt: '2026-07-10T12:00:00.000Z',
      })),
      getCardRetrievability: jest.fn((card: SrsCardState) => card.stability),
    } as unknown as LearningSrsStore

    const result = await loadLearningProjectStats({
      vault,
      project,
      srsStore,
      now: new Date('2026-07-12T12:00:00.000Z'),
    })

    expect(result.totalCards).toBe(1)
    expect(result.dueCards).toBe(0)
    expect(result.nextAction).toEqual({
      kind: 'learn',
      knowledgePointTitle: 'B',
      started: false,
    })
  })

  it('freezes paused project statistics while preserving real study time', async () => {
    const { vault, project } = createFixture()
    const pausedAt = new Date('2026-07-12T12:00:00.000Z')
    const lastStudiedAt = '2026-07-10T12:00:00.000Z'
    const getEffectiveProjectState = jest.fn(
      async (_projectSlug: string, at: Date) => {
        const shiftMs = at.getTime() - pausedAt.getTime()
        const shift = (value: string) =>
          new Date(new Date(value).getTime() + shiftMs).toISOString()
        return {
          version: 3 as const,
          cards: {
            aaaaaaaa: state(
              shift('2026-07-11T12:00:00.000Z'),
              shift('2026-07-10T12:00:00.000Z'),
              0.95,
            ),
            bbbbbbbb: state(
              shift('2026-07-15T12:00:00.000Z'),
              shift('2026-07-11T12:00:00.000Z'),
              0.85,
            ),
          },
          suspended: [],
          pausedAt: pausedAt.toISOString(),
          lastStudiedAt,
        }
      },
    )
    const srsStore = {
      getEffectiveProjectState,
      getCardRetrievability: jest.fn(
        (card: SrsCardState, at: Date) =>
          1 -
          (at.getTime() - new Date(card.lastReview ?? 0).getTime()) /
            (100 * 24 * 60 * 60 * 1_000),
      ),
    } as unknown as LearningSrsStore

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

    expect(first).toEqual(later)
    expect(first.paused).toBe(true)
    expect(first.lastStudiedAt).toBe(new Date(lastStudiedAt).getTime())
    expect(first.lastActiveAt).toBe(new Date(lastStudiedAt).getTime())
    expect(first.nextDueAt).toBe(new Date('2026-07-15T12:00:00.000Z').getTime())
    expect(getEffectiveProjectState).toHaveBeenNthCalledWith(
      1,
      project.slug,
      pausedAt,
    )
  })
})
