import {
  ANKI_IMPORT_JOURNAL_DIR_NAME,
  FileAnkiImportJournalStorage,
} from '../../anki/import/journalStorage'
import type {
  AnkiImportJournalStorage,
  AnkiJournalFilePort,
} from '../../anki/import/ports'
import { runWithLearningManagedDataLock } from '../paths'

import {
  getHostLearningDataRoot,
  normalizeHostAnkiPath,
  splitLearningDataPath,
} from './paths'

type HostVault = YoloModuleHostApiV1['vault']

export type HostAnkiJournalOptions = Readonly<{
  legacyJournalDataRoots?: readonly string[]
}>

type JournalHost = Pick<YoloModuleHostApiV1, 'paths' | 'vault'>

export const createHostAnkiJournalStorage = (
  host: JournalHost,
  options: HostAnkiJournalOptions = {},
  lockMutations = true,
): AnkiImportJournalStorage => {
  const getDataRoot = async () => getHostLearningDataRoot(host.paths)
  const storage = new FileAnkiImportJournalStorage(
    createHostAnkiJournalFilePort(host.vault, getDataRoot, options),
    getDataRoot,
  )
  if (!lockMutations) return storage

  return {
    create: (content) =>
      runWithLearningManagedDataLock(host.paths, () => storage.create(content)),
    write: (path, content) =>
      runWithLearningManagedDataLock(host.paths, () =>
        storage.write(path, content),
      ),
    list: () => storage.list(),
    read: (path) => storage.read(path),
    remove: (path) =>
      runWithLearningManagedDataLock(host.paths, () => storage.remove(path)),
  }
}

const journalDirectory = (root: string): string =>
  `${root}/${ANKI_IMPORT_JOURNAL_DIR_NAME}`

const normalizeDataRoot = (path: string, label: string): string => {
  const normalized = normalizeHostAnkiPath(path, label)
  const split = splitLearningDataPath(normalized)
  if (split.root !== normalized || split.relative) {
    throw new Error(`${label} must be a canonical Learning JSON data root`)
  }
  return normalized
}

const directJournalName = (name: string): boolean =>
  name.endsWith('.json') && !name.includes('/') && !name.includes('\\')

export const createHostAnkiJournalFilePort = (
  vault: HostVault,
  getLearningDataRoot: () => Promise<string>,
  options: HostAnkiJournalOptions = {},
): AnkiJournalFilePort => {
  const legacyDirectories = (options.legacyJournalDataRoots ?? []).map((root) =>
    journalDirectory(normalizeDataRoot(root, 'Legacy Anki journal data root')),
  )
  const pinnedDirectories = new Set(legacyDirectories)

  const currentDirectory = async (): Promise<string> => {
    const root = normalizeDataRoot(
      await getLearningDataRoot(),
      'Anki journal data root',
    )
    const directory = journalDirectory(root)
    pinnedDirectories.add(directory)
    return directory
  }

  const assertDirectory = async (path: string): Promise<string> => {
    const normalized = normalizeHostAnkiPath(path, 'Anki journal directory')
    const current = await currentDirectory()
    if (normalized !== current && !legacyDirectories.includes(normalized)) {
      throw new Error(`Unmanaged Anki journal directory: ${path}`)
    }
    return normalized
  }

  const assertFile = async (path: string): Promise<string> => {
    const normalized = normalizeHostAnkiPath(path, 'Anki journal path')
    const slash = normalized.lastIndexOf('/')
    const directory = normalized.slice(0, slash)
    const name = normalized.slice(slash + 1)
    await currentDirectory()
    if (!pinnedDirectories.has(directory) || !directJournalName(name)) {
      throw new Error(`Unmanaged Anki journal path: ${path}`)
    }
    return normalized
  }

  const listDirectory = async (
    directory: string,
  ): Promise<readonly string[]> => {
    const entry = await vault.stat(directory)
    if (entry === null) return []
    if (entry.kind !== 'folder') {
      throw new Error(`Anki journal directory is not a folder: ${directory}`)
    }
    const prefix = `${directory}/`
    return (await vault.list(directory))
      .filter(
        (child) =>
          child.kind === 'file' &&
          child.path === `${prefix}${child.name}` &&
          directJournalName(child.name),
      )
      .map((child) => child.path)
  }

  return {
    exists: async (path) => {
      const normalized = normalizeHostAnkiPath(path, 'Anki journal path')
      const entry = normalized.endsWith(`/${ANKI_IMPORT_JOURNAL_DIR_NAME}`)
        ? await assertDirectory(normalized)
        : await assertFile(normalized)
      return vault.exists(entry)
    },
    mkdir: async (path) => {
      await vault.ensureFolder(await assertDirectory(path))
    },
    write: async (path, content) => {
      const normalized = await assertFile(path)
      const entry = await vault.stat(normalized)
      if (entry === null) {
        await vault.createText(normalized, content)
        return
      }
      if (entry.kind !== 'file') {
        throw new Error(`Anki journal path is not a file: ${normalized}`)
      }
      await vault.writeText(normalized, content)
    },
    list: async (path) => {
      const current = await assertDirectory(path)
      const directories = [...new Set([current, ...legacyDirectories])]
      const files = (await Promise.all(directories.map(listDirectory))).flat()
      return { files: files.sort() }
    },
    read: (path) =>
      assertFile(path).then((normalized) => vault.readText(normalized)),
    remove: async (path) => {
      const normalized = await assertFile(path)
      if (!(await vault.removeFileExact(normalized))) {
        throw new Error(
          `Host refused exact Anki journal removal: ${normalized}`,
        )
      }
    },
  }
}
