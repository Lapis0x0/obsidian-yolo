// Shared "create a new whiteboard" flow behind the creation entries
// (command + ribbon + folder context menu). The command and ribbon pass the
// folder from the module settings ("New whiteboard folder"; `''` — the vault
// root — when unset, see ./settings.ts); the folder menu action passes the
// right-clicked folder.
// All funnel through this one function so naming, conflict resolution,
// and open-after-create behavior can never drift between the entry
// points (src/index.tsx wires all of them to this).

import { emptyBoard, serializeBoard } from '../domain/fileFormat'
import { generateBoardFileName } from '../domain/naming'
import { createWhiteboardTranslation } from '../i18n'

export async function createWhiteboard(
  host: YoloModuleHostApiV1,
  folderPath: string,
): Promise<void> {
  const t = createWhiteboardTranslation(host.i18n.getSnapshot().locale)
  try {
    const baseName = t('file.newWhiteboardBaseName')
    const existingNames = new Set(
      host.vault
        .listChildren(folderPath)
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.name),
    )
    const fileName = generateBoardFileName(baseName, existingNames)
    const path = folderPath ? `${folderPath}/${fileName}` : fileName

    await host.vault.ensureFolder(folderPath)
    await host.vault.createText(path, serializeBoard(emptyBoard()))
    await host.ui.openFileAt({ path })
  } catch (error) {
    console.error('[YOLO Whiteboard] failed to create a new whiteboard', error)
    host.ui.notice(t('error.createFailed'))
  }
}
