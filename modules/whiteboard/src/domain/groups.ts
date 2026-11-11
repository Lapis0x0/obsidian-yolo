// Groups: who is in one, how big its frame is, and what a drag does to
// membership — pure logic over board nodes, no DOM (Module Boundaries,
// CLAUDE.md).
//
// Membership is **recorded**: a group names the nodes it directly holds
// (fileFormat.ts's `GroupNode.members`), and a nested group holds its own. It
// used to be read off the geometry, the way Obsidian Canvas does it — a node
// wholly inside the frame was in the group — which made the frame the thing
// the user had to manage: grow it to take a card in, and a card nudged past
// its edge silently left. Now the frame follows what it holds (`fitGroups`),
// and joining or leaving is something a drag decides on purpose
// (`groupDropDecision`), with slack in both directions.
//
// Two rules about what a member is carry over from the geometric model:
//   - a PDF spread is held as a whole — the group names its title, and every
//     sheet goes where the title goes, wherever it lies;
//   - a group holds only nodes of its own board: what shows through a portal
//     is the board behind it, and goes where its portal goes.

import {
  type Board,
  type BoardNode,
  type GroupNode,
  NODE_PATH_SEPARATOR,
  type NodeId,
} from './fileFormat'
import { fileNodeKind } from './naming'
import { isPortal } from './portals'
import { isSpreadTitle, withTitleAbove } from './spread'

export type GroupRect = Readonly<{ x: number; y: number; w: number; h: number }>

/**
 * The margin between what a group holds and its frame, in world units.
 * Obsidian Canvas's own figure for a group made from a selection
 * (`I8(P8(bboxes), 20)`), and now the margin the frame always keeps.
 */
export const GROUP_PADDING = 20

/**
 * A group's title bar: a fixed-width strip outside the frame, over its
 * top-left corner, left edges aligned — `gap` above the frame. Whole cells of
 * the board's 13-unit grid where it can be; the height and gap are an open
 * PDF spread's title's (domain/spread.ts's SPREAD_METRICS), so the two read
 * as one kind of heading. A frame is never narrower than its title bar.
 */
export const GROUP_TITLE = Object.freeze({ width: 312, height: 39, gap: 6 })

/**
 * A collapsed group's box: as wide as its title bar, under it where the
 * frame's top-left corner was, holding a small picture of each thing it
 * holds — three to a row, at most two rows, the sixth cell saying how many
 * more there are when there are more than six. So its size is fixed: one row
 * or two.
 */
export const GROUP_COLLAPSED = Object.freeze({
  padding: 13,
  gap: 8,
  columns: 3,
  rows: 2,
  cellHeight: 68,
})

/** The size of a collapsed group's box holding `count` things. */
export function collapsedGroupSize(
  count: number,
  scale = 1,
): Readonly<{ w: number; h: number }> {
  const { padding, gap, columns, rows: most, cellHeight } = GROUP_COLLAPSED
  const rows = Math.max(1, Math.min(most, Math.ceil(count / columns)))
  return {
    w: GROUP_TITLE.width * scale,
    h: (padding * 2 + rows * cellHeight + (rows - 1) * gap) * scale,
  }
}

/** The cells of a collapsed group's box at `box`, in order: as many as are
 * shown — every thing, or five and the cell saying how many more. */
export function collapsedGroupCells(
  box: GroupRect,
  count: number,
  scale = 1,
): GroupRect[] {
  const { padding, gap, columns, rows, cellHeight } = GROUP_COLLAPSED
  const shown = Math.min(count, columns * rows)
  const cellW =
    (GROUP_TITLE.width - padding * 2 - gap * (columns - 1)) / columns
  const cells: GroupRect[] = []
  for (let index = 0; index < shown; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    cells.push({
      x: box.x + (padding + column * (cellW + gap)) * scale,
      y: box.y + (padding + row * (cellHeight + gap)) * scale,
      w: cellW * scale,
      h: cellHeight * scale,
    })
  }
  return cells
}

/** How many things `group` directly holds: on the board, or put away in it
 * while it is collapsed. */
