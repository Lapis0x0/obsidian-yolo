import { type Board, type BoardNode, emptyBoard } from './fileFormat'
import {
  CARD_PREVIEW_CHARS,
  previewablePaths,
  readBoardCard,
  summarizeBoard,
} from './summary'

function text(id: string, body: string, x = 0, y = 0): BoardNode {
  return { id, type: 'text', x, y, w: 100, h: 50, text: body, extra: {} }
}

function file(id: string, path: string): BoardNode {
  return { id, type: 'file', x: 0, y: 0, w: 100, h: 50, file: path, extra: {} }
}

function boardWith(nodes: BoardNode[], edges: Board['edges'] = []): Board {
  return { ...emptyBoard(), nodes, edges }
}

describe('summarizeBoard', () => {
  it('names the board and counts what is on it', () => {
    const summary = summarizeBoard(boardWith([text('c-1', 'a')]), {
      path: 'Boards/plan.yoloboard',
    })
    expect(summary).toContain('board: Boards/plan.yoloboard')
    expect(summary).toContain('1 card, 0 edges')
  })

  it('gives every card its coordinates, which is the only spatial fact a board has', () => {
    const summary = summarizeBoard(boardWith([text('c-1', 'a', 320, -140)]), {
      path: 'b.yoloboard',
    })
    expect(summary).toContain('320,-140')
  })

  it('previews a text card rather than giving it in full', () => {
    const long = 'x'.repeat(CARD_PREVIEW_CHARS * 3)
    const summary = summarizeBoard(boardWith([text('c-1', long)]), {
      path: 'b.yoloboard',
    })
    expect(summary).toContain(`${'x'.repeat(CARD_PREVIEW_CHARS)}…`)
    expect(summary).not.toContain(long)
  })

  it('says how to read a card in full', () => {
    const summary = summarizeBoard(boardWith([text('c-1', 'a')]), {
      path: 'b.yoloboard',
    })
    expect(summary).toContain('b.yoloboard#<card id>')
  })

  it('previews a note card from the text it was given', () => {
    const summary = summarizeBoard(boardWith([file('c-1', 'notes/a.md')]), {
      path: 'b.yoloboard',
      previews: new Map([['notes/a.md', 'The core idea is that']]),
    })
    expect(summary).toContain('notes/a.md')
    expect(summary).toContain('The core idea is that')
  })

  it('distinguishes an empty note from one nobody resolved', () => {
    const resolved = summarizeBoard(boardWith([file('c-1', 'notes/a.md')]), {
      path: 'b.yoloboard',
      previews: new Map([['notes/a.md', '']]),
    })
    expect(resolved).toContain('(empty note)')

    const unresolved = summarizeBoard(boardWith([file('c-1', 'notes/a.md')]), {
      path: 'b.yoloboard',
    })
    expect(unresolved).not.toContain('(empty note)')
  })

  it('calls a file card by what it actually is', () => {
    const summary = summarizeBoard(
      boardWith([file('c-1', 'a.md'), file('c-2', 'a.png')]),
      { path: 'b.yoloboard' },
    )
    expect(summary).toContain('c-1  note')
    expect(summary).toContain('c-2  image')
  })

  it('lists groups with their members', () => {
    const board = boardWith([
      {
        id: 'g-1',
        type: 'group',
        x: 0,
        y: 0,
        w: 400,
        h: 400,
        label: 'why',
        extra: {},
      },
      text('c-1', 'inside', 50, 50),
      text('c-2', 'outside', 5000, 5000),
    ])
    const summary = summarizeBoard(board, { path: 'b.yoloboard' })
    expect(summary).toContain('g-1 "why"')
    expect(summary).toMatch(/g-1 "why".*c-1/)
    expect(summary).not.toMatch(/g-1 "why".*c-2/)
  })

  it('lists edges with their labels', () => {
    const board = boardWith(
      [text('c-1', 'a'), text('c-2', 'b')],
      [
        {
          id: 'e-1',
          fromNode: 'c-1',
          toNode: 'c-2',
          fromEnd: 'none',
          toEnd: 'arrow',
          label: 'leads to',
          extra: {},
        },
      ],
    )
    const summary = summarizeBoard(board, { path: 'b.yoloboard' })
    expect(summary).toContain('e-1: c-1 -> c-2 "leads to"')
  })
})

describe('readBoardCard', () => {
  it('gives a text card in full', () => {
    const long = 'y'.repeat(CARD_PREVIEW_CHARS * 3)
    expect(readBoardCard(boardWith([text('c-1', long)]), 'c-1')).toBe(long)
  })

  it('points at the file behind a note card instead of pretending to have it', () => {
    const answer = readBoardCard(boardWith([file('c-1', 'notes/a.md')]), 'c-1')
    expect(answer).toContain('notes/a.md')
  })

  it('returns null for a card that is not there, which is a failed read', () => {
    expect(readBoardCard(emptyBoard(), 'c-nope')).toBeNull()
  })
})

describe('previewablePaths', () => {
  it('lists each markdown card path once', () => {
    const board = boardWith([
      file('c-1', 'a.md'),
      file('c-2', 'a.md'),
      file('c-3', 'b.png'),
      text('c-4', 'x'),
    ])
    expect(previewablePaths(board)).toEqual(['a.md'])
  })
})
