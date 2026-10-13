// Portals: a card onto another board, through which that board's cards are
// seen — and worked on — at this board's scale.
//
// A portal is a file node whose file is a `.yoloboard` (domain/naming.ts's
// `board` kind). Its `view` is the point of the other board at its top-left
// corner, so the card's size is how much of that board it shows.
//
// On the board, what is behind a portal is nodes like any other: each of the
// other board's nodes is put on this board — moved by where the portal is,
// and named by the way in (`portal/card`, domain/nodePath.ts) — right after
// the portal, so it is drawn over it. Selecting, dragging, editing, colouring,
// deleting and connecting a card behind a portal is then what doing it to any
// card is. That is `composeBoard`: the board the canvas works on, made from
// this board's own file and the files behind its portals.
//
// What is done to that board goes back to the files it was made from:
// `changesBetween` sorts what changed by the file it belongs to, in that
// file's own terms — ids without the way in, positions without the portal's
// — and `applyChanges` puts a file's changes on it. Changes rather than
// boards, because a board behind a portal may be shown, and worked on,
// somewhere else too (its own tab, another portal), and a change puts back
// only what it touched.
//
// Pure: which portals are opened, and what is behind them, is the caller's to
// say (`PortalExpansion`).

import type {
  Board,
  BoardNode,
  Edge,
  EdgeId,
  FileNode,
  NodeId,
} from './fileFormat'
import { NODE_PATH_SEPARATOR } from './fileFormat'
import { fileNodeKind } from './naming'

export type Rect = Readonly<{ x: number; y: number; w: number; h: number }>

/** Whether `node` is a portal: a card onto another board. */
export function isPortal(node: BoardNode | undefined): node is FileNode {
  return node?.type === 'file' && fileNodeKind(node.file) === 'board'
}

/**
 * The board behind a portal, to put on the board in its place — null to leave
 * it shut. `id` is the portal's id on the board being made (the way in, for a
 * portal behind another), and `ancestors` the files already passed through to
 * reach it, this board's own first.
 */
export type PortalExpansion = (
  portal: FileNode,
  id: NodeId,
  ancestors: readonly string[],
) => Board | null

/** A portal opened on a composed board. */
export type ComposedPortal = Readonly<{
  /** The portal's id on the composed board. */
  id: NodeId
  /** The board file behind it. */
  file: string
  /** That board, as it was put on this one. */
  source: Board
  /** Where its world is, on this board's: add to a position behind it. */
  dx: number
  dy: number
  /** What of this board it can be seen through: its card, inside every
   * portal it is itself behind. */
  clip: Rect
  /** The portal it is behind, if any. */
  parent: NodeId | null
}>

export type Composition = Readonly<{
  board: Board
  /** The portals opened, by their id on `board`. */
  portals: ReadonlyMap<NodeId, ComposedPortal>
}>

/** The point of the board behind `portal` at its top-left corner: its
 * `view`, or the top-left of everything on that board. */
export function portalView(
  portal: FileNode,
  behind: Board,
): Readonly<{ x: number; y: number }> {
  if (portal.view) return portal.view
  let x = Infinity
  let y = Infinity
  for (const node of behind.nodes) {
    x = Math.min(x, node.x)
    y = Math.min(y, node.y)
  }
  return Number.isFinite(x) ? { x, y } : { x: 0, y: 0 }
}

/**
 * The board to work on: `own`, with what is behind each portal `expand`
 * opens put on it — portals behind portals too. A board already on the way
 * in is not opened again: a board with a portal onto itself, or two that
 * show each other, would otherwise go on forever.
 */
