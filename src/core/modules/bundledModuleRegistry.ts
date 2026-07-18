import {
  type ModuleArtifactReadStore,
  type VerifiedModuleArtifact,
  verifyInstalledModuleArtifact,
} from './moduleArtifactVerifier'
import type { ModuleLoader } from './moduleLoader'
import { parseModuleReleaseUrl } from './moduleReleaseUrl'
import type { ModuleRuntime } from './moduleRuntime'
import {
  type ModuleArtifactDataSchemas,
  type ModuleArtifactPlatform,
  assertModuleId,
  assertModulePathSegment,
  isModuleHostApiRange,
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
  hostApi: string
  dataSchemas: ModuleArtifactDataSchemas
  platforms: readonly ModuleArtifactPlatform[]
  manifestUrl: string
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
  platform: ModuleArtifactPlatform
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
  reportActivationError?: (moduleId: string, error: unknown) => void
}

type ActivationState = Readonly<{
  version: string
  active?: boolean
  error?: string
}>

export function parseBundledModuleIndex(value: unknown): BundledModuleIndex {
  const candidate = asPlainObject(value, 'Bundled module index')
  assertKeys(candidate, ['schemaVersion', 'modules'], 'Bundled module index')
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.modules)) {
    throw new Error('Bundled module index is invalid')
  }
  const ids = new Set<string>()
  const modules = candidate.modules.map((value) => {
    const descriptor = asPlainObject(value, 'Bundled module descriptor')
    assertKeys(
      descriptor,
      [
        'id',
        'version',
        'name',
        'description',
        'hostApi',
        'dataSchemas',
        'platforms',
        'manifestUrl',
        'manifest',
      ],
      'Bundled module descriptor',
    )
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
    if (
      !isModuleHostApiRange(descriptor.hostApi) ||
      !Array.isArray(descriptor.platforms) ||
      descriptor.platforms.length === 0 ||
      descriptor.platforms.length > 2 ||
      descriptor.platforms.some(
        (platform) => platform !== 'desktop' && platform !== 'mobile',
      ) ||
      new Set(descriptor.platforms).size !== descriptor.platforms.length ||
      typeof descriptor.manifestUrl !== 'string' ||
      !parseModuleReleaseUrl(descriptor.manifestUrl)
    ) {
      throw new Error('Bundled module compatibility metadata is invalid')
    }
    const dataSchemas = parseDataSchemas(descriptor.dataSchemas)
    const manifest = asPlainObject(
      descriptor.manifest,
      'Bundled module manifest metadata',
    )
    assertKeys(
      manifest,
      ['byteSize', 'sha256'],
      'Bundled module manifest metadata',
    )
    if (
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
      hostApi: descriptor.hostApi,
      dataSchemas,
      platforms: Object.freeze(
        [...descriptor.platforms].sort(),
      ) as readonly ModuleArtifactPlatform[],
      manifestUrl: descriptor.manifestUrl,
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
    if (options.platform !== 'desktop' && options.platform !== 'mobile') {
      throw new Error('Bundled module runtime platform is invalid')
    }
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
      if (!module.platforms.includes(this.options.platform)) {
        throw new Error(
          `Bundled module "${module.id}" does not support ${this.options.platform}`,
        )
      }
      const artifact = await verifyInstalledModuleArtifact(
        this.options.store,
        {
          id: module.id,
          version: module.version,
          hostApi: module.hostApi,
          dataSchemas: module.dataSchemas,
          platform: this.options.platform,
          manifestUrl: module.manifestUrl,
          manifest: module.manifest,
        },
        this.subtleCrypto,
      )
      this.verifiedArtifacts.set(module.id, artifact)
      const { manifest, variant, entryBytes } = artifact
      const entry = variant.files.find((file) => file.role === 'entry')!
      const definition = await this.options.loader.load(
        {
          id: manifest.id,
          byteSize: entry.byteSize,
          sha256: entry.sha256,
        },
        entryBytes,
      )
      await this.options.runtime.activate(definition, module.version)
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

function assertKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value)
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new Error(`${label} fields are invalid`)
  }
}

function asPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function parseDataSchemas(value: unknown): ModuleArtifactDataSchemas {
  const schemas = asPlainObject(value, 'Bundled module dataSchemas')
  const result = Object.create(null) as Record<
    string,
    { readMin: number; readMax: number; write: number }
  >
  for (const [namespace, candidate] of Object.entries(schemas)) {
    if (
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(namespace) ||
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new Error('Bundled module dataSchemas is invalid')
    }
    const schema = asPlainObject(candidate, 'Bundled module data schema')
    assertKeys(
      schema,
      ['readMin', 'readMax', 'write'],
      'Bundled module data schema',
    )
    if (
      !Number.isSafeInteger(schema.readMin) ||
      (schema.readMin as number) < 0 ||
      !Number.isSafeInteger(schema.readMax) ||
      (schema.readMax as number) < (schema.readMin as number) ||
      !Number.isSafeInteger(schema.write) ||
      (schema.write as number) < (schema.readMin as number) ||
      (schema.write as number) > (schema.readMax as number)
    ) {
      throw new Error('Bundled module dataSchemas is invalid')
    }
    result[namespace] = Object.freeze({
      readMin: schema.readMin as number,
      readMax: schema.readMax as number,
      write: schema.write as number,
    })
  }
  return Object.freeze(result)
}
