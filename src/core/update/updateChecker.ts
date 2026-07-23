import { requestUrl } from 'obsidian'

import type { DistributionFeedClient } from '../distribution/distributionFeedClient'

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/Lapis0x0/obsidian-yolo/releases'

const GITHUB_RELEASE_DOWNLOAD_BASE =
  'https://github.com/Lapis0x0/obsidian-yolo/releases/download'

function releaseTagUrl(version: string): string {
  return `${GITHUB_RELEASES_URL}/tags/${encodeURIComponent(version)}`
}

/** Matches the UI page size and GitHub `per_page` for on-demand loading. */
export const RELEASE_HISTORY_PAGE_SIZE = 10

export type ReleaseNotesByLanguage = {
  en: string | null
  zh: string | null
}

export type ReleaseHistoryEntry = {
  productId: string
  productName: string
  version: string
  releaseNotes: ReleaseNotesByLanguage
  releaseUrl: string
  publishedAt: string | null
}

export type ReleaseHistoryPageResult = {
  entries: ReleaseHistoryEntry[]
  hasNext: boolean
}

export type ReleaseAssetMeta = {
  url: string
  size: number
  mirrorUrl?: string
  sha256?: string
}

export type ReleaseAssets = {
  mainJs: ReleaseAssetMeta
  manifestJson: ReleaseAssetMeta
  stylesCss: ReleaseAssetMeta
}

/** @deprecated Use ReleaseAssets */
export type ReleaseAssetUrls = ReleaseAssets

export type UpdateCheckResult = {
  hasUpdate: boolean
  latestVersion: string
  releaseNotes: ReleaseNotesByLanguage
  releaseUrl: string
  assets: ReleaseAssets | null
}

type GitHubReleaseAsset = {
  name?: string
  browser_download_url?: string
  size?: number
}

type GitHubReleaseResponse = {
  tag_name?: string
  body?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
  assets?: GitHubReleaseAsset[]
}

function stripVersionPrefix(tag: string): string {
  return (tag ?? '').replace(/^v/i, '').trim()
}

/** Normalizes manifest/tag versions for equality checks against release entries. */
export function normalizePluginVersion(version: string): string {
  return stripVersionPrefix((version ?? '').trim())
}

export type ReleaseHistoryLocateResult = {
  pageIndex: number
  pageCache: Map<number, ReleaseHistoryPageResult>
  found: boolean
}

const RELEASE_HISTORY_LOCATE_MAX_PAGES = 50

/**
 * Walks GitHub release pages until `currentVersion` is found, caching each page
 * along the way so the history modal can open directly on the installed build.
 */
export async function locateReleaseHistoryPage(
  currentVersion: string,
): Promise<ReleaseHistoryLocateResult | null> {
  const normalized = normalizePluginVersion(currentVersion)
  if (!normalized) {
    return null
  }

  const pageCache = new Map<number, ReleaseHistoryPageResult>()
  let githubPage = 1

  while (githubPage <= RELEASE_HISTORY_LOCATE_MAX_PAGES) {
    const fetched = await fetchReleaseHistoryPage(githubPage)
    if (!fetched) {
      if (pageCache.size === 0) {
        return null
      }
      return { pageIndex: 0, pageCache, found: false }
    }

    const pageIndex = githubPage - 1
    pageCache.set(pageIndex, fetched)

    if (
      fetched.entries.some(
        (entry) => entry.productId === 'core' && entry.version === normalized,
      )
    ) {
      return { pageIndex, pageCache, found: true }
    }

    if (!fetched.hasNext) {
      return { pageIndex: 0, pageCache, found: false }
    }

    githubPage += 1
  }

  return { pageIndex: 0, pageCache, found: false }
}

/**
 * Returns true if `latest` is strictly newer than `current`.
 * Compares dot-separated numeric segments; non-numeric segments sort as 0.
 */
export function compareVersions(current: string, latest: string): boolean {
  const a = stripVersionPrefix(current)
    .split('.')
    .map((s) => parseInt(s, 10) || 0)
  const b = stripVersionPrefix(latest)
    .split('.')
    .map((s) => parseInt(s, 10) || 0)
  if (a.length === 0 || b.length === 0) {
    return false
  }
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (bv > av) return true
    if (bv < av) return false
  }
  return false
}

function isPluginVersion(version: string): boolean {
  return /^v?\d+(?:\.\d+)*$/i.test(version.trim())
}

export function parseLatestVersionFromVersionsJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }

    let latestVersion: string | null = null
    for (const version of Object.keys(parsed)) {
      if (!isPluginVersion(version)) {
        continue
      }
      const normalized = normalizePluginVersion(version)
      if (!latestVersion || compareVersions(latestVersion, normalized)) {
        latestVersion = normalized
      }
    }
    return latestVersion
  } catch {
    return null
  }
}

export function parseReleaseNoteVersion(markdown: string): string | null {
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('#')) {
      continue
    }
    const match = line.match(/^#{1,6}\s+(v?\d+(?:\.\d+)*)\b/i)
    return match ? normalizePluginVersion(match[1]) : null
  }
  return null
}

/**
 * Splits a release body into English / Chinese sections.
 *
 * The repo's release notes follow a stable shape: the English block, a
 * horizontal-rule line (`---`), then the Chinese block. Rather than hardcode
 * that order we split on horizontal rules and classify each segment by its CJK
 * character ratio, so reordering or extra dividers still sort correctly.
 * A language with no matching segment becomes `null`, which tells the UI to
 * hide the language toggle and render the single available language.
 */
export function splitReleaseNotesByLanguage(
  body: string,
): ReleaseNotesByLanguage {
  const segments = body
    .split(/^\s*---\s*$/m)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  const enParts: string[] = []
  const zhParts: string[] = []

  for (const segment of segments) {
    const nonWhitespace = segment.replace(/\s/g, '').length
    const cjkCount = (segment.match(/[一-鿿]/g) ?? []).length
    const cjkRatio = nonWhitespace === 0 ? 0 : cjkCount / nonWhitespace
    if (cjkRatio >= 0.2) {
      zhParts.push(segment)
    } else {
      enParts.push(segment)
    }
  }

  return {
    en: enParts.length > 0 ? enParts.join('\n\n---\n\n') : null,
    zh: zhParts.length > 0 ? zhParts.join('\n\n---\n\n') : null,
  }
}

/**
 * Section accent tone, mapped from the leading emoji of a `###` heading. Drives
 * the small colored dot in front of each section name (see UpdateToast). `accent`
 * defers to the theme's interactive accent; the others are fixed hues.
 */
export type ChangelogTone = 'accent' | 'teal' | 'rose' | 'amber'

export type ChangelogItem = {
  /** Bold lead-in of the bullet, with any trailing `(#123)` ref stripped out. */
  title: string
  /** Issue/PR ref like `#360`, extracted from the title; null when absent. */
  ref: string | null
  /** Remainder of the bullet after the title + separator; may contain inline Markdown. */
  body: string
}

export type ChangelogSection = {
  tone: ChangelogTone
  /** Leading emoji of the heading, kept for callers that want it; may be null. */
  emoji: string | null
  name: string
  items: ChangelogItem[]
}

export type ParsedChangelog = {
  /** First `##` heading, with version number and trailing emoji stripped. */
  subtitle: string | null
  sections: ChangelogSection[]
}

const EMOJI_TONE: Record<string, ChangelogTone> = {
  '✨': 'accent',
  '🎨': 'teal',
  '🐛': 'rose',
  '🔧': 'amber',
  '⚡': 'amber',
  '🚀': 'accent',
}

function cleanSubtitle(text: string): string {
  return text
    .replace(/^v?\d+(?:\.\d+)*\s+/i, '')
    .replace(/[\s\u{FE0F}\u{200D}\p{Extended_Pictographic}]+$/u, '')
    .trim()
}

function splitEmojiPrefix(text: string): {
  emoji: string | null
  name: string
} {
  const match = text.match(/^(\p{Extended_Pictographic})\s*(.*)$/u)
  if (match) {
    return { emoji: match[1], name: match[2].trim() }
  }
  return { emoji: null, name: text.trim() }
}