export function groupMemberCount(
  group: GroupNode,
  nodes: readonly BoardNode[],
): number {
  const present = new Set(
    (group.stash ? group.stash.nodes : nodes).map((node) => node.id),
  )
  return group.members.filter((id) => present.has(id)).length
}

/** How near a dragged card's centre has to come to a frame for dropping it
 * to put it in that group. A fitted frame hugs what it holds, so "on the
 * frame" has to include a little of the outside. */
export const GROUP_JOIN_DISTANCE = 39

/** How far a member's centre has to be taken from the frame the rest of its
 * group makes for dropping it to take it out. Far more than joining: a card
 * nudged off line is not a card being taken away. */
export const GROUP_LEAVE_DISTANCE = 91

/** True when `outer` completely encloses `inner`. */
export function rectContains(outer: GroupRect, inner: GroupRect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  )
}

/** The group each node on the board is directly in, by the node's id. */
export function groupParents(
  nodes: readonly BoardNode[],
): ReadonlyMap<NodeId, NodeId> {
  const present = new Set(nodes.map((node) => node.id))
  const parents = new Map<NodeId, NodeId>()
  for (const node of nodes) {
    if (node.type !== 'group') continue
    for (const id of node.members) {
      if (present.has(id) && !parents.has(id)) parents.set(id, node.id)
    }
  }
  return parents
}

/** The members of `group` that are on the board — a deleted member's id
 * stays in the list until the file is written, so an undo brings it back. */
function presentMembers(
  group: GroupNode,
  byId: ReadonlyMap<NodeId, BoardNode>,
): BoardNode[] {
  const out: BoardNode[] = []
  for (const id of group.members) {
    const node = byId.get(id)
    if (node && node.type !== 'pdf-page') out.push(node)
  }
  return out
}

/**
 * Ids of every node `group` holds, at any depth, excluding the group itself,
 * in board order: its members, what its nested groups hold, and the sheets of
 * every open spread among them.
 */
export function nodesInsideGroup(
  group: BoardNode,
  nodes: readonly BoardNode[],
): NodeId[] {
  if (group.type !== 'group') return []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ids = new Set<NodeId>()
  const visit = (holder: GroupNode) => {
    for (const member of presentMembers(holder, byId)) {
      if (ids.has(member.id) || member.id === group.id) continue
      ids.add(member.id)
      if (member.type === 'group') visit(member)
    }
  }
  visit(group)
  const titles = new Set(
    nodes
      .filter((node) => ids.has(node.id) && isSpreadTitle(node))
      .map((n) => n.id),
  )
  return nodes
    .filter(
      (node) =>
        ids.has(node.id) ||
        (node.type === 'pdf-page' && titles.has(node.parent)),
    )
    .map((node) => node.id)
}

/**
 * What moving `node` carries along: a group what it holds, a spread's title
 * its pages, a portal everything behind it. Nothing for any other node.
 */
function carriedBy(node: BoardNode, nodes: readonly BoardNode[]): NodeId[] {
  if (node.type === 'group') return nodesInsideGroup(node, nodes)
  if (isSpreadTitle(node)) {
    return nodes
      .filter((other) => other.type === 'pdf-page' && other.parent === node.id)
      .map((other) => other.id)
  }
  if (!isPortal(node)) return []
  const inner = `${node.id}${NODE_PATH_SEPARATOR}`
  return nodes
    .filter((other) => other.id.startsWith(inner))
    .map((other) => other.id)
}

/**
 * Every node a drag of `selectedIds` must actually move: the selection itself,
 * plus what each selected group holds (and each spread title its sheets, each
 * portal what is behind it).
 */
export function nodesToDragWith(
  selectedIds: ReadonlySet<NodeId>,
  nodes: readonly BoardNode[],
): NodeId[] {
  const ids = new Set<NodeId>()
  for (const node of nodes) {
    if (!selectedIds.has(node.id)) continue
    ids.add(node.id)
    for (const contained of carriedBy(node, nodes)) ids.add(contained)
  }
  return Array.from(ids)
}

