import { createAnkiRuntimeHost } from '../../anki/runtime/host'
import type { AnkiRuntimeHostPort } from '../../anki/runtime/ports'

import {
  createRootedAnkiRuntimeStorage,
  runHostStorageExclusive,
} from './privateStorage'

const RUNTIME_ROOT = 'anki-runtime'

export type AnkiRuntimeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export const createHostAnkiRuntime = (
  host: Pick<YoloModuleHostApiV1, 'privateStorage'>,
  fetcher: AnkiRuntimeFetch = globalThis.fetch.bind(globalThis),
): AnkiRuntimeHostPort => {
  const scope = host.privateStorage.deviceLocal
  return createAnkiRuntimeHost({
    storage: createRootedAnkiRuntimeStorage(scope, RUNTIME_ROOT),
    downloadArrayBuffer: async (url) => {
      const response = await fetcher(url, { method: 'GET' })
      if (!response.ok) {
        throw new Error(`Runtime download failed: HTTP ${response.status}`)
      }
      return (await response.arrayBuffer()).slice(0)
    },
    runExclusive: (operation) =>
      runHostStorageExclusive(scope, RUNTIME_ROOT, operation),
  })
}