function parseChangelogItem(text: string): ChangelogItem {
  const bold = text.match(/^\*\*(.+?)\*\*\s*(.*)$/)
  if (!bold) {
    return { title: '', ref: null, body: text.trim() }
  }
  let title = bold[1].trim()
  const body = bold[2].replace(/^\s*[:：]\s*/, '').trim()

  let ref: string | null = null
  // Trailing `(#360)` — or a multi-ref group like `(#354, #355)` / `（#354、#355）`.
  const refMatch = title.match(
    /[（(]\s*(#\d+(?:\s*[,，、]\s*#\d+)*)\s*[）)]\s*$/,
  )
  if (refMatch) {
    ref = refMatch[1]
    title = title.slice(0, refMatch.index).trim()
  }
  return { title, ref, body }
}

/**
 * Parses one language's release-note markdown into the structured shape the
 * update toast renders (Direction 1 / "Cursor minimal card" design): a subtitle
 * plus tone-tagged sections of bullet items. The repo authors release notes in a
 * stable shape — a `##` title heading, `### {emoji} {name}` section headings, and
 * `- **Title (#ref)**: body` bullets — so this maps directly. Content that
 * appears before the first section is gathered into an unnamed leading section so
 * nothing is dropped if the format drifts.
 */
export function parseChangelog(markdown: string): ParsedChangelog {
  let subtitle: string | null = null
  const sections: ChangelogSection[] = []
  let current: ChangelogSection | null = null

  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (!line) continue

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (heading) {
      if (heading[1].length <= 2) {
        if (subtitle === null) subtitle = cleanSubtitle(heading[2])
        continue
      }
      const { emoji, name } = splitEmojiPrefix(heading[2])
      current = {
        tone: emoji ? (EMOJI_TONE[emoji] ?? 'accent') : 'accent',
        emoji,
        name,
        items: [],
      }
      sections.push(current)
      continue
    }

    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      if (!current) {
        current = { tone: 'accent', emoji: null, name: '', items: [] }
        sections.push(current)
      }
      current.items.push(parseChangelogItem(bullet[1]))
    }
  }

  return { subtitle, sections }
}

const RELEASE_ASSET_NAMES = {
  mainJs: 'main.js',
  manifestJson: 'manifest.json',
  stylesCss: 'styles.css',
} as const

function releaseAssetDownloadUrl(version: string, fileName: string): string {
  return `${GITHUB_RELEASE_DOWNLOAD_BASE}/${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`
}

export function buildReleaseAssets(version: string): ReleaseAssets | null {
  const normalized = normalizePluginVersion(version)
  if (!normalized) {
    return null
  }

  return {
    mainJs: {
      url: releaseAssetDownloadUrl(normalized, RELEASE_ASSET_NAMES.mainJs),
      size: 0,
    },
    manifestJson: {
      url: releaseAssetDownloadUrl(
        normalized,
        RELEASE_ASSET_NAMES.manifestJson,
      ),
      size: 0,
    },
    stylesCss: {
      url: releaseAssetDownloadUrl(normalized, RELEASE_ASSET_NAMES.stylesCss),
      size: 0,
    },
  }
}

function parseReleaseAssetMeta(
  assets: GitHubReleaseAsset[] | undefined,
  fileName: string,
): ReleaseAssetMeta | null {
  if (!Array.isArray(assets)) {
    return null
  }

  for (const asset of assets) {
    const name = typeof asset.name === 'string' ? asset.name : ''
    if (name !== fileName) {
      continue
    }
    const url =
      typeof asset.browser_download_url === 'string'
        ? asset.browser_download_url
        : ''
    if (!url) {
      return null
    }
    const size = typeof asset.size === 'number' ? asset.size : 0
    return { url, size }
  }

  return null
}

/**
 * Extracts download URLs and sizes for the three release artifacts from a
 * GitHub release payload. Returns null when any required asset is missing.
 */
export function parseReleaseAssets(
  assets: GitHubReleaseAsset[] | undefined,
): ReleaseAssets | null {
  const mainJs = parseReleaseAssetMeta(assets, RELEASE_ASSET_NAMES.mainJs)
  const manifestJson = parseReleaseAssetMeta(
    assets,
    RELEASE_ASSET_NAMES.manifestJson,
  )
  const stylesCss = parseReleaseAssetMeta(assets, RELEASE_ASSET_NAMES.stylesCss)
  if (!mainJs || !manifestJson || !stylesCss) {
    return null
  }

  return { mainJs, manifestJson, stylesCss }
}

/** @deprecated Use parseReleaseAssets */
export function parseReleaseAssetUrls(
  assets: GitHubReleaseAsset[] | undefined,
): ReleaseAssets | null {
  return parseReleaseAssets(assets)
}

/**
 * Fetches a specific GitHub release by tag/version. Returns null on failure.
 */