/**
 * The nodes an align or distribute acts on (ui/canvas/toolbarController.ts's
 * arrange button, canvas.ts's own selection menu).
 *
 * Normally the selection. The exception is a lone selected group, where the
 * target is what the group directly *holds* — Obsidian Canvas does the same,
 * and it is what makes a group worth having: tidying a cluster becomes
 * "select its frame, align", rather than rubber-banding its members first. A
 * nested group is one of those things, and takes what it holds along.
 */
export function arrangeTargets(
  board: Board,
  selectedIds: ReadonlySet<NodeId>,
): readonly BoardNode[] {
  const selected = board.nodes.filter((node) => selectedIds.has(node.id))
  if (selected.length === 1 && selected[0].type === 'group') {
    const byId = new Map(board.nodes.map((node) => [node.id, node]))
    const direct = new Set(
      presentMembers(selected[0], byId).map((node) => node.id),
    )
    return board.nodes.filter((node) => direct.has(node.id))
  }
  // A node its own group is carrying is not a target beside it: it has no
  // position of its own to align, it goes where the frame goes. Leaving it in
  // would let an align pull a card out of the group it sits in.
  const carried = new Set<NodeId>()
  for (const node of selected) {
    for (const id of carriedBy(node, board.nodes)) carried.add(id)
  }
  return selected.filter((node) => !carried.has(node.id))
}

/**
 * The moves `positions` really implies: a group that moves carries what it
 * holds, so each of its members moves by the same delta — the counterpart of
 * `nodesToDragWith` for a move that is computed rather than dragged (align,
 * distribute).
 *
 * A node that has a move of its own keeps it. `arrangeTargets` never returns a
 * carried node beside its group, so the two cannot disagree unless a caller
 * asks for something contradictory, and then what it asked for wins.
 */
export function carryGroupMembers(
  nodes: readonly BoardNode[],
  positions: ReadonlyMap<NodeId, Readonly<{ x: number; y: number }>>,
): Map<NodeId, Readonly<{ x: number; y: number }>> {
  const carried = new Map(positions)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const [id, point] of positions) {
    const carrier = byId.get(id)
    if (!carrier) continue
    const dx = point.x - carrier.x
    const dy = point.y - carrier.y
    if (dx === 0 && dy === 0) continue
    for (const memberId of carriedBy(carrier, nodes)) {
      if (positions.has(memberId)) continue
      const member = byId.get(memberId)
      if (!member) continue
      carried.set(memberId, { x: member.x + dx, y: member.y + dy })
    }
  }
  return carried
}

/**
 * The board as the overview tier arranges it: one rectangle per thing that
 * stands on its own. A group is its frame and whatever it holds is part of
 * it; an open spread is its title and every sheet, as one box; anything else
 * not in a group is its own rectangle. Nodes in `exclude` — what a drag is
 * carrying — are left out, and so is a spread whose title is.
 *
 * What a drag lines up with from far away (ui/canvas/dragGestures.ts): at
 * that zoom the board is arranged by its blocks, and a sheet's corner or a
 * card inside a frame is detail the arrangement is not about.
 */
export function boardBlocks(
  nodes: readonly BoardNode[],
  exclude: ReadonlySet<NodeId>,
): GroupRect[] {
  const held = new Set<NodeId>()
  for (const node of nodes) {
    if (node.type !== 'group') continue
    for (const id of nodesInsideGroup(node, nodes)) held.add(id)
  }
  const sheets = new Map<NodeId, BoardNode[]>()
  for (const node of nodes) {
    if (node.type !== 'pdf-page') continue
    const list = sheets.get(node.parent)
    if (list) list.push(node)
    else sheets.set(node.parent, [node])
  }
  const blocks: GroupRect[] = []
  for (const node of nodes) {
    if (node.type === 'pdf-page' || held.has(node.id) || exclude.has(node.id)) {
      continue
    }
    const block = groupRectForNodes([node, ...(sheets.get(node.id) ?? [])], 0)
    if (block) blocks.push(block)
  }
  return blocks
}

