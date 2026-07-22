export type LearningVaultFileSnapshot = {
  readonly path: string
  readonly content: string
  /** Adapter-owned identity used to detect delete-and-recreate races. */
  readonly identity: unknown
}

export type LearningVaultWrittenFile = {
  readonly path: string
  readonly mtime: number
}

/** Compare-and-swap Learning boundary over vault text files. */
export type LearningVaultWriteApi = {
  ensureFolder(folderPath: string): Promise<void>
  createFolder(folderPath: string): Promise<void>
  listChildNames(folderPath: string): Promise<readonly string[]>
  listChildFilePaths(folderPath: string): Promise<readonly string[]>
  createText(
    filePath: string,
    content: string,
  ): Promise<LearningVaultWrittenFile>
  createBinary(filePath: string, content: ArrayBuffer): Promise<void>
  writeText(
    filePath: string,
    content: string,
  ): Promise<LearningVaultWrittenFile>
  renamePath(oldPath: string, newPath: string): Promise<void>
  removeExactPath(path: string): Promise<void>
  removeEmptyFolder(folderPath: string): Promise<void>
  removeTree(folderPath: string): Promise<void>
  readTextSnapshot(filePath: string): Promise<LearningVaultFileSnapshot | null>
  createTextIfAbsent(
    filePath: string,
    content: string,
  ): Promise<LearningVaultFileSnapshot | null>
  replaceTextIfUnchanged(
    expected: LearningVaultFileSnapshot,
    content: string,
  ): Promise<LearningVaultFileSnapshot | null>
  /** Atomically removes owned payload but retains a safe file shell. */
  revertOwnedCreatedTextIfUnchanged(
    created: LearningVaultFileSnapshot,
    expected: LearningVaultFileSnapshot,
    fallbackContent: string,
  ): Promise<LearningVaultFileSnapshot | null>
}

/** The capability needed by card-file transactions. */
export type LearningVaultCasWriteApi = Pick<
  LearningVaultWriteApi,
  | 'readTextSnapshot'
  | 'createTextIfAbsent'
  | 'replaceTextIfUnchanged'
  | 'revertOwnedCreatedTextIfUnchanged'
>
