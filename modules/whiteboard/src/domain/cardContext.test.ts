import {
  buildCardContext,
  cardSourceIds,
  cardSourceNotePaths,
} from './cardContext'
import { type Board, type BoardNode, emptyBoard } from './fileFormat'
import { CARD_PREVIEW_CHARS } from './summary'

function text(id: string, body: string, x = 0, y = 0): BoardNode {
  return { id, type: 'text', x, y, w: 100, h: 50, text: body, extra: {} }
}

function file(id: string, path: string, x = 0, y = 0): BoardNode {
  return { id, type: 'file', x, y, w: 100, h: 50, file: path, extra: {} }
}

function group(
  id: string,
  rect: { x: number; y: number; w: number; h: number },
  label?: string,
): BoardNode {
  return { id, type: 'group', ...rect, label, extra: {} }
}

function edge(id: string, fromNode: string, toNode: string): Board['edges'][0] {
  return {
    id,
    fromNode,
    fromSide: 'right',
    toNode,
    toSide: 'left',
    fromEnd: 'none',
    toEnd: 'arrow',
    extra: {},
  }
}

function boardWith(nodes: BoardNode[], edges: Board['edges'] = []): Board {
  return { ...emptyBoard(), nodes, edges }
}

describe('cardSourceIds', () => {
  it('takes the cards wired into this one, not the ones it feeds', () => {
    const board = boardWith(
      [text('c-1', 'a'), text('c-2', 'b'), text('c-3', 'c')],
      [edge('e-1', 'c-1', 'c-2'), edge('e-2', 'c-2', 'c-3')],
    )
    expect(cardSourceIds(board, 'c-2')).toEqual(['c-1'])
  })

  it('names each source once however many edges reach this card', () => {
    const board = boardWith(
      [text('c-1', 'a'), text('c-2', 'b')],
      [edge('e-1', 'c-1', 'c-2'), edge('e-2', 'c-1', 'c-2')],
    )
    expect(cardSourceIds(board, 'c-2')).toEqual(['c-1'])
  })
})

describe('cardSourceNotePaths', () => {
  it('asks for a source note card in full', () => {
    const board = boardWith(
      [file('c-1', 'notes/a.md'), text('c-2', '')],
      [edge('e-1', 'c-1', 'c-2')],
    )
    expect(cardSourceNotePaths(board, 'c-2')).toEqual(['notes/a.md'])
  })

  it('expands a source group into the notes inside it', () => {
    const board = boardWith(
      [
        group('g-1', { x: 0, y: 0, w: 400, h: 400 }),
        file('c-1', 'notes/a.md', 10, 10),
        file('c-2', 'notes/b.md', 10, 200),
        file('c-3', 'notes/away.md', 900, 900),
        text('c-4', ''),
      ],
      [edge('e-1', 'g-1', 'c-4')],
    )
    expect(cardSourceNotePaths(board, 'c-4')).toEqual([
      'notes/a.md',
      'notes/b.md',
    ])
  })

  it('ignores a source that has no text of its own', () => {
    const board = boardWith(
      [file('c-1', 'assets/a.png'), text('c-2', '')],
      [edge('e-1', 'c-1', 'c-2')],
    )
    expect(cardSourceNotePaths(board, 'c-2')).toEqual([])
  })
})

describe('buildCardContext', () => {
  it('opens with the board summary and locates this card', () => {
    const board = boardWith([text('c-1', 'note to self', 320, -140)])
    const context = buildCardContext({
      board,
      nodeId: 'c-1',
      path: 'Boards/plan.yoloboard',
    })
    expect(context).toContain('board: Boards/plan.yoloboard')
    expect(context).toContain('this card: c-1 at 320,-140 100×50')
  })

  it('gives a source text card in full while the summary only previews it', () => {
    const long = `${'x'.repeat(CARD_PREVIEW_CHARS * 3)} tail`
    const board = boardWith(
      [text('c-1', long), text('c-2', '')],
      [edge('e-1', 'c-1', 'c-2')],
    )
    const context = buildCardContext({
      board,
      nodeId: 'c-2',
      path: 'b.yoloboard',
    })
    expect(context).toContain('sources')
    expect(context).toContain('--- c-1 ---')
    expect(context).toContain(long)
  })

  it('gives a source note card the whole note it was handed', () => {
    const board = boardWith(
      [file('c-1', 'notes/a.md'), text('c-2', '')],
      [edge('e-1', 'c-1', 'c-2')],
    )
    const context = buildCardContext({
      board,
      nodeId: 'c-2',
      path: 'b.yoloboard',
      noteTexts: new Map([['notes/a.md', 'first line\n\nsecond paragraph']]),
    })
    expect(context).toContain('note notes/a.md:')
    expect(context).toContain('second paragraph')
  })

  it('says so when a source note could not be read', () => {
    const board = boardWith(
      [file('c-1', 'notes/gone.md'), text('c-2', '')],
      [edge('e-1', 'c-1', 'c-2')],
    )
    const context = buildCardContext({
      board,
      nodeId: 'c-2',
      path: 'b.yoloboard',
    })
    expect(context).toContain('could not be read')
  })

  it('expands a source group into every member, in full', () => {
    const board = boardWith(
      [
        group('g-1', { x: 0, y: 0, w: 400, h: 400 }, 'Theme'),
        text('c-1', 'inside one', 10, 10),
        text('c-2', 'inside two', 10, 200),
        text('c-3', 'far away', 900, 900),
        text('c-4', '', 600, 0),
      ],
      [edge('e-1', 'g-1', 'c-4')],
    )
    const context = buildCardContext({
      board,
      nodeId: 'c-4',
      path: 'b.yoloboard',
    })
    expect(context).toContain('g-1 "Theme" — a group of 2 card(s)')
    expect(context).toContain('inside one')
    expect(context).toContain('inside two')
    expect(context).not.toContain('--- c-3 ---')
  })

  it('has no sources section for an isolated card', () => {
    const board = boardWith([text('c-1', 'a'), text('c-2', '')])
    const context = buildCardContext({
      board,
      nodeId: 'c-2',
      path: 'b.yoloboard',
    })
    expect(context).not.toContain('sources')
    expect(context).toContain('this card: c-2')
  })
})
