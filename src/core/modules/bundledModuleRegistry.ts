import {
  type ModuleArtifactReadStore,
  type VerifiedModuleArtifact,
  verifyInstalledModuleArtifact,
} from './moduleArtifactVerifier'
import type { ModuleLoader } from './moduleLoader'
import type { ModuleRuntime } from './moduleRuntime'
import { assertModuleId, assertModulePathSegment } from './moduleStore'
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
  manifest: Readonly<{
    byteSize: number
    sha256: string
  }>
}>

export type BundledModuleIndex = Readonly<{
  schemaVersion: 1
  modules: readonly BundledModuleDescriptor[]
}>

export type BundledModuleRegistryOptions = {
  store: ModuleArtifactReadStore & {
    readBundledIndexBytes(): Promise<Uint8Array>
  }
  loader: Pick<ModuleLoader, 'load'>
  runtime: Pick<ModuleRuntime, 'activate'>
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
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
    if (typeof descriptor.id !== 'string') {
      throw new Error('Bundled module id must be a string')
    }
    if (typeof descriptor.version !== 'string') {
      throw new Error('Bundled module version must be a string')
    }
    assertModuleId(descriptor.id, 'Bundled module id')
    assertModulePathSegment(descriptor.version, 'Bundled module version')
    const id = descriptor.id
    const version = descriptor.version
    const canonicalId = id.toLowerCase()
    if (ids.has(canonicalId)) {
      throw new Error(`Bundled module index contains duplicate id "${id}"`)
    }
    ids.add(canonicalId)
    if (typeof descriptor.name !== 'string' || !descriptor.name.trim()) {
      throw new Error('Bundled module name must be a non-empty string')
    }
    if (typeof descriptor.description !== 'string') {
      throw new Error('Bundled module description must be a string')
    }
    const manifest = descriptor.manifest as
      | { byteSize?: unknown; sha256?: unknown }
      | undefined
    if (
      !manifest ||
      !Number.isSafeInteger(manifest.byteSize) ||
      (manifest.byteSize as number) < 0 ||
      typeof manifest.sha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(manifest.sha256)
    ) {
      throw new Error('Bundled module manifest metadata is invalid')
    }
    return Object.freeze({
      id,
      version,
      name: descriptor.name,
      description: descriptor.description,
      manifest: Object.freeze({
        byteSize: manifest.byteSize as number,
        sha256: manifest.sha256.toLowerCase(),
      }),
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
  private readonly verifiedArtifacts = new Map<string, VerifiedModuleArtifact>()
  private readonly subtleCrypto: Pick<SubtleCrypto, 'digest'>

  constructor(private readonly options: BundledModuleRegistryOptions) {
    const subtleCrypto = options.subtleCrypto ?? globalThis.crypto?.subtle
    if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
    this.subtleCrypto = subtleCrypto
  }

  activateAll(): Promise<void> {
    this.activationPromise ??= this.activateAllOnce()
    return this.activationPromise
  }

  getVerifiedArtifact(moduleId: string): VerifiedModuleArtifact | undefined {
    return this.verifiedArtifacts.get(moduleId)
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
    this.verifiedArtifacts.delete(module.id)
    try {
      const artifact = await verifyInstalledModuleArtifact(
        this.options.store,
        module,
        this.subtleCrypto,
      )
      this.verifiedArtifacts.set(module.id, artifact)
      const { manifest, entryBytes } = artifact
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
      this.verifiedArtifacts.delete(module.id)
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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
