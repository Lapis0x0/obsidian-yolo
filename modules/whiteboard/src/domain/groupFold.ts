// A collapsed group (fileFormat.ts's `GroupNode.collapsed`) — how what it
// holds is put away into it on the board, and brought back out.
//
// The file keeps a collapsed group's members where they are, as nodes like
// any other, and the group's rectangle is the frame they make. The board
// cannot work with that: everything that reasons about space would go on
// finding, hitting, snapping to and lining up with cards nobody can see. So,
// the way an open PDF spread is given a shape of its own on the board
// (domain/spread.ts's `expandBoard`), a collapsed group is given one: its node
// is the small box under its title bar, and what it holds — at any depth,
// with the edges among them — is taken off the board into its `stash`. An
// edge from outside to something put away is drawn to the box, and remembers
// the end it really has (`fromMember` / `toMember`).
//
// `foldGroups` puts away what every collapsed group not yet folded holds;
// `unfoldGroup` brings one group's back, offset by however far the box was
// moved; `fileShape` and `boardShape` are the whole conversion, PDF spreads
// included, in the order the two need: spreads are spread out before groups
// put them away, and groups give them back before spreads are folded.
//
// Pure, no DOM (Module Boundaries, CLAUDE.md).

import type {
  Board,
  BoardNode,
  Edge,
  GroupNode,
  GroupStash,
  NodeId,
} from './fileFormat'
import {
  type ScaleOf,
  collapsedGroupSize,
  fitGroups,
  groupMemberCount,
  nodesInsideGroup,
} from './groups'
import { collapseBoard, expandBoard } from './spread'

const UNIT_SCALE: ScaleOf = () => 1

/** Whether a node is a collapsed group holding what it put away. */
export function isFolded(
  node: BoardNode | undefined,
): node is GroupNode & Readonly<{ stash: GroupStash }> {
  return node?.type === 'group' && node.stash !== undefined
}

/**
 * The board's shape of a board read from its file: spreads spread out,
 * frames fitted, and every collapsed group folded.
 */
export function boardShape(file: Board, scaleOf: ScaleOf = UNIT_SCALE): Board {
  return settleGroups(expandBoard(file), scaleOf)
}

/** The file's shape of the board: every folded group opened back out —
 * still marked collapsed — and spreads folded into their PDFs. */
export function fileShape(board: Board): Board {
  return collapseBoard(unfoldAllGroups(board))
}

/**
 * Frames where what they hold puts them, and every group that is collapsed
 * but not yet folded, folded — then the frames round those fitted again to
 * the boxes they became. What every write of the board goes through.
 */
export function settleGroups(
  board: Board,
  scaleOf: ScaleOf = UNIT_SCALE,
): Board {
  const fitted = fitGroups(board, scaleOf)
  const folded = foldGroups(fitted, scaleOf)
  return folded === fitted ? fitted : fitGroups(folded, scaleOf)
}

/**
 * Folds every collapsed group that is not folded yet, innermost first: what
 * it holds goes into its stash, and its node becomes the box. The same board
 * when there is none.
 */
export function foldGroups(board: Board, scaleOf: ScaleOf = UNIT_SCALE): Board {
  let next = board
  for (;;) {
    const pending = next.nodes.filter(
      (node): node is GroupNode =>
        node.type === 'group' && node.collapsed === true && !node.stash,
    )
    // Innermost first: one that holds another pending one waits for it.
    const ready = pending.find(
      (group) =>
        !nodesInsideGroup(group, next.nodes).some((id) =>
          pending.some((other) => other.id === id),
        ),
    )
    if (!ready) return next
    next = foldGroup(next, ready.id, scaleOf)
  }
}

function foldGroup(board: Board, id: NodeId, scaleOf: ScaleOf): Board {
  const group = board.nodes.find((node) => node.id === id)
  if (group?.type !== 'group' || group.stash) return board
  const inside = new Set(nodesInsideGroup(group, board.nodes))
  const stashNodes = board.nodes.filter((node) => inside.has(node.id))
  const stashEdges: Edge[] = []
  const edges: Edge[] = []
  for (const edge of board.edges) {
    const from = inside.has(edge.fromNode)
    const to = inside.has(edge.toNode)
    if (from && to) {
      stashEdges.push(edge)
      continue
    }
    if (!from && !to) {
      edges.push(edge)
      continue
    }
    edges.push({
      ...edge,
      ...(from
        ? { fromNode: id, fromMember: edge.fromMember ?? edge.fromNode }
        : {}),
      ...(to ? { toNode: id, toMember: edge.toMember ?? edge.toNode } : {}),
    })
  }
  const stash: GroupStash = {
    frame: { x: group.x, y: group.y, w: group.w, h: group.h },
    nodes: stashNodes,
    edges: stashEdges,
  }
  const size = collapsedGroupSize(
    groupMemberCount({ ...group, stash }, board.nodes),
    scaleOf(id),
  )
  const nodes = board.nodes.flatMap((node): BoardNode[] => {
    if (inside.has(node.id)) return []
    if (node.id !== id) return [node]
    return [{ ...group, ...size, stash }]
  })
  return { ...board, nodes, edges }
}

/**
 * Brings back what folded group `id` put away, where it was relative to the
 * box: moved by however far the box's corner is from where the frame's was.
 * The group is the frame again, expanded — or, with `keepCollapsed`, still
 * marked collapsed, which is how the file has it. Edges drawn to the box
 * reach what they really reach again, or the box of a group that still has
 * it put away.
 */
