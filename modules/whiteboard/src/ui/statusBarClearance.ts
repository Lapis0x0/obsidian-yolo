// Keeping chrome at the bottom of the board clear of Obsidian's status bar.
//
// On desktop the status bar floats over the bottom right of the workspace
// rather than taking room of its own, so anything pinned to the bottom of
// the board can end up under it. It grows leftward from the window's right
// edge, which in a narrow pane reaches under the middle of the board too —
// so whether a piece of chrome is covered depends on where it sits, and each
// one asks for its own horizontal extent. Used by the creation bar
// (./cardMenu.ts) and the minimap (./canvas/minimap.ts).

/** Obsidian's status bar, which on desktop floats over the bottom right of
 * the workspace; absent in a popout and on mobile. */
export function findStatusBar(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>('.status-bar')
}

/**
 * How far chrome spanning `left`–`right` (client x) at the bottom of `area`
 * has to rise to stand clear of the status bar: as far as the bar reaches up
 * into the area when the two share any of that span, and nothing otherwise.
 */
export function statusBarLift(
  area: DOMRect,
  bar: DOMRect | undefined,
  left: number,
  right: number,
): number {
  if (!bar || !(bar.height > 0) || !(area.height > 0)) return 0
  const sharesX = bar.left < right && bar.right > left
  return sharesX ? Math.max(0, area.bottom - bar.top) : 0
}
