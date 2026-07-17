export type LearningVaultFile = {
  readonly kind: 'file'
  readonly path: string
  readonly name: string
  readonly ctime: number
  readonly mtime: number
}

export type LearningVaultFolder = {
  readonly kind: 'folder'
  readonly path: string
  readonly name: string
}

export type LearningVaultEntry = LearningVaultFile | LearningVaultFolder

export type LearningVaultEntryListener = (entry: LearningVaultEntry) => void
export type LearningVaultRenameListener = (
  entry: LearningVaultEntry,
  oldPath: string,
) => void

/** Read-only Learning boundary over the vault. All paths are vault-relative. */
export type LearningVaultReadApi = {
  getEntry(path: string): LearningVaultEntry | null
  listChildren(folderPath: string): readonly LearningVaultEntry[]
  listMarkdownFiles(): readonly LearningVaultFile[]
  readText(filePath: string): Promise<string>
  onCreate(scopePath: string, listener: LearningVaultEntryListener): () => void
  onModify(scopePath: string, listener: LearningVaultEntryListener): () => void
  onDelete(scopePath: string, listener: LearningVaultEntryListener): () => void
  onRename(scopePath: string, listener: LearningVaultRenameListener): () => void
}

export function normalizeLearningVaultPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

export function isLearningVaultPathInScope(
  path: string,
  scopePath: string,
): boolean {
  const normalizedPath = normalizeLearningVaultPath(path)
  const normalizedScope = normalizeLearningVaultPath(scopePath)
  if (normalizedScope === '') return true
  return (
    normalizedPath === normalizedScope ||
    normalizedPath.startsWith(`${normalizedScope}/`)
  )
}
