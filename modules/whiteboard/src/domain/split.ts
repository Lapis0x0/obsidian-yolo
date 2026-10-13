// Moving part of a board to a board of its own ("移到新白板"), leaving a
// portal onto it where it was.
//
// The part keeps its coordinates in the new file, and the portal looks at
// exactly where it is — the portal's `view` is its own top-left — so nothing
// on screen moves: the cards are where they were, now behind a frame.
//
// What this returns is the board the canvas works on (domain/portals.ts's
// composed board) as it is after the move, and the new file's board. The
// file is written first; the board is then committed like any edit, and
// `changesBetween` takes it from there: the cards and the edges among them
// leave the file they were in, the portal arrives, and an edge with one end
// in the part now reaches it through the portal. Undoing that puts the cards
// back and leaves the new file, which this module never deletes.

import {
  type Board,
  type BoardNode,
  type Edge,
  type FileNode,
  NODE_PATH_SEPARATOR,
  type NodeId,
  emptyBoard,
} from './fileFormat'
import { groupRectForNodes } from './groups'
import {
  type Composition,
  commonPortal,
  isPortal,
  portalOf,
  tidy,
} from './portals'
import { isSpreadTitle } from './spread'

/** Where the part stands from the corner of its own board's screen when
 * that board is opened. */
const CONTENT_MARGIN = 80

export type Split = Readonly<{
  /** The board the canvas works on, the part gone and the portal there. */
  board: Board
  /** The new file's board. */
  content: Board
  /** The portal's id on the board. */
  portal: NodeId
}>

/**
 * Moves `ids` (and what is behind any portal among them) to the board in
 * `file`, behind a portal named `portalName` on the board they were on.
 * Every one of `ids` has to be on the same board — this one's own, or the
 * one behind a portal; the ones that are not, a PDF's spread, and a portal
 * onto a board the part is seen from (it would show itself) stay where they
 * are. Null when nothing is left to move.
 */
export function splitOff(
  board: Board,
  composition: Composition,
  ownFile: string,
  ids: readonly NodeId[],
  file: string,
  portalName: NodeId,
): Split | null {
  const { portals } = composition
  if (ids.length === 0) return null
  const home = portalOf(ids[0], portals)
  const homeId = home?.id ?? null
  const prefix = homeId === null ? '' : `${homeId}${NODE_PATH_SEPARATOR}`
  const dx = home?.dx ?? 0
  const dy = home?.dy ?? 0
  const scale = home?.scale ?? 1
  // Into the terms of the board it was on (domain/portals.ts's
  // `ComposedPortal`).
  const local = (value: number, offset: number) =>
    scale === 1 ? value - offset : tidy((value - offset) / scale)
  const seenFrom = new Set([ownFile, file])
  for (
    let at = home;
    at;
    at = at.parent === null ? null : (portals.get(at.parent) ?? null)
  ) {
    seenFrom.add(at.file)
  }

  const byId = new Map(board.nodes.map((node) => [node.id, node]))
  const moved = new Set<NodeId>()
  for (const id of ids) {
    const node = byId.get(id)
    if (!node || (portalOf(id, portals)?.id ?? null) !== homeId) continue
    if (node.type === 'pdf-page' || isSpreadTitle(node)) continue
    if (isPortal(node) && seenFrom.has(node.file)) continue
    moved.add(id)
  }
  // Behind a portal being moved: it goes with that portal's board.
  const rides = (id: NodeId) => {
    for (const portal of moved) {
      if (id.startsWith(`${portal}${NODE_PATH_SEPARATOR}`)) return true
    }
    return false
  }
  if (moved.size === 0) return null
  const part = board.nodes.filter((node) => moved.has(node.id))
  const frame = groupRectForNodes(part)
  if (!frame) return null

  const portalId = `${prefix}${portalName}`
  const view = {
    x: local(Math.round(frame.x), dx),
    y: local(Math.round(frame.y), dy),
  }
  const portal: FileNode = {
    id: portalId,
    type: 'file',
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    file,
    // What the portal looks at is the file's own coordinates, which are the
    // board's it was on.
    view,
    extra: {},
  }

  // In the file: as they were on the board they were on.
  const localId = (id: NodeId) => id.slice(prefix.length)
  const contentNodes: BoardNode[] = part.map((node) => ({
    ...node,
    id: localId(node.id),
    x: local(node.x, dx),
    y: local(node.y, dy),
    w: local(node.w, 0),
    h: local(node.h, 0),
  }))

  const inPart = (id: NodeId) => moved.has(id) || rides(id)
  // An end in the part is reached through the portal now.
  const through = (id: NodeId) =>
    inPart(id) ? `${portalId}${NODE_PATH_SEPARATOR}${localId(id)}` : id
  const contentEdges: Edge[] = []
  const edges: Edge[] = []
  for (const edge of board.edges) {
    const from = inPart(edge.fromNode)
    const to = inPart(edge.toNode)
    if (!from && !to) {
      edges.push(edge)
      continue
    }
    const edgeHome =
      commonPortal(edge.fromNode, edge.toNode, portals)?.id ?? null
    // On the board behind a portal in the part: it goes with that board.
    if (edgeHome !== null && inPart(edgeHome)) continue
    if (from && to && edgeHome === homeId) {
      contentEdges.push({
        ...edge,
        id: localId(edge.id),
        fromNode: localId(edge.fromNode),
        toNode: localId(edge.toNode),
      })
      continue
    }
    edges.push({
      ...edge,
      fromNode: through(edge.fromNode),
      toNode: through(edge.toNode),
    })
  }

  // The portal stands where the part's lowest card stood.
  const nodes: BoardNode[] = []
  let placed = false
  for (const node of board.nodes) {
    if (inPart(node.id)) {
      if (!placed && moved.has(node.id)) {
        nodes.push(portal)
        placed = true
      }
      continue
    }
    nodes.push(node)
  }

  return {
    board: { ...board, nodes, edges },
    content: {
      ...emptyBoard(),
      // Opened on its own, it opens on the part.
      camera: {
        x: CONTENT_MARGIN - view.x,
        y: CONTENT_MARGIN - view.y,
        scale: 1,
      },
      nodes: contentNodes,
      edges: contentEdges,
    },
    portal: portalId,
  }
}
