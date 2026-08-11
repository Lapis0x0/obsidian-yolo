import type { VerifiedModuleArtifact } from './moduleArtifactVerifier'
import type { ModuleStore } from './moduleStore'
import { assertModuleId, normalizeModuleArtifactFilePath } from './moduleStore'

/**
 * Resolves a module chat mode's declared skill file name (a `role: 'data'`
 * artifact in the module's manifest — see `YoloModuleChatModeV1.skills`) to
 * the trusted absolute path of the file on disk.
 *
 * Deliberately lazy: at the moment a module calls `chat.registerMode(...)`
 * (during its own `activate()`), the module's `VerifiedModuleArtifact` has
 * not been published yet — `ModuleRuntime.activate` commits capabilities
 * (including this one's caller, `moduleChatModeRegistry`) strictly before
 * `moduleActivationCoordinator` publishes the artifact. Resolving eagerly at
 * registration time would therefore always fail for the module currently
 * activating. Every consumer of a module's declared skills (the skills
 * registry, `McpCoordinator`'s tool-server replay analog) instead resolves
 * on demand, well after activation has settled — mirroring how
 * `ModuleAssetsCapabilityProvider` resolves `role: 'style'/'worker'/'wasm'`
 * assets lazily through the same `getVerifiedArtifact` accessor.
 */
export type ModuleChatModeSkillResolverV1 = Readonly<{
  /**
   * Returns the absolute (adapter-relative) path to `fileName` if the
   * module is currently active and its verified manifest declares a
   * `role: 'data'` file with that exact name — `null` otherwise (module
   * inactive, artifact identity mismatch, or no matching declared file).
   * Never throws for an ordinary "not available right now" outcome, since
   * callers treat that identically to "mode currently unavailable".
   */
  resolveSkillPath(
    moduleId: string,
    fileName: string,
  ): Promise<string | null>
}>

export type ModuleChatModeSkillResolverOptions = Readonly<{
  store: Pick<ModuleStore, 'resolveEntryPath'>
  getVerifiedArtifact(
    moduleId: string,
  ):
    | VerifiedModuleArtifact
    | null
    | undefined
    | Promise<VerifiedModuleArtifact | null | undefined>
}>

export function createModuleChatModeSkillResolver(
  options: ModuleChatModeSkillResolverOptions,
): ModuleChatModeSkillResolverV1 {
  return Object.freeze({
    resolveSkillPath: async (moduleId, fileName) => {
      assertModuleId(moduleId, 'Module id')
      let normalizedName: string
      try {
        normalizedName = normalizeModuleArtifactFilePath(fileName)
      } catch {
        return null
      }
      const artifact = await options.getVerifiedArtifact(moduleId)
      if (!artifact || artifact.manifest.id !== moduleId) {
        return null
      }
      const canonicalName = canonicalize(normalizedName)
      const file = artifact.variant.files.find(
        (candidate) =>
          candidate.role === 'data' &&
          canonicalize(candidate.path) === canonicalName,
      )
      if (!file) {
        return null
      }
      return options.store.resolveEntryPath(
        moduleId,
        artifact.manifest.version,
        file.path,
      )
    },
  })
}

function canonicalize(path: string): string {
  return path.normalize('NFC').toLowerCase()
}
