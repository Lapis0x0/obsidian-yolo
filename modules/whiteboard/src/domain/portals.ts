// Portals: a card onto another board, through which that board's cards are
// seen — and worked on.
//
// A portal is a file node whose file is a `.yoloboard` (domain/naming.ts's
// `board` kind). Its `view` is the point of the other board at its top-left
// corner and how large that board is shown against this one, so the card's
// size is how much of that board it shows.
//
// On the board, what is behind a portal is nodes like any other: each of the
// other board's nodes is put on this board — placed by where the portal is
// and sized by its scale, and named by the way in (`portal/card`,
// domain/nodePath.ts) — right after the portal, so it is drawn over it. A
// card's rectangle on the board is where it is seen; what it holds is laid
// out at its own size and drawn at the portal's scale (ui/canvas/
// cardRenderer.ts). Selecting, dragging, editing, colouring,
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
import { isSpreadTitle } from './spread'

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
  /** How its world sits on this board's: a position behind it is
   * `local × scale + (dx, dy)` here, a length `local × scale` — `scale`
   * being every portal's on the way in, multiplied. */
  dx: number
  dy: number
  scale: number
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

/**
 * How much heavier what is drawn for a reader — an edge's line, its
 * arrowhead, its label — is behind portals of cumulative `scale` than on the
 * board. That weight follows 1/sqrt of the scale it is seen at
 * (ui/canvas/cameraController.ts's `applyZoomScale`); behind a portal that
 * is the camera's times the portal's, and the camera's share is the board's
 * own weight already.
 */
export function portalWeight(scale: number): number {
  return Math.sqrt(scale)
}

/** How large a portal shows the board behind it, against its own board. */
export function portalScale(portal: FileNode): number {
  return portal.view?.scale ?? 1
}

/** The point of the board behind `portal` at its top-left corner: its
 * `view`, or the top-left of everything on that board. */
export function portalView(
  portal: FileNode,
  behind: Board,
): Readonly<{ x: number; y: number }> {
  if (portal.view) return { x: portal.view.x, y: portal.view.y }
  const bounds = contentBounds(behind)
  return bounds
    ? {
        x: bounds.x - PORTAL_CONTENT_PADDING,
        y: bounds.y - PORTAL_CONTENT_PADDING,
      }
    : { x: 0, y: 0 }
}

/** How far a portal that says nowhere looks out from the board's content,
 * and what a portal made to fit a board leaves around it — room for the
 * titles that hang above cards. */
export const PORTAL_CONTENT_PADDING = 40

/** The rectangle everything on `board` is in; null for an empty board. */
export function contentBounds(board: Board): Rect | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const node of board.nodes) {
    left = Math.min(left, node.x)
    top = Math.min(top, node.y)
    right = Math.max(right, node.x + node.w)
    bottom = Math.max(bottom, node.y + node.h)
  }
  return Number.isFinite(left)
    ? { x: left, y: top, w: right - left, h: bottom - top }
    : null
}

/** The size of a portal that shows all of `board` — up to `max`, past which
 * it shows the top-left of it — and no smaller than `min`. */
export function portalSizeFor(
  board: Board,
  min: Readonly<{ w: number; h: number }>,
  max: Readonly<{ w: number; h: number }>,
): Readonly<{ w: number; h: number }> {
  const bounds = contentBounds(board)
  if (!bounds) return min
  const fit = (size: number, low: number, high: number) =>
    Math.round(Math.min(high, Math.max(low, size + PORTAL_CONTENT_PADDING * 2)))
  return { w: fit(bounds.w, min.w, max.w), h: fit(bounds.h, min.h, max.h) }
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
    scale: number,
    clip: Rect | null,
    parent: NodeId | null,
    ancestors: readonly string[],
  ) => {
    for (const source of board.nodes) {
      const node =
        prefix === '' ? source : project(source, prefix, dx, dy, scale)
      nodes.push(node)
      if (!isPortal(node)) continue
      if (ancestors.includes(node.file)) continue
      const behind = expand(node, node.id, ancestors)
      if (!behind) continue
      const frame = { x: node.x, y: node.y, w: node.w, h: node.h }
      const portal: ComposedPortal = {
        id: node.id,
        file: node.file,
        source: behind,
        ...placeBehind(node, behind, scale),
        clip: clip ? intersect(clip, frame) : frame,
        parent,
      }
      portals.set(node.id, portal)
      const inner = `${node.id}${NODE_PATH_SEPARATOR}`
      for (const edge of behind.edges) edges.push(projectEdge(edge, inner))
      visit(
        behind,
        inner,
        portal.dx,
        portal.dy,
        portal.scale,
        portal.clip,
        node.id,
        [...ancestors, node.file],
      )
    }
  }
  visit(own, '', 0, 0, 1, null, null, [ownFile])
  return { board: { ...own, nodes, edges }, portals }
}

