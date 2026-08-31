// Where the floating selection toolbar goes.
//
// The toolbar lives in the viewport (screen-space) layer, not in the world, so
// it keeps a constant size while the camera moves — the same arrangement
// Obsidian Canvas uses (measured: its `.canvas-menu-container` is a child of
// `.canvas-wrapper`, positioned with plain `left`/`top` in screen pixels).
// What has to be recomputed on every camera change is therefore only this: the
// screen projection of the selection's world bounds, and a point above it.
//
// Pure geometry, no DOM (the caller measures the toolbar and applies the
// result), so the placement rules — centred on the selection, above it when
// there is room, below it when there isn't, always inside the viewport — are
// testable on their own.

import type { ScreenPoint } from './camera'
import type { CanvasView } from './virtualization'

export type ToolbarBounds = Readonly<{
  x: number
  y: number
  w: number
  h: number
}>
export type ToolbarSize = Readonly<{ width: number; height: number }>

/**
 * Screen position for a toolbar of `toolbar` size anchored to the world
 * rectangle `bounds`.
 *
 * `gap` is the clear space between the toolbar and the selection; `margin` is
 * how close to the viewport edge the toolbar may come. Flipping below the
 * selection when there is no room above is Obsidian Canvas's behaviour too,
 * and it matters most for the case that produces it: a card whose top is off
 * the top of the screen, which is exactly when the toolbar would otherwise be
 * pinned somewhere unrelated to what it acts on.
 */
export function toolbarScreenPosition(
  bounds: ToolbarBounds,
  view: CanvasView,
  viewport: ToolbarSize,
  toolbar: ToolbarSize,
  gap: number,
  margin: number,
): ScreenPoint {
  const left = bounds.x * view.scale + view.tx
  const top = bounds.y * view.scale + view.ty
  const right = (bounds.x + bounds.w) * view.scale + view.tx
  const bottom = (bounds.y + bounds.h) * view.scale + view.ty

  const above = top - gap - toolbar.height
  const below = bottom + gap
  const fitsBelow = below + toolbar.height + margin <= viewport.height
  const y = above >= margin || !fitsBelow ? above : below

  return {
    x: clamp(
      (left + right) / 2 - toolbar.width / 2,
      margin,
      viewport.width - toolbar.width - margin,
    ),
    y: clamp(y, margin, viewport.height - toolbar.height - margin),
  }
}

/** Clamps into `[min, max]`, and to `min` when the range is inverted — a
 * viewport too small to hold the toolbar with its margins still has to put it
 * somewhere, and the near edge is the predictable choice. */
function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min
  return Math.min(Math.max(value, min), max)
}
