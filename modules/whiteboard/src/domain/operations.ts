// Structured board operations — the primitives (`addNode`, `updateNode`,
// `replaceNode`, `removeNode`, `moveNodes`, `addEdge`, `updateEdge`,
// `removeEdge`) that are
// the *only* sanctioned way to change a Board in 1.0
// (docs/plans/08-25-yolo-whiteboard/p1-design.md §1.1). This is also the land for the AI-driven editing
// primitives promised for a later milestone, so keep this the single choke
// point for board mutation rather than letting callers hand-edit `Board`
// object literals.
//
// All operations are pure and immutable: each returns a new `Board`. A
// node/edge object that isn't touched by the operation keeps its original
// reference (mirrors the repository's chat-state invariant — "an object's
// reference changes if and only if its content changes"). Invalid input
// (an id that doesn't exist, a duplicate id, an edge pointing at a missing
// node, …) throws a descriptive Error rather than silently no-oping.

import type {
  Board,
  BoardNode,
  Edge,
  EdgeEnd,
  EdgeId,
  NodeColor,
  NodeId,
  NodeSide,
} from './fileFormat'

/** Fields `updateNode` may patch. `id`/`type` are immutable — see `updateNode`. */
export type NodePatch = Readonly<{
  x?: number
  y?: number
  w?: number
  h?: number
  color?: NodeColor
  file?: string
  text?: string
  label?: string
}>

/** Fields `updateEdge` may patch: where an edge is attached, and everything
 * about how it reads — its arrowheads, its colour, its label. */
export type EdgePatch = Readonly<{
  fromNode?: NodeId
  toNode?: NodeId
  fromSide?: NodeSide
  toSide?: NodeSide
  fromEnd?: EdgeEnd
  toEnd?: EdgeEnd
  color?: NodeColor
  label?: string
}>

export function addNode(board: Board, node: BoardNode): Board {
  if (!node.id) throw new Error('addNode: node id must be non-empty')
  if (board.nodes.some((existing) => existing.id === node.id)) {
    throw new Error(`addNode: duplicate node id "${node.id}"`)
  }
  return { ...board, nodes: [...board.nodes, node] }
}

export function updateNode(board: Board, id: NodeId, patch: NodePatch): Board {
  if ('id' in patch || 'type' in patch) {
    throw new Error('updateNode: patch must not include "id" or "type"')
  }
  const index = board.nodes.findIndex((node) => node.id === id)
  if (index === -1) throw new Error(`updateNode: node "${id}" not found`)

  const current = board.nodes[index]
  const next = { ...current, ...patch } as BoardNode
  if (shallowEqual(current, next)) return board

  const nodes = board.nodes.slice()
  nodes[index] = next
  return { ...board, nodes }
}

/**
 * Swaps one node for another that keeps its id — the "same node, different
 * identity" operation, used when a text node is converted into a file node.
 *
 * `updateNode` cannot express it (`id` and `type` are immutable there) and
 * remove-then-add cannot either: `removeNode` cascades edge removal, so a
 * node that was wired to three others would come back an island. Position
 * and edges are untouched here by construction — only the node object at
 * that index changes.
 *
 * Deliberately general rather than a `convertNodeToFile`: further
 * conversions will follow (a file node demoted back to text, a node repointed
 * at another file), and one primitive per conversion would grow the operation
 * set without adding meaning.
 */
export function replaceNode(board: Board, id: NodeId, next: BoardNode): Board {
  if (next.id !== id) {
    throw new Error(
      `replaceNode: replacement id "${next.id}" must equal "${id}"`,
    )
  }
  const index = board.nodes.findIndex((node) => node.id === id)
  if (index === -1) throw new Error(`replaceNode: node "${id}" not found`)
  if (shallowEqual(board.nodes[index], next)) return board

  const nodes = board.nodes.slice()
  nodes[index] = next
  return { ...board, nodes }
}

