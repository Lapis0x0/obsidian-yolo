import type { AnkiImportVaultPort } from '../../anki/import/ports'

import { normalizeHostAnkiPath } from './paths'

type HostVault = YoloModuleHostApiV1['vault']
type HostVaultExactRemoval = Partial<
  Pick<HostVault, 'removeFileExact' | 'removeEmptyFolderExact'>
>

const exactRemoval = (vault: HostVault): Required<HostVaultExactRemoval> => {
  const capability = vault as HostVault & HostVaultExactRemoval
  if (
    typeof capability.removeFileExact !== 'function' ||
    typeof capability.removeEmptyFolderExact !== 'function'
  ) {
    throw new Error(HOST_ANKI_IMPORT_BLOCKER)
  }
  return {
    removeFileExact: capability.removeFileExact.bind(vault),
    removeEmptyFolderExact: capability.removeEmptyFolderExact.bind(vault),
  }
}

const pathFor = (path: string): string =>
  normalizeHostAnkiPath(path, 'Anki import vault path')

export const createHostAnkiImportVaultPort = (
  vault: HostVault,
): AnkiImportVaultPort => {
  const removal = exactRemoval(vault)
  return {
    exists: (path) => vault.exists(pathFor(path)),
    readText: (path) => vault.readText(pathFor(path)),
    readBinary: (path) => vault.readBinary(pathFor(path)),
    ensureFolder: (path) => vault.ensureFolder(pathFor(path)),
    createFolder: (path) => vault.createFolder(pathFor(path)),
    createText: async (path, content) => {
      await vault.createText(pathFor(path), content)
    },
    createBinary: (path, content) => vault.createBinary(pathFor(path), content),
    removeExactPath: async (path) => {
      const normalized = pathFor(path)
      const entry = vault.getEntry(normalized)
      if (entry === null) return
      if (entry.kind !== 'file') {
        throw new Error(
          `Refusing to remove a non-file Anki import path: ${path}`,
        )
      }
      const removed = await removal.removeFileExact(normalized)
      if (!removed) {
        throw new Error(`Host refused exact Anki import file removal: ${path}`)
      }
    },
    removeEmptyFolder: async (path) => {
      const normalized = pathFor(path)
      const entry = vault.getEntry(normalized)
      if (entry === null) return
      if (entry.kind !== 'folder') {
        throw new Error(
          `Refusing to remove a non-folder Anki import path: ${path}`,
        )
      }
      if (vault.listChildren(normalized).length !== 0) {
        throw new Error(
          `Refusing to remove a non-empty Anki import folder: ${path}`,
        )
      }
      const removed = await removal.removeEmptyFolderExact(normalized)
      if (!removed) {
        throw new Error(
          `Host refused empty Anki import folder removal: ${path}`,
        )
      }
    },
  }
}

export const HOST_ANKI_IMPORT_BLOCKER =
  'Host vault exact-removal capabilities are unavailable; safe Anki import rollback requires removeFileExact and removeEmptyFolderExact.'
