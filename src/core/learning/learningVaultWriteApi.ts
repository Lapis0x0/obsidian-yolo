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
  deleteCreatedTextIfUnchanged(
    expected: LearningVaultFileSnapshot,
  ): Promise<boolean>
}
