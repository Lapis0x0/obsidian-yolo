import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'Lapis0x0/obsidian-yolo'
const ZONE_NAME = 'yoloapp.dev'
const MIRROR_LAUNCHED_AT = '2026-07-25T05:38:22.000Z'
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const CLOUDFLARE_GRAPHQL_API = `${CLOUDFLARE_API}/graphql`
const ASSET_PATH_PREFIXES = ['/core/', '/modules/', '/runtime-components/']
const REFRESH_DAYS = 3

export function isMirroredAssetPath(value) {
  return (
    typeof value === 'string' &&
    ASSET_PATH_PREFIXES.some((prefix) => value.startsWith(prefix))
  )
}

export function buildDateWindows(startedAt, now) {
  const start = new Date(startedAt)
  const end = new Date(now)
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end
  ) {
    throw new Error('Download statistics time range is invalid')
  }

  const windows = []
  let cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  )
  while (cursor < end) {
    const next = new Date(cursor.getTime() + 86_400_000)
    const from = new Date(Math.max(cursor.getTime(), start.getTime()))
    const to = new Date(Math.min(next.getTime(), end.getTime()))
    windows.push({
      date: cursor.toISOString().slice(0, 10),
      from: from.toISOString(),
      to: to.toISOString(),
      complete: next <= end,
    })
    cursor = next
  }
  return windows
}

export function selectWindowsToRefresh(
  windows,
  daily,
  refreshDays = REFRESH_DAYS,
) {
  const refreshFrom = Math.max(0, windows.length - refreshDays)
  return windows.filter(
    (window, index) => daily[window.date] === undefined || index >= refreshFrom,
  )
}

export function sumCloudflareGroups(groups) {
  if (!Array.isArray(groups)) {
    throw new Error('Cloudflare Analytics groups are invalid')
  }
  return groups.reduce((total, group) => {
    const status = group?.dimensions?.edgeResponseStatus
    const requestPath = group?.dimensions?.clientRequestPath
    const count = group?.count
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(status) ||
      status < 200 ||
      status >= 300 ||
      !isMirroredAssetPath(requestPath)
    ) {
      return total
    }
    return total + count
  }, 0)
}

export function buildBadge(total) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('Download total is invalid')
  }
  return {
    schemaVersion: 1,
    label: 'downloads',
    message: formatCompactNumber(total),
    color: '0984e3',
  }
}

export function formatCompactNumber(value) {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return formatUnit(value, 1_000, 'k')
  if (value < 1_000_000_000) return formatUnit(value, 1_000_000, 'm')
  return formatUnit(value, 1_000_000_000, 'b')
}

function formatUnit(value, divisor, suffix) {
  const scaled = value / divisor
  const digits = scaled < 10 ? 1 : 0
  return `${scaled.toFixed(digits).replace(/\.0$/, '')}${suffix}`
}

export async function updateDownloadStats(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = new Date(options.now ?? Date.now())
  const state = options.state ?? { schemaVersion: 1, cloudflareDaily: {} }
  validateState(state)

  const token = options.cloudflareToken ?? process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new Error('Cloudflare Analytics API token is missing')

  const accountId =
    options.cloudflareAccountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
  const zoneId =
    options.cloudflareZoneId ??
    process.env.CLOUDFLARE_ZONE_ID ??
    (await findZoneId({ token, accountId, fetchImpl }))
  const windows = buildDateWindows(MIRROR_LAUNCHED_AT, now)
  const selected = selectWindowsToRefresh(windows, state.cloudflareDaily)
  const cloudflareDaily = { ...state.cloudflareDaily }

  for (const window of selected) {
    cloudflareDaily[window.date] = await fetchCloudflareAssetCount({
      token,
      zoneId,
      window,
      fetchImpl,
    })
  }

  const githubTotal = await fetchGitHubReleaseAssetTotal({
    repository: options.repository ?? REPOSITORY,
    token:
      options.githubToken ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
    fetchImpl,
  })
  const cloudflareTotal = Object.values(cloudflareDaily).reduce(
    (sum, value) => sum + value,
    0,
  )
  const total = githubTotal + cloudflareTotal
  return {
    state: {
      schemaVersion: 1,
      mirrorLaunchedAt: MIRROR_LAUNCHED_AT,
      updatedAt: now.toISOString(),
      githubTotal,
      cloudflareTotal,
      total,
      cloudflareDaily,
    },
    badge: buildBadge(total),
  }
}