/**
 * The union of `nodes`' rectangles, inflated by `padding`. Null when there is
 * nothing to enclose.
 */
export function groupRectForNodes(
  nodes: readonly GroupRect[],
  padding: number = GROUP_PADDING,
): GroupRect | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.w)
    maxY = Math.max(maxY, node.y + node.h)
  }
  return {
    x: minX - padding,
    y: minY - padding,
    w: maxX - minX + padding * 2,
    h: maxY - minY + padding * 2,
  }
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/** How large a node shows at — a portal's scale for one behind it, 1 for the
 * board's own. A frame's margins and title are in its own board's units. */
export type ScaleOf = (id: NodeId) => number

const UNIT_SCALE: ScaleOf = () => 1

/** The whole of a group seen from outside: its frame and the title bar over
 * it. */
export function groupOuterRect(frame: GroupRect, scale = 1): GroupRect {
  const lead = (GROUP_TITLE.height + GROUP_TITLE.gap) * scale
  return {
    x: frame.x,
    y: frame.y - lead,
    w: Math.max(frame.w, GROUP_TITLE.width * scale),
    h: frame.h + lead,
  }
}

/**
 * What of the board a node takes up, as a frame around it must see it: its
 * rectangle, with what is drawn outside it — the title line over a PDF or a
 * portal card, an open spread's sheets, a nested group's title bar.
 */
function nodeExtent(
  node: BoardNode,
  sheetsOf: ReadonlyMap<NodeId, readonly BoardNode[]>,
  scale: number,
): GroupRect {
  if (node.type === 'group') return groupOuterRect(node, scale)
  if (isSpreadTitle(node)) {
    return (
      groupRectForNodes([node, ...(sheetsOf.get(node.id) ?? [])], 0) ?? node
    )
  }
  if (node.type === 'file') {
    // The file's shape of an open spread: the card's box is not what shows.
    if (node.spread?.open === true) {
      return (
        groupRectForNodes([node.spread.title, ...node.spread.pages], 0) ?? node
      )
    }
    if (['pdf', 'board'].includes(fileNodeKind(node.file))) {
      const lead = -withTitleAbove({ x: 0, y: 0, w: 0, h: 0 }).y * scale
      return { x: node.x, y: node.y - lead, w: node.w, h: node.h + lead }
    }
  }
  return node
}

type FrameContext = Readonly<{
  byId: ReadonlyMap<NodeId, BoardNode>
  sheetsOf: ReadonlyMap<NodeId, readonly BoardNode[]>
  scaleOf: ScaleOf
  exclude: ReadonlySet<NodeId>
}>

function frameContext(
  nodes: readonly BoardNode[],
  scaleOf: ScaleOf,
  exclude: ReadonlySet<NodeId>,
): FrameContext {
  const sheetsOf = new Map<NodeId, BoardNode[]>()
  for (const node of nodes) {
    if (node.type !== 'pdf-page') continue
    const list = sheetsOf.get(node.parent)
    if (list) list.push(node)
    else sheetsOf.set(node.parent, [node])
  }
  return {
    byId: new Map(nodes.map((node) => [node.id, node])),
    sheetsOf,
    scaleOf,
    exclude,
  }
}

/**
 * The frame `group` should have: its `bounds` and its members — each with a
 * margin round it — together, at least its title bar wide. Null when it has
 * neither, for the caller to decide (a group that held its last member keeps
 * the frame it had).
 */
