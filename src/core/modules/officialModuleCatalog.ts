import type { ModuleCatalogLocalizations } from './moduleCatalogPresentation'
export type OfficialModulePlatform = 'desktop' | 'mobile'

export type OfficialModuleDataSchema = Readonly<{
  readMin: number
  readMax: number
  write: number
}>

export type OfficialModuleReleaseNotes = Readonly<{
  url: string
  byteSize: number
  sha256: string
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
  releaseNotes?: OfficialModuleReleaseNotes
}>

export type OfficialModuleCatalogModule = Readonly<{
  id: string
  icon?: string
  localizations: ModuleCatalogLocalizations
  versions: readonly OfficialModuleCatalogVersion[]
}>

export type OfficialModuleCatalogV1 = Readonly<{
  schemaVersion: 1
  modules: readonly OfficialModuleCatalogModule[]
}>

export type OfficialModuleCatalogCandidate = Pick<
  OfficialModuleCatalogModule,
  'id' | 'versions'
>

export type OfficialModuleCompatibility = Readonly<{
  hostApi: string
  platform: OfficialModulePlatform
  activeVersion?: string
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

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export type OfficialModuleCompatibilityIssue = 'platform' | 'host-api'

/** Evaluates the one latest candidate exposed by the signed distribution Feed. */
export function getOfficialModuleVersionCompatibilityIssues(
  candidate: OfficialModuleCatalogVersion,
  compatibility: OfficialModuleCompatibility,
): readonly OfficialModuleCompatibilityIssue[] {
  return Object.freeze([
    ...candidateCompatibilityIssues(
      candidate,
      parseCompatibility(compatibility),
    ),
  ])
}

export function compareModuleVersions(left: string, right: string): number {
  const leftVersion = parseSemver(left)
  const rightVersion = parseSemver(right)
  if (!leftVersion || !rightVersion) {
    throw new Error('Module version is invalid')
  }
  return compareSemver(leftVersion, rightVersion)
}

/**
 * Whether the running Host API satisfies a module's declared range.
 *
 * Both sides are code-owned: `hostApi` is the constant this build ships and
 * `range` comes from the signed Feed, so an unparseable value is a defect, not
 * untrusted input — the host version throws and a malformed range is simply
 * unsatisfied.
 */
export function isHostApiCompatible(hostApi: string, range: string): boolean {
  const version = parseSemver(hostApi)
  if (!version) throw new Error('Current Host API version is invalid')
  return satisfiesRange(version, range)
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

const MAX_RANGE_ALTERNATIVES = 8
const MAX_COMPARATORS_PER_ALTERNATIVE = 16

function parseRange(value: string): readonly (readonly Comparator[])[] | null {
  if (!value || value.trim() !== value) return null
  const texts = value.split('||')
  if (texts.length > MAX_RANGE_ALTERNATIVES) return null
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
      if (comparators.length > MAX_COMPARATORS_PER_ALTERNATIVE) return null
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
  const alternatives = parseRange(range)
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

/**
 * Whether a declared Host API range is syntactically valid, without evaluating
 * it. Kept beside `parseRange` so the accepted grammar has one definition.
 */
export function isModuleHostApiRange(value: unknown): value is string {
  return typeof value === 'string' && parseRange(value) !== null
}

/**
 * Whether a module version is a version `compareModuleVersions` can order.
 * Every source of module versions must gate on this: the strict comparator
 * throws rather than guessing, and one of its callers runs during render.
 */
export function isModuleVersion(value: unknown): value is string {
  return typeof value === 'string' && parseSemver(value) !== null
}
