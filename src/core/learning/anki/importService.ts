import type { App } from 'obsidian'

import { type AnkiImportPlan, buildAnkiImportPlan } from './importPlan'
import { commitAnkiImportPlan } from './importWriter'
import { parseAnkiPackageInWorker } from './workerClient'

export async function prepareAnkiImport({
  app,
  baseDir,
  packageBytes,
  wasmBytes,
  signal,
}: {
  app: App
  baseDir: string
  packageBytes: ArrayBuffer
  wasmBytes: ArrayBuffer
  signal?: AbortSignal
}): Promise<AnkiImportPlan> {
  const parsed = await parseAnkiPackageInWorker(packageBytes, wasmBytes, signal)
  if (signal?.aborted)
    throw new DOMException('Anki import was aborted', 'AbortError')
  const listing = (await app.vault.adapter.exists(baseDir))
    ? await app.vault.adapter.list(baseDir)
    : { files: [], folders: [] }
  const slugs = listing.folders.map((path) => path.split('/').at(-1) ?? '')
  return buildAnkiImportPlan({ parsed, baseDir, existingProjectSlugs: slugs })
}

export { commitAnkiImportPlan }
export { recoverAnkiImports } from './importWriter'
export { renameAnkiImportPlan } from './importPlan'
export type { AnkiImportPlan } from './importPlan'
