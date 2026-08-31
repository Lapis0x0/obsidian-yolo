// Group membership and the rectangle a new group takes (P3 batch 3 wave B,
// feature 3) — pure geometry over board nodes, no DOM (Module Boundaries,
// CLAUDE.md).
//
// Membership is **spatial, not stored**: a node belongs to a group while it
// sits inside the group's rectangle, and stops belonging the moment either one
// moves. There is no parent field on a node and nothing to keep in sync — the
// same model Obsidian Canvas uses, verified against its running 1.13.7 build,
// where `getContainingNodes` re-runs a spatial query every time a group is
// grabbed:
//
//   getContainingNodes = function(e){ return this.nodeIndex.search(e)
//     .filter(function(t){ return L8(e, t.getBBox()) }) }
//   function L8(e,t){ return e.minX<=t.minX && e.minY<=t.minY
//     && e.maxX>=t.maxX && e.maxY>=t.maxY }
//
// `L8` is **full containment** — a node hanging half out of a group is not in
// it. Copied rather than chosen: centre-point containment would carry away a
// card whose visible bulk is outside the frame, and intersection would carry
// away anything the frame merely grazed.

import type { Board, BoardNode, NodeId } from './fileFormat'

export type GroupRect = Readonly<{ x: number; y: number; w: number; h: number }>

/**
 * Padding between a selection and the group created around it, in world
 * units. Obsidian Canvas's own figure, read off the closure its "create group"
 * action runs (`I8(P8(bboxes), 20)`): the union of the selection, inflated by
 * 20 on every side.
 */
export const GROUP_SELECTION_PADDING = 20

/** True when `outer` completely encloses `inner` — Canvas's `L8`, above. */
export function rectContains(outer: GroupRect, inner: GroupRect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  )
}

/**
 * Ids of every node that sits wholly inside `group`, excluding the group
 * itself. Other groups count: a group nested inside another is carried by it,
 * and so (being inside the outer one too) is everything the inner group holds.
 */
export function nodesInsideGroup(
  group: BoardNode,
  nodes: readonly BoardNode[],
): NodeId[] {
  return nodes
    .filter((node) => node.id !== group.id && rectContains(group, node))
    .map((node) => node.id)
}

/**
 * Every node a drag of `selectedIds` must actually move: the selection itself,
 * plus the contents of any group in it.
 *
 * Resolved here, at the moment the drag begins, because membership is
 * positional — asking any earlier would answer for a layout that has since
 * changed. Resizing a group deliberately does not go through this (Canvas's
 * group resize leaves its contents where they are, so a group can be grown
 * around more cards or shrunk off them), and neither does anything else that
 * moves a single node.
 */
export function nodesToDragWith(
  selectedIds: ReadonlySet<NodeId>,
  nodes: readonly BoardNode[],
): NodeId[] {
  const ids = new Set<NodeId>()
  for (const node of nodes) {
    if (!selectedIds.has(node.id)) continue
    ids.add(node.id)
    if (node.type !== 'group') continue
    for (const contained of nodesInsideGroup(node, nodes)) ids.add(contained)
  }
  return Array.from(ids)
}

/**
 * The nodes an align or distribute acts on (ui/canvas/toolbarController.ts's
 * arrange button, canvas.ts's own selection menu).
 *
 * Normally the selection. The exception is a lone selected group, where the
 * target is what the group *holds* — Obsidian Canvas does exactly this, and
 * it is what makes a group worth having: tidying a cluster becomes "select
 * its frame, align", rather than rubber-banding its members first.
 */
export function arrangeTargets(
  board: Board,
  selectedIds: ReadonlySet<NodeId>,
): readonly BoardNode[] {
  const selected = board.nodes.filter((node) => selectedIds.has(node.id))
  if (selected.length === 1 && selected[0].type === 'group') {
    const contained = new Set(nodesInsideGroup(selected[0], board.nodes))
    return board.nodes.filter((node) => contained.has(node.id))
  }
  return selected
}

/**
 * The rectangle a group created from `nodes` takes: their union, inflated so
 * the frame reads as holding them rather than touching them. Null when there
 * is nothing to enclose.
 */
export function groupRectForNodes(
  nodes: readonly BoardNode[],
  padding: number = GROUP_SELECTION_PADDING,
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