function computeFrame(
  group: GroupNode,
  context: FrameContext,
  memo: Map<NodeId, GroupRect | null>,
  path: Set<NodeId>,
): GroupRect | null {
  const known = memo.get(group.id)
  if (known !== undefined) return known
  // Membership is kept acyclic (fileFormat.ts's `recordMembership`); this
  // only keeps a board that breaks the rule from looping.
  if (path.has(group.id)) return null
  // A collapsed box is the size it is, whatever it put away.
  if (group.stash) {
    memo.set(group.id, group)
    return group
  }
  path.add(group.id)
  const scale = context.scaleOf(group.id)
  const pad = GROUP_PADDING * scale
  const parts: GroupRect[] = group.bounds ? [group.bounds] : []
  for (const member of presentMembers(group, context.byId)) {
    if (context.exclude.has(member.id)) continue
    let extent: GroupRect
    if (member.type === 'group') {
      const frame =
        computeFrame(member, context, memo, path) ?? (member as GroupRect)
      extent = groupOuterRect(frame, scale)
    } else {
      extent = nodeExtent(member, context.sheetsOf, scale)
    }
    parts.push({
      x: extent.x - pad,
      y: extent.y - pad,
      w: extent.w + pad * 2,
      h: extent.h + pad * 2,
    })
  }
  path.delete(group.id)
  const union = groupRectForNodes(parts, 0)
  const frame = union
    ? { ...union, w: Math.max(union.w, GROUP_TITLE.width * scale) }
    : null
  memo.set(group.id, frame)
  return frame
}

/**
 * The board with every group's frame where its members and `bounds` put it
 * (`computeFrame`), inner groups first. A group that changes nothing is the
 * same object, and a board where none changes is the same board.
 *
 * Every write of a board goes through this, so a group node's own rectangle
 * is always the frame as drawn — and everything that reads node rectangles
 * (virtualization, hit-testing, snapping, the minimap, export) reads frames
 * without knowing about membership.
 */
export function fitGroups(board: Board, scaleOf: ScaleOf = UNIT_SCALE): Board {
  if (!board.nodes.some((node) => node.type === 'group')) return board
  const context = frameContext(board.nodes, scaleOf, new Set())
  const memo = new Map<NodeId, GroupRect | null>()
  let changed = false
  const nodes = board.nodes.map((node) => {
    if (node.type !== 'group') return node
    const frame = computeFrame(node, context, memo, new Set())
    if (
      !frame ||
      (frame.x === node.x &&
        frame.y === node.y &&
        frame.w === node.w &&
        frame.h === node.h)
    ) {
      return node
    }
    changed = true
    return { ...node, x: frame.x, y: frame.y, w: frame.w, h: frame.h }
  })
  return changed ? { ...board, nodes } : board
}

/**
 * The frame `group` would have without the nodes in `exclude` — what the rest
 * of it makes while some of it is being dragged. A group left with nothing
 * keeps the rectangle it has.
 */
export function groupFrameWithout(
  group: GroupNode,
  nodes: readonly BoardNode[],
  exclude: ReadonlySet<NodeId>,
  scaleOf: ScaleOf = UNIT_SCALE,
): GroupRect {
  const context = frameContext(nodes, scaleOf, exclude)
  return computeFrame(group, context, new Map(), new Set()) ?? group
}

// ---------------------------------------------------------------------------
// Changing membership
// ---------------------------------------------------------------------------

/**
 * `board` with `ids` moved into the group `target` (null: into no group),
 * each out of the group that held it. Nothing is moved into a group it holds,
 * or into itself — that would make a group hold itself — and a spread's sheet
 * is never a member on its own. The same board when nothing changes. Frames
 * are left for `fitGroups`.
 */
export function setMembership(
  board: Board,
  ids: Iterable<NodeId>,
  target: NodeId | null,
): Board {
  const byId = new Map(board.nodes.map((node) => [node.id, node]))
  const targetNode = target === null ? null : byId.get(target)
  if (target !== null && targetNode?.type !== 'group') return board
  const parents = groupParents(board.nodes)
  const isAncestor = (id: NodeId, of: NodeId | null): boolean => {
    for (let at = of; at !== null; at = parents.get(at) ?? null) {
      if (at === id) return true
    }
    return false
  }
  const moving = new Set<NodeId>()
  for (const id of ids) {
    const node = byId.get(id)
    if (!node || node.type === 'pdf-page') continue
    if ((parents.get(id) ?? null) === target) continue
    if (isAncestor(id, target)) continue
    moving.add(id)
  }
  if (moving.size === 0) return board
  const nodes = board.nodes.map((node) => {
    if (node.type !== 'group') return node
    const kept = node.members.filter((id) => !moving.has(id))
    const added =
      node.id === target
        ? board.nodes
            .filter((other) => moving.has(other.id))
            .map((other) => other.id)
        : []
    if (kept.length === node.members.length && added.length === 0) return node
    return { ...node, members: [...kept, ...added] }
  })
  return { ...board, nodes }
}

