import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v81 -> v82: knowledge bases become independent (multi-vector-store)
 * entities instead of one implicit "the vault" index scoped by
 * `ragOptions.includePatterns`/`excludePatterns`/`excludeYoloBaseDir`
 * (docs/plans/08-23-knowledge-bases/00-plan.md). Those three fields, plus
 * the long-dead `continuationOptions.knowledgeBaseFolders`, are dropped.
 *
 * Deliberately does NOT synthesize a default `knowledgeBases` entry from the
 * old include/exclude patterns: each knowledge base now owns its own
 * IndexedDB-backed vector store, so any pre-existing index has to be
 * rebuilt from scratch regardless of whether a base is auto-created here.
 * Forcing the user to create their first base explicitly avoids guessing a
 * name/description on their behalf. `knowledgeBases` is left absent so the
 * settings schema's own default (`[]`) fills it in.
 */
export const migrateFrom81To82: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 82 }

  if (isRecord(next.ragOptions)) {
    const {
      includePatterns: _includePatterns,
      excludePatterns: _excludePatterns,
      excludeYoloBaseDir: _excludeYoloBaseDir,
      ...restRagOptions
    } = next.ragOptions
    next.ragOptions = restRagOptions
  }

  if (isRecord(next.continuationOptions)) {
    const { knowledgeBaseFolders: _knowledgeBaseFolders, ...restContinuation } =
      next.continuationOptions
    next.continuationOptions = restContinuation
  }

  return next
}
