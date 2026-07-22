export type AnkiRuntimeStorageStat = {
  type: 'file' | 'folder'
  size: number
}

export type AnkiRuntimeStorageListing = {
  files: readonly string[]
  folders: readonly string[]
}

/** Paths are relative to a host-owned root; the empty path names that root. */
export type AnkiRuntimeStoragePort = {
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<AnkiRuntimeStorageStat | null>
  list(path: string): Promise<AnkiRuntimeStorageListing>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  /** The Host must provide an atomic rename within the same storage root. */
  rename(fromPath: string, toPath: string): Promise<void>
  readText(path: string): Promise<string>
  readBinary(path: string): Promise<ArrayBuffer>
  writeText(path: string, content: string): Promise<void>
  writeBinary(path: string, content: ArrayBuffer): Promise<void>
}

export type AnkiRuntimeHostPort = {
  readonly storage: AnkiRuntimeStoragePort
  downloadArrayBuffer(url: string): Promise<ArrayBuffer>
  /** Must serialize mutations across all managers sharing this storage root. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}
