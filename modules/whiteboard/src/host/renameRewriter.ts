// Activate-level, always-on service: the "event layer" half of reference
// resilience (docs/plans/08-25-yolo-whiteboard/p1-design.md §1.2). Runs for
// the lifetime of the module (registered once from src/index.tsx's
// `activate`), independent of whether any `.yoloboard` file is currently
// open — a card's backing file can be renamed/moved while its board is
// closed, and the board must still come back correct next time it's
// opened.
//
// Scope: a vault-wide `rename` subscription (`host.vault.subscribe('', …)`
// — the empty scope path matches every path, per moduleVault.ts's
// `doesPathAffectScope`). On every rename, every `.yoloboard` file in the
// vault is scanned (p1-design: "白板文件数量少，全量扫描 + 按需改写即可，不
// 建常驻索引") and rewritten only if it actually references the moved path.
// A `.yoloboard` file being renamed itself is a no-op here — the reference
// direction is board -> card, never the reverse, so nothing points *at* a
// board file to rewrite.

import { parseBoard, serializeBoard } from '../domain/fileFormat'
import { rewriteFileReferences } from '../domain/fileReferences'

const YOLOBOARD_EXTENSION = 'yoloboard'
/** `host.paths.runExclusive` namespace: serializes the "scan every board,
 * rewrite the ones that reference the renamed path" pass against itself, so
 * two renames landing close together can't interleave reads/writes of the
 * same `.yoloboard` file. */
const RENAME_REWRITE_NAMESPACE = 'whiteboard-rename-rewrite'

/** Registers the listener and returns its disposer (for `host.lifecycle.add`). */
export function registerWhiteboardRenameRewriter(
  host: YoloModuleHostApiV1,
): () => void {
  return host.vault.subscribe('', (event) => {
    if (event.type !== 'rename') return
    if (event.entry.kind !== 'file') return
    if (isYoloboardPath(event.entry.path)) return
    const oldPath = event.oldPath
    const newPath = event.entry.path
    void host.paths
      .runExclusive(RENAME_REWRITE_NAMESPACE, () =>
        rewriteAllBoardReferences(host, oldPath, newPath),
      )
      .catch((error: unknown) => {
        console.error(
          '[YOLO Whiteboard] rename reference rewrite failed',
          error,
        )
      })
  })
}

async function rewriteAllBoardReferences(
  host: YoloModuleHostApiV1,
  oldPath: string,
  newPath: string,
): Promise<void> {
  for (const boardPath of collectYoloboardPaths(host, '')) {
    await rewriteBoardIfReferencing(host, boardPath, oldPath, newPath)
  }
}

function collectYoloboardPaths(
  host: YoloModuleHostApiV1,
  folderPath: string,
): string[] {
  const paths: string[] = []
  for (const entry of host.vault.listChildren(folderPath)) {
    if (entry.kind === 'folder') {
      paths.push(...collectYoloboardPaths(host, entry.path))
    } else if (isYoloboardPath(entry.path)) {
      paths.push(entry.path)
    }
  }
  return paths
}

async function rewriteBoardIfReferencing(
  host: YoloModuleHostApiV1,
  boardPath: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  let raw: string
  try {
    raw = await host.vault.readText(boardPath)
  } catch (error) {
    console.error(
      `[YOLO Whiteboard] failed to read "${boardPath}" during rename rewrite`,
      error,
    )
    return
  }
  const result = parseBoard(raw)
  // An unparsable board can't be safely round-tripped — leave it untouched
  // rather than risk clobbering content this pass doesn't understand.
  if (!result.ok) return
  const rewritten = rewriteFileReferences(result.board, oldPath, newPath)
  if (!rewritten) return
  try {
    await host.vault.writeText(boardPath, serializeBoard(rewritten))
  } catch (error) {
    console.error(
      `[YOLO Whiteboard] failed to write "${boardPath}" during rename rewrite`,
      error,
    )
  }
}

function isYoloboardPath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${YOLOBOARD_EXTENSION}`)
}
