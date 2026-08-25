// Shared "create a new whiteboard" flow behind both creation entries
// (docs/plans/08-25-yolo-whiteboard/p1-design.md §5: command + folder
// context menu). The command creates at the vault root (`folderPath`
// `''`); the folder menu action creates inside the right-clicked folder.
// Both funnel through this one function so naming, conflict resolution,
// and open-after-create behavior can never drift between the two entry
// points (src/index.tsx wires both to this).

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
