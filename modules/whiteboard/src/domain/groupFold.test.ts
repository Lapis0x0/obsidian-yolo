import type { Board, BoardNode, Edge, GroupNode } from './fileFormat'
import { emptyBoard, parseBoard, serializeBoard } from './fileFormat'
import {
  boardShape,
  collapseGroup,
  expandGroup,
  fileShape,
  isFolded,
  settleGroups,
} from './groupFold'
import { GROUP_TITLE, collapsedGroupSize, groupDropDecision } from './groups'
import { moveNodes } from './operations'

const card = (id: string, x: number, y: number): BoardNode => ({
  id,
  type: 'text',
  x,
  y,
  w: 100,
  h: 100,
  text: id,
  extra: {},
})
const group = (id: string, members: string[], extra = {}): GroupNode => ({
  id,
  type: 'group',
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  members,
  extra: {},
  ...extra,
})
const edge = (id: string, from: string, to: string): Edge => ({
  id,
  fromNode: from,
  toNode: to,
  fromEnd: 'none',
  toEnd: 'arrow',
  extra: {},
})
const node = (board: Board, id: string) =>
  board.nodes.find((candidate) => candidate.id === id)

describe('collapsing a group', () => {
  const open = settleGroups({
    ...emptyBoard(),
    nodes: [
      group('g', ['a', 'b']),
      card('a', 0, 0),
      card('b', 200, 0),
      card('out', 900, 0),
    ],
    edges: [edge('ab', 'a', 'b'), edge('ax', 'a', 'out')],
  })

  it('puts what it holds away and becomes a box under its title', () => {
    const folded = settleGroups(collapseGroup(open, 'g'))
    const box = node(folded, 'g')
    expect(isFolded(box)).toBe(true)
    expect(folded.nodes.map((n) => n.id)).toEqual(['g', 'out'])
    expect(box).toMatchObject({
      x: node(open, 'g')?.x,
      y: node(open, 'g')?.y,
      ...collapsedGroupSize(2),
    })
    expect(box?.w).toBe(GROUP_TITLE.width)
    // An edge among them goes with them; one from outside goes to the box.
    expect(folded.edges).toEqual([
      { ...edge('ax', 'g', 'out'), fromMember: 'a' },
    ])
  })

  it('brings everything back where it was, moved with the box', () => {
    const folded = settleGroups(collapseGroup(open, 'g'))
    const moved = moveNodes(folded, ['g'], 500, 40)
    const back = settleGroups(expandGroup(moved, 'g'))
    expect(node(back, 'a')).toMatchObject({ x: 500, y: 40 })
    expect(node(back, 'b')).toMatchObject({ x: 700, y: 40 })
    expect(node(back, 'g')).not.toHaveProperty('collapsed')
    expect(back.edges).toEqual([edge('ax', 'a', 'out'), edge('ab', 'a', 'b')])
  })

  it('is written open, marked collapsed, and read back folded', () => {
    const folded = settleGroups(collapseGroup(open, 'g'))
    const file = fileShape(folded)
    expect(file.nodes.map((n) => n.id)).toEqual(['g', 'a', 'b', 'out'])
    expect(node(file, 'g')).toMatchObject({
      collapsed: true,
      w: node(open, 'g')?.w,
    })
    const text = serializeBoard(file)
    const parsed = parseBoard(text)
    if (!parsed.ok) throw new Error('unparsable')
    const reread = boardShape(parsed.board)
    expect(isFolded(node(reread, 'g'))).toBe(true)
    expect(reread.edges[0]).toMatchObject({ fromNode: 'g', fromMember: 'a' })
  })

  it('folds a group inside a collapsed one with it, and brings it back folded', () => {
    const nested = settleGroups({
      ...emptyBoard(),
      nodes: [
        group('outer', ['inner', 'c']),
        group('inner', ['a'], { collapsed: true }),
        card('a', 0, 300),
        card('c', 0, 0),
        card('out', 900, 0),
      ],
      edges: [edge('ax', 'a', 'out')],
    })
    expect(nested.edges[0]).toMatchObject({
      fromNode: 'inner',
      fromMember: 'a',
    })
    const both = settleGroups(collapseGroup(nested, 'outer'))
    expect(both.nodes.map((n) => n.id)).toEqual(['outer', 'out'])
    expect(both.edges[0]).toMatchObject({ fromNode: 'outer', fromMember: 'a' })
    const outerOpen = settleGroups(expandGroup(both, 'outer'))
    expect(isFolded(node(outerOpen, 'inner'))).toBe(true)
    expect(outerOpen.edges[0]).toMatchObject({
      fromNode: 'inner',
      fromMember: 'a',
    })
  })

  it('takes in what is dropped on its box or its title bar', () => {
    const folded = settleGroups({
      ...collapseGroup(open, 'g'),
      nodes: [...collapseGroup(open, 'g').nodes, card('new', 2000, 2000)],
    })
    const box = node(folded, 'g')
    if (!box) throw new Error('no box')
    const onBox = moveNodes(
      folded,
      ['new'],
      box.x + 10 - 2000,
      box.y + 10 - 2000,
    )
    expect(groupDropDecision(onBox, new Set(['new']), 91)).toEqual({
      target: 'g',
      leaving: false,
    })
    const near = moveNodes(
      folded,
      ['new'],
      box.x + box.w + 30 - 2000,
      box.y - 2000,
    )
    expect(groupDropDecision(near, new Set(['new']), 91)).toBeNull()
  })
})
