import { App, TFile, normalizePath } from 'obsidian'

import { normalizeLearningVaultPath } from './learningVaultReadApi'
import type {
  LearningVaultFileSnapshot,
  LearningVaultWriteApi,
} from './learningVaultWriteApi'

const normalizeVaultPath = (path: string) =>
  normalizePath(normalizeLearningVaultPath(path))

export function createObsidianLearningVaultWriteApi(
  app: App,
): LearningVaultWriteApi {
  const createdSnapshots = new WeakSet<LearningVaultFileSnapshot>()

  const snapshot = (
    file: TFile,
    content: string,
    created = false,
  ): LearningVaultFileSnapshot => {
    const value = { path: file.path, content, identity: file }
    if (created) createdSnapshots.add(value)
    return value
  }

  return {
    ensureFolder: async (folderPath) => {
      const path = normalizeVaultPath(folderPath)
      if (app.vault.getAbstractFileByPath(path)) return
      await app.vault.adapter.mkdir(path)
    },
    listChildNames: async (folderPath) => {
      const listed = await app.vault.adapter.list(
        normalizeVaultPath(folderPath),
      )
      return [...listed.files, ...listed.folders]
        .map((path) => path.split('/').at(-1))
        .filter((name): name is string => Boolean(name))
    },
    listChildFilePaths: async (folderPath) => {
      const listed = await app.vault.adapter.list(
        normalizeVaultPath(folderPath),
      )
      return listed.files
    },
    createText: async (filePath, content) => {
      const file = await app.vault.create(normalizeVaultPath(filePath), content)
      return { path: file.path, mtime: file.stat?.mtime ?? 0 }
    },
    createBinary: async (filePath, content) => {
      await app.vault.createBinary(normalizeVaultPath(filePath), content)
    },
    writeText: async (filePath, content) => {
      const path = normalizeVaultPath(filePath)
      const entry = app.vault.getAbstractFileByPath(path)
      if (!(entry instanceof TFile)) {
        throw new Error(`Learning vault file not found: ${path}`)
      }
      await app.vault.modify(entry, content)
      return { path: entry.path, mtime: entry.stat?.mtime ?? 0 }
    },
    renamePath: async (oldPath, newPath) => {
      await app.vault.adapter.rename(
        normalizeVaultPath(oldPath),
        normalizeVaultPath(newPath),
      )
    },
    removeTree: async (folderPath) => {
      await app.vault.adapter.rmdir(normalizeVaultPath(folderPath), true)
    },
    readTextSnapshot: async (filePath) => {
      const path = normalizeVaultPath(filePath)
      const entry = app.vault.getAbstractFileByPath(path)
      if (!entry) return null
      if (!(entry instanceof TFile)) {
        throw new Error(`cards.md 路径不是文件：${path}`)
      }
      return snapshot(entry, await app.vault.read(entry))
    },
    createTextIfAbsent: async (filePath, content) => {
      const path = normalizeVaultPath(filePath)
      if (app.vault.getAbstractFileByPath(path)) return null
      const file = await app.vault.create(path, content)
      return snapshot(file, content, true)
    },
    replaceTextIfUnchanged: async (expected, content) => {
      const path = normalizeVaultPath(expected.path)
      const entry = app.vault.getAbstractFileByPath(path)
      if (!(entry instanceof TFile) || entry !== expected.identity) return null
      if ((await app.vault.read(entry)) !== expected.content) return null
      await app.vault.modify(entry, content)
      const next = snapshot(entry, content)
      if (createdSnapshots.has(expected)) createdSnapshots.add(next)
      return next
    },
    deleteCreatedTextIfUnchanged: async (expected) => {
      if (!createdSnapshots.has(expected)) return false
      const path = normalizeVaultPath(expected.path)
      const entry = app.vault.getAbstractFileByPath(path)
      if (!(entry instanceof TFile) || entry !== expected.identity) return false
      if ((await app.vault.read(entry)) !== expected.content) return false
      // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Transaction rollback must restore the original absent-file state.
      await app.vault.delete(entry)
      return true
    },
  }
}
