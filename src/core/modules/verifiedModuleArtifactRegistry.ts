import type { VerifiedModuleArtifact } from './moduleArtifactVerifier'
import { assertModuleId } from './moduleStore'

/** Tracks the artifact for each module whose exact version is activating or
 * active — published just before runtime activation begins (module code
 * running during activation commit may read its own assets) and cleared on
 * activation failure or uninstall. */
export class VerifiedModuleArtifactRegistry {
  private readonly artifacts = new Map<string, VerifiedModuleArtifact>()

  getVerifiedArtifact(moduleId: string): VerifiedModuleArtifact | undefined {
    assertModuleId(moduleId, 'Module id')
    return this.artifacts.get(moduleId)
  }

  publish(
    moduleId: string,
    version: string,
    artifact: VerifiedModuleArtifact,
  ): void {
    assertModuleId(moduleId, 'Module id')
    if (
      !artifact ||
      artifact.manifest.id !== moduleId ||
      artifact.manifest.version !== version ||
      !artifact.manifest.variants.includes(artifact.variant)
    ) {
      throw new Error(
        `Module "${moduleId}" verified artifact does not match active version "${version}"`,
      )
    }
    this.artifacts.set(moduleId, artifact)
  }

  clear(moduleId: string): void {
    assertModuleId(moduleId, 'Module id')
    this.artifacts.delete(moduleId)
  }

  clearAll(): void {
    this.artifacts.clear()
  }
}
