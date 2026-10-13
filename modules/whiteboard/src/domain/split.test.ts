import { type Board, type BoardNode, type Edge, emptyBoard } from './fileFormat'
import { GROUP_SELECTION_PADDING } from './groups'
import { changesBetween, composeBoard } from './portals'
import { splitOff } from './split'

const text = (id: string, x: number, y: number): BoardNode => ({
  id,
  type: 'text',
  x,
  y,
  w: 100,
  h: 50,
  text: id,
  extra: {},
})
const edge = (id: string, from: string, to: string): Edge => ({
  id,
  fromNode: from,
  toNode: to,
  fromEnd: 'none',
  toEnd: 'arrow',
  extra: {},
})
const board = (nodes: BoardNode[], edges: Edge[] = []): Board => ({
  ...emptyBoard(),
  nodes,
  edges,
})
const pad = GROUP_SELECTION_PADDING

describe('splitOff', () => {
  it('moves the part to its own board and leaves a portal looking at it where it was', () => {
    const own = board(
      [text('t', 0, 0), text('a', 200, 100), text('b', 400, 100)],
      [edge('in', 'a', 'b'), edge('across', 't', 'a')],
    )
    const composition = composeBoard(own, 'Own.yoloboard', () => null)
    const split = splitOff(
      composition.board,
      composition,
      'Own.yoloboard',
      ['a', 'b'],
      'Part.yoloboard',
      'P',
    )
    expect(split?.portal).toBe('P')
    expect(split?.board.nodes.map((node) => node.id)).toEqual(['t', 'P'])
    expect(split?.board.nodes[1]).toMatchObject({
      file: 'Part.yoloboard',
      x: 200 - pad,
      y: 100 - pad,
      w: 300 + pad * 2,
      h: 50 + pad * 2,
      view: { x: 200 - pad, y: 100 - pad },
    })
    expect(split?.board.edges).toEqual([
      expect.objectContaining({ id: 'across', fromNode: 't', toNode: 'P/a' }),
    ])
    expect(split?.content.nodes).toEqual([
      text('a', 200, 100),
      text('b', 400, 100),
    ])
    expect(split?.content.edges).toEqual([edge('in', 'a', 'b')])

    const changes = changesBetween(composition, split!.board, 'Own.yoloboard')
    const ownChanges = changes.get('Own.yoloboard')
    expect([...(ownChanges?.nodes.keys() ?? [])].sort()).toEqual([
      'P',
      'a',
      'b',
    ])
    expect(ownChanges?.edges.get('in')?.after).toBeNull()
    expect(ownChanges?.edges.get('across')?.after).toMatchObject({
      toNode: 'P/a',
    })
  })

  it('splits behind a portal in that board’s own terms', () => {
    const sub = board([text('a', 10, 20), text('b', 300, 20)])
    const own = board([
      {
        id: 'p',
        type: 'file',
        x: 1000,
        y: 500,
        w: 600,
        h: 400,
        file: 'Sub.yoloboard',
        view: { x: 0, y: 0 },
        extra: {},
      },
    ])
    const composition = composeBoard(own, 'Own.yoloboard', () => sub)
    const split = splitOff(
      composition.board,
      composition,
      'Own.yoloboard',
      ['p/a'],
      'Part.yoloboard',
      'P',
    )
    expect(split?.portal).toBe('p/P')
    expect(split?.content.nodes).toEqual([text('a', 10, 20)])
    const changes = changesBetween(composition, split!.board, 'Own.yoloboard')
    expect(changes.get('Sub.yoloboard')?.nodes.get('P')?.after).toMatchObject({
      x: 10 - pad,
      y: 20 - pad,
      view: { x: 10 - pad, y: 20 - pad },
    })
    expect(changes.get('Sub.yoloboard')?.nodes.get('a')?.after).toBeNull()
  })

  it('moves nothing that is not on the board the first one is on', () => {
    const own = board([text('a', 0, 0)])
    const composition = composeBoard(own, 'Own.yoloboard', () => null)
    expect(
      splitOff(
        composition.board,
        composition,
        'Own.yoloboard',
        ['missing'],
        'Part.yoloboard',
        'P',
      ),
    ).toBeNull()
  })
})
