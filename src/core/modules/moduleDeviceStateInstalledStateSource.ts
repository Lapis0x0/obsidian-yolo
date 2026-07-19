import type { ModuleDeviceStateStore } from './moduleDeviceStateStore'
import type { InstalledModuleState, InstalledModuleStateSource } from './types'

const EMPTY_INSTALLED_STATES = Object.freeze(
  [],
) as readonly InstalledModuleState[]

export class ModuleDeviceStateInstalledStateSource
  implements InstalledModuleStateSource
{
  constructor(
    private readonly options: Readonly<{
      store: Pick<ModuleDeviceStateStore, 'list'>
      isActive(moduleId: string, version: string): boolean
      getError?(moduleId: string): string | undefined
    }>,
  ) {}

  async load(): Promise<readonly InstalledModuleState[]> {
    const states = await this.options.store.list()
    if (states.length === 0) return EMPTY_INSTALLED_STATES

    const installed: InstalledModuleState[] = []
    for (const state of states) {
      const version =
        state.activeVersion ??
        state.pendingVersion ??
        Object.keys(state.readyVersions).at(-1)
      if (version === undefined) continue
      const error = this.options.getError?.(state.moduleId)
      installed.push(
        Object.freeze({
          id: state.moduleId,
          version,
          ...(state.pendingVersion
            ? { pendingVersion: state.pendingVersion }
            : {}),
          ...(state.activationPhase
            ? { activationPhase: state.activationPhase }
            : {}),
          ...(error ? { error } : {}),
          ...(state.activeVersion === version &&
          this.options.isActive(state.moduleId, version)
            ? { active: true }
            : {}),
        }),
      )
    }
    return installed.length === 0
      ? EMPTY_INSTALLED_STATES
      : Object.freeze(installed)
  }
}
