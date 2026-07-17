export type AnkiRuntimeStorageStat = {
  type: 'file' | 'folder'
  size: number
}

export type AnkiRuntimeStorageListing = {
  files: readonly string[]
  folders: readonly string[]
}

/** Storage is rooted by the host; paths are relative, and an empty path names the root. */
export type AnkiRuntimeStorage = {
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<AnkiRuntimeStorageStat | null>
  list(path: string): Promise<AnkiRuntimeStorageListing>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  /** Atomically renames an entry within this storage root. */
  rename(fromPath: string, toPath: string): Promise<void>
  readText(path: string): Promise<string>
  readBinary(path: string): Promise<ArrayBuffer>
  writeText(path: string, content: string): Promise<void>
  writeBinary(path: string, content: ArrayBuffer): Promise<void>
}

export type AnkiRuntimeHost = {
  readonly storage: AnkiRuntimeStorage
  downloadArrayBuffer(url: string): Promise<ArrayBuffer>
  /** Serializes runtime mutations with other hosts for the same storage root. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}