export function removeNode(board: Board, id: NodeId): Board {
  if (!board.nodes.some((node) => node.id === id)) {
    throw new Error(`removeNode: node "${id}" not found`)
  }
  const nodes = board.nodes.filter((node) => node.id !== id)
  const hasIncidentEdges = board.edges.some(
    (edge) => edge.fromNode === id || edge.toNode === id,
  )
  const edges = hasIncidentEdges
    ? board.edges.filter((edge) => edge.fromNode !== id && edge.toNode !== id)
    : board.edges
  return { ...board, nodes, edges }
}

/** Batch-moves the given nodes by (dx, dy); no-op input returns the same board. */
export function moveNodes(
  board: Board,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): Board {
  if (ids.length === 0 || (dx === 0 && dy === 0)) return board
  const idSet = new Set(ids)
  for (const id of idSet) {
    if (!board.nodes.some((node) => node.id === id)) {
      throw new Error(`moveNodes: node "${id}" not found`)
    }
  }
  const nodes = board.nodes.map((node) =>
    idSet.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy } : node,
  )
  return { ...board, nodes }
}

/**
 * Moves nodes to absolute positions, each to its own.
 *
 * `moveNodes` cannot express this: it applies one shared delta, which is what
 * a drag is, whereas aligning or distributing a selection gives every node a
 * different destination. Doing it as a batch rather than a loop of
 * `updateNode` calls is what makes the whole rearrangement one board change,
 * and so one undo step.
 *
 * A node whose entry matches where it already is contributes nothing, and a
 * batch in which none of them moved returns the original board — so an align
 * that changes nothing records no history step.
 */
export function setNodePositions(
  board: Board,
  positions: ReadonlyMap<NodeId, Readonly<{ x: number; y: number }>>,
): Board {
  if (positions.size === 0) return board
  for (const id of positions.keys()) {
    if (!board.nodes.some((node) => node.id === id)) {
      throw new Error(`setNodePositions: node "${id}" not found`)
    }
  }
  let changed = false
  const nodes = board.nodes.map((node) => {
    const position = positions.get(node.id)
    if (!position || (position.x === node.x && position.y === node.y)) {
      return node
    }
    changed = true
    return { ...node, x: position.x, y: position.y }
  })
  return changed ? { ...board, nodes } : board
}

export function addEdge(board: Board, edge: Edge): Board {
  if (!edge.id) throw new Error('addEdge: edge id must be non-empty')
  if (board.edges.some((existing) => existing.id === edge.id)) {
    throw new Error(`addEdge: duplicate edge id "${edge.id}"`)
  }
  if (!board.nodes.some((node) => node.id === edge.fromNode)) {
    throw new Error(`addEdge: "fromNode" "${edge.fromNode}" not found`)
  }
  if (!board.nodes.some((node) => node.id === edge.toNode)) {
    throw new Error(`addEdge: "toNode" "${edge.toNode}" not found`)
  }
  return { ...board, edges: [...board.edges, edge] }
}

/**
 * Changes an edge: where an end is attached (what dragging a connection's
 * endpoint onto another node means), or how it reads — arrowheads, colour,
 * label, all written by the edge toolbar.
 */
export function updateEdge(board: Board, id: EdgeId, patch: EdgePatch): Board {
  const index = board.edges.findIndex((edge) => edge.id === id)
  if (index === -1) throw new Error(`updateEdge: edge "${id}" not found`)

  const current = board.edges[index]
  const next: Edge = { ...current, ...patch }
  for (const endpoint of [next.fromNode, next.toNode]) {
    if (!board.nodes.some((node) => node.id === endpoint)) {
      throw new Error(`updateEdge: node "${endpoint}" not found`)
    }
  }
  if (shallowEqual(current, next)) return board

  const edges = board.edges.slice()
  edges[index] = next
  return { ...board, edges }
}

export function removeEdge(board: Board, id: EdgeId): Board {
  if (!board.edges.some((edge) => edge.id === id)) {
    throw new Error(`removeEdge: edge "${id}" not found`)
  }
  return { ...board, edges: board.edges.filter((edge) => edge.id !== id) }
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => aRecord[key] === bRecord[key])
}