/** How the board behind `portal` — a portal as it is on the composed board,
 * itself seen at `outer` — sits on the composed board (`ComposedPortal`). */
function placeBehind(
  portal: FileNode,
  behind: Board,
  outer: number,
): Readonly<{ dx: number; dy: number; scale: number }> {
  const view = portalView(portal, behind)
  const scale = outer * portalScale(portal)
  return { dx: portal.x - view.x * scale, dy: portal.y - view.y * scale, scale }
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

/**
 * What an edge reaching into a portal ends on: the part of the card that
 * shows through it — or, when none does (the card has been looked away
 * from), the point of the frame nearest it.
 */
export function endThrough<T extends Readonly<{ id: NodeId }> & Rect>(
  card: T,
  clip: Rect,
): T {
  const part = shownPart(card, clip)
  if (part && part.w === card.w && part.h === card.h) return card
  if (part) return { ...card, ...part }
  const cx = card.x + card.w / 2
  const cy = card.y + card.h / 2
  return {
    ...card,
    x: Math.min(Math.max(cx, clip.x), clip.x + clip.w),
    y: Math.min(Math.max(cy, clip.y), clip.y + clip.h),
    w: 0,
    h: 0,
  }
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

// --- moving between boards ---------------------------------------------

/**
 * The open portal at a point: the innermost one whose window it is in —
 * where a card put down there goes. `skip` leaves out portals that cannot
 * take it (the ones being moved, and what is behind them).
 */
export function portalAt(
  point: Readonly<{ x: number; y: number }>,
  portals: ReadonlyMap<NodeId, ComposedPortal>,
  skip: (id: NodeId) => boolean,
): ComposedPortal | null {
  let found: ComposedPortal | null = null
  let depth = -1
  for (const portal of portals.values()) {
    const { clip } = portal
    if (
      point.x < clip.x ||
      point.x > clip.x + clip.w ||
      point.y < clip.y ||
      point.y > clip.y + clip.h ||
      skip(portal.id)
    ) {
      continue
    }
    const at = portal.id.split(NODE_PATH_SEPARATOR).length
    if (at > depth) {
      found = portal
      depth = at
    }
  }
  return found
}

/**
 * `board` with the nodes `ids` moved to the board behind the portal `to`
 * (null: the board's own) — the same cards, where they were, now in that
 * board's file. A card is named for the way to it, so moving it is renaming
 * it; `renamed` says what each one is called now. `changesBetween` then has
 * each leave its old file and arrive in the new one.
 *
 * A card keeps its size in its file, so on a board seen at another scale it
 * is seen at another size: it grows or shrinks about `at`, where it was put
 * down.
 *
 * The edges reaching a moved card follow it. One whose two ends now first
 * meet on another board belongs to that board, and is renamed for it too.
 *
 * Left where they are: a card already on that board, a PDF's spread (its
 * pages belong to it), and a portal onto a board the destination is shown
 * from — it would show itself.
 */
export function moveToBoard(
  board: Board,
  composition: Composition,
  ownFile: string,
  ids: readonly NodeId[],
  to: ComposedPortal | null,
  at: Readonly<{ x: number; y: number }>,
): Readonly<{ board: Board; renamed: ReadonlyMap<NodeId, NodeId> }> {
  const { portals } = composition
  const homeOf = (id: NodeId) => portalOf(id, portals)?.id ?? null
  const target = to?.id ?? null
  const prefix = target === null ? '' : `${target}${NODE_PATH_SEPARATOR}`
  // The files the destination is seen through: a portal onto one of them
  // cannot go there.
  const seenFrom = new Set([ownFile])
  for (
    let at = to;
    at;
    at = at.parent === null ? null : (portals.get(at.parent) ?? null)
  ) {
    seenFrom.add(at.file)
  }
  const byId = new Map(board.nodes.map((node) => [node.id, node]))
  const taken = new Set(byId.keys())
  const fresh = (want: string, used: Set<string>) => {
    let id = want
    for (let n = 2; used.has(id); n += 1) id = `${want}-${n}`
    used.add(id)
    return id
  }
  const renamed = new Map<NodeId, NodeId>()
  for (const id of ids) {
    const node = byId.get(id)
    if (!node || homeOf(id) === target) continue
    if (node.type === 'pdf-page' || isSpreadTitle(node)) continue
    if (isPortal(node) && seenFrom.has(node.file)) continue
    const home = homeOf(id)
    const inner = home === null ? id : id.slice(home.length + 1)
    renamed.set(id, fresh(`${prefix}${inner}`, taken))
  }
  if (renamed.size === 0) return { board, renamed }

  // Topmost on the board they go to: after the last of its cards, or the
  // portal itself when it has none.
  const moved: BoardNode[] = []
  const nodes: BoardNode[] = []
  let insertAt = -1
  const toScale = to?.scale ?? 1
  for (const node of board.nodes) {
    const name = renamed.get(node.id)
    if (name) {
      const fromScale = portalOf(node.id, portals)?.scale ?? 1
      const ratio = toScale / fromScale
      moved.push(
        ratio === 1
          ? { ...node, id: name }
          : {
              ...node,
              id: name,
              x: at.x + (node.x - at.x) * ratio,
              y: at.y + (node.y - at.y) * ratio,
              w: tidy(node.w / fromScale) * toScale,
              h: tidy(node.h / fromScale) * toScale,
            },
      )
      continue
    }
    nodes.push(node)
    if (node.id === target || homeOf(node.id) === target) {
      insertAt = nodes.length
    }
  }
  nodes.splice(insertAt < 0 ? nodes.length : insertAt, 0, ...moved)

  // A moved portal takes what is behind it along: an edge reaching in
  // reaches in through its new name.
  const rename = (end: NodeId) => {
    const direct = renamed.get(end)
    if (direct) return direct
    for (const [from, name] of renamed) {
      if (end.startsWith(`${from}${NODE_PATH_SEPARATOR}`)) {
        return `${name}${end.slice(from.length)}`
      }
    }
    return end
  }
  const edgeIds = new Set(board.edges.map((edge) => edge.id))
  let edgesChanged = false
  const edges = board.edges.map((edge) => {
    const fromNode = rename(edge.fromNode)
    const toNode = rename(edge.toNode)
    if (fromNode === edge.fromNode && toNode === edge.toNode) return edge
    const was = commonPortal(edge.fromNode, edge.toNode, portals)
    // On the board behind a moved portal: it goes with that board.
    for (
      let at = was;
      at;
      at = at.parent === null ? null : (portals.get(at.parent) ?? null)
    ) {
      if (renamed.has(at.id)) return edge
    }
    edgesChanged = true
    const home = commonPortalIn(fromNode, toNode, portals, renamed)
    const wasHome = was?.id ?? null
    if (home === wasHome) return { ...edge, fromNode, toNode }
    const inner = wasHome === null ? edge.id : edge.id.slice(wasHome.length + 1)
    const id = fresh(
      home === null ? inner : `${home}${NODE_PATH_SEPARATOR}${inner}`,
      edgeIds,
    )
    return { ...edge, id, fromNode, toNode }
  })
  return {
    board: { ...board, nodes, edges: edgesChanged ? edges : board.edges },
    renamed,
  }
}

/** Where two ends, some of them renamed by a move, first meet: the
 * innermost portal both are behind — of the ones open before the move,
 * which are the ones a card can have been moved into. */
function commonPortalIn(
  a: NodeId,
  b: NodeId,
  portals: ReadonlyMap<NodeId, ComposedPortal>,
  renamed: ReadonlyMap<NodeId, NodeId>,
): NodeId | null {
  const moved = new Set(renamed.values())
  const parts = (id: NodeId) => id.split(NODE_PATH_SEPARATOR)
  const pa = parts(a)
  const pb = parts(b)
  let common: NodeId | null = null
  for (let i = 0; i < Math.min(pa.length, pb.length) - 1; i += 1) {
    if (pa[i] !== pb[i]) break
    const id = pa.slice(0, i + 1).join(NODE_PATH_SEPARATOR)
    if (portals.has(id) || moved.has(id)) common = id
  }
  return common
}

// --- projection ----------------------------------------------------------

/** Projections made, by what they were made of: so the same node seen from
 * the same place is the same object, and the board's identity rule — an
 * object's reference changes if and only if its content does — holds for
 * what is behind a portal too. A few per node: one board may be behind
 * several portals. */
const projected = new WeakMap<object, Map<string, object>>()
const PROJECTIONS_PER_SOURCE = 4

/** What each projection was made of. */
const projectedFrom = new WeakMap<BoardNode, BoardNode>()

/**
 * A node of a composed board as its file has it: for one behind a portal,
 * the node it was put there from — its own id, position and size — and for
 * one of the board's own, itself. Two nodes made of the same one are the
 * same card, only seen from somewhere else (a portal moved or zoomed).
 */
export function fileNodeOf(node: BoardNode): BoardNode {
  return projectedFrom.get(node) ?? node
}

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

/** What a projection is remembered by: where it was made for. */
function projectionKey(
  prefix: string,
  dx: number,
  dy: number,
  scale: number,
): string {
  return `${prefix}\u0000${dx}\u0000${dy}\u0000${scale}`
}

function project(
  node: BoardNode,
  prefix: string,
  dx: number,
  dy: number,
  scale: number,
): BoardNode {
  const key = projectionKey(prefix, dx, dy, scale)
  const known = recall<BoardNode>(node, key)
  if (known) return known
  const moved = {
    ...node,
    id: `${prefix}${node.id}`,
    x: node.x * scale + dx,
    y: node.y * scale + dy,
    w: node.w * scale,
    h: node.h * scale,
  }
  const made: BoardNode =
    moved.type === 'pdf-page'
      ? { ...moved, parent: `${prefix}${moved.parent}` }
      : moved
  projectedFrom.set(made, node)
  return remember(node, key, made)
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

/** A length or a position brought back through a scale: what the division
 * leaves past a millionth of a world unit is its own rounding, not the
 * board's. */
export function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6
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
  const offsets = new Map<
    NodeId,
    Readonly<{ dx: number; dy: number; scale: number }>
  >()
  const live = (portal: ComposedPortal | null): boolean => {
    for (let at = portal; at; ) {
      if (!afterById.has(at.id)) return false
      at = at.parent === null ? null : (before.portals.get(at.parent) ?? null)
    }
    return true
  }
  // As `composeBoard` places it, from the portals on the way in as `after`
  // has them — so the board made again from the files is `after`.
  const offsetOf = (
    portal: ComposedPortal,
  ): Readonly<{ dx: number; dy: number; scale: number }> => {
    let known = offsets.get(portal.id)
    if (!known) {
      const node = afterById.get(portal.id)
      const parent =
        portal.parent === null
          ? null
          : (before.portals.get(portal.parent) ?? null)
      known =
        node && isPortal(node)
          ? placeBehind(
              node,
              portal.source,
              parent ? offsetOf(parent).scale : 1,
            )
          : { dx: portal.dx, dy: portal.dy, scale: portal.scale }
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
    const { dx, dy, scale } = offsetOf(portal)
    const id = node.id.slice(portal.id.length + 1)
    const source = portal.source.nodes.find((known) => known.id === id) ?? null
    const own = unproject(node, portal.id, dx, dy, scale, source)
    if (source && sameNode(source, own)) continue
    forFile(portal.file).nodes.set(id, { before: source, after: own, index })
    // The board made again from its files gives back what `after` has.
    projectedFrom.set(node, own)
    remember(
      own,
      projectionKey(`${portal.id}${NODE_PATH_SEPARATOR}`, dx, dy, scale),
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

/**
 * `node` in the terms of the file behind `portalId`: `project` backwards. A
 * coordinate `source` (the node as the file has it) still projects to is
 * taken from it as it is, so what was not moved or resized is written back
 * unchanged rather than through a division.
 */
function unproject(
  node: BoardNode,
  portalId: NodeId,
  dx: number,
  dy: number,
  scale: number,
  source: BoardNode | null,
): BoardNode {
  const strip = (id: NodeId) => id.slice(portalId.length + 1)
  const back = (value: number, offset: number, was: number | undefined) =>
    was !== undefined && was * scale + offset === value
      ? was
      : scale === 1
        ? value - offset
        : tidy((value - offset) / scale)
  const moved = {
    ...node,
    id: strip(node.id),
    x: back(node.x, dx, source?.x),
    y: back(node.y, dy, source?.y),
    w: back(node.w, 0, source?.w),
    h: back(node.h, 0, source?.h),
  }
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
