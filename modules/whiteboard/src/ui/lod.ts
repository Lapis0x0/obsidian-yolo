// Pure level-of-detail helpers for the canvas's zoom-based card degrade
// (docs/plans/08-25-yolo-whiteboard/p1-design.md §3: "补齐 spike 未移植项：
// 缩放阈值降级"). Kept out of domain/ despite being pure/DOM-free because
// this isn't board *data* logic — it's UI presentation policy (what scale
// counts as "too small to bother laying out markdown", what string a
// degraded card shows) that has no `.yoloboard` representation and has no
// reason to move if the file format ever changes.

import type { BoardNode } from '../domain/fileFormat'
import { basenameWithoutExtension } from '../domain/naming'

/**
 * Whether cards should be showing their degraded (title-only) form now that
 * the camera has reached `scale`, given whether they already are.
 *
 * Two thresholds rather than one: content is torn down below `band.enter` and
 * built again only once the camera is back above `band.restore`
 * (constants.ts's DEGRADE_SCALE_THRESHOLD / DEGRADE_RESTORE_SCALE). The gap
 * is what keeps a zoom that settles on the boundary from rebuilding and
 * destroying every visible card's markdown on alternate throttle ticks — see
 * DEGRADE_RESTORE_DOUBLINGS for why the band is the width it is.
 *
 * Evaluated at the canvas's existing visibility-recompute throttle, not per
 * frame (src/ui/canvas.ts's updateDegradedState()).
 */
export function nextDegradedState(
  scale: number,
  degraded: boolean,
  band: Readonly<{ enter: number; restore: number }>,
): boolean {
  return degraded ? scale < band.restore : scale < band.enter
}

const MAX_DEGRADED_TITLE_LENGTH = 60

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/**
 * The label a degraded card shows in place of its rendered markdown: a file
 * node shows its backing file's basename, a text node shows its first line
 * (trimmed and truncated) — p1-design §3's "note 卡显示文件名、text 卡显示
 * 首行截断". A group node has no degraded form: its label is chrome, drawn at
 * every zoom, so this returns it unchanged for the callers that ask.
 *
 * A text node's leading `#` markers are dropped: the line is being shown as
 * a title, not as markdown, and a card that opens with a heading — the most
 * common way to title one — would otherwise wear its syntax in the one place
 * the syntax is never rendered. Only the heading marker goes; a first line
 * that starts with a bullet or a quote is prose the user wrote that way.
 */
export function degradedNodeTitle(node: BoardNode): string {
  switch (node.type) {
    case 'file':
      return basenameWithoutExtension(node.file)
    case 'group':
      return truncate(node.label ?? '', MAX_DEGRADED_TITLE_LENGTH)
    case 'text': {
      const newlineIndex = node.text.indexOf('\n')
      const firstLine =
        newlineIndex === -1 ? node.text : node.text.slice(0, newlineIndex)
      const title = firstLine.trim().replace(/^#{1,6}\s+/, '')
      return truncate(title, MAX_DEGRADED_TITLE_LENGTH)
    }
  }
}
