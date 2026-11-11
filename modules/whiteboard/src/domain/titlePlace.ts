// Where a node's title stands on the board (domain/title.ts's NODE_TITLE):
// the one answer for everything that asks — whether a drag reaches a group
// (groups.ts's `groupDropDecision`), and where the UI draws the title and
// stands the toolbar over it (ui/canvas/nodeTitle.ts's `titleBox`, which
// narrows this to what the title says).

import type { BoardNode } from './fileFormat'
import { fileNodeKind } from './naming'
import { isSpreadTitle } from './spread'
import { NODE_TITLE } from './title'

type Rect = Readonly<{ x: number; y: number; w: number; h: number }>

/**
 * How `node` wears a title: `over` it — a group's over its frame, a PDF
 * card's or a portal's over the card — or as its `own` box, an open spread's
 * title node, which is its title. Null for a node that wears none.
 */
export function titleStand(node: BoardNode): 'over' | 'own' | null {
  if (isSpreadTitle(node)) return 'own'
  if (node.type === 'group') return 'over'
  if (
    node.type === 'file' &&
    ['pdf', 'board'].includes(fileNodeKind(node.file))
  )
    return 'over'
  return null
}

/**
 * The room `node`'s title has over it shown at `rect` — in whatever units
 * `rect` is in, `unit` of them to one of the node's own (its portals' scale
 * on the board, the camera's too on screen) — held `scale` times its size
 * (ui/canvas/nodeTitle.ts's `titleScale`), or null for a node that wears
 * none.
 *
 * Left edges aligned, NODE_TITLE.gap above it, or its own node's bottom edge
 * for an open spread's. As wide as its node — an open spread's title node is
 * one page wide, as wide as the card the PDF folds into, so the title is the
 * same either way — and never narrower than NODE_TITLE.room: the title over a
 * small card, or held large over a board zoomed out, runs on past it.
 */
export function titleRoom(
  node: BoardNode,
  rect: Rect,
  unit = 1,
  scale = 1,
): Rect | null {
  const stand = titleStand(node)
  if (!stand) return null
  const h = NODE_TITLE.height * scale * unit
  const bottom =
    stand === 'own' ? rect.y + rect.h : rect.y - NODE_TITLE.gap * unit
  return {
    x: rect.x,
    y: bottom - h,
    w: Math.max(rect.w, NODE_TITLE.room * scale * unit),
    h,
  }
}
