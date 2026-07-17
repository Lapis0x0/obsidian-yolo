import type { ModuleLoader } from './moduleLoader'
import type { ModuleRuntime } from './moduleRuntime'
import {
  type ModuleArtifactManifest,
  type ModuleStore,
  parseModuleArtifactManifest,
} from './moduleStore'
import type {
  InstalledModuleState,
  InstalledModuleStateSource,
  ModuleCatalogEntry,
  ModuleCatalogSource,
} from './types'

export type BundledModuleDescriptor = Readonly<{
  id: string
  version: string
  name: string
  description: string
}>

export type BundledModuleIndex = Readonly<{
  schemaVersion: 1
  modules: readonly BundledModuleDescriptor[]
}>

export type BundledModuleRegistryOptions = {
  store: Pick<
    ModuleStore,
    'readBundledIndexBytes' | 'readManifestBytes' | 'readEntryBytes'
  >
  loader: Pick<ModuleLoader, 'load'>
  runtime: Pick<ModuleRuntime, 'activate'>
  reportActivationError?: (moduleId: string, error: unknown) => void
}

type ActivationState = Readonly<{
  version: string
  active?: boolean
  error?: string
}>

export function parseBundledModuleIndex(value: unknown): BundledModuleIndex {
  if (!value || typeof value !== 'object') {
    throw new Error('Bundled module index is invalid')
  }
  const candidate = value as {
    schemaVersion?: unknown
    modules?: unknown
  }
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.modules)) {
    throw new Error('Bundled module index is invalid')
  }
  const ids = new Set<string>()
  const modules = candidate.modules.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('Bundled module descriptor is invalid')
    }
    const descriptor = value as Record<string, unknown>
    const id = requirePathSegment(descriptor.id, 'Bundled module id')
    const version = requirePathSegment(
      descriptor.version,
      'Bundled module version',
    )
    if (ids.has(id)) {
      throw new Error(`Bundled module index contains duplicate id "${id}"`)
    }
    ids.add(id)
    if (typeof descriptor.name !== 'string' || !descriptor.name.trim()) {
      throw new Error('Bundled module name must be a non-empty string')
    }
    if (typeof descriptor.description !== 'string') {
      throw new Error('Bundled module description must be a string')
    }
    return Object.freeze({
      id,
      version,
      name: descriptor.name,
      description: descriptor.description,
    })
  })
  return Object.freeze({
    schemaVersion: 1,
    modules: Object.freeze(modules),
  })
}

/** Discovers and activates module artifacts shipped beside the plugin. */
export class BundledModuleRegistry {
  readonly catalogSource: ModuleCatalogSource = Object.freeze({
    load: async () => this.loadCatalog(),
  })

  readonly installedStateSource: InstalledModuleStateSource = Object.freeze({
    load: async () => this.loadInstalledStates(),
  })

  private indexPromise: Promise<BundledModuleIndex> | null = null
  private activationPromise: Promise<void> | null = null
  private readonly states = new Map<string, ActivationState>()

  constructor(private readonly options: BundledModuleRegistryOptions) {}

  activateAll(): Promise<void> {
    this.activationPromise ??= this.activateAllOnce()
    return this.activationPromise
  }

  private async loadIndex(): Promise<BundledModuleIndex> {
    this.indexPromise ??= this.options.store
      .readBundledIndexBytes()
      .then((bytes) =>
        parseBundledModuleIndex(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        ),
      )
    return await this.indexPromise
  }

  private async loadCatalog(): Promise<readonly ModuleCatalogEntry[]> {
    const index = await this.loadIndex()
    return Object.freeze(
      index.modules.map((module) =>
        Object.freeze({
          id: module.id,
          version: module.version,
          name: module.name,
          description: module.description,
        }),
      ),
    )
  }

  private async loadInstalledStates(): Promise<
    readonly InstalledModuleState[]
  > {
    const index = await this.loadIndex()
    return Object.freeze(
      index.modules.map((module) => {
        const state = this.states.get(module.id)
        return Object.freeze({
          id: module.id,
          version: state?.version ?? module.version,
          ...(state?.active ? { active: true } : {}),
          ...(state?.error ? { error: state.error } : {}),
        })
      }),
    )
  }

  private async activateAllOnce(): Promise<void> {
    const index = await this.loadIndex()
    for (const module of index.modules) {
      await this.activateOne(module)
    }
  }

  private async activateOne(module: BundledModuleDescriptor): Promise<void> {
    this.states.set(module.id, Object.freeze({ version: module.version }))
    try {
      const manifest = await this.readManifest(module)
      const entryBytes = await this.options.store.readEntryBytes(
        manifest.id,
        manifest.version,
        manifest.entry.path,
      )
      const definition = await this.options.loader.load(
        {
          id: manifest.id,
          byteSize: manifest.entry.byteSize,
          sha256: manifest.entry.sha256,
        },
        entryBytes,
      )
      await this.options.runtime.activate(definition)
      this.states.set(
        module.id,
        Object.freeze({ version: module.version, active: true }),
      )
    } catch (error) {
      this.states.set(
        module.id,
        Object.freeze({
          version: module.version,
          error: errorMessage(error),
        }),
      )
      try {
        this.options.reportActivationError?.(module.id, error)
      } catch {
        // Reporting cannot block activation of the remaining modules.
      }
    }
  }

  private async readManifest(
    module: BundledModuleDescriptor,
  ): Promise<ModuleArtifactManifest> {
    const bytes = await this.options.store.readManifestBytes(
      module.id,
      module.version,
    )
    const manifest = parseModuleArtifactManifest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    )
    if (manifest.id !== module.id || manifest.version !== module.version) {
      throw new Error(
        `Bundled module "${module.id}" manifest identity mismatch`,
      )
    }
    return manifest
  }
}

function requirePathSegment(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    /[\\/]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty path segment`)
  }
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
