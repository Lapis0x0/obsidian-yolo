// Rename-reference rewrite — the pure half of the "event layer" reference
// resilience insurance (docs/plans/08-25-yolo-whiteboard/p1-design.md §1.2:
// "监听 vault rename 事件，改写所有 .yoloboard...中对该路径的引用"). The host
// side (src/host/renameRewriter.ts) does the vault scanning/read/write I/O;
// this module only decides *whether* and *how* a given board's card `file`
// references change for a single rename, so the decision is testable
// without any vault fixture.

import type { Board, BoardCard } from './fileFormat'

/**
 * Rewrites every `note`/`pdf` card whose `file` equals `oldPath` to
 * `newPath`. Returns `null` when the board has no such reference at all —
 * the caller's contract (src/host/renameRewriter.ts) is "don't write back a
 * file with nothing to change", so `null` doubles as that signal. Cards
 * that aren't touched keep their original object reference (the repo's
 * "reference changes iff content changes" invariant, same as operations.ts).
 */
export function rewriteFileReferences(
  board: Board,
  oldPath: string,
  newPath: string,
): Board | null {
  let changed = false
  const cards = board.cards.map((card): BoardCard => {
    if (card.type === 'text' || card.file !== oldPath) return card
    changed = true
    return { ...card, file: newPath }
  })
  if (!changed) return null
  return { ...board, cards }
}
