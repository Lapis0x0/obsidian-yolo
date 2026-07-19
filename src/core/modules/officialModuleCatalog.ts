export type OfficialModulePlatform = 'desktop' | 'mobile'

export type OfficialModuleDataSchema = Readonly<{
  readMin: number
  readMax: number
  write: number
}>

export type OfficialModuleCatalogVersion = Readonly<{
  version: string
  hostApi: string
  platforms: readonly OfficialModulePlatform[]
  dataSchemas: Readonly<Record<string, OfficialModuleDataSchema>>
  manifestUrl: string
  manifest: Readonly<{
    byteSize: number
    sha256: string
  }>
}>

export type OfficialModuleCatalogModule = Readonly<{
  id: string
  name?: string
  description?: string
  versions: readonly OfficialModuleCatalogVersion[]
}>

export type OfficialModuleCatalogV1 = Readonly<{
  schemaVersion: 1
  modules: readonly OfficialModuleCatalogModule[]
}>

export type OfficialModuleCompatibility = Readonly<{
  hostApi: string
  platform: OfficialModulePlatform
  activeVersion?: string
}>

export type OfficialModuleCatalogParserOptions = Readonly<{
  /** Code-owned trust roots. Never derive these values from catalog data. */
  allowedRepositories: readonly Readonly<{ owner: string; repo: string }>[]
  limits?: Readonly<Partial<OfficialModuleCatalogLimits>>
}>

type OfficialModuleCatalogLimits = Readonly<{
  maxBytes: number
  maxModules: number
  maxVersionsPerModule: number
  maxNamespacesPerVersion: number
  maxStringBytes: number
  maxRangeAlternatives: number
  maxComparatorsPerAlternative: number
  maxManifestBytes: number
}>

type Semver = Readonly<{
  major: string
  minor: string
  patch: string
  prerelease: readonly Readonly<{ numeric: boolean; value: string }>[]
}>

type Comparator = Readonly<{
  operator: '<' | '<=' | '>' | '>=' | '='
  version: Semver
}>

const DEFAULT_LIMITS: OfficialModuleCatalogLimits = Object.freeze({
  maxBytes: 1_000_000,
  maxModules: 100,
  maxVersionsPerModule: 200,
  maxNamespacesPerVersion: 32,
  maxStringBytes: 4_096,
  maxRangeAlternatives: 8,
  maxComparatorsPerAlternative: 16,
  maxManifestBytes: 1024 * 1024,
})
const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SCHEMA_NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const DANGEROUS_NAMESPACES = new Set(['__proto__', 'prototype', 'constructor'])
const SHA256 = /^[a-fA-F0-9]{64}$/
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export function parseOfficialModuleCatalog(
  raw: string | Uint8Array,
  options: OfficialModuleCatalogParserOptions,
): OfficialModuleCatalogV1 {
  const limits = resolveLimits(options)
  const source = decodeCatalog(raw, limits.maxBytes)
  let decoded: unknown
  try {
    decoded = JSON.parse(source) as unknown
  } catch {
    throw new Error('Official module catalog is not valid JSON')
  }
  assertBoundedStrings(decoded, limits.maxStringBytes)

  const catalog = asObject(decoded, 'Official module catalog')
  assertKeys(catalog, ['schemaVersion', 'modules'], 'Official module catalog')
  if (
    catalog.schemaVersion !== 1 ||
    !Array.isArray(catalog.modules) ||
    catalog.modules.length > limits.maxModules
  ) {
    throw new Error('Official module catalog is invalid')
  }

  const repositories = parseAllowedRepositories(options.allowedRepositories)
  const moduleIds = new Set<string>()
  const modules = catalog.modules.map((value, index) => {
    const label = `Official module catalog module ${index}`
    const module = asObject(value, label)
    assertKeys(module, ['id', 'name', 'description', 'versions'], label)
    if (
      typeof module.id !== 'string' ||
      !MODULE_ID.test(module.id) ||
      (module.name !== undefined && typeof module.name !== 'string') ||
      (module.description !== undefined &&
        typeof module.description !== 'string') ||
      !Array.isArray(module.versions) ||
      module.versions.length === 0 ||
      module.versions.length > limits.maxVersionsPerModule
    ) {
      throw new Error(`${label} is invalid`)
    }
    if (moduleIds.has(module.id)) {
      throw new Error(`Duplicate official module id "${module.id}"`)
    }
    moduleIds.add(module.id)

    const versions = new Map<string, string>()
    const parsedVersions = module.versions.map((value, versionIndex) => {
      const parsed = parseCatalogVersion(
        value,
        `${label} version ${versionIndex}`,
        repositories,
        limits,
      )
      const semver = parseSemver(parsed.version)!
      const precedenceKey = semverPrecedenceKey(semver)
      const duplicate = versions.get(precedenceKey)
      if (duplicate !== undefined) {
        throw new Error(
          `Duplicate equivalent versions "${duplicate}" and "${parsed.version}" for module "${module.id}"`,
        )
      }
      versions.set(precedenceKey, parsed.version)
      return parsed
    })
    parsedVersions.sort(compareCatalogVersions)
    return frozenRecord({
      id: module.id,
      ...(module.name !== undefined ? { name: module.name } : {}),
      ...(module.description !== undefined
        ? { description: module.description }
        : {}),
      versions: Object.freeze(parsedVersions),
    }) as OfficialModuleCatalogModule
  })
  return frozenRecord({
    schemaVersion: 1,
    modules: Object.freeze(modules),
  }) as OfficialModuleCatalogV1
}