/**
 * `board` with group `id` no longer keeping a size set by hand: its frame is
 * what it holds again, once fitted. The same board when it kept none.
 */
export function releaseBounds(board: Board, id: NodeId): Board {
  let changed = false
  const nodes = board.nodes.map((node) => {
    if (node.id !== id || node.type !== 'group' || !node.bounds) return node
    changed = true
    const { bounds: _bounds, ...rest } = node
    return rest
  })
  return changed ? { ...board, nodes } : board
}

/**
 * `board` with group `id` sized by hand to `rect`: the range its frame keeps
 * (`GroupNode.bounds`), with what it holds round it. A range wholly inside
 * the frame its contents make asks for nothing that frame does not already
 * give — the frame dragged in as far as it goes — and the group is left
 * hugging its contents instead. Frames are left for `fitGroups`.
 */
export function sizeGroup(
  board: Board,
  id: NodeId,
  rect: GroupRect,
  scaleOf: ScaleOf = UNIT_SCALE,
): Board {
  const group = board.nodes.find((node) => node.id === id)
  if (group?.type !== 'group') return board
  const { bounds: _kept, ...bare } = group
  const hugging = computeFrame(
    bare,
    frameContext(board.nodes, scaleOf, new Set()),
    new Map(),
    new Set(),
  )
  const bounds = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  const nodes = board.nodes.map((node) => {
    if (node.id !== id || node.type !== 'group') return node
    if (hugging && rectContains(hugging, bounds)) {
      const { bounds: _bounds, ...rest } = node
      return rest
    }
    return { ...node, ...bounds, bounds }
  })
  return { ...board, nodes }
}

/**
 * `board` with a new group round the nodes `ids`, fitted to them. The group
 * holds those of them no other of them carries (a selected group brings what
 * it holds); they leave the groups they were in, and the new group takes
 * their place in the group they all shared, if they shared one. It is put
 * just before the first of them in board order, which is paint order: a frame
 * behind what it holds. Null when there is nothing to group.
 */
export function createGroup(
  board: Board,
  group: Omit<GroupNode, 'members' | 'x' | 'y' | 'w' | 'h'>,
  ids: Iterable<NodeId>,
  scaleOf: ScaleOf = UNIT_SCALE,
): Board | null {
  const asked = new Set(ids)
  const carried = new Set<NodeId>()
  for (const node of board.nodes) {
    if (!asked.has(node.id)) continue
    for (const id of carriedBy(node, board.nodes)) carried.add(id)
  }
  const top = board.nodes.filter(
    (node) =>
      asked.has(node.id) && !carried.has(node.id) && node.type !== 'pdf-page',
  )
  if (top.length === 0) return null
  const parents = groupParents(board.nodes)
  const shared = parents.get(top[0].id) ?? null
  const parent = top.every((node) => (parents.get(node.id) ?? null) === shared)
    ? shared
    : null
  const frame = groupRectForNodes(top) as GroupRect
  const made: GroupNode = {
    ...group,
    ...frame,
    members: top.map((node) => node.id),
  }
  const at = board.nodes.indexOf(top[0])
  const memberIds = new Set(made.members)
  const nodes = board.nodes.map((node) =>
    node.type === 'group' && node.members.some((id) => memberIds.has(id))
      ? { ...node, members: node.members.filter((id) => !memberIds.has(id)) }
      : node,
  )
  nodes.splice(at, 0, made)
  let next: Board = { ...board, nodes }
  if (parent !== null) next = setMembership(next, [made.id], parent)
  return fitGroups(next, scaleOf)
}

// ---------------------------------------------------------------------------
// What a drag does to membership
// ---------------------------------------------------------------------------

