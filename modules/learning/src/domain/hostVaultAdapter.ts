import type {
  LearningVaultEntryListener,
  LearningVaultReadApi,
} from './learningVaultReadApi'
import type {
  LearningVaultFileSnapshot,
  LearningVaultWriteApi,
} from './learningVaultWriteApi'

type HostVault = YoloModuleHostApiV1['vault']
type HostTextSnapshot = NonNullable<
  Awaited<ReturnType<HostVault['readTextSnapshot']>>
>

const snapshotMaps = new WeakMap<
  HostVault,
  WeakMap<LearningVaultFileSnapshot, HostTextSnapshot>
>()

export const HOST_VAULT_WRITE_API_GAPS = [
  'renamePath',
  'removeExactPath',
  'removeEmptyFolder',
  'removeTree',
] as const satisfies readonly (keyof LearningVaultWriteApi)[]

type HostVaultWriteGap = (typeof HOST_VAULT_WRITE_API_GAPS)[number]

/**
 * The write port subset whose semantics are provided exactly by host.vault.
 * Permanent deletion, empty-only deletion, tree deletion, and folder rename
 * cannot be represented by host.vault's trash/file-rename operations.
 */
export type HostLearningVaultWriteApi = Omit<
  LearningVaultWriteApi,
  HostVaultWriteGap
>

export function createHostLearningVaultReadApi(
  vault: HostVault,
): LearningVaultReadApi {
  return {
    getEntry: (path) => vault.getEntry(path),
    listChildren: (folderPath) => vault.listChildren(folderPath),
    listMarkdownFiles: () => vault.listMarkdownFiles(),
    exists: (path) => vault.exists(path),
    readText: (filePath) => vault.readText(filePath),
    readBinary: (filePath) => vault.readBinary(filePath),
    onCreate: (scopePath, listener) =>
      subscribeToEntryEvent(vault, scopePath, 'create', listener),
    onModify: (scopePath, listener) =>
      subscribeToEntryEvent(vault, scopePath, 'modify', listener),
    onDelete: (scopePath, listener) =>
      subscribeToEntryEvent(vault, scopePath, 'delete', listener),
    onRename: (scopePath, listener) =>
      vault.subscribe(scopePath, (event) => {
        if (event.type === 'rename') listener(event.entry, event.oldPath)
      }),
  }
}

export function createHostLearningVaultWriteApi(
  vault: HostVault,
): HostLearningVaultWriteApi {
  let snapshots = snapshotMaps.get(vault)
  if (!snapshots) {
    snapshots = new WeakMap<LearningVaultFileSnapshot, HostTextSnapshot>()
    snapshotMaps.set(vault, snapshots)
  }

  const wrapSnapshot = (
    snapshot: HostTextSnapshot | null,
  ): LearningVaultFileSnapshot | null => {
    if (!snapshot) return null
    const wrapped: LearningVaultFileSnapshot = Object.freeze({
      path: snapshot.path,
      content: snapshot.content,
      identity: snapshot,
    })
    snapshots.set(wrapped, snapshot)
    return wrapped
  }

  const unwrapSnapshot = (
    snapshot: LearningVaultFileSnapshot,
  ): HostTextSnapshot | null => snapshots.get(snapshot) ?? null

  return {
    ensureFolder: (folderPath) => vault.ensureFolder(folderPath),
    createFolder: (folderPath) => vault.createFolder(folderPath),
    listChildNames: async (folderPath) =>
      vault.listChildren(folderPath).map((entry) => entry.name),
    listChildFilePaths: async (folderPath) =>
      vault
        .listChildren(folderPath)
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.path),
    createText: (filePath, content) => vault.createText(filePath, content),
    createBinary: (filePath, content) => vault.createBinary(filePath, content),
    writeText: (filePath, content) => vault.writeText(filePath, content),
    readTextSnapshot: async (filePath) =>
      wrapSnapshot(await vault.readTextSnapshot(filePath)),
    createTextIfAbsent: async (filePath, content) =>
      wrapSnapshot(await vault.createTextIfAbsent(filePath, content)),
    replaceTextIfUnchanged: async (expected, content) => {
      const hostExpected = unwrapSnapshot(expected)
      if (!hostExpected) return null
      return wrapSnapshot(
        await vault.replaceTextIfUnchanged(hostExpected, content),
      )
    },
    revertOwnedCreatedTextIfUnchanged: async (
      created,
      expected,
      fallbackContent,
    ) => {
      const hostCreated = unwrapSnapshot(created)
      const hostExpected = unwrapSnapshot(expected)
      if (!hostCreated || !hostExpected) return null
      return wrapSnapshot(
        await vault.revertOwnedCreatedTextIfUnchanged(
          hostCreated,
          hostExpected,
          fallbackContent,
        ),
      )
    },
  }
}

function subscribeToEntryEvent(
  vault: HostVault,
  scopePath: string,
  type: 'create' | 'modify' | 'delete',
  listener: LearningVaultEntryListener,
): () => void {
  return vault.subscribe(scopePath, (event) => {
    if (event.type === type) listener(event.entry)
  })
}
