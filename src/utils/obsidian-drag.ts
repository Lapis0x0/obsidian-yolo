import { App, TFile, TFolder } from 'obsidian'

/**
 * Reads the vault items behind an in-progress Obsidian drag.
 *
 * Obsidian's own drag state is the authoritative source for a drag that
 * started inside the app: dragging from the file explorer puts no usable
 * vault path in the `DataTransfer` (and a dragged folder appears nowhere in
 * it at all), so anything that wants to accept an internal drop has to read
 * `dragManager` instead. That is a private API, so it is accessed
 * defensively and lives behind this one function — both the chat input's
 * drop resolution and the module Host API's drop surface read it from here
 * rather than each reaching into `app` on their own.
 */
type ObsidianDraggable = {
  file?: unknown
  files?: unknown[]
}

export function getDraggedVaultItems(app: App): (TFile | TFolder)[] {
  const draggable = (
    app as unknown as { dragManager?: { draggable?: ObsidianDraggable } }
  ).dragManager?.draggable
  if (!draggable) {
    return []
  }

  const candidates: unknown[] = []
  if (draggable.file) {
    candidates.push(draggable.file)
  }
  if (Array.isArray(draggable.files)) {
    candidates.push(...draggable.files)
  }

  return candidates.filter(
    (candidate): candidate is TFile | TFolder =>
      candidate instanceof TFile || candidate instanceof TFolder,
  )
}