export function unfoldGroup(
  board: Board,
  id: NodeId,
  keepCollapsed = false,
): Board {
  const index = board.nodes.findIndex((node) => node.id === id)
  const group = board.nodes[index]
  if (!isFolded(group)) return board
  const { stash, collapsed: _collapsed, ...rest } = group
  const dx = group.x - stash.frame.x
  const dy = group.y - stash.frame.y
  const restored = stash.nodes.map((node) => translateNode(node, dx, dy))
  // Its own range moved with the box (operations.ts's `moveNodes`); what
  // it put away did not.
  const opened: GroupNode = {
    ...rest,
    x: stash.frame.x + dx,
    y: stash.frame.y + dy,
    w: stash.frame.w,
    h: stash.frame.h,
    ...(keepCollapsed ? { collapsed: true } : {}),
  }
  const nodes = [
    ...board.nodes.slice(0, index),
    opened,
    ...restored,
    ...board.nodes.slice(index + 1),
  ]
  const next: Board = { ...board, nodes, edges: board.edges }
  const carrier = carrierOf(next)
  const edges = [...board.edges, ...stash.edges].map((edge) => {
    const from =
      edge.fromNode === id && edge.fromMember !== undefined
        ? edge.fromMember
        : null
    const to =
      edge.toNode === id && edge.toMember !== undefined ? edge.toMember : null
    if (from === null && to === null) return edge
    return withEnds(edge, from, to, carrier)
  })
  return { ...next, edges }
}

/** Every folded group opened back out, outermost first, still marked
 * collapsed — the file's shape of what they hold. */
export function unfoldAllGroups(board: Board): Board {
  let next = board
  for (;;) {
    const folded = next.nodes.find(isFolded)
    if (!folded) return next
    next = unfoldGroup(next, folded.id, true)
  }
}

/** Expands folded group `id` for good: the group open on the board, what it
 * holds back where it was. */
export function expandGroup(board: Board, id: NodeId): Board {
  return unfoldGroup(board, id, false)
}

/** Marks group `id` collapsed, to be folded when the board is next settled
 * (`settleGroups`). The same board for one already collapsed. */
export function collapseGroup(board: Board, id: NodeId): Board {
  let changed = false
  const nodes = board.nodes.map((node) => {
    if (node.id !== id || node.type !== 'group' || node.collapsed) return node
    changed = true
    return { ...node, collapsed: true }
  })
  return changed ? { ...board, nodes } : board
}

/** For a node put away, the folded group on the board drawn in its place —
 * the outermost one it is put away in; for one on the board, itself. */
function carrierOf(board: Board): (id: NodeId) => NodeId | null {
  const where = new Map<NodeId, NodeId>()
  for (const node of board.nodes) {
    where.set(node.id, node.id)
    if (!isFolded(node)) continue
    for (const id of stashedIds(node.stash)) where.set(id, node.id)
  }
  return (id) => where.get(id) ?? null
}

function stashedIds(stash: GroupStash): NodeId[] {
  const ids: NodeId[] = []
  for (const node of stash.nodes) {
    ids.push(node.id)
    if (isFolded(node)) ids.push(...stashedIds(node.stash))
  }
  return ids
}

/** An edge with an end that really reaches `from` (or `to`), drawn to what
 * is on the board in its place. */
function withEnds(
  edge: Edge,
  from: NodeId | null,
  to: NodeId | null,
  carrier: (id: NodeId) => NodeId | null,
): Edge {
  const { fromMember: _fromMember, toMember: _toMember, ...base } = edge
  const end = (
    real: NodeId | null,
    node: NodeId,
    member: NodeId | undefined,
  ): Readonly<{ node: NodeId; member?: NodeId }> => {
    if (real === null) {
      return member === undefined ? { node } : { node, member }
    }
    const shown = carrier(real) ?? real
    return shown === real ? { node: real } : { node: shown, member: real }
  }
  const f = end(from, edge.fromNode, edge.fromMember)
  const t = end(to, edge.toNode, edge.toMember)
  return {
    ...base,
    fromNode: f.node,
    toNode: t.node,
    ...(f.member === undefined ? {} : { fromMember: f.member }),
    ...(t.member === undefined ? {} : { toMember: t.member }),
  }
}

/** `node` moved by `dx`, `dy` — and with it everything it carries in its
 * own fields: a group's hand-set range and what it put away, a spread
 * title's reader card. */
function translateNode(node: BoardNode, dx: number, dy: number): BoardNode {
  if (dx === 0 && dy === 0) return node
  const moved = { ...node, x: node.x + dx, y: node.y + dy }
  if (moved.type === 'file' && moved.readerRect) {
    const reader = moved.readerRect
    return {
      ...moved,
      readerRect: { ...reader, x: reader.x + dx, y: reader.y + dy },
    }
  }
  if (moved.type !== 'group') return moved
  const { bounds, stash } = moved
  return {
    ...moved,
    ...(bounds
      ? { bounds: { ...bounds, x: bounds.x + dx, y: bounds.y + dy } }
      : {}),
    ...(stash
      ? {
          stash: {
            ...stash,
            frame: {
              ...stash.frame,
              x: stash.frame.x + dx,
              y: stash.frame.y + dy,
            },
            nodes: stash.nodes.map((inner) => translateNode(inner, dx, dy)),
          },
        }
      : {}),
  }
}
