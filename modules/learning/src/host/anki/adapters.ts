import {
  type HostLearningSrsOptions,
  resolveHostLearningSrsStore,
} from '../srsStorage'

import { type AnkiRuntimeFetch, createHostAnkiRuntime } from './runtime'
import {
  type HostAnkiJournalOptions,
  createHostAnkiJournalStorage,
} from './sharedData'
import { createHostAnkiImportVaultPort } from './vault'
import { createHostAnkiWorkerFactory } from './worker'

export const createHostAnkiAdapters = (
  host: Pick<
    YoloModuleHostApiV1,
    'paths' | 'privateStorage' | 'vault' | 'workers'
  >,
  fetcher?: AnkiRuntimeFetch,
  options: HostLearningSrsOptions & HostAnkiJournalOptions = {},
) => {
  const srs = resolveHostLearningSrsStore(host, options)
  return Object.freeze({
    runtime: createHostAnkiRuntime(host, fetcher),
    workers: createHostAnkiWorkerFactory(host.workers),
    srs,
    journals: createHostAnkiJournalStorage(host, options),
    importVault: createHostAnkiImportVaultPort(host.vault),
  })
}

export { createHostAnkiImportService } from './import'
export type { HostAnkiImportService } from './import'
