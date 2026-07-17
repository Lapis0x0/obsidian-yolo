import { App, TFile, TFolder, normalizePath } from 'obsidian'

import {
  type LearningVaultEntry,
  type LearningVaultEntryListener,
  type LearningVaultReadApi,
  type LearningVaultRenameListener,
  isLearningVaultPathInScope,
  normalizeLearningVaultPath,
} from './learningVaultReadApi'

const normalizeVaultPath = (path: string) =>
  normalizePath(normalizeLearningVaultPath(path))

const describeEntry = (entry: TFile | TFolder): LearningVaultEntry =>
  entry instanceof TFile
    ? {
        kind: 'file',
        path: entry.path,
        name: entry.name,
        ctime: entry.stat?.ctime ?? 0,
        mtime: entry.stat?.mtime ?? 0,
      }
    : { kind: 'folder', path: entry.path, name: entry.name }

export function createObsidianLearningVaultReadApi(
  app: App,
): LearningVaultReadApi {
  const subscribe = (
    event: 'create' | 'modify' | 'delete',
    scopePath: string,
    listener: LearningVaultEntryListener,
  ): (() => void) => {
    const normalizedScope = normalizeVaultPath(scopePath)
    const handler = (entry: TFile | TFolder) => {
      if (!(entry instanceof TFile || entry instanceof TFolder)) return
      if (!isLearningVaultPathInScope(entry.path, normalizedScope)) return
      listener(describeEntry(entry))
    }
    const ref =
      event === 'create'
        ? app.vault.on('create', handler)
        : event === 'modify'
          ? app.vault.on('modify', handler)
          : app.vault.on('delete', handler)
    return () => app.vault.offref(ref)
  }

  return {
    getEntry: (path) => {
      const entry = app.vault.getAbstractFileByPath(normalizeVaultPath(path))
      return entry instanceof TFile || entry instanceof TFolder
        ? describeEntry(entry)
        : null
    },
    listChildren: (folderPath) => {
      const entry = app.vault.getAbstractFileByPath(
        normalizeVaultPath(folderPath),
      )
      return entry instanceof TFolder ? entry.children.map(describeEntry) : []
    },
    listMarkdownFiles: () =>
      app.vault.getMarkdownFiles().map((file) => ({
        kind: 'file' as const,
        path: file.path,
        name: file.name,
        ctime: file.stat?.ctime ?? 0,
        mtime: file.stat?.mtime ?? 0,
      })),
    readText: async (filePath) => {
      const entry = app.vault.getAbstractFileByPath(
        normalizeVaultPath(filePath),
      )
      if (!(entry instanceof TFile)) {
        throw new Error(`Learning vault file not found: ${filePath}`)
      }
      return app.vault.cachedRead(entry)
    },
    onCreate: (scopePath, listener) => subscribe('create', scopePath, listener),
    onModify: (scopePath, listener) => subscribe('modify', scopePath, listener),
    onDelete: (scopePath, listener) => subscribe('delete', scopePath, listener),
    onRename: (scopePath, listener: LearningVaultRenameListener) => {
      const normalizedScope = normalizeVaultPath(scopePath)
      const ref = app.vault.on('rename', (entry, oldPath) => {
        if (!(entry instanceof TFile || entry instanceof TFolder)) return
        if (
          !isLearningVaultPathInScope(entry.path, normalizedScope) &&
          !isLearningVaultPathInScope(oldPath, normalizedScope)
        ) {
          return
        }
        listener(describeEntry(entry), oldPath)
      })
      return () => app.vault.offref(ref)
    },
  }
}
