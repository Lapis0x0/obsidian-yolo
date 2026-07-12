import {
  type WorkspaceCard,
  calculateTargetFileIndex,
  groupCardsByProjectOrder,
  isBrowseDragDisabled,
  mergeDiskAndPreviewCards,
  reconcilePreviewEvents,
  summarizeCardGeneration,
} from './cardsWorkspace'

const card = (id: string, kpUuid = 'aaaaaaaa'): WorkspaceCard => ({
  id,
  kpUuid,
  pointId: null,
  pointTitle: kpUuid,
  chapterId: 'chapter',
  chapterTitle: 'Chapter',
  front: id,
  back: id,
  mastery: 'new',
  dueAt: null,
  srsState: null,
  filePath: null,
  startLine: 1,
  sourceIndex: 0,
  preview: true,
})

describe('cards workspace calculations', () => {
  test('summarizes complete, partial, and failed generation results', () => {
    const result = (
      status: 'generated' | 'partial' | 'failed' | 'skipped',
      cardCount: number,
    ) => ({
      chapterIndex: 0,
      chapterTitle: 'Chapter',
      cards: Array.from({ length: cardCount }, (_, index) => ({
        title: `Card ${index}`,
        kpUuid: 'aaaaaaaa',
        front: 'Question',
        back: 'Answer',
        startLine: index,
        cardUuid: `card-${index}`,
      })),
      status,
      discardedCount: 0,
    })

    expect(
      summarizeCardGeneration([result('generated', 2), result('generated', 3)]),
    ).toEqual({
      outcome: 'success',
      chapterCount: 2,
      cardCount: 5,
      incompleteChapterCount: 0,
      skippedChapterCount: 0,
    })
    expect(
      summarizeCardGeneration([result('generated', 2), result('partial', 1)]),
    ).toEqual({
      outcome: 'partial',
      chapterCount: 2,
      cardCount: 3,
      incompleteChapterCount: 1,
      skippedChapterCount: 0,
    })
    expect(summarizeCardGeneration([result('failed', 0)])).toEqual({
      outcome: 'failed',
      chapterCount: 1,
      cardCount: 0,
      incompleteChapterCount: 1,
      skippedChapterCount: 0,
    })
    expect(summarizeCardGeneration([result('skipped', 0)])).toEqual({
      outcome: 'success',
      chapterCount: 1,
      cardCount: 0,
      incompleteChapterCount: 0,
      skippedChapterCount: 1,
    })
  })

  test('disk cards replace previews with the same UUID', () => {
    const disk = { ...card('11111111'), preview: false, filePath: 'cards.md' }
    expect(
      mergeDiskAndPreviewCards([disk], [card('11111111'), card('22222222')]),
    ).toEqual([disk, card('22222222')])
  })

  test('settled result removes discarded chapter previews', () => {
    const event = (cardUuid: string, chapterIndex: number) => ({
      runId: 'run',
      projectId: 'project',
      chapterId: 'chapter',
      chapterIndex,
      cardIndex: 0,
      cardUuid,
      card: { ...card(cardUuid), cardUuid, title: cardUuid, startLine: 1 },
    })
    expect(
      reconcilePreviewEvents(
        [event('11111111', 0), event('22222222', 0), event('33333333', 1)],
        {
          chapterIndex: 0,
          chapterTitle: 'Chapter',
          cards: [event('11111111', 0).card],
          status: 'partial',
          discardedCount: 1,
        },
      ).map((item) => item.cardUuid),
    ).toEqual(['11111111', '33333333'])
  })

  test('groups chapters and knowledge points in project order including empty points', () => {
    const project = {
      id: 'p',
      slug: 'p',
      topic: 'P',
      goal: 'Understand P',
      status: 'studying' as const,
      folderPath: 'p',
      indexFilePath: 'p/index.md',
      chapters: [
        {
          id: 'c',
          projectId: 'p',
          slug: 'c',
          title: 'C',
          folderPath: 'p/c',
          knowledgePointIds: ['c/bbbbbbbb', 'c/aaaaaaaa'],
        },
      ],
      knowledgePoints: [
        {
          id: 'c/aaaaaaaa',
          projectId: 'p',
          chapterId: 'c',
          uuid: 'aaaaaaaa',
          title: 'A',
          knowledgeFilePath: '',
          relations: [],
          hasCards: false,
          hasExercises: false,
          mtime: 0,
        },
        {
          id: 'c/bbbbbbbb',
          projectId: 'p',
          chapterId: 'c',
          uuid: 'bbbbbbbb',
          title: 'B',
          knowledgeFilePath: '',
          relations: [],
          hasCards: false,
          hasExercises: false,
          mtime: 0,
        },
      ],
    }
    const groups = groupCardsByProjectOrder(project, [
      card('11111111', 'aaaaaaaa'),
    ])
    expect(
      groups[0].points.map((group) => [group.point.title, group.cards.length]),
    ).toEqual([
      ['B', 0],
      ['A', 1],
    ])
  })

  test('calculates global cards.md index while preserving knowledge point groups', () => {
    const cards = [
      card('11111111', 'aaaaaaaa'),
      card('22222222', 'bbbbbbbb'),
      card('33333333', 'aaaaaaaa'),
    ]
    expect(
      calculateTargetFileIndex('bbbbbbbb', 0, ['aaaaaaaa', 'bbbbbbbb'], cards, [
        '33333333',
      ]),
    ).toBe(1)
    expect(
      calculateTargetFileIndex('aaaaaaaa', 1, ['aaaaaaaa', 'bbbbbbbb'], cards, [
        '22222222',
      ]),
    ).toBe(1)
  })

  test('uses actual file positions when existing cards are interleaved', () => {
    const cards = [
      card('11111111', 'aaaaaaaa'),
      card('22222222', 'bbbbbbbb'),
      card('33333333', 'aaaaaaaa'),
      card('44444444', 'cccccccc'),
    ]

    expect(
      calculateTargetFileIndex(
        'aaaaaaaa',
        2,
        ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'],
        cards,
        ['44444444'],
      ),
    ).toBe(3)
    expect(
      calculateTargetFileIndex(
        'bbbbbbbb',
        0,
        ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'],
        cards,
        ['44444444'],
      ),
    ).toBe(1)
  })

  test('disables browse dragging for mastery filters and readonly states', () => {
    expect(
      isBrowseDragDisabled({
        masteryFilter: '已掌握',
        writeDisabled: false,
        chapterGenerating: false,
        preview: false,
      }),
    ).toBe(true)
    expect(
      isBrowseDragDisabled({
        masteryFilter: '全部',
        writeDisabled: false,
        chapterGenerating: false,
        preview: false,
      }),
    ).toBe(false)
  })
})
