export type LearningVaultFileSnapshot = {
  readonly path: string
  readonly content: string
  /** Adapter-owned identity used to detect delete-and-recreate races. */
  readonly identity: unknown
}

/** Compare-and-swap Learning boundary over vault text files. */
export type LearningVaultWriteApi = {
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
