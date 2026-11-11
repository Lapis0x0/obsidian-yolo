import {
  type Board,
  type BoardNode,
  type GroupNode,
  emptyBoard,
} from './fileFormat'
import {
  GROUP_JOIN_DISTANCE,
  GROUP_LEAVE_DISTANCE,
  GROUP_PADDING,
  GROUP_TITLE,
  arrangeTargets,
  boardBlocks,
  carryGroupMembers,
  createGroup,
  distanceToRect,
  fitGroups,
  groupDropDecision,
  groupFrameWithout,
  groupParents,
  groupRectForNodes,
  nodesInsideGroup,
  nodesToDragWith,
  rectContains,
  setMembership,
} from './groups'

function group(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  members: string[] = [],
  bounds?: GroupNode['bounds'],
): GroupNode {
  return {
    id,
    type: 'group',
    x,
    y,
    w,
    h,
    members,
    ...(bounds ? { bounds } : {}),
    extra: {},
  }
}

function card(id: string, x: number, y: number, w = 50, h = 50): BoardNode {
  return { id, type: 'text', x, y, w, h, text: '', extra: {} }
}

function boardWith(nodes: BoardNode[]): Board {
  return { ...emptyBoard(), nodes }
}

function node(board: Board, id: string): BoardNode {
  const found = board.nodes.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no node ${id}`)
  return found
}

function members(board: Board, id: string): readonly string[] {
  const found = node(board, id)
  return found.type === 'group' ? found.members : []
}

describe('rectContains', () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 }

  it('accepts a rect wholly inside, flush edges included', () => {
    expect(rectContains(outer, { x: 10, y: 10, w: 20, h: 20 })).toBe(true)
    expect(rectContains(outer, { x: 0, y: 0, w: 100, h: 100 })).toBe(true)
  })

  it('rejects a rect hanging out on one side', () => {
    expect(rectContains(outer, { x: 90, y: 10, w: 20, h: 20 })).toBe(false)
  })
})

describe('nodesInsideGroup', () => {
  it('is what the group records, not what its frame covers', () => {
    const frame = group('g', 0, 0, 200, 200, ['far'])
    const under = card('under', 20, 20)
    const far = card('far', 900, 900)
    expect(nodesInsideGroup(frame, [frame, under, far])).toEqual(['far'])
  })

  it('never returns the group itself', () => {
    const frame = group('g', 0, 0, 200, 200, ['g'])
    expect(nodesInsideGroup(frame, [frame])).toEqual([])
  })

  it('holds what a nested group holds, at any depth', () => {
    const outer = group('g', 0, 0, 200, 200, ['inner'])
    const inner = group('inner', 10, 10, 50, 50, ['deep'])
    const deep = card('deep', 20, 20)
    expect(nodesInsideGroup(outer, [outer, inner, deep])).toEqual([
      'inner',
      'deep',
    ])
  })

  it('leaves out a member that is not on the board', () => {
    const frame = group('g', 0, 0, 200, 200, ['gone', 'a'])
    expect(nodesInsideGroup(frame, [frame, card('a', 0, 0)])).toEqual(['a'])
  })
})

describe('nodesToDragWith', () => {
  const frame = group('g', 0, 0, 200, 200, ['inside'])
  const inside = card('inside', 20, 20)
  const outside = card('outside', 40, 40)
  const nodes = [frame, inside, outside]

  it('carries what a group holds — and not what merely sits on it', () => {
    expect(nodesToDragWith(new Set(['g']), nodes).sort()).toEqual([
      'g',
      'inside',
    ])
  })

  it('carries nothing extra for a plain card', () => {
    expect(nodesToDragWith(new Set(['inside']), nodes)).toEqual(['inside'])
  })

  it('carries a nested group’s contents too', () => {
    const outer = group('o', 0, 0, 300, 300, ['n'])
    const nested = group('n', 10, 10, 100, 100, ['deep'])
    const deep = card('deep', 20, 20, 10, 10)
    expect(
      nodesToDragWith(new Set(['o']), [outer, nested, deep]).sort(),
    ).toEqual(['deep', 'n', 'o'])
  })
})

describe('arrangeTargets', () => {
  it("returns a lone selected group's direct members", () => {
    const board = boardWith([
      group('g', 0, 0, 200, 200, ['a', 'n']),
      card('a', 20, 20),
      group('n', 0, 100, 100, 100, ['deep']),
      card('deep', 10, 110),
      card('outside', 40, 40),
    ])
    expect(arrangeTargets(board, new Set(['g'])).map((n) => n.id)).toEqual([
      'a',
      'n',
    ])
  })

  it('drops a card its own selected group is carrying', () => {
    const board = boardWith([
      group('g', 0, 0, 200, 200, ['inside']),
      card('inside', 20, 20),
      card('outside', 400, 400),
    ])
    expect(
      arrangeTargets(board, new Set(['g', 'inside', 'outside'])).map(
        (n) => n.id,
      ),
    ).toEqual(['g', 'outside'])
  })
})

describe('carryGroupMembers', () => {
  const nodes = [
    group('g', 0, 0, 200, 200, ['inside']),
    card('inside', 20, 20),
    card('passed', 400, 400),
  ]

  it("moves a group's members by the group's delta, and nothing it passes", () => {
    const moved = carryGroupMembers(nodes, new Map([['g', { x: 380, y: 380 }]]))
    expect(moved.get('inside')).toEqual({ x: 400, y: 400 })
    expect(moved.has('passed')).toBe(false)
  })
})

describe('boardBlocks', () => {
  it('is a group with what it holds, as its frame', () => {
    const nodes = [
      group('g', 0, 0, 300, 300, ['a']),
      card('a', 10, 10),
      card('b', 400, 0),
    ]
    expect(boardBlocks(nodes, new Set())).toEqual([
      { x: 0, y: 0, w: 300, h: 300 },
      { x: 400, y: 0, w: 50, h: 50 },
    ])
  })
})

describe('groupRectForNodes', () => {
  it('encloses the union with padding on every side', () => {
    expect(
      groupRectForNodes([card('a', 0, 0, 50, 50), card('b', 100, 80, 50, 50)]),
    ).toEqual({
      x: -GROUP_PADDING,
      y: -GROUP_PADDING,
      w: 150 + GROUP_PADDING * 2,
      h: 130 + GROUP_PADDING * 2,
    })
    expect(groupRectForNodes([])).toBeNull()
  })
})

describe('fitGroups', () => {
  const wide = (count: number) => count * 200

  it('hugs its members with a margin, at least its title bar wide', () => {
    const board = fitGroups(
      boardWith([
        group('g', 0, 0, 10, 10, ['a', 'b']),
        card('a', 100, 100, wide(1), 100),
        card('b', 400, 300, wide(1), 100),
      ]),
    )
    expect(node(board, 'g')).toMatchObject({
      x: 100 - GROUP_PADDING,
      y: 100 - GROUP_PADDING,
      w: 500 + GROUP_PADDING * 2,
      h: 300 + GROUP_PADDING * 2,
    })
    const small = fitGroups(
      boardWith([group('g', 0, 0, 10, 10, ['a']), card('a', 0, 0, 50, 50)]),
    )
    expect(node(small, 'g').w).toBe(GROUP_TITLE.width)
  })

  it('is its bounds and its members together — never less than what it holds', () => {
    const bounds = { x: 0, y: 0, w: 600, h: 400 }
    const inside = fitGroups(
      boardWith([group('g', 0, 0, 1, 1, ['a'], bounds), card('a', 50, 50)]),
    )
    expect(node(inside, 'g')).toMatchObject(bounds)
    // A member taken past the bounds stretches the frame out to it…
    const out = fitGroups(
      boardWith([group('g', 0, 0, 1, 1, ['a'], bounds), card('a', 900, 50)]),
    )
    expect(node(out, 'g')).toMatchObject({
      x: 0,
      y: 0,
      w: 950 + GROUP_PADDING,
      h: 400,
    })
    // …and brought back, the frame is the bounds again.
    const back = fitGroups({
      ...out,
      nodes: out.nodes.map((n) => (n.id === 'a' ? { ...n, x: 50 } : n)),
    })
    expect(node(back, 'g')).toMatchObject(bounds)
  })

  it('fits inner groups first, title bar included', () => {
    const board = fitGroups(
      boardWith([
        group('outer', 0, 0, 1, 1, ['inner']),
        group('inner', 0, 0, 1, 1, ['a']),
        card('a', 100, 200, 400, 100),
      ]),
    )
    const inner = node(board, 'inner')
    expect(inner).toMatchObject({ x: 80, y: 180, w: 440, h: 140 })
    expect(node(board, 'outer')).toMatchObject({
      x: inner.x - GROUP_PADDING,
      y: inner.y - GROUP_TITLE.height - GROUP_TITLE.gap - GROUP_PADDING,
    })
  })

  it('keeps the frame of a group with nothing left in it', () => {
    const board = boardWith([group('g', 5, 5, 300, 100, ['gone'])])
    expect(fitGroups(board)).toBe(board)
  })

  it('returns the same board when nothing moves', () => {
    const fitted = fitGroups(
      boardWith([group('g', 0, 0, 1, 1, ['a']), card('a', 0, 0)]),
    )
    expect(fitGroups(fitted)).toBe(fitted)
  })

  it('takes a whole open spread in: title, every sheet', () => {
    const board = fitGroups(
      boardWith([
        group('g', 0, 0, 1, 1, ['p']),
        {
          id: 'p',
          type: 'file',
          file: 'a.pdf',
          x: 0,
          y: 0,
          w: 400,
          h: 39,
          readerRect: { x: 0, y: 45, w: 400, h: 500 },
          extra: {},
        },
        {
          id: 'p/p1',
          type: 'pdf-page',
          parent: 'p',
          file: 'a.pdf',
          page: 1,
          x: 900,
          y: 900,
          w: 400,
          h: 500,
          extra: {},
        },
      ]),
    )
    expect(node(board, 'g')).toMatchObject({
      x: -GROUP_PADDING,
      y: -GROUP_PADDING,
      w: 1300 + GROUP_PADDING * 2,
      h: 1400 + GROUP_PADDING * 2,
    })
  })
})

describe('setMembership', () => {
  const board = boardWith([
    group('a', 0, 0, 100, 100, ['x']),
    group('b', 500, 0, 100, 100, []),
    card('x', 10, 10),
    card('y', 600, 10),
  ])

  it('moves a node from the group it is in to another', () => {
    const next = setMembership(board, ['x'], 'b')
    expect(members(next, 'a')).toEqual([])
    expect(members(next, 'b')).toEqual(['x'])
    expect(groupParents(next.nodes).get('x')).toBe('b')
  })

  it('takes a node out of every group', () => {
    const next = setMembership(board, ['x'], null)
    expect(members(next, 'a')).toEqual([])
    expect(groupParents(next.nodes).has('x')).toBe(false)
  })

  it('never makes a group hold itself, however deep', () => {
    const nested = setMembership(board, ['b'], 'a')
    expect(setMembership(nested, ['a'], 'b')).toBe(nested)
    expect(setMembership(nested, ['a'], 'a')).toBe(nested)
  })

  it('returns the same board when nothing changes', () => {
    expect(setMembership(board, ['x'], 'a')).toBe(board)
  })
})

describe('createGroup', () => {
  const make = (board: Board, ids: string[]) =>
    createGroup(board, { id: 'new', type: 'group', extra: {} }, ids)

  it('records the selection as members and fits the frame to it', () => {
    const next = make(boardWith([card('a', 0, 0), card('b', 400, 0)]), [
      'a',
      'b',
    ])
    if (!next) throw new Error('expected a board')
    expect(members(next, 'new')).toEqual(['a', 'b'])
    expect(node(next, 'new')).toMatchObject({
      x: -GROUP_PADDING,
      y: -GROUP_PADDING,
      w: 450 + GROUP_PADDING * 2,
    })
    expect(node(next, 'new')).not.toHaveProperty('bounds')
    // Behind what it holds.
    expect(next.nodes[0].id).toBe('new')
  })

  it('takes the place of its members in the group they shared', () => {
    const next = make(
      boardWith([
        group('outer', 0, 0, 1000, 1000, ['a', 'b', 'c']),
        card('a', 0, 0),
        card('b', 100, 0),
        card('c', 800, 800),
      ]),
      ['a', 'b'],
    )
    if (!next) throw new Error('expected a board')
    expect(members(next, 'outer')).toEqual(['c', 'new'])
    expect(members(next, 'new')).toEqual(['a', 'b'])
  })

  it('holds a selected group, not also what that group carries', () => {
    const next = make(
      boardWith([
        group('g', 0, 0, 100, 100, ['a']),
        card('a', 0, 0),
        card('b', 500, 0),
      ]),
      ['g', 'a', 'b'],
    )
    if (!next) throw new Error('expected a board')
    expect(members(next, 'new')).toEqual(['g', 'b'])
    expect(members(next, 'g')).toEqual(['a'])
  })

  it('makes nothing of nothing', () => {
    expect(make(boardWith([card('a', 0, 0)]), [])).toBeNull()
  })
})

describe('groupDropDecision', () => {
  // A group holding two cards side by side: frame 0,0 → 660 wide.
  const base = fitGroups(
    boardWith([
      group('g', 0, 0, 1, 1, ['a', 'b']),
      card('a', 20, 20, 300, 100),
      card('b', 340, 20, 300, 100),
      card('loose', 2000, 0, 100, 100),
    ]),
  )
  const frame = node(base, 'g')
  const at = (board: Board, id: string, x: number, y: number): Board => ({
    ...board,
    nodes: board.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
  })

  it('puts a card dropped near a frame into the group', () => {
    // Centre just outside the frame's right edge.
    const x = frame.x + frame.w + GROUP_JOIN_DISTANCE - 1 - 50
    const moved = at(base, 'loose', x, 20)
    expect(groupDropDecision(moved, new Set(['loose']))).toEqual({
      target: 'g',
      leaving: false,
    })
  })

  it('leaves a card dropped further off where it was', () => {
    const x = frame.x + frame.w + GROUP_JOIN_DISTANCE + 1 - 50
    expect(
      groupDropDecision(at(base, 'loose', x, 20), new Set(['loose'])),
    ).toBeNull()
  })

  it('keeps a member nudged off line in its group', () => {
    // b dragged a little past where the rest of the group ends.
    const rest = groupFrameWithout(
      frame as GroupNode,
      base.nodes,
      new Set(['b']),
    )
    const x = rest.x + rest.w + GROUP_LEAVE_DISTANCE - 1 - 150
    expect(groupDropDecision(at(base, 'b', x, 20), new Set(['b']))).toBeNull()
  })

  it('takes a member dragged well away out of its group', () => {
    const rest = groupFrameWithout(
      frame as GroupNode,
      base.nodes,
      new Set(['b']),
    )
    const x = rest.x + rest.w + GROUP_LEAVE_DISTANCE + 1 - 150
    expect(groupDropDecision(at(base, 'b', x, 20), new Set(['b']))).toEqual({
      target: null,
      leaving: true,
    })
  })

  it('moves a card from one group into another it is dropped on', () => {
    const two = fitGroups({
      ...base,
      nodes: [
        ...base.nodes,
        group('h', 0, 0, 1, 1, ['c']),
        card('c', 3000, 1000, 100, 100),
      ],
    })
    const moved = at(two, 'b', 3000, 1050)
    expect(groupDropDecision(moved, new Set(['b']))).toEqual({
      target: 'h',
      leaving: false,
    })
  })

  it('prefers the innermost group the drop is on', () => {
    const nested = fitGroups(
      boardWith([
        group('outer', 0, 0, 1, 1, ['inner', 'x']),
        group('inner', 0, 0, 1, 1, ['y']),
        card('x', 0, 0, 100, 100),
        card('y', 0, 400, 100, 100),
        card('loose', 3000, 0, 100, 100),
      ]),
    )
    expect(
      groupDropDecision(at(nested, 'loose', 120, 400), new Set(['loose'])),
    ).toEqual({ target: 'inner', leaving: false })
    // Taken out of the inner one onto the outer one: a way out.
    const yOut = at(nested, 'y', 0, -2000)
    const rest = fitGroups(yOut)
    expect(groupDropDecision(at(rest, 'y', 0, 0), new Set(['y']))).toEqual({
      target: 'outer',
      leaving: true,
    })
  })

  it('judges a dragged group as one thing, carried members aside', () => {
    const moving = new Set(['g', 'a', 'b'])
    expect(groupDropDecision(base, moving)).toBeNull()
  })

  it('does not take apart a selection gathered from several groups', () => {
    const two = fitGroups({
      ...base,
      nodes: [...base.nodes, group('h', 0, 0, 1, 1, ['c']), card('c', 3000, 0)],
    })
    const moved = at(at(two, 'b', 6000, 6000), 'c', 6100, 6000)
    expect(groupDropDecision(moved, new Set(['b', 'c']))).toBeNull()
  })
})

describe('distanceToRect', () => {
  it('is zero inside and the straight-line gap outside', () => {
    const rect = { x: 0, y: 0, w: 10, h: 10 }
    expect(distanceToRect(rect, { x: 5, y: 5 })).toBe(0)
    expect(distanceToRect(rect, { x: 13, y: 14 })).toBe(5)
  })
})
