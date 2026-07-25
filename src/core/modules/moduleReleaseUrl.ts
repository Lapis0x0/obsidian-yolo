export type ModuleReleaseRepository = Readonly<{
  owner: string
  repo: string
}>

export type ParsedModuleReleaseUrl = Readonly<{
  owner: string
  repo: string
  repositoryKey: string
  tag: string
  encodedTag: string
  assetName: string
  releaseParent: string
}>

const URL_PREFIX = 'https://github.com/'
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY = /^[A-Za-z0-9._-]+$/
const TAG_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

export const OFFICIAL_MODULE_RELEASE_REPOSITORIES = Object.freeze([
  Object.freeze({ owner: 'Lapis0x0', repo: 'obsidian-yolo' }),
])

/** Checks a release URL against the code-owned first-party repository list. */
export function isOfficialModuleReleaseUrl(value: unknown): value is string {
  return isModuleReleaseUrlAllowed(value, OFFICIAL_MODULE_RELEASE_REPOSITORIES)
}

/** Parses the one canonical GitHub Release asset URL form accepted by modules. */
export function parseModuleReleaseUrl(
  value: unknown,
): ParsedModuleReleaseUrl | null {
  if (typeof value !== 'string' || !value.startsWith(URL_PREFIX)) return null
  const parts = value.slice(URL_PREFIX.length).split('/')
  if (
    parts.length !== 6 ||
    parts[2] !== 'releases' ||
    parts[3] !== 'download'
  ) {
    return null
  }

  const [owner = '', repo = '', , , rawTag = '', assetName = ''] = parts
  if (
    !OWNER.test(owner) ||
    !REPOSITORY.test(repo) ||
    repo.length > 100 ||
    !isSafePathSegment(repo) ||
    !ASSET_NAME.test(assetName) ||
    assetName.length > 255 ||
    !isSafePathSegment(assetName)
  ) {
    return null
  }
  const tag = parseReleaseTag(rawTag)
  if (!tag) return null

  const repositoryKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`
  return Object.freeze({
    owner,
    repo,
    repositoryKey,
    tag: tag.decoded,
    encodedTag: tag.encoded,
    assetName,
    releaseParent: `${repositoryKey}/${tag.encoded}`,
  })
}

export function isModuleReleaseUrlAllowed(
  value: unknown,
  repositories: readonly ModuleReleaseRepository[],
): value is string {
  const parsed = parseModuleReleaseUrl(value)
  return Boolean(
    parsed &&
      repositories.some(
        (repository) =>
          moduleReleaseRepositoryKey(repository) === parsed.repositoryKey,
      ),
  )
}

export function moduleReleaseRepositoryKey(
  repository: ModuleReleaseRepository,
): string | null {
  if (
    !repository ||
    typeof repository.owner !== 'string' ||
    typeof repository.repo !== 'string' ||
    !OWNER.test(repository.owner) ||
    !REPOSITORY.test(repository.repo) ||
    repository.repo.length > 100 ||
    !isSafePathSegment(repository.repo)
  ) {
    return null
  }
  return `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`
}

function parseReleaseTag(
  value: string,
): Readonly<{ decoded: string; encoded: string }> | null {
  if (!value.includes('%')) {
    return isTagSegment(value)
      ? Object.freeze({ decoded: value, encoded: value })
      : null
  }
  const separators = value.match(/%2f/gi)
  if (separators?.length !== 1) return null
  const segments = value.split(/%2f/i)
  if (
    segments.length !== 2 ||
    segments.some((segment) => !isTagSegment(segment))
  ) {
    return null
  }
  return Object.freeze({
    decoded: `${segments[0]}/${segments[1]}`,
    encoded: `${segments[0]}%2F${segments[1]}`,
  })
}

function isTagSegment(value: string): boolean {
  return (
    value.length <= 255 && TAG_SEGMENT.test(value) && isSafePathSegment(value)
  )
}

function isSafePathSegment(value: string): boolean {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.endsWith('.') ||
    value.normalize('NFKC') !== value
  ) {
    return false
  }
  const baseName = value.split('.')[0]?.toUpperCase()
  return !(
    baseName === 'CON' ||
    baseName === 'PRN' ||
    baseName === 'AUX' ||
    baseName === 'NUL' ||
    /^COM[1-9]$/.test(baseName ?? '') ||
    /^LPT[1-9]$/.test(baseName ?? '')
  )
}
