// The vault-facing half of the `.canvas` importer (p3-canvas-parity D4). The
// conversion itself is pure and lives in domain/canvasImport.ts; this file
// only does I/O: read the `.canvas`, pick a free `.yoloboard` name beside it,
// write it, and say what happened.
//
// One-way, and the source file is never touched — not read-modify-written,
// not renamed, not trashed. A user who imports a canvas still has their
// canvas, and Obsidian still owns it.

import { importCanvas } from '../domain/canvasImport'
import { serializeBoard } from '../domain/fileFormat'
import {
  basenameWithoutExtension,
  folderPathOf,
  generateBoardFileName,
  isCanvasPath,
} from '../domain/naming'
import { createWhiteboardTranslation } from '../i18n'

export type CanvasImportOutcome =
  | Readonly<{ ok: true; path: string; nodes: number; edges: number }>
  | Readonly<{
      ok: false
      reason: 'unreadable' | 'unparsable' | 'write-failed'
    }>

/**
 * Imports one `.canvas` into a sibling `.yoloboard`. The new board takes the
 * canvas's own base name, with the module's existing numeric-suffix conflict
 * rule (domain/naming.ts) applied — so importing twice gives "Board" and
 * "Board 1" rather than overwriting anything.
 */
export async function importCanvasFile(
  host: YoloModuleHostApiV1,
  canvasPath: string,
): Promise<CanvasImportOutcome> {
  let raw: string
  try {
    raw = await host.vault.readText(canvasPath)
  } catch (error) {
    console.error(
      `[YOLO Whiteboard] failed to read "${canvasPath}" for import`,
      error,
    )
    return { ok: false, reason: 'unreadable' }
  }

  const result = importCanvas(raw)
  if (!result.ok) {
    console.warn(
      `[YOLO Whiteboard] "${canvasPath}" is not a readable .canvas file`,
      result.issues,
    )
    return { ok: false, reason: 'unparsable' }
  }
  if (result.issues.length > 0) {
    // Per-record losses are developer-facing detail; the notice reports the
    // counts that actually landed.
    console.warn(
      `[YOLO Whiteboard] skipped records while importing "${canvasPath}"`,
      result.issues,
    )
  }

  const folderPath = folderPathOf(canvasPath)
  const existingNames = new Set(
    host.vault
      .listChildren(folderPath)
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.name),
  )
  const fileName = generateBoardFileName(
    basenameWithoutExtension(canvasPath),
    existingNames,
  )
  const boardPath = folderPath ? `${folderPath}/${fileName}` : fileName

  try {
    await host.vault.createText(boardPath, serializeBoard(result.board))
  } catch (error) {
    console.error(
      `[YOLO Whiteboard] failed to write "${boardPath}" during import`,
      error,
    )
    return { ok: false, reason: 'write-failed' }
  }
  return {
    ok: true,
    path: boardPath,
    nodes: result.counts.nodes,
    edges: result.counts.edges,
  }
}

/**
 * The file-menu entry: import this one canvas and open the result. The user
 * pointed at a specific file, so the board they get is opened for them.
 */
export async function importCanvasFileAndOpen(
  host: YoloModuleHostApiV1,
  canvasPath: string,
): Promise<void> {
  const t = createWhiteboardTranslation(host.i18n.getSnapshot().locale)
  const outcome = await importCanvasFile(host, canvasPath)
  if (!outcome.ok) {
    host.ui.notice(t('error.importFailed'))
    return
  }
  host.ui.notice(t('notice.imported').replace('{path}', outcome.path))
  await host.ui.openFileAt({ path: outcome.path })
}

/**
 * The command entry: import every `.canvas` in the vault.
 *
 * A command carries no target — the Host API has no active-file surface and
 * no file picker — so the useful thing a command can do here is the migration
 * D4 exists for: bring a vault's canvases across in one go. It asks first,
 * with the count, because it writes one new file per canvas; nothing existing
 * is overwritten (`generateBoardFileName` finds a free name each time).
 */
export async function importAllCanvasFiles(
  host: YoloModuleHostApiV1,
): Promise<void> {
  const t = createWhiteboardTranslation(host.i18n.getSnapshot().locale)
  const canvasPaths = collectCanvasPaths(host, '')
  if (canvasPaths.length === 0) {
    host.ui.notice(t('notice.importNoneFound'))
    return
  }
  const confirmed = await host.ui.confirm({
    title: t('confirm.importAllTitle'),
    message: t('confirm.importAllMessage').replace(
      '{count}',
      String(canvasPaths.length),
    ),
    ctaText: t('confirm.importAllCta'),
  })
  if (!confirmed) return

  let imported = 0
  let failed = 0
  for (const canvasPath of canvasPaths) {
    const outcome = await importCanvasFile(host, canvasPath)
    if (outcome.ok) imported += 1
    else failed += 1
  }
  host.ui.notice(
    t('notice.importedAll')
      .replace('{imported}', String(imported))
      .replace('{failed}', String(failed)),
  )
}

function collectCanvasPaths(
  host: YoloModuleHostApiV1,
  folderPath: string,
): string[] {
  const paths: string[] = []
  for (const entry of host.vault.listChildren(folderPath)) {
    if (entry.kind === 'folder') {
      paths.push(...collectCanvasPaths(host, entry.path))
    } else if (isCanvasPath(entry.path)) {
      paths.push(entry.path)
    }
  }
  return paths
}
