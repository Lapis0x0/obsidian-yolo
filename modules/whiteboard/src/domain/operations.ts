// Structured board operations — the six primitives (`addCard`, `updateCard`,
// `removeCard`, `moveCard`, `addEdge`, `removeEdge`) that are the *only*
// sanctioned way to change a Board in 1.0 (docs/plans/08-25-yolo-whiteboard/
// p1-design.md §1.1). This is also the land for the AI-driven editing
// primitives promised for a later milestone, so keep this the single choke
// point for board mutation rather than letting callers hand-edit `Board`
// object literals.
//
// All operations are pure and immutable: each returns a new `Board`. A
// card/edge object that isn't touched by the operation keeps its original
// reference (mirrors the repository's chat-state invariant — "an object's
// reference changes if and only if its content changes"). Invalid input
// (an id that doesn't exist, a duplicate id, an edge pointing at a missing
// card, …) throws a descriptive Error rather than silently no-oping.

import type { Board, BoardCard, CardId, Edge, EdgeId } from './fileFormat'

/** Fields `updateCard` may patch. `id`/`type` are immutable — see `updateCard`. */
export type CardPatch = Readonly<{
  x?: number
  y?: number
  w?: number
  h?: number
  file?: string
  markdown?: string
  page?: number
}>

export function addCard(board: Board, card: BoardCard): Board {
  if (!card.id) throw new Error('addCard: card id must be non-empty')
  if (board.cards.some((existing) => existing.id === card.id)) {
    throw new Error(`addCard: duplicate card id "${card.id}"`)
  }
  return { ...board, cards: [...board.cards, card] }
}

export function updateCard(board: Board, id: CardId, patch: CardPatch): Board {
  if ('id' in patch || 'type' in patch) {
    throw new Error('updateCard: patch must not include "id" or "type"')
  }
  const index = board.cards.findIndex((card) => card.id === id)
  if (index === -1) throw new Error(`updateCard: card "${id}" not found`)

  const current = board.cards[index]
  const next = { ...current, ...patch } as BoardCard
  if (shallowEqual(current, next)) return board

  const cards = board.cards.slice()
  cards[index] = next
  return { ...board, cards }
}

export function removeCard(board: Board, id: CardId): Board {
  if (!board.cards.some((card) => card.id === id)) {
    throw new Error(`removeCard: card "${id}" not found`)
  }
  const cards = board.cards.filter((card) => card.id !== id)
  const hasIncidentEdges = board.edges.some((edge) => edge.from === id || edge.to === id)
  const edges = hasIncidentEdges
    ? board.edges.filter((edge) => edge.from !== id && edge.to !== id)
    : board.edges
  return { ...board, cards, edges }
}

/** Batch-moves the given cards by (dx, dy); no-op input returns the same board. */
export function moveCard(
  board: Board,
  ids: readonly CardId[],
  dx: number,
  dy: number,
): Board {
  if (ids.length === 0 || (dx === 0 && dy === 0)) return board
  const idSet = new Set(ids)
  for (const id of idSet) {
    if (!board.cards.some((card) => card.id === id)) {
      throw new Error(`moveCard: card "${id}" not found`)
    }
  }
  const cards = board.cards.map((card) =>
    idSet.has(card.id) ? { ...card, x: card.x + dx, y: card.y + dy } : card,
  )
  return { ...board, cards }
}

export function addEdge(board: Board, edge: Edge): Board {
  if (!edge.id) throw new Error('addEdge: edge id must be non-empty')
  if (board.edges.some((existing) => existing.id === edge.id)) {
    throw new Error(`addEdge: duplicate edge id "${edge.id}"`)
  }
  if (!board.cards.some((card) => card.id === edge.from)) {
    throw new Error(`addEdge: "from" card "${edge.from}" not found`)
  }
  if (!board.cards.some((card) => card.id === edge.to)) {
    throw new Error(`addEdge: "to" card "${edge.to}" not found`)
  }
  return { ...board, edges: [...board.edges, edge] }
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
