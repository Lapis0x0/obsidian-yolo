import { requestUrl } from 'obsidian'

const GITHUB_RELEASE_URL =
  'https://api.github.com/repos/Lapis0x0/obsidian-yolo/releases/latest'

export type UpdateCheckResult = {
  hasUpdate: boolean
  latestVersion: string
  releaseNotes: string
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

function firstParagraph(text: string, maxLen = 200): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed
  if (firstLine.length <= maxLen) return firstLine
  return `${firstLine.slice(0, maxLen - 1)}…`
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
      typeof data.body === 'string' ? firstParagraph(data.body) : ''
    const releaseUrl =
      typeof data.html_url === 'string' ? data.html_url : ''

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
