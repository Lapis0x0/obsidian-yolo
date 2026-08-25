// Pure level-of-detail helpers for the canvas's zoom-based card degrade
// (docs/plans/08-25-yolo-whiteboard/p1-design.md §3: "补齐 spike 未移植项：
// 缩放阈值降级"). Kept out of domain/ despite being pure/DOM-free because
// this isn't board *data* logic — it's UI presentation policy (what scale
// counts as "too small to bother laying out markdown", what string a
// degraded card shows) that has no `.yoloboard` representation and has no
// reason to move if the file format ever changes.

import type { BoardCard } from '../domain/fileFormat'

/** True once `scale` has dropped below `threshold`. The canvas toggles a
 * single CSS class on the world element at this boundary — checked at the
 * existing visibility-recompute throttle, not per frame — rather than
 * mounting/unmounting anything (src/ui/canvas.ts's updateDegradedState()). */
export function isDegradedScale(scale: number, threshold: number): boolean {
  return scale < threshold
}

const MAX_DEGRADED_TITLE_LENGTH = 60

/** Vault-relative (or bare) file path -> its basename without extension, for
 * a note/pdf card's degraded title. */
export function basenameWithoutExtension(filePath: string): string {
  const slashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const name = slashIndex === -1 ? filePath : filePath.slice(slashIndex + 1)
  const dotIndex = name.lastIndexOf('.')
  return dotIndex > 0 ? name.slice(0, dotIndex) : name
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/**
 * The label a degraded card shows in place of its rendered markdown: a
 * note/pdf card shows its backing file's basename, a text card shows its
 * first line (trimmed and truncated) — p1-design §3's "note 卡显示文件名、
 * text 卡显示首行截断".
 */
export function degradedCardTitle(card: BoardCard): string {
  switch (card.type) {
    case 'note':
    case 'pdf':
      return basenameWithoutExtension(card.file)
    case 'text': {
      const newlineIndex = card.markdown.indexOf('\n')
      const firstLine = newlineIndex === -1 ? card.markdown : card.markdown.slice(0, newlineIndex)
      return truncate(firstLine.trim(), MAX_DEGRADED_TITLE_LENGTH)
    }
  }
}
