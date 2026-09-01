// Pure level-of-detail helpers for the canvas's one zoom-based rendering-tier
// switch (constants.ts's OVERVIEW_SCALE_THRESHOLD). Kept out of domain/
// despite being pure/DOM-free because this isn't board *data* logic — it's UI
// presentation policy (what scale counts as too small for a card to be worth
// an element, what string a card shows in place of its content) that has no
// `.yoloboard` representation and has no reason to move if the file format
// ever changes.

import type { BoardNode } from '../domain/fileFormat'
import { basenameWithoutExtension } from '../domain/naming'

/**
 * Whether the board should be drawn by the overview canvas now that the camera
 * has reached `scale`, given whether it already is.
 *
 * Two thresholds rather than one: the DOM gives the board up below
 * `band.enter` and takes it back only once the camera is above `band.restore`
 * (constants.ts's OVERVIEW_SCALE_THRESHOLD / OVERVIEW_RESTORE_SCALE). The gap
 * is what keeps a zoom that settles on the boundary from unmounting and
 * remounting every visible card on alternate throttle ticks — see
 * OVERVIEW_RESTORE_DOUBLINGS for why the band is the width it is.
 *
 * Evaluated at the canvas's existing visibility-recompute throttle, not per
 * frame (src/ui/canvas.ts's updateOverviewState()).
 */
export function nextOverviewState(
  scale: number,
  overview: boolean,
  band: Readonly<{ enter: number; restore: number }>,
): boolean {
  return overview ? scale < band.restore : scale < band.enter
}

const MAX_TITLE_LENGTH = 60

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/**
 * The label a card shows in place of its content — the title block a mounted
 * card wears until its content is built, and the line the overview canvas
 * draws for a card that has no element at all. A file node shows its backing
 * file's basename, a link node its URL, a text node its first line (trimmed
 * and truncated) — p1-design §3's "note 卡显示文件名、text 卡显示首行截断". A
 * group node never shows one: its label is chrome, drawn at every zoom, so
 * this returns it unchanged for the callers that ask.
 *
 * A text node's leading `#` markers are dropped: the line is being shown as
 * a title, not as markdown, and a card that opens with a heading — the most
 * common way to title one — would otherwise wear its syntax in the one place
 * the syntax is never rendered. Only the heading marker goes; a first line
 * that starts with a bullet or a quote is prose the user wrote that way.
 */
export function nodeTitleText(node: BoardNode): string {
  switch (node.type) {
    case 'file':
      return basenameWithoutExtension(node.file)
    case 'link':
      return truncate(node.url, MAX_TITLE_LENGTH)
    case 'group':
      return truncate(node.label ?? '', MAX_TITLE_LENGTH)
    case 'text': {
      const newlineIndex = node.text.indexOf('\n')
      const firstLine =
        newlineIndex === -1 ? node.text : node.text.slice(0, newlineIndex)
      const title = firstLine.trim().replace(/^#{1,6}\s+/, '')
      return truncate(title, MAX_TITLE_LENGTH)
    }
  }
}
