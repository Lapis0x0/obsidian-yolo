import { App, FileSystemAdapter, Platform, TFile, TFolder } from 'obsidian'

import { Mentionable } from '../../../../../types/mentionable'

const OBSIDIAN_OPEN_PREFIX = 'obsidian://open?'

export type ResolvedDrop = {
  /** Vault resources — inserted as mention chips. */
  mentionables: Mentionable[]
  /** Files outside the vault — handed to the existing attachment classifier. */
  files: File[]
}

/**
 * Whether a drag carries something the chat input can take.
 *
 * Called during dragenter/dragover, where the browser blocks `getData()` and
 * `files` is always empty — only `types` is readable. So an inbound drag is
 * recognised from `types` plus Obsidian's own drag state, and the full
 * resolution below is deferred to the drop itself. One consequence: an
 * `obsidian://` link dragged from a browser cannot be recognised early, so it
 * gets no drop hint even though the drop still works. That gap is inherent to
 * the DataTransfer protection model, not something to work around.
 */
export function canAcceptDrop(app: App, dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types ?? [])
  if (types.includes('Files')) {
    return true
  }
  return getDraggedVaultItems(app).length > 0
}

/**
 * Normalises a drop into vault mentionables plus leftover external files.
 *
 * Both drag sources converge here: whatever an item's origin, it is classified
 * by what it actually is and where it lives. A dropped path inside the vault
 * becomes the same mention an internal drag would have produced.
 */
export function resolveDrop(
  app: App,
  dataTransfer: DataTransfer,
): ResolvedDrop {
  const mentionables: Mentionable[] = []
  const files: File[] = []
  const seenKeys = new Set<string>()

  const push = (mentionable: Mentionable, key: string) => {
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    mentionables.push(mentionable)
  }

  const addVaultItem = (item: TFile | TFolder) => {
    if (item instanceof TFolder) {
      push({ type: 'folder', folder: item }, `folder:${item.path}`)
    } else {
      push({ type: 'file', file: item }, `file:${item.path}`)
    }
  }

  // Obsidian's own drag state is the authoritative source for an internal
  // drag; a dragged folder appears nowhere else in the DataTransfer.
  getDraggedVaultItems(app).forEach(addVaultItem)

  for (const url of extractCandidateUrls(dataTransfer)) {
    const file = resolveObsidianOpenUrl(app, url)
    if (file) {
      addVaultItem(file)
    }
  }

  for (const { file, isDirectory } of collectDroppedEntries(dataTransfer)) {
    const absolutePath = getDroppedFilePath(file)
    const vaultItem = absolutePath
      ? resolveVaultItemFromAbsolutePath(app, absolutePath)
      : null

    if (vaultItem) {
      addVaultItem(vaultItem)
      continue
    }

    if (isDirectory) {
      // A directory has no content to attach. Outside the vault the absolute
      // path is the context itself — the agent reads it through its own tools.
      if (absolutePath) {
        push(
          { type: 'local-folder', path: absolutePath },
          `local-folder:${absolutePath}`,
        )
      }
      continue
    }

    files.push(file)
  }

  return { mentionables, files }
}

/** Obsidian's internal drag state. Not public API — accessed defensively. */
type ObsidianDraggable = {
  file?: unknown
  files?: unknown[]
}

function getDraggedVaultItems(app: App): (TFile | TFolder)[] {
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

function extractCandidateUrls(dataTransfer: DataTransfer): string[] {
  const uriList = dataTransfer.getData('text/uri-list')
  if (uriList) {
    const lines = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    if (lines.length > 0) {
      return lines
    }
  }

  const plain = dataTransfer.getData('text/plain')
  if (plain) {
    return plain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  return []
}

function resolveObsidianOpenUrl(app: App, raw: string): TFile | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith(OBSIDIAN_OPEN_PREFIX)) {
    return null
  }

  let linkpath: string
  let vault: string | null
  try {
    const url = new URL(trimmed)
    const file = url.searchParams.get('file')
    if (!file) {
      return null
    }
    linkpath = file
    vault = url.searchParams.get('vault')
  } catch {
    return null
  }

  if (vault && vault !== app.vault.getName()) {
    return null
  }

  const linked = app.metadataCache.getFirstLinkpathDest(linkpath, '')
  if (linked) {
    return linked
  }

  const direct = app.vault.getAbstractFileByPath(linkpath)
  if (direct instanceof TFile) {
    return direct
  }

  const withMd = app.vault.getAbstractFileByPath(`${linkpath}.md`)
  return withMd instanceof TFile ? withMd : null
}

type DroppedEntry = {
  file: File
  isDirectory: boolean
}

/**
 * Pairs each dropped item with whether it is a directory.
 *
 * `webkitGetAsEntry` is the only trustworthy signal here: a dropped directory
 * still arrives as a `File`, and its `size` is the directory inode's size —
 * 352 bytes on macOS, not the zero that a "looks empty" heuristic assumes.
 * The entry must be read synchronously while the drop event is live.
 */
function collectDroppedEntries(dataTransfer: DataTransfer): DroppedEntry[] {
  const items = dataTransfer.items
  const entries: DroppedEntry[] = []

  for (let index = 0; index < (items?.length ?? 0); index += 1) {
    const item = items[index]
    if (item.kind !== 'file') {
      continue
    }
    const file = item.getAsFile()
    if (!file) {
      continue
    }
    entries.push({
      file,
      isDirectory: item.webkitGetAsEntry()?.isDirectory ?? false,
    })
  }

  if (entries.length > 0) {
    return entries
  }

  return Array.from(dataTransfer.files ?? []).map((file) => ({
    file,
    isDirectory: false,
  }))
}

/**
 * Absolute host path of a dropped item. Desktop only: `File.path` was removed
 * in Electron 32, and `webUtils` is the replacement. Without it (mobile) the
 * drop degrades to attachment-only handling, which is the correct behaviour
 * there anyway — mobile has no external filesystem to reach into.
 */
function getDroppedFilePath(file: File): string | null {
  if (!Platform.isDesktopApp) {
    return null
  }
  try {
    // electron is injected by Obsidian's desktop runtime and marked external
    // in esbuild.config.mjs, so it never reaches the mobile bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only runtime API injected by Obsidian
    const { webUtils } = require('electron') as {
      webUtils?: { getPathForFile: (file: File) => string }
    }
    const path = webUtils?.getPathForFile(file)
    return path && path.length > 0 ? path : null
  } catch {
    return null
  }
}

function resolveVaultItemFromAbsolutePath(
  app: App,
  absolutePath: string,
): TFile | TFolder | null {
  const adapter = app.vault.adapter
  if (!(adapter instanceof FileSystemAdapter)) {
    return null
  }

  const basePath = normalizeSeparators(adapter.getBasePath()).replace(
    /\/+$/,
    '',
  )
  const target = normalizeSeparators(absolutePath).replace(/\/+$/, '')
  if (target === basePath || !target.startsWith(`${basePath}/`)) {
    return null
  }

  const vaultPath = target.slice(basePath.length + 1)
  const item = app.vault.getAbstractFileByPath(vaultPath)
  return item instanceof TFile || item instanceof TFolder ? item : null
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/')
}
