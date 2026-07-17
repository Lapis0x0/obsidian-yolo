import type { LearningVaultReadApi } from '../learningVaultReadApi'

import type { AnkiWorkerHost } from './AnkiWorkerHost'
import { type AnkiImportPlan, buildAnkiImportPlan } from './importPlan'
import { commitAnkiImportPlan } from './importWriter'
import { parseAnkiPackageInWorker } from './workerClient'

export async function prepareAnkiImport({
  workerHost,
  vault,
  baseDir,
  packageBytes,
  wasmBytes,
  signal,
}: {
  workerHost: AnkiWorkerHost
  vault: LearningVaultReadApi
  baseDir: string
  packageBytes: ArrayBuffer
  wasmBytes: ArrayBuffer
  signal?: AbortSignal
}): Promise<AnkiImportPlan> {
  const parsed = await parseAnkiPackageInWorker(
    workerHost,
    packageBytes,
    wasmBytes,
    signal,
  )
  if (signal?.aborted)
    throw new DOMException('Anki import was aborted', 'AbortError')
  const slugs = vault
    .listChildren(baseDir)
    .filter((entry) => entry.kind === 'folder')
    .map((entry) => entry.name)
  return buildAnkiImportPlan({ parsed, baseDir, existingProjectSlugs: slugs })
}

export { commitAnkiImportPlan }
export { recoverAnkiImports } from './importWriter'
export { renameAnkiImportPlan } from './importPlan'
export type { AnkiImportPlan } from './importPlan'
