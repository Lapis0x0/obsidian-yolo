import {
  type AnkiImportPlan,
  buildAnkiImportPlan,
  commitAnkiImportPlan,
  recoverAnkiImports,
} from '../../anki/import'
import type { AnkiImportSrsPort } from '../../anki/import/ports'
import { AnkiSqliteRuntimeManager } from '../../anki/runtime'
import { parseAnkiPackageInWorker } from '../../anki/worker/client'
import { parseCardFile } from '../../domain/cardFile'
import { createHostLearningVaultReadApi } from '../../domain/hostVaultAdapter'
import { scanProject } from '../../domain/projectScanner'
import { LearningSrsStore, replaySrsEvents } from '../../domain/srs/srsStore'
import { runWithLearningManagedDataLock } from '../paths'
import {
  type HostLearningSrsOptions,
  createUnlockedHostLearningSrsStorage,
  resolveHostLearningSrsStore,
} from '../srsStorage'

import { type AnkiRuntimeFetch, createHostAnkiRuntime } from './runtime'
import {
  type HostAnkiJournalOptions,
  createHostAnkiJournalStorage,
} from './sharedData'
import { createHostAnkiImportVaultPort } from './vault'
import { createHostAnkiWorkerFactory } from './worker'

const INLINE_WORKER_SYMBOL = Symbol.for(
  'yolo.module.inline-worker.v1:learning:ankiParser',
)

export type HostAnkiImportService = Readonly<{
  prepare(input: {
    file: File
    packageBytes: ArrayBuffer
    baseDir: string
    signal: AbortSignal
    onRuntimeReady: () => void
  }): Promise<AnkiImportPlan>
  commit(input: { plan: AnkiImportPlan; signal: AbortSignal }): Promise<string>
  listExistingProjectSlugs(baseDir: string): readonly string[]
  recover(): ReturnType<typeof recoverAnkiImports>
  runtime: AnkiSqliteRuntimeManager
}>

const getInlineWorkerSource = (): string => {
  const source = (globalThis as Record<symbol, unknown>)[INLINE_WORKER_SYMBOL]
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('Bundled Anki parser worker is unavailable')
  }
  return source
}

export function createHostAnkiImportService(
  host: Pick<
    YoloModuleHostApiV1,
    'paths' | 'privateStorage' | 'vault' | 'workers'
  >,
  options: Readonly<{
    fetcher?: AnkiRuntimeFetch
    workerSource?: () => string
  }> &
    HostLearningSrsOptions &
    HostAnkiJournalOptions = {},
): HostAnkiImportService {
  const runtimeHost = createHostAnkiRuntime(host, options.fetcher)
  const runtime = new AnkiSqliteRuntimeManager({ host: runtimeHost })
  const sharedSrs = resolveHostLearningSrsStore(host, options)
  const transactionSrs = new LearningSrsStore(
    createUnlockedHostLearningSrsStorage(host),
  )
  const srs: AnkiImportSrsPort = {
    getProjectStateFilePath: (projectSlug) =>
      transactionSrs.getProjectStateFilePath(projectSlug),
    initializeProjectStateAtPath: (projectSlug, path, state, initOptions) =>
      transactionSrs.initializeProjectStateAtPath(
        projectSlug,
        path,
        state,
        initOptions,
      ),
    activateProjectState: (projectSlug, state) => {
      transactionSrs.activateProjectState(projectSlug, state)
      sharedSrs.activateProjectState(projectSlug, state)
    },
    invalidateProject: (projectSlug) => {
      transactionSrs.invalidateProject(projectSlug)
      sharedSrs.invalidateProject(projectSlug)
    },
    getProjectState: (projectSlug) =>
      transactionSrs.getProjectState(projectSlug),
    hasPersistedProjectStateAtPath: (projectSlug, path) =>
      transactionSrs.hasPersistedProjectStateAtPath(projectSlug, path),
    deletePersistedProjectStateAtPath: (projectSlug, path) =>
      transactionSrs.deletePersistedProjectStateAtPath(projectSlug, path),
  }
  const journals = createHostAnkiJournalStorage(host, options, false)
  const workers = createHostAnkiWorkerFactory(host.workers)
  const readVault = createHostLearningVaultReadApi(host.vault)
  const parser = {
    scanProject: async (projectPath: string) =>
      (await scanProject(readVault, projectPath)) !== null,
    parseChapterCards: (content: string, path: string) => {
      const parsed = parseCardFile(content, {
        mode: 'chapter-direct',
        path,
      })
      return { complete: parsed.complete, cards: parsed.cards }
    },
  }
  const dependencies = {
    vault: createHostAnkiImportVaultPort(host.vault),
    parser,
    srs,
    journalStorage: journals,
  }

  return Object.freeze({
    runtime,
    prepare: async ({ packageBytes, baseDir, signal, onRuntimeReady }) => {
      const ready = await runtime.ensureReady()
      if (signal.aborted) {
        throw new DOMException('Anki import was aborted', 'AbortError')
      }
      onRuntimeReady()
      const wasmBytes = await runtimeHost.storage.readBinary(
        `${ready.dir}/sql-wasm.wasm`,
      )
      const parsed = await parseAnkiPackageInWorker(
        workers,
        (options.workerSource ?? getInlineWorkerSource)(),
        packageBytes,
        wasmBytes,
        signal,
      )
      return buildAnkiImportPlan({
        parsed,
        baseDir,
        existingProjectSlugs: listExistingProjectSlugs(host.vault, baseDir),
        srsReplay: { replay: replaySrsEvents },
      })
    },
    commit: ({ plan, signal }) =>
      runWithLearningManagedDataLock(host.paths, () =>
        commitAnkiImportPlan({ ...dependencies, plan, signal }),
      ),
    listExistingProjectSlugs: (baseDir) =>
      listExistingProjectSlugs(host.vault, baseDir),
    recover: () =>
      runWithLearningManagedDataLock(host.paths, () =>
        recoverAnkiImports(dependencies),
      ),
  })
}

const listExistingProjectSlugs = (
  vault: YoloModuleHostApiV1['vault'],
  baseDir: string,
): readonly string[] => {
  const entry = vault.getEntry(baseDir)
  if (entry === null) return []
  if (entry.kind !== 'folder') {
    throw new Error(`Learning import base is not a folder: ${baseDir}`)
  }
  return vault
    .listChildren(baseDir)
    .filter((child) => child.kind === 'folder')
    .map((child) => child.name)
    .sort((left, right) => left.localeCompare(right))
}
