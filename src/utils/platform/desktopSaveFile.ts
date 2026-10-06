// The system save dialog and the file it names, for the desktop app only:
// Electron's dialog through `@electron/remote`, the file through `node:fs`.
// Loaded lazily (Runtime Boundaries, CLAUDE.md) — nothing here may be reached
// on mobile, which has no dialog to show.
//
// The file is written beside its destination under a temporary name and moved
// into place on close, so an abandoned save leaves the file the user chose to
// replace as it was.

import { loadDesktopNodeModule } from './desktopNodeModule'

export type SaveFileRequest = Readonly<{
  suggestedName: string
  filters?: readonly Readonly<{
    name: string
    extensions: readonly string[]
  }>[]
}>

export type SaveFileSink = Readonly<{
  name: string
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}>

type ElectronRemote = {
  dialog: {
    showSaveDialog(
      window: unknown,
      options: Readonly<{
        defaultPath: string
        filters?: { name: string; extensions: string[] }[]
      }>,
    ): Promise<{ canceled: boolean; filePath?: string }>
  }
  BrowserWindow: { getFocusedWindow(): unknown }
  getCurrentWindow(): unknown
}

export async function showDesktopSaveDialog(
  request: SaveFileRequest,
): Promise<SaveFileSink | null> {
  const remote = await loadDesktopNodeModule<ElectronRemote>('@electron/remote')
  const fs =
    await loadDesktopNodeModule<typeof import('node:fs/promises')>(
      'node:fs/promises',
    )
  // The window the user is in — a popout's, when that is where they asked —
  // so the dialog is attached to it rather than to the main window.
  const owner =
    remote.BrowserWindow.getFocusedWindow() ?? remote.getCurrentWindow()
  const result = await remote.dialog.showSaveDialog(owner, {
    defaultPath: request.suggestedName,
    filters: request.filters?.map((filter) => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
  })
  const target = result.filePath
  if (result.canceled || !target) return null
  const temporary = `${target}.${Date.now().toString(36)}.part`
  const handle = await fs.open(temporary, 'w')
  // Writes land in order however the caller awaits them.
  let queue: Promise<unknown> = Promise.resolve()
  let finished = false
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task)
    queue = next.catch(() => undefined)
    return next
  }
  return Object.freeze({
    name: target.split(/[\\/]/).pop() ?? target,
    write: (chunk: Uint8Array) => {
      if (finished) return Promise.reject(new Error('The file is closed'))
      return enqueue(async () => {
        await handle.write(chunk)
      })
    },
    close: () => {
      if (finished) return Promise.reject(new Error('The file is closed'))
      finished = true
      return enqueue(async () => {
        await handle.close()
        await fs.rename(temporary, target)
      })
    },
    abort: () => {
      if (finished) return Promise.resolve()
      finished = true
      return enqueue(async () => {
        await handle.close().catch(() => undefined)
        await fs.rm(temporary, { force: true })
      })
    },
  })
}