export function composeBoard(
  own: Board,
  ownFile: string,
  expand: PortalExpansion,
): Composition {
  const portals = new Map<NodeId, ComposedPortal>()
  const nodes: BoardNode[] = []
  const edges: Edge[] = [...own.edges]
  const visit = (
    board: Board,
    prefix: string,
    dx: number,
    dy: number,
    clip: Rect | null,
    parent: NodeId | null,
    ancestors: readonly string[],
  ) => {
    for (const source of board.nodes) {
      const node = prefix === '' ? source : project(source, prefix, dx, dy)
      nodes.push(node)
      if (!isPortal(node)) continue
      if (ancestors.includes(node.file)) continue
      const behind = expand(node, node.id, ancestors)
      if (!behind) continue
      const view = portalView(node, behind)
      const frame = { x: node.x, y: node.y, w: node.w, h: node.h }
      const portal: ComposedPortal = {
        id: node.id,
        file: node.file,
        source: behind,
        dx: node.x - view.x,
        dy: node.y - view.y,
        clip: clip ? intersect(clip, frame) : frame,
        parent,
      }
      portals.set(node.id, portal)
      const inner = `${node.id}${NODE_PATH_SEPARATOR}`
      for (const edge of behind.edges) edges.push(projectEdge(edge, inner))
      visit(behind, inner, portal.dx, portal.dy, portal.clip, node.id, [
        ...ancestors,
        node.file,
      ])
    }
  }
  visit(own, '', 0, 0, null, null, [ownFile])
  return { board: { ...own, nodes, edges }, portals }
}

/** The portal `id` is behind on `composition`, the innermost one; null for
 * a node of the board's own. */
export function portalOf(
  id: NodeId,
  portals: ReadonlyMap<NodeId, ComposedPortal>,
): ComposedPortal | null {
  let end = id.lastIndexOf(NODE_PATH_SEPARATOR)
  while (end > 0) {
    const portal = portals.get(id.slice(0, end))
    if (portal) return portal
    end = id.lastIndexOf(NODE_PATH_SEPARATOR, end - 1)
  }
  return null
}

/**
 * Where what is behind `portal` shows, with every portal on the way in at
 * the rectangle `frameOf` gives it — for frames a gesture holds somewhere
 * they have not been put down yet. With each one's own rectangle it is
 * `portal.clip`.
 */
export function clipThrough(
  portal: ComposedPortal,
  portals: ReadonlyMap<NodeId, ComposedPortal>,
  frameOf: (id: NodeId) => Rect,
): Rect {
  const frame = frameOf(portal.id)
  const parent =
    portal.parent === null ? null : (portals.get(portal.parent) ?? null)
  return parent
    ? intersect(clipThrough(parent, portals, frameOf), frame)
    : frame
}

/** What of `node` shows through `clip` (null: all of it) — null when
 * nothing does. */
export function shownPart(
  node: Readonly<{ id: NodeId }> & Rect,
  clip: Rect | null,
): (Readonly<{ id: NodeId }> & Rect) | null {
  if (!clip) return node
  const part = intersect(node, clip)
  return part.w > 0 && part.h > 0 ? { id: node.id, ...part } : null
}

/** Where the portal `id` and the other end of an edge meet: the innermost
 * portal both are behind, whose board the edge belongs to. */
export function commonPortal(
  a: NodeId,
  b: NodeId,
  portals: ReadonlyMap<NodeId, ComposedPortal>,
): ComposedPortal | null {
  let portal = portalOf(a, portals)
  while (portal) {
    if (b.startsWith(`${portal.id}${NODE_PATH_SEPARATOR}`)) return portal
    portal =
      portal.parent === null ? null : (portals.get(portal.parent) ?? null)
  }
  return null
}

// --- projection ----------------------------------------------------------

/** Projections made, by what they were made of: so the same node seen from
 * the same place is the same object, and the board's identity rule — an
 * object's reference changes if and only if its content does — holds for
 * what is behind a portal too. A few per node: one board may be behind
 * several portals. */
const projected = new WeakMap<object, Map<string, object>>()
const PROJECTIONS_PER_SOURCE = 4

function remember<T extends object>(source: object, key: string, made: T): T {
  let known = projected.get(source)
  if (!known) {
    known = new Map()
    projected.set(source, known)
  }
  known.set(key, made)
  if (known.size > PROJECTIONS_PER_SOURCE) {
    known.delete(known.keys().next().value as string)
  }
  return made
}

