import { App, TFile, normalizePath } from 'obsidian'

import { normalizeLearningVaultPath } from './learningVaultReadApi'
import type {
  LearningVaultFileSnapshot,
  LearningVaultWriteApi,
} from './learningVaultWriteApi'

const normalizeVaultPath = (path: string) =>
  normalizePath(normalizeLearningVaultPath(path))

type AppWriteState = {
  readonly pathQueues: Map<string, Promise<void>>
  readonly creationReceipts: WeakMap<LearningVaultFileSnapshot, symbol>
}

const appWriteStates = new WeakMap<App, AppWriteState>()
const processMismatch = new Error('Learning vault process mismatch')

function getAppWriteState(app: App): AppWriteState {
  let state = appWriteStates.get(app)
  if (!state) {
    state = {
      pathQueues: new Map(),
      creationReceipts: new WeakMap(),
    }
    appWriteStates.set(app, state)
  }
  return state
}

function serializePath<R>(
  state: AppWriteState,
  path: string,
  operation: () => Promise<R>,
): Promise<R> {
  const previous = state.pathQueues.get(path) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  state.pathQueues.set(path, settled)
  void settled.then(() => {
    if (state.pathQueues.get(path) === settled) state.pathQueues.delete(path)
  })
  return result
}

export function createObsidianLearningVaultWriteApi(
  app: App,
): LearningVaultWriteApi {
  const state = getAppWriteState(app)

  const snapshot = (
    file: TFile,
    content: string,
    receipt?: symbol,
  ): LearningVaultFileSnapshot => {
    const value = { path: file.path, content, identity: file }
    if (receipt) state.creationReceipts.set(value, receipt)
    return value
  }

  const revertOwnedCreatedTextIfUnchanged = async (
    created: LearningVaultFileSnapshot,
    expected: LearningVaultFileSnapshot,
    fallbackContent: string,
  ): Promise<LearningVaultFileSnapshot | null> => {
    const path = normalizeVaultPath(expected.path)
    return serializePath(state, path, async () => {
      const receipt = state.creationReceipts.get(created)
      if (
        !receipt ||
        state.creationReceipts.get(expected) !== receipt ||
        created.path !== expected.path ||
        created.identity !== expected.identity
      ) {
        return null
      }
      const entry = app.vault.getAbstractFileByPath(path)
      if (!(entry instanceof TFile) || entry !== expected.identity) return null
      try {
        await app.vault.process(entry, (current) => {
          if (current !== expected.content) throw processMismatch
          return fallbackContent
        })
      } catch (error) {
        if (error === processMismatch) return null
        throw error
      }
      if (app.vault.getAbstractFileByPath(path) !== entry) return null
      return snapshot(entry, fallbackContent)
    })
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
      const path = normalizeVaultPath(filePath)
      return serializePath(state, path, async () => {
        const file = await app.vault.create(path, content)
        return { path: file.path, mtime: file.stat?.mtime ?? 0 }
      })
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
      return serializePath(state, path, async () => {
        if (app.vault.getAbstractFileByPath(path)) return null
        const file = await app.vault.create(path, content)
        return snapshot(file, content, Symbol(path))
      })
    },
    replaceTextIfUnchanged: async (expected, content) => {
      const path = normalizeVaultPath(expected.path)
      return serializePath(state, path, async () => {
        const entry = app.vault.getAbstractFileByPath(path)
        if (!(entry instanceof TFile) || entry !== expected.identity)
          return null
        try {
          await app.vault.process(entry, (current) => {
            if (current !== expected.content) throw processMismatch
            return content
          })
        } catch (error) {
          if (error === processMismatch) return null
          throw error
        }
        if (app.vault.getAbstractFileByPath(path) !== entry) return null
        return snapshot(entry, content, state.creationReceipts.get(expected))
      })
    },
    revertOwnedCreatedTextIfUnchanged,
  }
}