export async function fetchReleaseByVersion(version: string): Promise<{
  version: string
  releaseUrl: string
  assets: ReleaseAssets | null
} | null> {
  const normalized = normalizePluginVersion(version)
  if (!normalized) {
    return null
  }

  try {
    const response = await requestUrl({
      url: releaseTagUrl(normalized),
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
      },
    })

    if (response.status < 200 || response.status >= 300) {
      return null
    }

    const data = JSON.parse(response.text) as GitHubReleaseResponse
    const tag = typeof data.tag_name === 'string' ? data.tag_name : ''
    const releaseVersion = stripVersionPrefix(tag)
    if (!releaseVersion) {
      return null
    }

    return {
      version: releaseVersion,
      releaseUrl: typeof data.html_url === 'string' ? data.html_url : '',
      assets: parseReleaseAssets(data.assets),
    }
  } catch {
    return null
  }
}

/**
 * Fetches the latest published version from the repo's static Obsidian
 * `versions.json` file and compares it to `currentVersion`.
 * Returns null on network/parse failure.
 */
export async function checkForUpdate(
  currentVersion: string,
  feedClient: Pick<DistributionFeedClient, 'loadFresh'>,
): Promise<UpdateCheckResult | null> {
  try {
    const core = (await feedClient.loadFresh()).core
    const latestVersion = core.version
    const hasUpdate = compareVersions(currentVersion, latestVersion)
    const releaseNotes: ReleaseNotesByLanguage = hasUpdate
      ? core.releaseNotes
      : { en: null, zh: null }

    return {
      hasUpdate,
      latestVersion,
      releaseNotes,
      releaseUrl: core.releaseUrl,
      assets: {
        mainJs: feedReleaseAsset(core.assets.mainJs),
        manifestJson: feedReleaseAsset(core.assets.manifestJson),
        stylesCss: feedReleaseAsset(core.assets.stylesCss),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[YOLO] Plugin update check failed: ${message}`)
    return null
  }
}

function feedReleaseAsset(
  asset: Readonly<{
    canonicalUrl: string
    mirrorPath: string
    byteSize: number
    sha256: string
  }>,
): ReleaseAssetMeta {
  return {
    url: asset.canonicalUrl,
    mirrorUrl: `https://updates.yoloapp.dev/${asset.mirrorPath}`,
    size: asset.byteSize,
    sha256: asset.sha256,
  }
}

/**
 * Fetches one page of published GitHub releases for the release-history modal.
 * `page` is 1-based (GitHub API convention). Returns null on network/parse failure.
 */
export async function fetchReleaseHistoryPage(
  page: number,
  perPage: number = RELEASE_HISTORY_PAGE_SIZE,
): Promise<ReleaseHistoryPageResult | null> {
  try {
    const response = await requestUrl({
      url: `${GITHUB_RELEASES_URL}?page=${page}&per_page=${perPage}`,
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
      },
    })

    if (response.status < 200 || response.status >= 300) {
      return null
    }

    const data = JSON.parse(response.text) as GitHubReleaseResponse[]
    if (!Array.isArray(data)) {
      return null
    }

    const entries = parseReleaseHistoryEntries(data)
    return {
      entries,
      // A full GitHub page implies there may be more releases to load.
      hasNext: data.length >= perPage,
    }
  } catch {
    return null
  }
}

function parseReleaseHistoryEntries(
  releases: GitHubReleaseResponse[],
): ReleaseHistoryEntry[] {
  const entries: ReleaseHistoryEntry[] = []
  for (const release of releases) {
    if (release.draft || release.prerelease) {
      continue
    }

    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const product = parseProductReleaseTag(tag)
    if (!product) continue

    const body = typeof release.body === 'string' ? release.body : ''
    entries.push({
      productId: product.id,
      productName: product.name,
      version: product.version,
      releaseNotes: body
        ? splitReleaseNotesByLanguage(body)
        : { en: null, zh: null },
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : '',
      publishedAt:
        typeof release.published_at === 'string' ? release.published_at : null,
    })
  }
  return entries
}

function parseProductReleaseTag(
  tag: string,
): Readonly<{ id: string; name: string; version: string }> | null {
  const core = normalizePluginVersion(tag)
  if (/^\d+(?:\.\d+){2,3}$/.test(core)) {
    return { id: 'core', name: 'YOLO Core', version: core }
  }
  const module = tag.match(
    /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/,
  )
  if (!module) return null
  const id = module[1]
  return {
    id,
    name: id === 'learning' ? 'Learning' : id,
    version: module[2],
  }
}
