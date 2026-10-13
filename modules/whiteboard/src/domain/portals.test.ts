import { type Board, type BoardNode, type Edge, emptyBoard } from './fileFormat'
import {
  type PortalExpansion,
  applyChanges,
  changesBetween,
  clipThrough,
  composeBoard,
  endThrough,
  invertChanges,
  moveToBoard,
  portalAt,
  shownPart,
} from './portals'

const text = (id: string, x: number, y: number, extra = {}): BoardNode => ({
  id,
  type: 'text',
  x,
  y,
  w: 100,
  h: 50,
  text: id,
  extra: {},
  ...extra,
})
const portal = (
  id: string,
  file: string,
  x: number,
  y: number,
  view?: { x: number; y: number; scale?: number },
): BoardNode => ({
  id,
  type: 'file',
  x,
  y,
  w: 400,
  h: 300,
  file,
  ...(view ? { view } : {}),
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

function files(boards: Record<string, Board>): PortalExpansion {
  return (node) => boards[node.file] ?? null
}

describe('composeBoard', () => {
  const sub = board(
    [text('a', 10, 20), text('b', 300, 20)],
    [edge('e', 'a', 'b')],
  )
  const own = board([
    portal('p', 'Sub.yoloboard', 1000, 500, { x: 0, y: 0 }),
    text('t', 0, 0),
  ])

  it('puts what is behind a portal right after it, where the portal shows it', () => {
    const { board: composed, portals } = composeBoard(
      own,
      'Own.yoloboard',
      files({ 'Sub.yoloboard': sub }),
    )
    expect(composed.nodes.map((node) => [node.id, node.x, node.y])).toEqual([
      ['p', 1000, 500],
      ['p/a', 1010, 520],
      ['p/b', 1300, 520],
      ['t', 0, 0],
    ])
    expect(composed.edges).toEqual([
      expect.objectContaining({ id: 'p/e', fromNode: 'p/a', toNode: 'p/b' }),
    ])
    expect(portals.get('p')).toMatchObject({
      file: 'Sub.yoloboard',
      dx: 1000,
      dy: 500,
      clip: { x: 1000, y: 500, w: 400, h: 300 },
    })
  })

  it('gives back the same objects for the same board seen from the same place', () => {
    const expand = files({ 'Sub.yoloboard': sub })
    const once = composeBoard(own, 'Own.yoloboard', expand).board
    const again = composeBoard(own, 'Own.yoloboard', expand).board
    expect(again.nodes[1]).toBe(once.nodes[1])
    expect(again.edges[0]).toBe(once.edges[0])
  })

  it('opens portals behind portals, clipped by both, and never a board already on the way in', () => {
    const inner = board([
      text('c', 0, 0),
      portal('back', 'Own.yoloboard', 0, 100),
    ])
    const middle = board([
      portal('q', 'Inner.yoloboard', 50, 50, { x: 0, y: 0 }),
    ])
    const { board: composed, portals } = composeBoard(
      board([portal('p', 'Middle.yoloboard', 0, 0, { x: 0, y: 0 })]),
      'Own.yoloboard',
      files({ 'Middle.yoloboard': middle, 'Inner.yoloboard': inner }),
    )
    expect(composed.nodes.map((node) => node.id)).toEqual([
      'p',
      'p/q',
      'p/q/c',
      'p/q/back',
    ])
    expect(portals.get('p/q')).toMatchObject({
      parent: 'p',
      dx: 50,
      dy: 50,
      clip: { x: 50, y: 50, w: 350, h: 250 },
    })
    expect(portals.has('p/q/back')).toBe(false)
  })

  it('looks at the top-left of a board when the portal says nowhere', () => {
    const { portals } = composeBoard(
      board([portal('p', 'Sub.yoloboard', 0, 0)]),
      'Own.yoloboard',
      files({ 'Sub.yoloboard': sub }),
    )
    // Its content's top-left, and the padding a portal leaves around it.
    expect(portals.get('p')).toMatchObject({ dx: 30, dy: 20 })
  })
})

describe('changesBetween', () => {
  const sub = board(
    [text('a', 10, 20), text('b', 300, 20)],
    [edge('e', 'a', 'b')],
  )
  const own = board([
    portal('p', 'Sub.yoloboard', 1000, 500, { x: 0, y: 0 }),
    text('t', 0, 0),
  ])
  const compose = () =>
    composeBoard(own, 'Own.yoloboard', files({ 'Sub.yoloboard': sub }))

  it('sends a change behind a portal to its file, in its terms', () => {
    const before = compose()
    const after: Board = {
      ...before.board,
      nodes: before.board.nodes.map((node) =>
        node.id === 'p/a' ? { ...node, x: node.x + 5 } : node,
      ),
    }
    const changes = changesBetween(before, after, 'Own.yoloboard')
    expect([...changes.keys()]).toEqual(['Sub.yoloboard'])
    const change = changes.get('Sub.yoloboard')?.nodes.get('a')
    expect(change?.before).toBe(sub.nodes[0])
    expect(change?.after).toMatchObject({ id: 'a', x: 15, y: 20 })

    const applied = applyChanges(sub, changes.get('Sub.yoloboard')!)
    expect(applied.nodes[0]).toMatchObject({ id: 'a', x: 15 })
    expect(applied.nodes[1]).toBe(sub.nodes[1])

    // Made again from the files, the board is the one the edit made.
    const remade = composeBoard(
      own,
      'Own.yoloboard',
      files({ 'Sub.yoloboard': applied }),
    ).board
    expect(remade.nodes[1]).toBe(after.nodes[1])
  })

  it('counts a portal dragged with what is behind it as the portal moving', () => {
    const before = compose()
    const moved = new Set(['p', 'p/a', 'p/b'])
    const after: Board = {
      ...before.board,
      nodes: before.board.nodes.map((node) =>
        moved.has(node.id) ? { ...node, x: node.x + 40, y: node.y + 7 } : node,
      ),
    }
    const changes = changesBetween(before, after, 'Own.yoloboard')
    expect([...changes.keys()]).toEqual(['Own.yoloboard'])
    expect(changes.get('Own.yoloboard')?.nodes.get('p')?.after).toMatchObject({
      x: 1040,
      y: 507,
    })
  })

  it('removes a card behind a portal from its file, and puts it back on undo', () => {
    const before = compose()
    const after: Board = {
      ...before.board,
      nodes: before.board.nodes.filter((node) => node.id !== 'p/a'),
      edges: [],
    }
    const changes = changesBetween(before, after, 'Own.yoloboard')
    const subChanges = changes.get('Sub.yoloboard')!
    const removed = applyChanges(sub, subChanges)
    expect(removed.nodes.map((node) => node.id)).toEqual(['b'])
    expect(removed.edges).toEqual([])

    const undone = applyChanges(
      removed,
      invertChanges(changes).get('Sub.yoloboard')!,
    )
    expect(undone.nodes).toEqual(sub.nodes)
    expect(undone.edges).toEqual(sub.edges)
  })

  it('leaves the board behind a removed portal alone', () => {
    const before = compose()
    const after: Board = {
      ...before.board,
      nodes: before.board.nodes.filter((node) => !node.id.startsWith('p')),
      edges: [],
    }
    const changes = changesBetween(before, after, 'Own.yoloboard')
    expect([...changes.keys()]).toEqual(['Own.yoloboard'])
    expect([...changes.get('Own.yoloboard')!.nodes.keys()]).toEqual(['p'])
  })

  it('keeps an edge with the board that sees both its ends', () => {
    const before = compose()
    const after: Board = {
      ...before.board,
      edges: [
        ...before.board.edges,
        edge('x', 't', 'p/b'),
        edge('y', 'p/a', 'p/b'),
      ],
    }
    const changes = changesBetween(before, after, 'Own.yoloboard')
    expect(changes.get('Own.yoloboard')?.edges.get('x')?.after).toMatchObject({
      fromNode: 't',
      toNode: 'p/b',
    })
    expect(changes.get('Sub.yoloboard')?.edges.get('y')?.after).toMatchObject({
      fromNode: 'a',
      toNode: 'b',
    })
  })

  it('puts back only what a change touched, over what changed elsewhere since', () => {
    const before = compose()
    const after: Board = {
      ...before.board,
      nodes: before.board.nodes.map((node) =>
        node.id === 'p/a' ? { ...node, x: 0 } : node,
      ),
    }
    const changes = changesBetween(before, after, 'Own.yoloboard')
    const edited = applyChanges(sub, changes.get('Sub.yoloboard')!)
    // Somewhere else, b moves.
    const elsewhere: Board = {
      ...edited,
      nodes: edited.nodes.map((node) =>
        node.id === 'b' ? { ...node, y: 999 } : node,
      ),
    }
    const undone = applyChanges(
      elsewhere,
      invertChanges(changes).get('Sub.yoloboard')!,
    )
    expect(undone.nodes[0]).toBe(sub.nodes[0])
    expect(undone.nodes[1]).toMatchObject({ id: 'b', y: 999 })
  })
})

describe('clipThrough', () => {
  const inner = board([text('a', 0, 0)])
  const middle = board([portal('q', 'inner.yoloboard', 100, 100)])
  const own = board([portal('p', 'middle.yoloboard', 0, 0, { x: 0, y: 0 })])
  const { portals } = composeBoard(
    own,
    'own.yoloboard',
    files({ 'middle.yoloboard': middle, 'inner.yoloboard': inner }),
  )
  const q = portals.get('p/q')

  it('is the composed clip with every frame where the board has it', () => {
    const frames = new Map([
      ['p', { x: 0, y: 0, w: 400, h: 300 }],
      ['p/q', { x: 100, y: 100, w: 400, h: 300 }],
    ])
    expect(q && clipThrough(q, portals, (id) => frames.get(id)!)).toEqual(
      q?.clip,
    )
  })

  it('follows an outer frame held somewhere else', () => {
    const frames = new Map([
      ['p', { x: 0, y: 0, w: 200, h: 150 }],
      ['p/q', { x: 100, y: 100, w: 400, h: 300 }],
    ])
    expect(q && clipThrough(q, portals, (id) => frames.get(id)!)).toEqual({
      x: 100,
      y: 100,
      w: 100,
      h: 50,
    })
  })
})

describe('shownPart', () => {
  const card = { id: 'p/a', x: 50, y: 50, w: 100, h: 100 }

  it('is all of a card nothing clips', () => {
    expect(shownPart(card, null)).toBe(card)
  })

  it('is what shows through the clip, or nothing', () => {
    expect(shownPart(card, { x: 0, y: 0, w: 100, h: 100 })).toEqual({
      id: 'p/a',
      x: 50,
      y: 50,
      w: 50,
      h: 50,
    })
    expect(shownPart(card, { x: 200, y: 0, w: 100, h: 100 })).toBeNull()
  })
})

describe('moveToBoard', () => {
  const sub = board(
    [text('a', 10, 20), text('b', 300, 20)],
    [edge('e', 'a', 'b')],
  )
  const own = board(
    [
      portal('p', 'Sub.yoloboard', 1000, 500, { x: 0, y: 0 }),
      text('t', 0, 0),
      text('a', 1100, 600),
    ],
    [edge('f', 't', 'a')],
  )
  const expand = files({ 'Sub.yoloboard': sub })
  const composition = composeBoard(own, 'Own.yoloboard', expand)
  const p = composition.portals.get('p') ?? null

  it('moves a card in: it leaves this file and arrives in the one behind, where it was', () => {
    const { board: moved, renamed } = moveToBoard(
      composition.board,
      composition,
      'Own.yoloboard',
      ['a'],
      p,
      { x: 0, y: 0 },
    )
    // Behind the portal there is an `a` already.
    expect(renamed).toEqual(new Map([['a', 'p/a-2']]))
    expect(moved.nodes.map((node) => node.id)).toEqual([
      'p',
      'p/a',
      'p/b',
      'p/a-2',
      't',
    ])
    // An edge from here to it now reaches through the portal, and stays
    // here, where both its ends can be seen.
    expect(moved.edges).toContainEqual(
      expect.objectContaining({ id: 'f', fromNode: 't', toNode: 'p/a-2' }),
    )
    const changes = changesBetween(composition, moved, 'Own.yoloboard')
    expect(changes.get('Own.yoloboard')?.nodes.get('a')?.after).toBeNull()
    expect(changes.get('Sub.yoloboard')?.nodes.get('a-2')?.after).toMatchObject(
      { id: 'a-2', x: 100, y: 100 },
    )
    expect(changes.get('Own.yoloboard')?.edges.get('f')?.after).toMatchObject({
      toNode: 'p/a-2',
    })
    expect(changes.get('Sub.yoloboard')?.edges.size ?? 0).toBe(0)
  })

  it('moves a card out, and an edge whose ends now meet here comes with it', () => {
    const { board: moved, renamed } = moveToBoard(
      composition.board,
      composition,
      'Own.yoloboard',
      ['p/b'],
      null,
      { x: 0, y: 0 },
    )
    expect(renamed).toEqual(new Map([['p/b', 'b']]))
    expect(moved.edges).toContainEqual(
      expect.objectContaining({ id: 'e', fromNode: 'p/a', toNode: 'b' }),
    )
    const changes = changesBetween(composition, moved, 'Own.yoloboard')
    expect(changes.get('Sub.yoloboard')?.nodes.get('b')?.after).toBeNull()
    expect(changes.get('Sub.yoloboard')?.edges.get('e')?.after).toBeNull()
    expect(changes.get('Own.yoloboard')?.nodes.get('b')?.after).toMatchObject({
      x: 1300,
      y: 520,
    })
    expect(changes.get('Own.yoloboard')?.edges.get('e')?.after).toMatchObject({
      fromNode: 'p/a',
      toNode: 'b',
    })
  })

  it('leaves a card already on that board, and a portal that would show itself', () => {
    const selfish = composeBoard(
      board([
        portal('p', 'Sub.yoloboard', 0, 0, { x: 0, y: 0 }),
        portal('back', 'Own.yoloboard', 50, 50),
      ]),
      'Own.yoloboard',
      expand,
    )
    const moved = moveToBoard(
      selfish.board,
      selfish,
      'Own.yoloboard',
      ['p/a', 'back'],
      selfish.portals.get('p') ?? null,
      { x: 0, y: 0 },
    )
    expect(moved.renamed.size).toBe(0)
    expect(moved.board).toBe(selfish.board)
  })
})

describe('portalAt', () => {
  const middle = board([portal('q', 'Inner.yoloboard', 50, 50, { x: 0, y: 0 })])
  const { portals } = composeBoard(
    board([portal('p', 'Middle.yoloboard', 0, 0, { x: 0, y: 0 })]),
    'Own.yoloboard',
    files({ 'Middle.yoloboard': middle, 'Inner.yoloboard': board([]) }),
  )

  it('is the innermost portal whose window the point is in', () => {
    expect(portalAt({ x: 100, y: 100 }, portals, () => false)?.id).toBe('p/q')
    expect(portalAt({ x: 10, y: 10 }, portals, () => false)?.id).toBe('p')
    expect(portalAt({ x: 900, y: 10 }, portals, () => false)).toBeNull()
  })

  it('passes over the ones it is told to', () => {
    expect(
      portalAt({ x: 100, y: 100 }, portals, (id) => id === 'p/q')?.id,
    ).toBe('p')
  })
})

describe('endThrough', () => {
  const frame = { x: 0, y: 0, w: 100, h: 100 }

  it('is the card itself when all of it shows', () => {
    const card = { id: 'p/a', x: 10, y: 10, w: 20, h: 20 }
    expect(endThrough(card, frame)).toBe(card)
  })

  it('is what shows of it, or the nearest point of the frame', () => {
    expect(
      endThrough({ id: 'p/a', x: 80, y: 10, w: 40, h: 20 }, frame),
    ).toEqual({ id: 'p/a', x: 80, y: 10, w: 20, h: 20 })
    expect(
      endThrough({ id: 'p/a', x: 300, y: 40, w: 40, h: 20 }, frame),
    ).toEqual({ id: 'p/a', x: 100, y: 50, w: 0, h: 0 })
  })
})

describe('a portal at another scale', () => {
  const sub = board([text('a', 10, 20), text('b', 300, 20)])
  const own = board([
    portal('p', 'Sub.yoloboard', 1000, 500, { x: 0, y: 0, scale: 0.5 }),
  ])
  const expand = files({ 'Sub.yoloboard': sub })
  const composition = composeBoard(own, 'Own.yoloboard', expand)

  it('shows what is behind it scaled about where it looks', () => {
    expect(
      composition.board.nodes.map((node) => [
        node.id,
        node.x,
        node.y,
        node.w,
        node.h,
      ]),
    ).toEqual([
      ['p', 1000, 500, 400, 300],
      ['p/a', 1005, 510, 50, 25],
      ['p/b', 1150, 510, 50, 25],
    ])
    expect(composition.portals.get('p')).toMatchObject({
      dx: 1000,
      dy: 500,
      scale: 0.5,
    })
  })

  it('writes back what was done there in the file’s own sizes', () => {
    const moved = composition.board.nodes.map((node) =>
      node.id === 'p/a' ? { ...node, x: node.x + 10, w: 60 } : node,
    )
    const changes = changesBetween(
      composition,
      { ...composition.board, nodes: moved },
      'Own.yoloboard',
    )
    expect(changes.get('Sub.yoloboard')?.nodes.get('a')?.after).toMatchObject({
      x: 30,
      y: 20,
      w: 120,
      h: 50,
    })
  })

  it('multiplies the scales of portals behind portals', () => {
    const deeper = composeBoard(
      own,
      'Own.yoloboard',
      files({
        'Sub.yoloboard': board([
          portal('q', 'Deep.yoloboard', 100, 100, { x: 0, y: 0, scale: 0.5 }),
        ]),
        'Deep.yoloboard': board([text('d', 40, 0)]),
      }),
    )
    expect(deeper.portals.get('p/q')?.scale).toBe(0.25)
    expect(
      deeper.board.nodes.find((node) => node.id === 'p/q/d'),
    ).toMatchObject({ x: 1060, y: 550, w: 25, h: 12.5 })
  })

  it('keeps a card’s size in its file as it crosses: it is seen at the new board’s scale, about where it was put down', () => {
    const withCard = composeBoard(
      board([...own.nodes, text('t', 1100, 600)]),
      'Own.yoloboard',
      expand,
    )
    const { board: movedIn } = moveToBoard(
      withCard.board,
      withCard,
      'Own.yoloboard',
      ['t'],
      withCard.portals.get('p') ?? null,
      { x: 1100, y: 600 },
    )
    expect(movedIn.nodes.find((node) => node.id === 'p/t')).toMatchObject({
      x: 1100,
      y: 600,
      w: 50,
      h: 25,
    })
    const changes = changesBetween(withCard, movedIn, 'Own.yoloboard')
    expect(changes.get('Sub.yoloboard')?.nodes.get('t')?.after).toMatchObject({
      x: 200,
      y: 200,
      w: 100,
      h: 50,
    })

    const { board: movedOut } = moveToBoard(
      composition.board,
      composition,
      'Own.yoloboard',
      ['p/b'],
      null,
      { x: 1160, y: 520 },
    )
    expect(movedOut.nodes.find((node) => node.id === 'b')).toMatchObject({
      x: 1140,
      y: 500,
      w: 100,
      h: 50,
    })
  })
})