export type OfficialModuleCompatibilityIssue = 'platform' | 'host-api'

export function getOfficialModuleCompatibilityIssues(
  module: OfficialModuleCatalogModule,
  compatibility: OfficialModuleCompatibility,
): readonly OfficialModuleCompatibilityIssue[] {
  const context = parseCompatibility(compatibility)
  const candidates = context.activeVersion
    ? module.versions.filter(
        (candidate) =>
          compareSemver(
            parseSemver(candidate.version)!,
            context.activeVersion!,
          ) === 0,
      )
    : module.versions
  const issues = new Set<OfficialModuleCompatibilityIssue>()
  for (const candidate of candidates) {
    for (const issue of candidateCompatibilityIssues(candidate, context)) {
      issues.add(issue)
    }
  }
  return Object.freeze([...issues].sort())
}

export function selectInitialCompatibleVersion(
  module: OfficialModuleCatalogModule,
  compatibility: OfficialModuleCompatibility,
): OfficialModuleCatalogVersion | null {
  const context = parseCompatibility(compatibility)
  if (context.activeVersion) return null
  return findHighestCompatible(module, context)
}

export function findCompatibleUpdate(
  module: OfficialModuleCatalogModule,
  compatibility: OfficialModuleCompatibility,
): OfficialModuleCatalogVersion | null {
  const context = parseCompatibility(compatibility)
  if (!context.activeVersion) {
    throw new Error('Active module version is required when finding an update')
  }
  return findHighestCompatible(module, context, context.activeVersion)
}

type CompatibilityContext = Readonly<{
  hostApi: Semver
  platform: OfficialModulePlatform
  activeVersion: Semver | null
}>

function parseCompatibility(
  compatibility: OfficialModuleCompatibility,
): CompatibilityContext {
  const hostApi = parseSemver(compatibility.hostApi)
  if (!hostApi) throw new Error('Current Host API version is invalid')
  if (
    compatibility.platform !== 'desktop' &&
    compatibility.platform !== 'mobile'
  ) {
    throw new Error('Current platform is invalid')
  }
  const activeVersion = compatibility.activeVersion
    ? parseSemver(compatibility.activeVersion)
    : null
  if (compatibility.activeVersion && !activeVersion) {
    throw new Error('Active module version is invalid')
  }
  return {
    hostApi,
    platform: compatibility.platform,
    activeVersion,
  }
}

function candidateCompatibilityIssues(
  candidate: OfficialModuleCatalogVersion,
  compatibility: CompatibilityContext,
): readonly OfficialModuleCompatibilityIssue[] {
  if (!candidate.platforms.includes(compatibility.platform)) return ['platform']
  if (!satisfiesRange(compatibility.hostApi, candidate.hostApi)) {
    return ['host-api']
  }
  return []
}

