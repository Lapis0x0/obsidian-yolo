// Pure decision logic for the "self-heal" insurance layer (docs/plans/
// 08-25-yolo-whiteboard/p1-design.md §1.2: "白板打开时逐卡解析 file 路径；
// 失效的用文件名...重定位（移动不改名必中），找回即就地修正保存"). The host
// side (src/ui/canvas.ts) does the I/O — checking which file nodes' `file`
// no longer resolves to a vault entry, and listing the vault's markdown
// files — and hands both in here; this module only decides which of those
// missing nodes can be safely relocated.
//
// Conservative on purpose: a node is only relocated when its basename
// matches *exactly one* candidate file. Zero matches (truly gone) or
// multiple matches (ambiguous — could silently repoint to the wrong note)
// both leave the node alone, so a wrong guess never overwrites a user's
// intent. Only markdown file nodes are covered: no vault API enumerates
// other file types the way `listMarkdownFiles()` does for notes, so the
// caller filters to those before calling in.

import type { NodeId } from './fileFormat'

export type MissingFileNode = Readonly<{ nodeId: NodeId; file: string }>

/** The subset of a vault markdown file's identity this decision needs. */
export type MarkdownFileCandidate = Readonly<{ path: string; name: string }>

export type FileNodeRelocation = Readonly<{ nodeId: NodeId; file: string }>

/**
 * `missing` is every markdown file node whose current `file` failed a vault
 * existence check. `markdownFiles` is the vault's full markdown file list
 * (`host.vault.listMarkdownFiles()`). Returns one relocation per missing
 * node that has exactly one same-basename candidate elsewhere in the
 * vault — nodes with zero or multiple candidates are omitted (the caller
 * renders them as "file missing" instead, per p1-design's "真丢失的渲染
 * '文件丢失'占位卡" — no automatic guess).
 */
export function planFileNodeSelfHeal(
  missing: readonly MissingFileNode[],
  markdownFiles: readonly MarkdownFileCandidate[],
): readonly FileNodeRelocation[] {
  if (missing.length === 0) return []

  const candidatesByName = new Map<string, string[]>()
  for (const file of markdownFiles) {
    const paths = candidatesByName.get(file.name)
    if (paths) paths.push(file.path)
    else candidatesByName.set(file.name, [file.path])
  }

  const relocations: FileNodeRelocation[] = []
  for (const node of missing) {
    const candidates = candidatesByName.get(basename(node.file))
    if (!candidates || candidates.length !== 1) continue
    const [onlyMatch] = candidates
    if (onlyMatch === undefined || onlyMatch === node.file) continue
    relocations.push({ nodeId: node.nodeId, file: onlyMatch })
  }
  return relocations
}

function basename(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator === -1 ? path : path.slice(separator + 1)
}
