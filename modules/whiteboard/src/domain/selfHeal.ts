// Pure decision logic for the "self-heal" insurance layer (docs/plans/
// 08-25-yolo-whiteboard/p1-design.md §1.2: "白板打开时逐卡解析 file 路径；
// 失效的用文件名...重定位（移动不改名必中），找回即就地修正保存"). The host
// side (src/ui/canvas.ts) does the I/O — checking which note cards' `file`
// no longer resolves to a vault entry, and listing the vault's markdown
// files — and hands both in here; this module only decides which of those
// missing cards can be safely relocated.
//
// Conservative on purpose: a card is only relocated when its basename
// matches *exactly one* candidate file. Zero matches (truly gone) or
// multiple matches (ambiguous — could silently repoint to the wrong note)
// both leave the card alone, so a wrong guess never overwrites a user's
// intent. PDF cards are out of scope for M1 (p1-design's task brief; no
// vault API enumerates PDFs the way `listMarkdownFiles()` does for notes).

import type { CardId } from './fileFormat'

export type MissingNoteCard = Readonly<{ cardId: CardId; file: string }>

/** The subset of a vault markdown file's identity this decision needs. */
export type MarkdownFileCandidate = Readonly<{ path: string; name: string }>

export type NoteCardRelocation = Readonly<{ cardId: CardId; file: string }>

/**
 * `missing` is every note card whose current `file` failed a vault
 * existence check. `markdownFiles` is the vault's full markdown file list
 * (`host.vault.listMarkdownFiles()`). Returns one relocation per missing
 * card that has exactly one same-basename candidate elsewhere in the
 * vault — cards with zero or multiple candidates are omitted (the caller
 * renders them as "file missing" instead, per p1-design's "真丢失的渲染
 * '文件丢失'占位卡" — no automatic guess).
 */
export function planNoteCardSelfHeal(
  missing: readonly MissingNoteCard[],
  markdownFiles: readonly MarkdownFileCandidate[],
): readonly NoteCardRelocation[] {
  if (missing.length === 0) return []

  const candidatesByName = new Map<string, string[]>()
  for (const file of markdownFiles) {
    const paths = candidatesByName.get(file.name)
    if (paths) paths.push(file.path)
    else candidatesByName.set(file.name, [file.path])
  }

  const relocations: NoteCardRelocation[] = []
  for (const card of missing) {
    const candidates = candidatesByName.get(basename(card.file))
    if (!candidates || candidates.length !== 1) continue
    const [onlyMatch] = candidates
    if (onlyMatch === undefined || onlyMatch === card.file) continue
    relocations.push({ cardId: card.cardId, file: onlyMatch })
  }
  return relocations
}

function basename(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator === -1 ? path : path.slice(separator + 1)
}