function findHighestCompatible(
  module: OfficialModuleCatalogModule,
  compatibility: CompatibilityContext,
  newerThan?: Semver,
): OfficialModuleCatalogVersion | null {
  let selected: OfficialModuleCatalogVersion | null = null
  for (const candidate of module.versions) {
    const candidateVersion = parseSemver(candidate.version)
    if (
      !candidateVersion ||
      candidateCompatibilityIssues(candidate, compatibility).length > 0 ||
      (newerThan && compareSemver(candidateVersion, newerThan) <= 0)
    ) {
      continue
    }
    if (
      !selected ||
      compareSemver(candidateVersion, parseSemver(selected.version)!) > 0
    ) {
      selected = candidate
    }
  }
  return selected
}

function parseCatalogVersion(
  value: unknown,
  label: string,
  repositories: ReadonlySet<string>,
  limits: OfficialModuleCatalogLimits,
): OfficialModuleCatalogVersion {
  const version = asObject(value, label)
  assertKeys(
    version,
    [
      'version',
      'hostApi',
      'platforms',
      'dataSchemas',
      'manifestUrl',
      'manifest',
    ],
    label,
  )
  if (
    typeof version.version !== 'string' ||
    !parseSemver(version.version) ||
    typeof version.hostApi !== 'string' ||
    !parseRange(version.hostApi, limits) ||
    !Array.isArray(version.platforms) ||
    version.platforms.length === 0 ||
    version.platforms.length > 2 ||
    version.platforms.some(
      (platform) => platform !== 'desktop' && platform !== 'mobile',
    ) ||
    new Set(version.platforms).size !== version.platforms.length ||
    typeof version.manifestUrl !== 'string' ||
    !isAllowedReleaseUrl(version.manifestUrl, repositories)
  ) {
    throw new Error(`${label} is invalid`)
  }
  const dataSchemas = parseDataSchemas(version.dataSchemas, label, limits)
  const manifest = asObject(version.manifest, `${label} manifest`)
  assertKeys(manifest, ['byteSize', 'sha256'], `${label} manifest`)
  if (
    !Number.isSafeInteger(manifest.byteSize) ||
    (manifest.byteSize as number) <= 0 ||
    (manifest.byteSize as number) > limits.maxManifestBytes ||
    typeof manifest.sha256 !== 'string' ||
    !SHA256.test(manifest.sha256)
  ) {
    throw new Error(`${label} manifest is invalid`)
  }
  return frozenRecord({
    version: version.version,
    hostApi: version.hostApi,
    platforms: Object.freeze(
      [...version.platforms].sort(),
    ) as readonly OfficialModulePlatform[],
    dataSchemas,
    manifestUrl: version.manifestUrl,
    manifest: frozenRecord({
      byteSize: manifest.byteSize as number,
      sha256: manifest.sha256.toLowerCase(),
    }),
  }) as OfficialModuleCatalogVersion
}

function parseDataSchemas(
  value: unknown,
  label: string,
  limits: OfficialModuleCatalogLimits,
): Readonly<Record<string, OfficialModuleDataSchema>> {
  const schemas = asObject(value, `${label} dataSchemas`)
  const entries = Object.entries(schemas)
  if (entries.length === 0 || entries.length > limits.maxNamespacesPerVersion) {
    throw new Error(`${label} dataSchemas is invalid`)
  }
  const parsed = Object.create(null) as Record<string, OfficialModuleDataSchema>
  for (const [namespace, value] of entries) {
    if (!isNamespace(namespace)) {
      throw new Error(`${label} data schema namespace is invalid`)
    }
    const schema = asObject(value, `${label} data schema "${namespace}"`)
    assertKeys(
      schema,
      ['readMin', 'readMax', 'write'],
      `${label} data schema "${namespace}"`,
    )
    if (
      !isSchemaVersion(schema.readMin) ||
      !isSchemaVersion(schema.readMax) ||
      !isSchemaVersion(schema.write) ||
      schema.readMin > schema.readMax ||
      schema.write < schema.readMin ||
      schema.write > schema.readMax
    ) {
      throw new Error(`${label} data schema "${namespace}" is invalid`)
    }
    parsed[namespace] = frozenRecord({
      readMin: schema.readMin,
      readMax: schema.readMax,
      write: schema.write,
    }) as OfficialModuleDataSchema
  }
  return Object.freeze(parsed)
}

