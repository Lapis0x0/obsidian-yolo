import type { ModuleCreateIfAbsentResult } from './moduleSettingsStore'

/**
 * Modules this host version installs on behalf of a user who has never decided
 * for themselves. A module belongs here only when it is part of YOLO's core
 * experience rather than an optional add-on.
 *
 * The list is a host constant rather than catalog metadata on purpose. The
 * catalog is a remote feed shared by every released host version, so a
 * `defaultInstall` flag there would seed already-shipped hosts that never
 * tested the module. A constant only ever seeds the version carrying it, which
 * is exactly the claim being made: "this release considers the module core".
 */
export const DEFAULT_INSTALLED_MODULE_IDS: readonly string[] = Object.freeze([
  'whiteboard',
])

export type DefaultModuleInstallSeedOptions = Readonly<{
  moduleIds?: readonly string[]
  /**
   * Writes the synchronized `enabled` intent only when the module has no intent
   * at all. Uninstalling records `uninstalled`, which is itself a decision, so
   * a module the user removed is never seeded again.
   */
  enableIfAbsent(moduleId: string): Promise<ModuleCreateIfAbsentResult>
  reportError?: (moduleId: string, error: unknown) => void
}>

/**
 * Seeds installation intent for the default modules, returning the ids that
 * were actually seeded. One module's failure must not skip the rest: the
 * artifacts are downloaded later by readiness reconciliation, which retries on
 * the next start.
 */
export async function seedDefaultModuleInstallIntents({
  moduleIds = DEFAULT_INSTALLED_MODULE_IDS,
  enableIfAbsent,
  reportError,
}: DefaultModuleInstallSeedOptions): Promise<readonly string[]> {
  const seeded: string[] = []
  for (const moduleId of moduleIds) {
    try {
      if ((await enableIfAbsent(moduleId)) === 'created') seeded.push(moduleId)
    } catch (error) {
      reportError?.(moduleId, error)
    }
  }
  return Object.freeze(seeded)
}
