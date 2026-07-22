import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import {
  MODULE_CATALOG_LOCALES,
  type ModuleCatalogLocale,
  type ModuleCatalogLocaleSource,
  readModuleCatalogLocale,
  resolveModuleCatalogPresentation,
} from './moduleCatalogPresentation'
import {
  type OfficialModuleCatalogCandidate,
  type OfficialModuleCatalogModule,
  type OfficialModuleCatalogV1,
  type OfficialModuleCatalogVersion,
  type OfficialModuleCompatibility,
  findCompatibleUpdate,
  getOfficialModuleCompatibilityIssues,
  selectInitialCompatibleVersion,
} from './officialModuleCatalog'
import type { OfficialModuleCatalogClient } from './officialModuleCatalogClient'
import type { ModuleCatalogEntry, ModuleCatalogSource } from './types'

const EMPTY_RESOLVED_VERSIONS = Object.freeze(
  Object.create(null) as Record<string, OfficialModuleCatalogVersion>,
)

export type OfficialModuleCompatibilityProvider = (
  module: OfficialModuleCatalogCandidate,
) => OfficialModuleCompatibility | Promise<OfficialModuleCompatibility>

export type OfficialModuleCatalogSourceOptions = Readonly<{
  client: Pick<OfficialModuleCatalogClient, 'load' | 'loadFresh'>
  getCompatibility: OfficialModuleCompatibilityProvider
  locale: ModuleCatalogLocaleSource
}>

/** Resolves the trusted official catalog against the current host and module state. */
export class OfficialModuleCatalogSource implements ModuleCatalogSource {
  private resolvedVersions: Readonly<
    Record<string, OfficialModuleCatalogVersion>
  > = EMPTY_RESOLVED_VERSIONS
  private inFlight: Promise<ReadonlyArray<ModuleCatalogEntry>> | null = null
  private freshInFlight: Promise<ReadonlyArray<ModuleCatalogEntry>> | null =
    null
  private catalog: OfficialModuleCatalogV1 | null = null

  constructor(private readonly options: OfficialModuleCatalogSourceOptions) {
    if (
      !options ||
      !options.client ||
      typeof options.client.load !== 'function' ||
      typeof options.client.loadFresh !== 'function' ||
      typeof options.getCompatibility !== 'function' ||
      (typeof options.locale !== 'function' &&
        !MODULE_CATALOG_LOCALES.includes(options.locale))
    ) {
      throw new Error('Official module catalog source options are invalid')
    }
  }

  load(): Promise<ReadonlyArray<ModuleCatalogEntry>> {
    if (this.catalog) return this.resolve(this.catalog)
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

  loadFresh(): Promise<ReadonlyArray<ModuleCatalogEntry>> {
    if (this.freshInFlight) return this.freshInFlight

    const load = this.loadFreshOnce()
    this.freshInFlight = load
    void load.then(
      () => {
        if (this.freshInFlight === load) this.freshInFlight = null
      },
      () => {
        if (this.freshInFlight === load) this.freshInFlight = null
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

  getResolvedArtifactDescriptor(
    moduleId: string,
    expectedVersion: string,
    platform: OfficialModuleCompatibility['platform'],
  ): ModuleArtifactDescriptor | undefined {
    const resolved = this.resolvedVersions[moduleId]
    if (!resolved) return undefined
    if (resolved.version !== expectedVersion) {
      throw new Error(
        `Official module "${moduleId}" resolved candidate changed from "${expectedVersion}" to "${resolved.version}"`,
      )
    }
    if (!resolved.platforms.includes(platform)) {
      throw new Error(
        `Official module "${moduleId}" candidate does not support ${platform}`,
      )
    }
    const dataSchemas = Object.create(null) as Record<
      string,
      { readMin: number; readMax: number; write: number }
    >
    for (const [namespace, schema] of Object.entries(resolved.dataSchemas)) {
      dataSchemas[namespace] = Object.freeze({ ...schema })
    }
    return Object.freeze({
      id: moduleId,
      version: resolved.version,
      hostApi: resolved.hostApi,
      dataSchemas: Object.freeze(dataSchemas),
      platform,
      manifestUrl: resolved.manifestUrl,
      manifest: Object.freeze({ ...resolved.manifest }),
    })
  }

  private async loadOnce(): Promise<ReadonlyArray<ModuleCatalogEntry>> {
    const catalog = await this.options.client.load()
    const entries = await this.resolve(catalog)
    this.catalog = catalog
    return entries
  }

  private async loadFreshOnce(): Promise<ReadonlyArray<ModuleCatalogEntry>> {
    const catalog = await this.options.client.loadFresh()
    const entries = await this.resolve(catalog)
    this.catalog = catalog
    return entries
  }

  private async resolve(
    catalog: OfficialModuleCatalogV1,
  ): Promise<ReadonlyArray<ModuleCatalogEntry>> {
    const locale = readModuleCatalogLocale(this.options.locale)
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
        entries.push(catalogEntry(module, selected.version, locale))
      } else {
        const compatibilityIssues = getOfficialModuleCompatibilityIssues(
          module,
          compatibility,
        ).map((kind) => Object.freeze({ kind }))
        entries.push(
          catalogEntry(
            module,
            compatibility.activeVersion ?? '',
            locale,
            compatibilityIssues,
          ),
        )
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
  return [...catalog.modules]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .filter((module) => module.versions.length > 0)
}

function catalogEntry(
  module: OfficialModuleCatalogModule,
  version: string,
  locale: ModuleCatalogLocale,
  compatibilityIssues: ModuleCatalogEntry['compatibilityIssues'] = [],
): ModuleCatalogEntry {
  const presentation = resolveModuleCatalogPresentation(
    module.localizations,
    locale,
  )
  return Object.freeze({
    id: module.id,
    version,
    ...(module.icon ? { icon: module.icon } : {}),
    name: presentation.name,
    description: presentation.description,
    ...(compatibilityIssues.length > 0 ? { compatibilityIssues } : {}),
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