function decodeCatalog(raw: string | Uint8Array, maxBytes: number): string {
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).byteLength > maxBytes) {
      throw new Error('Official module catalog exceeds the byte limit')
    }
    return raw
  }
  if (!(raw instanceof Uint8Array)) {
    throw new Error('Official module catalog must be raw UTF-8 bytes or text')
  }
  if (raw.byteLength > maxBytes) {
    throw new Error('Official module catalog exceeds the byte limit')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new Error('Official module catalog is not valid UTF-8')
  }
}

function resolveLimits(
  options: OfficialModuleCatalogParserOptions,
): OfficialModuleCatalogLimits {
  if (!options || !Array.isArray(options.allowedRepositories)) {
    throw new Error('Official repository allowlist is required')
  }
  const supplied = options.limits ?? {}
  const limits = { ...DEFAULT_LIMITS, ...supplied }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Official module catalog limit "${name}" is invalid`)
    }
    if (
      Object.prototype.hasOwnProperty.call(supplied, name) &&
      value > DEFAULT_LIMITS[name as keyof OfficialModuleCatalogLimits]
    ) {
      throw new Error(
        `Official module catalog limit "${name}" cannot exceed its hard limit`,
      )
    }
  }
  return limits
}

function parseAllowedRepositories(
  repositories: OfficialModuleCatalogParserOptions['allowedRepositories'],
): ReadonlySet<string> {
  const parsed = new Set<string>()
  for (const repository of repositories) {
    const value = asObject(repository, 'Official repository allowlist entry')
    assertKeys(value, ['owner', 'repo'], 'Official repository allowlist entry')
    if (typeof value.owner !== 'string' || typeof value.repo !== 'string') {
      throw new Error('Official repository allowlist entry is invalid')
    }
    const key = moduleReleaseRepositoryKey({
      owner: value.owner,
      repo: value.repo,
    })
    if (!key) throw new Error('Official repository allowlist entry is invalid')
    parsed.add(key)
  }
  if (parsed.size === 0)
    throw new Error('Official repository allowlist is empty')
  return parsed
}

function isAllowedReleaseUrl(
  value: string,
  repositories: ReadonlySet<string>,
): boolean {
  const parsed = parseModuleReleaseUrl(value)
  return Boolean(parsed && repositories.has(parsed.repositoryKey))
}

function assertBoundedStrings(value: unknown, maxBytes: number): void {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (new TextEncoder().encode(current).byteLength > maxBytes) {
        throw new Error('Official module catalog string exceeds the byte limit')
      }
    } else if (Array.isArray(current)) {
      pending.push(...current)
    } else if (current !== null && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        pending.push(key, child)
      }
    }
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new Error(`${label} must contain only own data fields`)
    }
  }
  return value as Record<string, unknown>
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new Error(`${label} has unknown field "${unknown}"`)
}

function frozenRecord(
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.assign(Object.create(null), values))
}

function isNamespace(value: string): boolean {
  return SCHEMA_NAMESPACE.test(value) && !DANGEROUS_NAMESPACES.has(value)
}

function isSchemaVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value)
  if (!match) return null
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: Object.freeze(
      match[4]?.split('.').map((part) => ({
        numeric: /^\d+$/.test(part),
        value: part,
      })) ?? [],
    ),
  }
}

function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

function compareSemver(left: Semver, right: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumericStrings(left[key], right[key])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (!leftPart) return -1
    if (!rightPart) return 1
    if (leftPart.numeric && !rightPart.numeric) return -1
    if (!leftPart.numeric && rightPart.numeric) return 1
    const comparison = leftPart.numeric
      ? compareNumericStrings(leftPart.value, rightPart.value)
      : leftPart.value === rightPart.value
        ? 0
        : leftPart.value < rightPart.value
          ? -1
          : 1
    if (comparison !== 0) return comparison
  }
  return 0
}

function semverPrecedenceKey(version: Semver): string {
  const prerelease = version.prerelease
    .map((part) => `${part.numeric ? 'n' : 's'}${part.value}`)
    .join('.')
  return `${version.major}.${version.minor}.${version.patch}-${prerelease}`
}

function compareCatalogVersions(
  left: OfficialModuleCatalogVersion,
  right: OfficialModuleCatalogVersion,
): number {
  const precedence = compareSemver(
    parseSemver(right.version)!,
    parseSemver(left.version)!,
  )
  if (precedence !== 0) return precedence
  return left.manifestUrl.localeCompare(right.manifestUrl)
}

function parseRange(
  value: string,
  limits: OfficialModuleCatalogLimits,
): readonly (readonly Comparator[])[] | null {
  if (!value || value.trim() !== value) return null
  const texts = value.split('||')
  if (texts.length > limits.maxRangeAlternatives) return null
  const alternatives: Comparator[][] = []
  for (const alternative of texts) {
    const text = alternative.trim()
    if (!text) return null
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
    if (hyphen) {
      const lower = parseSemver(hyphen[1] ?? '')
      const upper = parseSemver(hyphen[2] ?? '')
      if (!lower || !upper) return null
      alternatives.push([
        { operator: '>=', version: lower },
        { operator: '<=', version: upper },
      ])
      continue
    }
    const comparators: Comparator[] = []
    for (const token of text.split(/\s+/)) {
      const parsed = parseComparator(token)
      if (!parsed) return null
      comparators.push(...parsed)
      if (comparators.length > limits.maxComparatorsPerAlternative) return null
    }
    alternatives.push(comparators)
  }
  return alternatives
}

function parseComparator(token: string): Comparator[] | null {
  if (token === '*' || /^x$/i.test(token)) return []
  const shorthand = /^([~^])(.+)$/.exec(token)
  if (shorthand) {
    const version = parseSemver(shorthand[2] ?? '')
    if (!version) return null
    const upper =
      shorthand[1] === '~'
        ? coreSemver(version.major, increment(version.minor), '0')
        : version.major !== '0'
          ? coreSemver(increment(version.major), '0', '0')
          : version.minor !== '0'
            ? coreSemver('0', increment(version.minor), '0')
            : coreSemver('0', '0', increment(version.patch))
    return [
      { operator: '>=', version },
      { operator: '<', version: upper },
    ]
  }
  const wildcard =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?$/.exec(token)
  if (wildcard && (/[xX*]/.test(token) || wildcard[3] === undefined)) {
    const major = wildcard[1]
    if (/^[xX*]$/.test(wildcard[2])) {
      return [
        { operator: '>=', version: coreSemver(major, '0', '0') },
        { operator: '<', version: coreSemver(increment(major), '0', '0') },
      ]
    }
    const minor = wildcard[2]
    return [
      { operator: '>=', version: coreSemver(major, minor, '0') },
      { operator: '<', version: coreSemver(major, increment(minor), '0') },
    ]
  }
  const match = /^(<=|>=|<|>|=)?(.+)$/.exec(token)
  const version = match ? parseSemver(match[2] ?? '') : null
  return version
    ? [
        {
          operator: (match?.[1] as Comparator['operator'] | undefined) ?? '=',
          version,
        },
      ]
    : null
}

function increment(value: string): string {
  const digits = value.split('')
  let carry = 1
  for (let index = digits.length - 1; index >= 0 && carry; index -= 1) {
    const next = Number(digits[index]) + carry
    digits[index] = String(next % 10)
    carry = next >= 10 ? 1 : 0
  }
  if (carry) digits.unshift('1')
  return digits.join('')
}

function coreSemver(major: string, minor: string, patch: string): Semver {
  return { major, minor, patch, prerelease: [] }
}

function satisfiesRange(version: Semver, range: string): boolean {
  const alternatives = parseRange(range, DEFAULT_LIMITS)
  if (!alternatives) return false
  return alternatives.some((comparators) => {
    if (
      version.prerelease.length > 0 &&
      !comparators.some(
        (comparator) =>
          comparator.version.prerelease.length > 0 &&
          sameCore(comparator.version, version),
      )
    ) {
      return false
    }
    return comparators.every((comparator) => {
      const comparison = compareSemver(version, comparator.version)
      if (comparator.operator === '<') return comparison < 0
      if (comparator.operator === '<=') return comparison <= 0
      if (comparator.operator === '>') return comparison > 0
      if (comparator.operator === '>=') return comparison >= 0
      return comparison === 0
    })
  })
}

function sameCore(left: Semver, right: Semver): boolean {
  return (
    left.major === right.major &&
    left.minor === right.minor &&
    left.patch === right.patch
  )
}
import {
  moduleReleaseRepositoryKey,
  parseModuleReleaseUrl,
} from './moduleReleaseUrl'
