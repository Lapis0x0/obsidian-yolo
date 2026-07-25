import { createHash } from 'node:crypto'
import { appendFile, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const args = parseArgs(process.argv.slice(2))
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) throw new Error('GH_TOKEN is required')
const expectedDraft = !args['allow-published']
const apiBase = 'https://api.github.com'
const release = await fetchJson(
  `${apiBase}/repos/${args.repository}/releases/${args['release-id']}`,
)
assertEqual(String(release.id), args['release-id'], 'Release id')
assertEqual(release.tag_name, args.tag, 'Release tag')
assertEqual(release.target_commitish, args['target-commit'], 'target commit')
assertEqual(release.draft, expectedDraft, 'draft state')
assertEqual(release.prerelease, false, 'prerelease state')
const expectedNames = new Set([
  'main.js',
  'manifest.json',
  'release-note.md',
  'styles.css',
])
const localEntries = await readdir(args['asset-dir'], { withFileTypes: true })
if (localEntries.some((entry) => !entry.isFile())) {
  throw new Error('Core asset directory contains non-file entries')
}
assertSetEqual(
  new Set(localEntries.map((entry) => entry.name)),
  expectedNames,
  'local asset closure',
)
if (!Array.isArray(release.assets))
  throw new Error('Release assets are invalid')
assertSetEqual(
  new Set(release.assets.map((asset) => asset.name)),
  expectedNames,
  'remote asset closure',
)
for (const name of expectedNames) {
  const asset = release.assets.find((candidate) => candidate.name === name)
  if (!asset || !Number.isSafeInteger(asset.size) || !asset.url) {
    throw new Error(`Release asset is invalid: ${name}`)
  }
  const [remoteBytes, localBytes] = await Promise.all([
    fetchBytes(asset.url, 'application/octet-stream'),
    readFile(path.join(args['asset-dir'], name)),
  ])
  assertEqual(remoteBytes.byteLength, asset.size, `${name} API size`)
  assertEqual(
    remoteBytes.byteLength,
    localBytes.byteLength,
    `${name} local size`,
  )
  assertEqual(sha256(remoteBytes), sha256(localBytes), `${name} SHA-256`)
}
const note = await readFile(
  path.join(args['asset-dir'], 'release-note.md'),
  'utf8',
)
assertEqual(
  note.trim(),
  String(release.body ?? '')
    .replace(/^<!-- .*? -->\s*/s, '')
    .trim(),
  'Release body',
)
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `release_id=${release.id}\nrelease_tag=${release.tag_name}\nrelease_url=${release.html_url}\n`,
  )
}
console.log(`Verified Core Release ${release.tag_name}`)

async function fetchJson(url) {
  return JSON.parse(
    (await fetchBytes(url, 'application/vnd.github+json')).toString('utf8'),
  )
}

async function fetchBytes(url, accept) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
  })
  if (!response.ok)
    throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function parseArgs(values) {
  const parsed = Object.create(null)
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index]
    if (option === '--allow-published') {
      parsed['allow-published'] = true
      continue
    }
    const value = values[index + 1]
    if (!option?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid option: ${option ?? ''}`)
    }
    parsed[option.slice(2)] = value
    index += 1
  }
  for (const name of [
    'repository',
    'tag',
    'release-id',
    'target-commit',
    'asset-dir',
  ]) {
    if (!parsed[name]) throw new Error(`Missing --${name}`)
  }
  return parsed
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertSetEqual(actual, expected, label) {
  assertEqual(
    JSON.stringify([...actual].sort()),
    JSON.stringify([...expected].sort()),
    label,
  )
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    )
  }
}