async function findZoneId({ token, accountId, fetchImpl }) {
  const query = new URLSearchParams({ name: ZONE_NAME, status: 'active' })
  if (accountId) query.set('account.id', accountId)
  const response = await fetchImpl(`${CLOUDFLARE_API}/zones?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await readJsonResponse(response, 'Cloudflare zone lookup')
  if (
    !body.success ||
    !Array.isArray(body.result) ||
    body.result.length !== 1
  ) {
    throw new Error(
      'Cloudflare zone lookup failed; grant Zone Read or set CLOUDFLARE_ZONE_ID',
    )
  }
  return body.result[0].id
}

async function fetchCloudflareAssetCount({ token, zoneId, window, fetchImpl }) {
  const query = `
    query DownloadAssets($zoneTag: string!, $from: Time!, $to: Time!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequestsAdaptiveGroups(
            limit: 10000
            filter: {
              datetime_geq: $from
              datetime_lt: $to
              clientRequestHTTPHost: "updates.yoloapp.dev"
              clientRequestHTTPMethodName: "GET"
              requestSource: "eyeball"
            }
          ) {
            count
            dimensions {
              clientRequestPath
              edgeResponseStatus
            }
          }
        }
      }
    }
  `
  const response = await fetchImpl(CLOUDFLARE_GRAPHQL_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { zoneTag: zoneId, from: window.from, to: window.to },
    }),
  })
  const body = await readJsonResponse(response, 'Cloudflare Analytics')
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(
      `Cloudflare Analytics failed: ${body.errors
        .map((error) => error.message)
        .join('; ')}`,
    )
  }
  const zones = body?.data?.viewer?.zones
  if (!Array.isArray(zones) || zones.length !== 1) {
    throw new Error('Cloudflare Analytics returned an unexpected zone result')
  }
  return sumCloudflareGroups(zones[0].httpRequestsAdaptiveGroups)
}

async function fetchGitHubReleaseAssetTotal({ repository, token, fetchImpl }) {
  let page = 1
  let total = 0
  while (true) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    const releases = await readJsonResponse(response, 'GitHub Releases')
    if (!Array.isArray(releases)) {
      throw new Error('GitHub Releases response is invalid')
    }
    for (const release of releases) {
      if (!Array.isArray(release.assets)) continue
      for (const asset of release.assets) {
        if (
          !Number.isSafeInteger(asset.download_count) ||
          asset.download_count < 0
        ) {
          throw new Error('GitHub Release asset download count is invalid')
        }
        total += asset.download_count
      }
    }
    if (releases.length < 100) return total
    page += 1
  }
}

async function readJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error(`${label} did not return JSON`)
  }
}

function validateState(state) {
  if (
    !state ||
    state.schemaVersion !== 1 ||
    !state.cloudflareDaily ||
    typeof state.cloudflareDaily !== 'object' ||
    Array.isArray(state.cloudflareDaily) ||
    Object.entries(state.cloudflareDaily).some(
      ([date, count]) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isSafeInteger(count) ||
        count < 0,
    )
  ) {
    throw new Error('Download statistics state is invalid')
  }
}

async function runCli() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1])
  }
  const statePath = args.get('--state')
  const outputDir = args.get('--output-dir')
  if (!outputDir) {
    throw new Error(
      'Usage: download-stats.mjs --output-dir <dir> [--state <file>]',
    )
  }
  let state
  if (statePath) {
    try {
      state = JSON.parse(await readFile(statePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const result = await updateDownloadStats({ state })
  await mkdir(outputDir, { recursive: true })
  await Promise.all([
    writeFile(
      path.join(outputDir, 'download-stats.json'),
      `${JSON.stringify(result.state, null, 2)}\n`,
    ),
    writeFile(
      path.join(outputDir, 'badge.json'),
      `${JSON.stringify(result.badge, null, 2)}\n`,
    ),
  ])
  process.stdout.write(
    `GitHub ${result.state.githubTotal}, Cloudflare ${result.state.cloudflareTotal}, total ${result.state.total}\n`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runCli()
}