/**
 * What dropping a drag where it is does to membership: the dragged things go
 * into `target` (null: out of any group). `leaving` says the move is a way
 * out — of the group they were in, to no group or to one it sits in — and not
 * into somewhere new.
 */
export type GroupDrop = Readonly<{ target: NodeId | null; leaving: boolean }>

/** How far `point` is from `rect`: 0 inside it. */
export function distanceToRect(
  rect: GroupRect,
  point: Readonly<{ x: number; y: number }>,
): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w))
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h))
  return Math.hypot(dx, dy)
}

/**
 * What dropping the nodes `moving` — a drag's whole set, with what its groups
 * carry — where `board` has them now does to membership, or null for nothing.
 *
 * The things dragged are the ones nothing else in the drag carries, judged as
 * one by the centre of what they cover. Every group they could go into is
 * asked whether that centre is on it:
 *   - the group they are all in, generously — they stay unless taken
 *     `GROUP_LEAVE_DISTANCE` from the frame the rest of it makes;
 *   - any other, strictly — within `GROUP_JOIN_DISTANCE` of its frame.
 * Of the groups that say yes the innermost wins. None, and they leave for no
 * group — unless they came from several, when nothing changes: a drag that
 * gathers cards from different groups is not a drag out of all of them.
 */
export function groupDropDecision(
  board: Board,
  moving: ReadonlySet<NodeId>,
  scaleOf: ScaleOf = UNIT_SCALE,
): GroupDrop | null {
  const parents = groupParents(board.nodes)
  const roots = new Set(draggedRoots(board.nodes, moving))
  const dragged = board.nodes.filter((node) => roots.has(node.id))
  if (dragged.length === 0) return null
  const from = new Set(dragged.map((node) => parents.get(node.id) ?? null))
  const home = from.size === 1 ? (from.values().next().value ?? null) : null
  const covered = groupRectForNodes(dragged, 0) as GroupRect
  const centre = {
    x: covered.x + covered.w / 2,
    y: covered.y + covered.h / 2,
  }
  const depth = (id: NodeId) => {
    let count = 0
    for (let at = parents.get(id); at; at = parents.get(at)) count += 1
    return count
  }
  const nearFrame = (node: GroupNode): boolean => {
    const frame = groupFrameWithout(node, board.nodes, moving, scaleOf)
    const distance = distanceToRect(frame, centre)
    return node.id === home
      ? distance <= GROUP_LEAVE_DISTANCE * scaleOf(node.id)
      : distance < GROUP_JOIN_DISTANCE * scaleOf(node.id)
  }
  let best: GroupNode | null = null
  for (const node of board.nodes) {
    if (node.type !== 'group' || moving.has(node.id)) continue
    // A collapsed group takes in what is dropped on it — its box or its
    // title bar — and nothing that is only near.
    const near = node.stash
      ? distanceToRect(groupOuterRect(node, scaleOf(node.id)), centre) === 0
      : nearFrame(node)
    if (!near) continue
    if (
      !best ||
      depth(node.id) > depth(best.id) ||
      (depth(node.id) === depth(best.id) && node.w * node.h < best.w * best.h)
    ) {
      best = node
    }
  }
  const target = best?.id ?? null
  if (target === null && from.size > 1) return null
  if (dragged.every((node) => (parents.get(node.id) ?? null) === target)) {
    return null
  }
  let leaving = false
  if (home !== null) {
    leaving = target === null
    for (let at = parents.get(home); at && !leaving; at = parents.get(at)) {
      if (at === target) leaving = true
    }
  }
  return { target, leaving }
}

/** The things a drag of `moving` decides membership for (`groupDropDecision`):
 * what nothing else in it carries. */
export function draggedRoots(
  nodes: readonly BoardNode[],
  moving: ReadonlySet<NodeId>,
): NodeId[] {
  const parents = groupParents(nodes)
  return nodes
    .filter(
      (node) =>
        moving.has(node.id) &&
        node.type !== 'pdf-page' &&
        !moving.has(parents.get(node.id) ?? ''),
    )
    .map((node) => node.id)
}
