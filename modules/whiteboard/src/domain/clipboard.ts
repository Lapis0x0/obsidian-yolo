// What copy and paste carry: a piece of a board, in the format Obsidian
// Canvas puts on the clipboard.
//
// Canvas writes its selection under the `obsidian/canvas` type as
// `{ nodes, edges, center }` — JSON Canvas nodes and edges, and the centre of
// their bounding box — and reads the same thing back on paste (measured off
// its running 1.13.7 build: `handleCopy`/`handlePaste`). Speaking that format
// rather than one of our own is what lets a board and a Canvas trade cards in
// both directions, and costs nothing: a board node *is* a JSON Canvas node
// with `w`/`h` for `width`/`height` (fileFormat.ts's header). Whatever a board
// knows and Canvas does not (a card's reading window) rides along as an
// unknown field, which each side keeps.
//
// Everything is decoded through `parseBoardValue`, the file format's own
// parser, so a pasted node is held to exactly the rules a node read from a
// file is. Zero dependencies beyond the domain, no DOM.

import type { ScreenPoint } from './camera'
import {
  type Board,
  type BoardNode,
  type Edge,
  type NodeId,
  parseBoardValue,
  serializeEdge,
  serializeNode,
} from './fileFormat'
import { nodesToDragWith } from './groups'
import { mintEdgeId, mintNodeId } from './ids'
import { addEdge, addNode } from './operations'
import { collapseBoard, expandBoard, pdfPageNodeId } from './spread'

/** The clipboard type Obsidian Canvas reads and writes. */
export const CANVAS_CLIPBOARD_TYPE = 'obsidian/canvas'

/** Some nodes and the edges between them — what one copy carries. Always in
 * the file's shape (domain/spread.ts): a spread is its PDF's node, never its
 * title and sheets, so a fragment reads the same on a Canvas as on a board. */
export type BoardFragment = Readonly<{
  nodes: readonly BoardNode[]
  edges: readonly Edge[]
}>

/**
 * What copying `selectedIds` takes: the selection, every node inside a
 * selected group, and each edge whose two ends are both taken.
 *
 * A group brings its contents because a group *is* what it frames — the same
 * membership a drag carries (groups.ts's `nodesToDragWith`). Canvas copies
 * the frame alone, which pastes an empty box. Nodes keep board order, so the
 * paste stacks the way the original did.
 */
export function fragmentFromSelection(
  board: Board,
  selectedIds: ReadonlySet<NodeId>,
): BoardFragment {
  const ids = new Set(nodesToDragWith(selectedIds, board.nodes))
  // A spread comes along whole or not at all: its title brings every sheet
  // (`nodesToDragWith`), and a sheet selected without it is part of a PDF that
  // is not being copied — the fold below drops it.
  const folded = collapseBoard({
    ...board,
    nodes: board.nodes.filter((node) => ids.has(node.id)),
    edges: board.edges.filter(
      (edge) => ids.has(edge.fromNode) && ids.has(edge.toNode),
    ),
  })
  return { nodes: folded.nodes, edges: folded.edges }
}

/** The fragment as Canvas's clipboard payload. */
export function serializeFragment(fragment: BoardFragment): string {
  return JSON.stringify({
    nodes: fragment.nodes.map((node) => {
      const { w, h, ...rest } = serializeNode(node)
      return { ...rest, width: w, height: h }
    }),
    edges: fragment.edges.map(serializeEdge),
    center: boundsCenter(fragment.nodes),
  })
}

/**
 * A clipboard payload as a fragment, or null when it holds no node this
 * board can take. A node or edge that does not parse is dropped, as it would
 * be from a file; `center` is not read — the bounds are recomputed from what
 * survived, which is what the paste has to be centred on anyway.
 */
export function parseFragment(raw: string): BoardFragment | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(json) || !Array.isArray(json.nodes)) return null
  const parsed = parseBoardValue({
    nodes: json.nodes.map((entry: unknown) => {
      if (!isPlainObject(entry)) return entry
      const { width, height, ...rest } = entry
      return { ...rest, w: width, h: height }
    }),
    edges: Array.isArray(json.edges) ? json.edges : [],
  })
  if (!parsed.ok || parsed.board.nodes.length === 0) return null
  return { nodes: parsed.board.nodes, edges: parsed.board.edges }
}

/**
 * What the fragment reads as outside a board: its text cards' markdown, one
 * paragraph each. The other kinds have no text of their own to give — a file
 * card's content is its file, a group's is its members.
 */
export function fragmentPlainText(fragment: BoardFragment): string {
  return fragment.nodes
    .flatMap((node) => (node.type === 'text' && node.text ? [node.text] : []))
    .join('\n\n')
}

/**
 * Adds a copy of `fragment` to `board`, centred on `at`: every node and edge
 * gets a fresh id, the layout is kept, and edges follow their nodes' new ids.
 * Returns the new board and the ids of the nodes placed, in fragment order.
 */
export function placeFragment(
  board: Board,
  fragment: BoardFragment,
  at: ScreenPoint,
): Readonly<{ board: Board; nodeIds: NodeId[] }> {
  // Placed in the board's shape, so an open spread lands as the title and
  // sheets it was copied as, and is centred on what was on screen.
  const opened = expandBoard({ ...board, ...fragment })
  const center = boundsCenter(opened.nodes)
  const dx = Math.round(at.x - center.x)
  const dy = Math.round(at.y - center.y)
  const idMap = new Map<NodeId, NodeId>()
  let next = board
  for (const node of opened.nodes) {
    const moved = { ...node, x: node.x + dx, y: node.y + dy }
    if (moved.type === 'pdf-page') {
      // Board order puts a title before its sheets, so its new id is known.
      const parent = idMap.get(moved.parent)
      if (parent === undefined) continue
      const id = pdfPageNodeId(parent, moved.page)
      idMap.set(node.id, id)
      next = addNode(next, { ...moved, id, parent })
      continue
    }
    const id = mintNodeId(next)
    idMap.set(node.id, id)
    if (moved.type === 'file' && moved.readerRect) {
      const reader = moved.readerRect
      next = addNode(next, {
        ...moved,
        id,
        readerRect: { ...reader, x: reader.x + dx, y: reader.y + dy },
      })
      continue
    }
    next = addNode(next, { ...moved, id })
  }
  for (const edge of opened.edges) {
    const fromNode = idMap.get(edge.fromNode)
    const toNode = idMap.get(edge.toNode)
    if (fromNode === undefined || toNode === undefined) continue
    next = addEdge(next, { ...edge, id: mintEdgeId(next), fromNode, toNode })
  }
  return {
    board: next,
    nodeIds: opened.nodes.flatMap((node) => {
      const id = idMap.get(node.id)
      return id === undefined ? [] : [id]
    }),
  }
}

/** The centre of the nodes' bounding box — where a fragment placed back at
 * it lands exactly on top of what it was copied from. */
export function boundsCenter(nodes: readonly BoardNode[]): ScreenPoint {
  if (nodes.length === 0) return { x: 0, y: 0 }
  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map((node) => node.x + node.w))
  const maxY = Math.max(...nodes.map((node) => node.y + node.h))
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
