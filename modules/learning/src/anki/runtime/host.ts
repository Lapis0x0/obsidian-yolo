import type { AnkiRuntimeHostPort, AnkiRuntimeStoragePort } from './ports'

type HostOptions = {
  storage: AnkiRuntimeStoragePort
  downloadArrayBuffer(url: string): Promise<ArrayBuffer>
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}

/** Binds Host-owned download, rooted storage, and cross-instance locking ports. */
export const createAnkiRuntimeHost = (
  options: HostOptions,
): AnkiRuntimeHostPort => ({
  storage: options.storage,
  downloadArrayBuffer: (url) => options.downloadArrayBuffer(url),
  runExclusive: (operation) => options.runExclusive(operation),
})