function recall<T extends object>(source: object, key: string): T | undefined {
  return projected.get(source)?.get(key) as T | undefined
}

function project(
  node: BoardNode,
  prefix: string,
  dx: number,
  dy: number,
): BoardNode {
  const key = `${prefix}\u0000${dx}\u0000${dy}`
  const known = recall<BoardNode>(node, key)
  if (known) return known
  const moved = {
    ...node,
    id: `${prefix}${node.id}`,
    x: node.x + dx,
    y: node.y + dy,
  }
  return remember(
    node,
    key,
    moved.type === 'pdf-page'
      ? { ...moved, parent: `${prefix}${moved.parent}` }
      : moved,
  )
}

function projectEdge(edge: Edge, prefix: string): Edge {
  const known = recall<Edge>(edge, prefix)
  if (known) return known
  return remember(edge, prefix, {
    ...edge,
    id: `${prefix}${edge.id}`,
    fromNode: `${prefix}${edge.fromNode}`,
    toNode: `${prefix}${edge.toNode}`,
  })
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
}

// --- changes -------------------------------------------------------------

/** One node, or edge, changed: what it was and what it is, in its own
 * file's terms; null where there was, or is, none. `index` is where it
 * stands among its file's nodes after the change — or, for one removed,
 * stood before it. */
export type Change<T> = Readonly<{
  before: T | null
  after: T | null
  index: number
}>

export type FileChanges = Readonly<{
  nodes: ReadonlyMap<NodeId, Change<BoardNode>>
  edges: ReadonlyMap<EdgeId, Change<Edge>>
}>

/** What changed, by file. */
export type BoardChanges = ReadonlyMap<string, FileChanges>

type MutableFileChanges = {
  nodes: Map<NodeId, Change<BoardNode>>
  edges: Map<EdgeId, Change<Edge>>
}

/**
 * What going from `before` to `after` — a board made from `before` by an edit
 * — changed in each file it was made from. A node behind a portal that was
 * moved only because its portal was (dragged with it) is no change: the
 * portal's own move is.
 *
 * What is behind a portal `after` no longer has is not anybody's change: the
 * portal was removed, not the board behind it.
 */
