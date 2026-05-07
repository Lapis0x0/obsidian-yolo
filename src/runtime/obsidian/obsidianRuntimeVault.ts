import { normalizePath, type App, TFile, TFolder } from 'obsidian'
import type {
  YoloFileRef,
  YoloRuntime,
  YoloVaultIndexEntry,
} from '../yoloRuntime.types'

function toFileRef(file: {
  path: string
  name: string
  basename: string
  extension: string
  stat?: {
    ctime: number
    mtime: number
    size: number
  }
}): YoloFileRef {
  return {
    path: file.path,
    name: file.name,
    basename: file.basename,
    extension: file.extension,
    stat: file.stat
      ? {
          ctime: file.stat.ctime,
          mtime: file.stat.mtime,
          size: file.stat.size,
        }
      : undefined,
  }
}

type VaultPathInput = string | { path: string }

type VaultAdapterLike = {
  exists?(path: string): Promise<boolean>
  stat?(path: string): Promise<{ type: string } | null>
}

function getPath(input: VaultPathInput): string {
  return typeof input === 'string' ? input : input.path
}

function resolveFile(app: App, input: VaultPathInput): TFile {
  const path = getPath(input)
  const file = app.vault.getFileByPath(path)
  if (!file) {
    throw new Error(`File not found: ${path}`)
  }
  return file
}

function resolveAbstractFile(app: App, input: VaultPathInput): TFile | TFolder {
  const path = getPath(input)
  const file = app.vault.getAbstractFileByPath(path)
  if (!file) {
    throw new Error(`Path not found: ${path}`)
  }
  return file as TFile | TFolder
}

async function isExistingFolder(app: App, path: string): Promise<boolean> {
  const adapter = app.vault.adapter as VaultAdapterLike
  if (typeof adapter.stat === 'function') {
    const stat = await adapter.stat(path)
    if (stat?.type === 'folder') {
      return true
    }
    if (stat?.type === 'file') {
      throw new Error(`Path already exists and is not a folder: ${path}`)
    }
  }

  const existing = app.vault.getAbstractFileByPath(path)
  if (existing instanceof TFolder) {
    return true
  }
  if (existing instanceof TFile) {
    throw new Error(`Path already exists and is not a folder: ${path}`)
  }

  if (typeof adapter.exists === 'function' && (await adapter.exists(path))) {
    return true
  }

  return false
}

async function ensureFolder(app: App, inputPath: string): Promise<void> {
  const path = normalizePath(inputPath)
  if (!path || path === '/') {
    return
  }

  if (await isExistingFolder(app, path)) {
    return
  }

  const slashIndex = path.lastIndexOf('/')
  if (slashIndex > 0) {
    await ensureFolder(app, path.slice(0, slashIndex))
  }

  try {
    await app.vault.createFolder(path)
  } catch (error) {
    if (await isExistingFolder(app, path)) {
      return
    }
    throw error
  }
}

export function createObsidianRuntimeVault(app: App): YoloRuntime['vault'] {
  return {
    getActiveFile: () => {
      const file = app.workspace.getActiveFile()
      return file ? toFileRef(file) : null
    },
    read: (file) => app.vault.read(resolveFile(app, file as VaultPathInput)),
    readBinary: (file) =>
      app.vault.readBinary(resolveFile(app, file as VaultPathInput)),
    search: async (query) => {
      const needle = query.toLowerCase()
      return app.vault
        .getMarkdownFiles()
        .filter((file) => file.path.toLowerCase().includes(needle))
        .slice(0, 50)
        .map(toFileRef)
    },
    getAbstractFileByPath: (path) => {
      const file = app.vault.getAbstractFileByPath(path)
      if (!file) return null
      const ref = { path: file.path, name: file.name }
      if (file instanceof TFile) {
        return { ...ref, basename: file.basename, extension: file.extension }
      }
      return { ...ref, basename: '', extension: '' }
    },
    listIndex: async () =>
      app.vault.getAllLoadedFiles().map((entry): YoloVaultIndexEntry => {
        if (entry instanceof TFile) {
          return {
            kind: 'file',
            path: entry.path,
            name: entry.name,
            basename: entry.basename,
            extension: entry.extension,
            stat: {
              ctime: entry.stat.ctime,
              mtime: entry.stat.mtime,
              size: entry.stat.size,
            },
          }
        }

        return {
          kind: 'folder',
          path: entry.path,
          name: entry.name,
          basename: entry.name,
          extension: '',
        }
      }),
    getFileByPath: (path) => app.vault.getFileByPath(path),
    createFolder: (path) => ensureFolder(app, path),
    modify: (file, content) =>
      app.vault.modify(resolveFile(app, file as VaultPathInput), content),
    create: (path, content) => app.vault.create(path, content).then(() => {}),
    trashFile: async (file) => {
      await app.fileManager
        .trashFile(resolveAbstractFile(app, file as VaultPathInput))
        .then(() => {})
    },
    getLeavesOfType: (type) => app.workspace.getLeavesOfType(type),
    getLeaf: (split) => app.workspace.getLeaf(split),
  }
}
