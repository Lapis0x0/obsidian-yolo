import {
  type OfficialModuleCatalogModule,
  type OfficialModuleCatalogV1,
  type OfficialModuleCatalogVersion,
  type OfficialModuleCompatibility,
  findCompatibleUpdate,
  selectInitialCompatibleVersion,
} from './officialModuleCatalog'
import type { OfficialModuleCatalogClient } from './officialModuleCatalogClient'
import type { ModuleCatalogEntry, ModuleCatalogSource } from './types'

const EMPTY_RESOLVED_VERSIONS = Object.freeze(
  Object.create(null) as Record<string, OfficialModuleCatalogVersion>,
)

export type OfficialModuleCompatibilityProvider = (
  module: OfficialModuleCatalogModule,
) => OfficialModuleCompatibility | Promise<OfficialModuleCompatibility>

export type OfficialModuleCatalogSourceOptions = Readonly<{
  client: Pick<OfficialModuleCatalogClient, 'load'>
  getCompatibility: OfficialModuleCompatibilityProvider
}>

/** Resolves the trusted official catalog against the current host and module state. */
export class OfficialModuleCatalogSource implements ModuleCatalogSource {
  private resolvedVersions: Readonly<
    Record<string, OfficialModuleCatalogVersion>
  > = EMPTY_RESOLVED_VERSIONS
  private inFlight: Promise<ReadonlyArray<ModuleCatalogEntry>> | null = null

  constructor(private readonly options: OfficialModuleCatalogSourceOptions) {
    if (
      !options ||
      !options.client ||
      typeof options.client.load !== 'function' ||
      typeof options.getCompatibility !== 'function'
    ) {
      throw new Error('Official module catalog source options are invalid')
    }
  }

  load(): Promise<ReadonlyArray<ModuleCatalogEntry>> {
    if (this.inFlight) return this.inFlight

    const load = this.loadOnce()
    this.inFlight = load
    void load.then(
      () => {
        if (this.inFlight === load) this.inFlight = null
      },
      () => {
        if (this.inFlight === load) this.inFlight = null
      },
    )
    return load
  }

  getResolvedVersion(
    moduleId: string,
  ): OfficialModuleCatalogVersion | undefined {
    return this.resolvedVersions[moduleId]
  }

  getResolvedVersions(): Readonly<
    Record<string, OfficialModuleCatalogVersion>
  > {
    return this.resolvedVersions
  }

  private async loadOnce(): Promise<ReadonlyArray<ModuleCatalogEntry>> {
    const catalog = await this.options.client.load()
    const entries: ModuleCatalogEntry[] = []
    const resolvedVersions = Object.create(null) as Record<
      string,
      OfficialModuleCatalogVersion
    >

    for (const module of sortedModules(catalog)) {
      let compatibility: OfficialModuleCompatibility
      try {
        compatibility = await this.options.getCompatibility(module)
      } catch (error) {
        throw new Error(
          `Could not resolve compatibility for official module "${module.id}": ${errorMessage(error)}`,
        )
      }

      let selected: OfficialModuleCatalogVersion | null
      try {
        selected =
          compatibility.activeVersion !== undefined
            ? findCompatibleUpdate(module, compatibility)
            : selectInitialCompatibleVersion(module, compatibility)
      } catch (error) {
        throw new Error(
          `Could not resolve compatibility for official module "${module.id}": ${errorMessage(error)}`,
        )
      }

      if (selected) {
        resolvedVersions[module.id] = selected
        entries.push(catalogEntry(module, selected.version))
      } else if (compatibility.activeVersion !== undefined) {
        entries.push(catalogEntry(module, compatibility.activeVersion))
      }
    }

    const nextEntries = Object.freeze(entries)
    const nextResolvedVersions = Object.freeze(resolvedVersions)
    this.resolvedVersions = nextResolvedVersions
    return nextEntries
  }
}

function sortedModules(
  catalog: OfficialModuleCatalogV1,
): readonly OfficialModuleCatalogModule[] {
  return [...catalog.modules].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )
}

function catalogEntry(
  module: OfficialModuleCatalogModule,
  version: string,
): ModuleCatalogEntry {
  return Object.freeze({
    id: module.id,
    version,
    ...(module.name !== undefined ? { name: module.name } : {}),
    ...(module.description !== undefined
      ? { description: module.description }
      : {}),
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