export function changesBetween(
  before: Composition,
  after: Board,
  ownFile: string,
): BoardChanges {
  const changes = new Map<string, MutableFileChanges>()
  const forFile = (file: string) => {
    let known = changes.get(file)
    if (!known) {
      known = { nodes: new Map(), edges: new Map() }
      changes.set(file, known)
    }
    return known
  }
  const afterById = new Map(after.nodes.map((node) => [node.id, node]))
  // The portals still on the board, where `after` has them.
  const offsets = new Map<NodeId, Readonly<{ dx: number; dy: number }>>()
  const live = (portal: ComposedPortal | null): boolean => {
    for (let at = portal; at; ) {
      if (!afterById.has(at.id)) return false
      at = at.parent === null ? null : (before.portals.get(at.parent) ?? null)
    }
    return true
  }
  const offsetOf = (portal: ComposedPortal) => {
    let known = offsets.get(portal.id)
    if (!known) {
      const node = afterById.get(portal.id)
      if (node && isPortal(node)) {
        const view = portalView(node, portal.source)
        known = { dx: node.x - view.x, dy: node.y - view.y }
      } else {
        known = { dx: portal.dx, dy: portal.dy }
      }
      offsets.set(portal.id, known)
    }
    return known
  }
  const sourceIndex = (board: Board, id: NodeId) =>
    board.nodes.findIndex((node) => node.id === id)

  const beforeById = new Map(before.board.nodes.map((node) => [node.id, node]))
  const afterIndex = new Map<NodeId, number>()
  const counts = new Map<string, number>()
  for (const node of after.nodes) {
    const portal = portalOf(node.id, before.portals)
    if (!live(portal)) continue
    const file = portal ? portal.file : ownFile
    const index = counts.get(file) ?? 0
    counts.set(file, index + 1)
    afterIndex.set(node.id, index)
  }

  for (const node of after.nodes) {
    const was = beforeById.get(node.id)
    if (was === node) continue
    const portal = portalOf(node.id, before.portals)
    if (!live(portal)) continue
    const index = afterIndex.get(node.id) ?? -1
    if (!portal) {
      forFile(ownFile).nodes.set(node.id, {
        before: was ?? null,
        after: node,
        index,
      })
      continue
    }
    const { dx, dy } = offsetOf(portal)
    const id = node.id.slice(portal.id.length + 1)
    const source = portal.source.nodes.find((known) => known.id === id) ?? null
    const own = unproject(node, portal.id, dx, dy)
    if (source && sameNode(source, own)) continue
    forFile(portal.file).nodes.set(id, { before: source, after: own, index })
    // The board made again from its files gives back what `after` has.
    remember(
      own,
      `${portal.id}${NODE_PATH_SEPARATOR}\u0000${dx}\u0000${dy}`,
      node,
    )
  }

  for (const was of before.board.nodes) {
    if (afterById.has(was.id)) continue
    const portal = portalOf(was.id, before.portals)
    if (!live(portal)) continue
    if (!portal) {
      forFile(ownFile).nodes.set(was.id, {
        before: was,
        after: null,
        index: sourceIndex(before.board, was.id),
      })
      continue
    }
    const id = was.id.slice(portal.id.length + 1)
    const source = portal.source.nodes.find((known) => known.id === id)
    if (!source) continue
    forFile(portal.file).nodes.set(id, {
      before: source,
      after: null,
      index: sourceIndex(portal.source, id),
    })
  }

  const beforeEdges = new Map(before.board.edges.map((edge) => [edge.id, edge]))
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]))
  const edgeHome = (edge: Edge) =>
    commonPortal(edge.fromNode, edge.toNode, before.portals)
  after.edges.forEach((edge, index) => {
    const was = beforeEdges.get(edge.id)
    if (was === edge) return
    const portal = edgeHome(edge)
    if (!live(portal)) return
    if (!portal) {
      forFile(ownFile).edges.set(edge.id, {
        before: was ?? null,
        after: edge,
        index,
      })
      return
    }
    const inner = `${portal.id}${NODE_PATH_SEPARATOR}`
    const own = unprojectEdge(edge, inner)
    const source =
      portal.source.edges.find((known) => known.id === own.id) ?? null
    if (source && sameEdge(source, own)) return
    forFile(portal.file).edges.set(own.id, {
      before: was ? source : null,
      after: own,
      index,
    })
  })
  before.board.edges.forEach((was, index) => {
    if (afterEdges.has(was.id)) return
    const portal = edgeHome(was)
    if (!live(portal)) return
    if (!portal) {
      forFile(ownFile).edges.set(was.id, { before: was, after: null, index })
      return
    }
    const inner = `${portal.id}${NODE_PATH_SEPARATOR}`
    const own = unprojectEdge(was, inner)
    const source = portal.source.edges.find((known) => known.id === own.id)
    if (!source) return
    forFile(portal.file).edges.set(own.id, {
      before: source,
      after: null,
      index: portal.source.edges.indexOf(source),
    })
  })

  for (const [file, known] of changes) {
    if (known.nodes.size === 0 && known.edges.size === 0) changes.delete(file)
  }
  return changes
}

/** `changes` put on `board`: forward, what they made it; back, what it was
 * before them. Only what they touched is touched. */
export function applyChanges(
  board: Board,
  changes: FileChanges,
  direction: 'forward' | 'back' = 'forward',
): Board {
  const nodes = applyTo(board.nodes, changes.nodes, direction, (n) => n.id)
  const edges = applyTo(board.edges, changes.edges, direction, (e) => e.id)
  if (nodes === board.nodes && edges === board.edges) return board
  // An edge left reaching a node no longer there would be dropped on the
  // next read of the file; it is dropped now.
  const ids = new Set(nodes.map((node) => node.id))
  const reaches = (id: NodeId) =>
    ids.has(id) || ids.has(id.split(NODE_PATH_SEPARATOR)[0])
  const kept = edges.filter(
    (edge) => reaches(edge.fromNode) && reaches(edge.toNode),
  )
  return {
    ...board,
    nodes,
    edges: kept.length === edges.length ? edges : kept,
  }
}

