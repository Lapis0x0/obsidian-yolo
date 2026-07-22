import type { ModuleArtifactDescriptor } from './moduleArtifactVerifier'
import {
  MODULE_CATALOG_LOCALES,
  type ModuleCatalogLocale,
  type ModuleCatalogLocaleSource,
  type ModuleCatalogLocalizations,
  parseModuleCatalogLocalizations,
  readModuleCatalogLocale,
  resolveModuleCatalogPresentation,
} from './moduleCatalogPresentation'
import { parseModuleReleaseUrl } from './moduleReleaseUrl'
import {
  type ModuleArtifactDataSchemas,
  type ModuleArtifactPlatform,
  assertModuleId,
  assertModulePathSegment,
  isModuleHostApiRange,
} from './moduleStore'
import type { OfficialModuleCatalogVersion } from './officialModuleCatalog'
import type { ModuleCatalogEntry, ModuleCatalogSource } from './types'

export type BundledModuleDescriptor = Readonly<{
  id: string
  version: string
  icon: string
  localizations: ModuleCatalogLocalizations
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

export type BundledModuleCatalogSourceOptions = {
  store: {
    readBundledIndexBytes(): Promise<Uint8Array>
  }
  platform: ModuleArtifactPlatform
  locale: ModuleCatalogLocaleSource
}

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
        'icon',
        'localizations',
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
    if (
      typeof descriptor.icon !== 'string' ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(descriptor.icon)
    ) {
      throw new Error('Bundled module icon must be an icon id')
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
    const localizations = parseModuleCatalogLocalizations(
      descriptor.localizations,
      'Bundled module localizations',
    )
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
      icon: descriptor.icon,
      localizations,
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

/** Projects immutable module artifacts shipped beside the plugin as a catalog. */
export class BundledModuleCatalogSource implements ModuleCatalogSource {
  private indexPromise: Promise<BundledModuleIndex> | null = null
  private readonly resolvedVersions = new Map<
    string,
    OfficialModuleCatalogVersion
  >()

  constructor(private readonly options: BundledModuleCatalogSourceOptions) {
    if (options.platform !== 'desktop' && options.platform !== 'mobile') {
      throw new Error('Bundled module runtime platform is invalid')
    }
    if (
      typeof options.locale !== 'function' &&
      !MODULE_CATALOG_LOCALES.includes(options.locale)
    ) {
      throw new Error('Bundled module catalog locale is invalid')
    }
  }

  async load(): Promise<ReadonlyArray<ModuleCatalogEntry>> {
    const index = await this.loadIndex()
    const locale = readModuleCatalogLocale(this.options.locale)
    this.resolvedVersions.clear()
    return Object.freeze(
      index.modules.map((module) => {
        if (!module.platforms.includes(this.options.platform)) {
          return catalogEntry(module, locale, [{ kind: 'platform' }])
        }
        this.resolvedVersions.set(module.id, resolvedVersion(module))
        return catalogEntry(module, locale)
      }),
    )
  }

  getResolvedVersion(
    moduleId: string,
  ): OfficialModuleCatalogVersion | undefined {
    return this.resolvedVersions.get(moduleId)
  }

  getResolvedArtifactDescriptor(
    moduleId: string,
    expectedVersion: string,
    platform: ModuleArtifactPlatform,
  ): ModuleArtifactDescriptor | undefined {
    const resolved = this.resolvedVersions.get(moduleId)
    if (!resolved) return undefined
    if (resolved.version !== expectedVersion) {
      throw new Error(
        `Bundled module "${moduleId}" resolved candidate changed from "${expectedVersion}" to "${resolved.version}"`,
      )
    }
    if (platform !== this.options.platform) {
      throw new Error(
        `Bundled module catalog platform ${this.options.platform} does not match ${platform}`,
      )
    }
    return Object.freeze({
      id: moduleId,
      version: resolved.version,
      hostApi: resolved.hostApi,
      dataSchemas: resolved.dataSchemas,
      platform,
      manifestUrl: resolved.manifestUrl,
      manifest: resolved.manifest,
    })
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
}

function catalogEntry(
  module: BundledModuleDescriptor,
  locale: ModuleCatalogLocale,
  compatibilityIssues: ModuleCatalogEntry['compatibilityIssues'] = [],
): ModuleCatalogEntry {
  const presentation = resolveModuleCatalogPresentation(
    module.localizations,
    locale,
  )
  return Object.freeze({
    id: module.id,
    version: module.version,
    icon: module.icon,
    name: presentation.name,
    description: presentation.description,
    ...(compatibilityIssues.length > 0
      ? { compatibilityIssues: Object.freeze(compatibilityIssues) }
      : {}),
  })
}

function resolvedVersion(
  module: BundledModuleDescriptor,
): OfficialModuleCatalogVersion {
  return Object.freeze({
    version: module.version,
    hostApi: module.hostApi,
    dataSchemas: module.dataSchemas,
    platforms: module.platforms,
    manifestUrl: module.manifestUrl,
    manifest: module.manifest,
  })
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
