import { TFile } from 'obsidian'
import type { App } from 'obsidian'

import { loadLearningProjectStats } from './learningStats'
import type { LearningSrsStore } from './srs/srsStore'
import type { SrsCardState } from './srs/srsTypes'
import type { Project } from './types'

const CARD_A =
  '## A <!--card:aaaaaaaa kp:11111111-->\n\nfront A\n\n---\n\nback A'
const CARD_B =
  '## B <!--card:bbbbbbbb kp:22222222-->\n\nfront B\n\n---\n\nback B'
const CARD_C =
  '## C <!--card:cccccccc kp:22222222-->\n\nfront C\n\n---\n\nback C'

function makeFile(path: string, ctime: number, mtime: number) {
  const file = new TFile()
  file.path = path
  file.name = path.split('/').at(-1) ?? ''
  file.stat = { ctime, mtime, size: 0 }
  return file
}

function createFixture() {
  const index = makeFile('learning/test/index.md', 100, 200)
  const cards = makeFile('learning/test/chapter/cards.md', 150, 300)
  const files = new Map([
    [index.path, index],
    [cards.path, cards],
  ])
  const content = new Map([[cards.path, `${CARD_A}\n\n${CARD_B}\n\n${CARD_C}`]])
  const app = {
    vault: {
      cachedRead: jest.fn(async (file: TFile) => content.get(file.path) ?? ''),
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getMarkdownFiles: () => [...files.values()],
    },
  } as unknown as App
  const project: Project = {
    id: 'learning/test',
    slug: 'test',
    topic: 'Test',
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
  return { app, project, cards, content, files }
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
    const { app, project } = createFixture()
    const projectState = {
      version: 1,
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
    }
    const srsStore = {
      getProjectState: jest.fn(async () => projectState),
      getCardRetrievability: jest.fn((card: SrsCardState) => card.stability),
    } as unknown as LearningSrsStore

    const result = await loadLearningProjectStats({
      app,
      project,
      srsStore,
      now: new Date('2026-07-12T12:00:00.000Z'),
    })

    expect(result).toEqual({
      totalCards: 3,
      targetCards: 1,
      targetCardProgress: 33,
      memoryProgress: 50,
      dueCards: 1,
      lastStudiedAt: new Date('2026-07-12T12:00:00.000Z').getTime(),
      createdAt: 100,
      lastActiveAt: new Date('2026-07-12T12:00:00.000Z').getTime(),
      nextDueAt: new Date('2026-07-15T12:00:00.000Z').getTime(),
    })
  })

  it('rejects duplicate card UUIDs across chapter files', async () => {
    const { app, project, cards, content } = createFixture()
    content.set(cards.path, `${CARD_A}\n\n${CARD_A}`)
    const srsStore = {
      getProjectState: jest.fn(async () => ({ version: 1, cards: {} })),
      getCardRetrievability: jest.fn(),
    } as unknown as LearningSrsStore

    await expect(
      loadLearningProjectStats({
        app,
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
    const { app, project, content, files } = createFixture()
    const unexpected = makeFile('learning/test/orphan/cards.md', 150, 300)
    files.set(unexpected.path, unexpected)
    content.set(
      unexpected.path,
      '## Invalid <!--card:not-a-uuid kp:11111111-->\n\nfront\n\n---\n\nback',
    )
    const srsStore = {
      getProjectState: jest.fn(async () => ({ version: 1, cards: {} })),
      getCardRetrievability: jest.fn(),
    } as unknown as LearningSrsStore

    await expect(
      loadLearningProjectStats({
        app,
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
})