/** Changes the other way round: what undoes them. */
export function invertChanges(changes: BoardChanges): BoardChanges {
  const inverted = new Map<string, FileChanges>()
  for (const [file, { nodes, edges }] of changes) {
    inverted.set(file, {
      nodes: invertMap(nodes),
      edges: invertMap(edges),
    })
  }
  return inverted
}

/** Two sets of changes, one after the other, as one: what is touched by
 * both keeps where it started and where it ended. */
export function mergeChanges(
  first: BoardChanges,
  then: BoardChanges,
): BoardChanges {
  const merged = new Map<string, FileChanges>(first)
  for (const [file, next] of then) {
    const earlier = merged.get(file)
    if (!earlier) {
      merged.set(file, next)
      continue
    }
    merged.set(file, {
      nodes: mergeMaps(earlier.nodes, next.nodes),
      edges: mergeMaps(earlier.edges, next.edges),
    })
  }
  return merged
}

function invertMap<K, T>(
  changes: ReadonlyMap<K, Change<T>>,
): Map<K, Change<T>> {
  const inverted = new Map<K, Change<T>>()
  for (const [id, change] of changes) {
    inverted.set(id, {
      before: change.after,
      after: change.before,
      index: change.index,
    })
  }
  return inverted
}

function mergeMaps<K, T>(
  first: ReadonlyMap<K, Change<T>>,
  then: ReadonlyMap<K, Change<T>>,
): Map<K, Change<T>> {
  const merged = new Map(first)
  for (const [id, change] of then) {
    const earlier = merged.get(id)
    merged.set(
      id,
      earlier
        ? { before: earlier.before, after: change.after, index: change.index }
        : change,
    )
  }
  return merged
}

function applyTo<T, K>(
  items: readonly T[],
  changes: ReadonlyMap<K, Change<T>>,
  direction: 'forward' | 'back',
  idOf: (item: T) => K,
): readonly T[] {
  if (changes.size === 0) return items
  const out = items.filter((item) => {
    const change = changes.get(idOf(item))
    return !change || (direction === 'forward' ? change.after : change.before)
  })
  const at = new Map<K, number>()
  out.forEach((item, index) => at.set(idOf(item), index))
  const inserts: { index: number; item: T }[] = []
  for (const [id, change] of changes) {
    const target = direction === 'forward' ? change.after : change.before
    if (!target) continue
    const index = at.get(id)
    if (index !== undefined) out[index] = target
    else inserts.push({ index: change.index, item: target })
  }
  inserts.sort((a, b) => a.index - b.index)
  for (const { index, item } of inserts) {
    out.splice(index < 0 ? out.length : Math.min(index, out.length), 0, item)
  }
  return out
}

function unproject(
  node: BoardNode,
  portalId: NodeId,
  dx: number,
  dy: number,
): BoardNode {
  const strip = (id: NodeId) => id.slice(portalId.length + 1)
  const moved = { ...node, id: strip(node.id), x: node.x - dx, y: node.y - dy }
  return moved.type === 'pdf-page' && moved.parent.startsWith(`${portalId}/`)
    ? { ...moved, parent: strip(moved.parent) }
    : moved
}

function unprojectEdge(edge: Edge, prefix: string): Edge {
  const strip = (id: string) =>
    id.startsWith(prefix) ? id.slice(prefix.length) : id
  return {
    ...edge,
    id: strip(edge.id),
    fromNode: strip(edge.fromNode),
    toNode: strip(edge.toNode),
  }
}

function sameNode(a: BoardNode, b: BoardNode): boolean {
  return shallowEqual(a, b)
}

function sameEdge(a: Edge, b: Edge): boolean {
  return shallowEqual(a, b)
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  return ka.every((key) => ra[key] === rb[key])
}
