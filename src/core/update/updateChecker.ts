import { requestUrl } from 'obsidian'

const GITHUB_RELEASE_URL =
  'https://api.github.com/repos/Lapis0x0/obsidian-yolo/releases/latest'

export type ReleaseNotesByLanguage = {
  en: string | null
  zh: string | null
}

export type UpdateCheckResult = {
  hasUpdate: boolean
  latestVersion: string
  releaseNotes: ReleaseNotesByLanguage
  releaseUrl: string
}

type GitHubReleaseResponse = {
  tag_name?: string
  body?: string
  html_url?: string
}

function stripVersionPrefix(tag: string): string {
  return tag.replace(/^v/i, '').trim()
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
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (bv > av) return true
    if (bv < av) return false
  }
  return false
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
  /** Remainder of the bullet after the title + separator; may contain `code`. */
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

/**
 * Fetches latest GitHub release and compares to `currentVersion`.
 * Returns null on network/parse failure (caller should stay silent).
 */
export async function checkForUpdate(
  currentVersion: string,
): Promise<UpdateCheckResult | null> {
  try {
    const response = await requestUrl({
      url: GITHUB_RELEASE_URL,
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
    const latestVersion = stripVersionPrefix(tag)
    if (!latestVersion) {
      return null
    }

    const hasUpdate = compareVersions(currentVersion, latestVersion)
    const releaseNotes =
      typeof data.body === 'string'
        ? splitReleaseNotesByLanguage(data.body)
        : { en: null, zh: null }
    const releaseUrl = typeof data.html_url === 'string' ? data.html_url : ''

    return {
      hasUpdate,
      latestVersion,
      releaseNotes,
      releaseUrl,
    }
  } catch {
    return null
  }
}
