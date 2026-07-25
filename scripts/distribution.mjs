import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import nacl from 'tweetnacl'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  setGlobalDispatcher(new EnvHttpProxyAgent())
}

const REPOSITORY = 'Lapis0x0/obsidian-yolo'
const FEED_PATH = path.resolve('distribution/feed-v1.json')
const SIGNATURE_PATH = path.resolve('distribution/feed-v1.sig')
const CATALOG_PATH = path.resolve('modules/catalog-v1.json')
const DEFAULT_PAGES_DIR = path.resolve('.distribution-pages')
const KEY_ID = 'yolo-distribution-2026-01'
const CORE_TAG = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2,3}$/
const MODULE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_FEED_BYTES = 1_000_000

export async function reconcileDistribution(options = {}) {
  const repository = options.repository ?? REPOSITORY
  const token =
    options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const fetchImpl = options.fetchImpl ?? fetch
  const releases =
    options.releases ?? (await listReleases(repository, token, fetchImpl))
  const configs = options.configs ?? (await readModuleConfigs(process.cwd()))
  const current = await readCurrentFeed()
  const desired = await buildDesiredSnapshot({
    repository,
    token,
    fetchImpl,
    releases,
    configs,
    current,
    triggerReleaseId: options.triggerReleaseId,
  })
  const previousSnapshot = current
    ? JSON.stringify({ core: current.core, modules: current.modules })
    : null
  const nextSnapshot = JSON.stringify({
    core: desired.core,
    modules: desired.modules,
  })
  if (previousSnapshot === nextSnapshot) {
    return { changed: false, feed: current }
  }

  const revision = (current?.revision ?? 0) + 1
  const feed = { schemaVersion: 1, revision, keyId: KEY_ID, ...desired }
  const raw = encodeJson(feed)
  if (raw.byteLength > MAX_FEED_BYTES)
    throw new Error('Feed exceeds byte limit')
  const signature = sign(
    raw,
    options.signingSecretKey ?? process.env.DISTRIBUTION_SIGNING_SECRET_KEY,
  )
  await mkdir(path.dirname(FEED_PATH), { recursive: true })
  await Promise.all([
    writeFile(FEED_PATH, raw),
    writeFile(SIGNATURE_PATH, `${Buffer.from(signature).toString('base64')}\n`),
    writeFile(CATALOG_PATH, encodeJson(projectCatalog(feed))),
  ])
  return { changed: true, feed }
}

export async function buildPagesSnapshot(options = {}) {
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_PAGES_DIR)
  const token =
    options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const fetchImpl = options.fetchImpl ?? fetch
  const raw = await readFile(FEED_PATH)
  const signature = await readFile(SIGNATURE_PATH, 'utf8')
  const feed = JSON.parse(raw.toString('utf8'))
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  await Promise.all([
    writeFile(path.join(outputDir, 'feed-v1.json'), raw),
    writeFile(path.join(outputDir, 'feed-v1.sig'), signature),
  ])

  for (const asset of Object.values(feed.core.assets)) {
    await mirrorAsset(asset, outputDir, token, fetchImpl)
  }
  for (const module of feed.modules) {
    const manifestBytes = await mirrorAsset(
      module.manifest,
      outputDir,
      token,
      fetchImpl,
    )
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const files = new Map()
    for (const variant of manifest.variants ?? []) {
      for (const file of variant.files ?? []) files.set(file.path, file)
    }
    for (const file of [...files.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      await mirrorAsset(
        {
          name: file.name,
          mirrorPath: `modules/${module.id}/${module.version}/${file.path}`,
          canonicalUrl: file.url,
          byteSize: file.byteSize,
          sha256: file.sha256,
        },
        outputDir,
        token,
        fetchImpl,
      )
    }
  }
  const headers = [
    '/feed-v1.json',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '/feed-v1.sig',
    '  Cache-Control: public, max-age=0, must-revalidate',
    '/core/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '/modules/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n')
  await writeFile(path.join(outputDir, '_headers'), headers)
  return { outputDir, revision: feed.revision }
}

export async function verifyPagesDeployment(options = {}) {
  const baseUrl = (options.baseUrl ?? 'https://updates.yoloapp.dev').replace(
    /\/$/,
    '',
  )
  const fetchImpl = options.fetchImpl ?? fetch
  const expectedFeed = await readFile(FEED_PATH)
  const expectedSignature = (await readFile(SIGNATURE_PATH, 'utf8')).trim()
  const feedResponse = await fetchImpl(`${baseUrl}/feed-v1.json`, {
    cache: 'no-store',
  })
  if (!feedResponse.ok)
    throw new Error(`Pages Feed returned HTTP ${feedResponse.status}`)
  const actualFeed = Buffer.from(await feedResponse.arrayBuffer())
  if (!actualFeed.equals(expectedFeed))
    throw new Error('Pages Feed bytes differ')
  const signatureResponse = await fetchImpl(`${baseUrl}/feed-v1.sig`, {
    cache: 'no-store',
  })
  if (!signatureResponse.ok)
    throw new Error(`Pages signature returned HTTP ${signatureResponse.status}`)
  if ((await signatureResponse.text()).trim() !== expectedSignature) {
    throw new Error('Pages signature differs')
  }
  const feed = JSON.parse(expectedFeed.toString('utf8'))
  const assets = [...Object.values(feed.core.assets)]
  for (const module of feed.modules) {
    const manifestResponse = await fetchImpl(
      `${baseUrl}/${module.manifest.mirrorPath}`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!manifestResponse.ok) {
      throw new Error(
        `${module.manifest.mirrorPath} returned HTTP ${manifestResponse.status}`,
      )
    }
    const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer())
    verifyBytes(manifestBytes, module.manifest)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const files = new Map()
    for (const variant of manifest.variants ?? []) {
      for (const file of variant.files ?? []) files.set(file.path, file)
    }
    for (const file of files.values()) {
      assets.push({
        name: file.name,
        mirrorPath: `modules/${module.id}/${module.version}/${file.path}`,
        canonicalUrl: file.url,
        byteSize: file.byteSize,
        sha256: file.sha256,
      })
    }
  }
  for (const asset of assets) {
    const response = await fetchImpl(`${baseUrl}/${asset.mirrorPath}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok)
      throw new Error(`${asset.mirrorPath} returned HTTP ${response.status}`)
    verifyBytes(Buffer.from(await response.arrayBuffer()), asset)
  }
  return { revision: feed.revision }
}

export async function buildDesiredSnapshot({
  repository,
  token,
  fetchImpl,
  releases,
  configs,
  current,
  triggerReleaseId,
}) {
  if (triggerReleaseId !== undefined) {
    const found = releases.some(
      (release) => String(release.id) === String(triggerReleaseId),
    )
    if (!found)
      throw new Error(`Trigger Release was not found: ${triggerReleaseId}`)
  }
  const published = releases.filter(
    (release) => !release.draft && !release.prerelease,
  )
  const coreRelease = highestRelease(
    published.filter((release) => CORE_TAG.test(release.tag_name ?? '')),
    (release) => release.tag_name,
  )
  if (!coreRelease) throw new Error('No published Core Release was found')
  const core = await describeCoreRelease(
    repository,
    coreRelease,
    token,
    fetchImpl,
  )
  assertNoVersionRollback(current?.core, core, 'Core')

  const modules = []
  for (const config of configs.sort((a, b) => a.id.localeCompare(b.id))) {
    const prefix = `${config.id}/v`
    const candidates = published.filter((release) => {
      const tag = release.tag_name ?? ''
      return (
        tag.startsWith(prefix) && MODULE_VERSION.test(tag.slice(prefix.length))
      )
    })
    if (candidates.length === 0) {
      if (current?.modules.some((module) => module.id === config.id)) {
        throw new Error(`Published module disappeared: ${config.id}`)
      }
      continue
    }
    const release = highestRelease(candidates, (candidate) =>
      candidate.tag_name.slice(prefix.length),
    )
    const module = await describeModuleRelease(
      repository,
      release,
      config,
      token,
      fetchImpl,
    )
    assertNoVersionRollback(
      current?.modules.find((entry) => entry.id === config.id),
      module,
      `Module ${config.id}`,
    )
    modules.push(module)
  }
  for (const module of current?.modules ?? []) {
    if (!configs.some((config) => config.id === module.id)) {
      throw new Error(`Official module config disappeared: ${module.id}`)
    }
  }
  return { core, modules }
}

export function assertNewReleaseVersion(releases, tag) {
  const published = releases.filter(
    (release) => !release.draft && !release.prerelease,
  )
  let candidates
  let version
  if (CORE_TAG.test(tag)) {
    version = tag
    candidates = published.filter((release) =>
      CORE_TAG.test(release.tag_name ?? ''),
    )
  } else {
    const match = tag.match(/^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/v(.+)$/)
    if (!match || !MODULE_VERSION.test(match[2])) {
      throw new Error(`Release tag is invalid: ${tag}`)
    }
    const prefix = `${match[1]}/v`
    version = match[2]
    candidates = published.filter(
      (release) =>
        release.tag_name?.startsWith(prefix) &&
        MODULE_VERSION.test(release.tag_name.slice(prefix.length)),
    )
  }
  if (candidates.length === 0) return
  const latest = highestRelease(candidates, (release) =>
    release.tag_name.includes('/v')
      ? release.tag_name.slice(release.tag_name.indexOf('/v') + 2)
      : release.tag_name,
  )
  const latestVersion = latest.tag_name.includes('/v')
    ? latest.tag_name.slice(latest.tag_name.indexOf('/v') + 2)
    : latest.tag_name
  if (compareVersions(version, latestVersion) <= 0) {
    throw new Error(
      `Release ${tag} must be newer than published ${latest.tag_name}`,
    )
  }
}

async function describeCoreRelease(repository, release, token, fetchImpl) {
  const version = release.tag_name
  const assets = Object.create(null)
  for (const [key, name] of [
    ['mainJs', 'main.js'],
    ['manifestJson', 'manifest.json'],
    ['stylesCss', 'styles.css'],
  ]) {
    const bytes = await downloadReleaseAsset(
      requireAsset(release, name),
      token,
      fetchImpl,
    )
    assets[key] = describeAsset(
      repository,
      release.tag_name,
      name,
      `core/${version}/${name}`,
      bytes,
    )
  }
  const manifest = JSON.parse(
    (
      await downloadReleaseAsset(
        requireAsset(release, 'manifest.json'),
        token,
        fetchImpl,
      )
    ).toString('utf8'),
  )
  if (manifest.version !== version)
    throw new Error(`Core manifest version mismatch: ${version}`)
  const noteAsset = release.assets?.find(
    (asset) => asset.name === 'release-note.md',
  )
  const note = noteAsset
    ? (await downloadReleaseAsset(noteAsset, token, fetchImpl)).toString('utf8')
    : String(release.body ?? '')
  return {
    version,
    minAppVersion: manifest.minAppVersion,
    releaseUrl: release.html_url,
    releaseNotes: splitReleaseNotes(note),
    assets,
  }
}

async function describeModuleRelease(
  repository,
  release,
  config,
  token,
  fetchImpl,
) {
  const version = release.tag_name.slice(`${config.id}/v`.length)
  const configAsset = release.assets?.find(
    (asset) => asset.name === 'module-config.json',
  )
  const releasedConfig = configAsset
    ? JSON.parse(
        (await downloadReleaseAsset(configAsset, token, fetchImpl)).toString(
          'utf8',
        ),
      )
    : config
  if (releasedConfig.id !== config.id) {
    throw new Error(`Module config identity mismatch: ${config.id}`)
  }
  const manifestBytes = await downloadReleaseAsset(
    requireAsset(release, 'module.json'),
    token,
    fetchImpl,
  )
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.id !== config.id || manifest.version !== version) {
    throw new Error(`Module manifest identity mismatch: ${config.id}`)
  }
  const platforms = [
    ...new Set((manifest.variants ?? []).map((variant) => variant.platform)),
  ].sort()
  if (platforms.length === 0)
    throw new Error(`Module has no platforms: ${config.id}`)
  const noteBytes = await downloadReleaseAsset(
    requireAsset(release, 'release-note.md'),
    token,
    fetchImpl,
  )
  const manifestDescriptor = describeAsset(
    repository,
    release.tag_name,
    'module.json',
    `modules/${config.id}/${version}/module.json`,
    manifestBytes,
  )
  const noteDescriptor = describeAsset(
    repository,
    release.tag_name,
    'release-note.md',
    null,
    noteBytes,
  )
  return {
    id: config.id,
    icon: releasedConfig.icon,
    localizations: releasedConfig.localizations,
    version,
    hostApi: manifest.hostApi,
    platforms,
    dataSchemas: manifest.dataSchemas,
    releaseUrl: release.html_url,
    releaseNotes: splitReleaseNotes(noteBytes.toString('utf8')),
    releaseNote: noteDescriptor,
    manifest: manifestDescriptor,
  }
}

function projectCatalog(feed) {
  return {
    schemaVersion: 1,
    modules: feed.modules.map((module) => ({
      id: module.id,
      icon: module.icon,
      localizations: module.localizations,
      versions: [
        {
          version: module.version,
          hostApi: module.hostApi,
          platforms: module.platforms,
          dataSchemas: module.dataSchemas,
          manifestUrl: module.manifest.canonicalUrl,
          manifest: {
            byteSize: module.manifest.byteSize,
            sha256: module.manifest.sha256,
          },
          releaseNotes: {
            url: module.releaseNote.canonicalUrl,
            byteSize: module.releaseNote.byteSize,
            sha256: module.releaseNote.sha256,
          },
        },
      ],
    })),
  }
}

async function mirrorAsset(asset, outputDir, token, fetchImpl) {
  validateDescriptor(asset)
  const bytes = await downloadUrl(asset.canonicalUrl, token, fetchImpl)
  verifyBytes(bytes, asset)
  const target = path.resolve(outputDir, asset.mirrorPath)
  if (!target.startsWith(`${outputDir}${path.sep}`))
    throw new Error('Mirror path escapes output')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return bytes
}

function describeAsset(repository, tag, name, mirrorPath, bytes) {
  return {
    name,
    ...(mirrorPath ? { mirrorPath } : {}),
    canonicalUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    byteSize: bytes.byteLength,
    sha256: sha256(bytes),
  }
}

function validateDescriptor(asset) {
  if (
    !asset ||
    typeof asset.name !== 'string' ||
    typeof asset.mirrorPath !== 'string' ||
    !asset.mirrorPath ||
    asset.mirrorPath.startsWith('/') ||
    asset.mirrorPath
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    typeof asset.canonicalUrl !== 'string' ||
    !asset.canonicalUrl.startsWith(
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/',
    ) ||
    !Number.isSafeInteger(asset.byteSize) ||
    asset.byteSize <= 0 ||
    !SHA256.test(asset.sha256)
  ) {
    throw new Error('Asset descriptor is invalid')
  }
}

function verifyBytes(bytes, descriptor) {
  if (
    bytes.byteLength !== descriptor.byteSize ||
    sha256(bytes) !== descriptor.sha256
  ) {
    throw new Error(`Asset integrity mismatch: ${descriptor.name}`)
  }
}

async function listReleases(repository, token, fetchImpl) {
  const releases = []
  for (let page = 1; ; page += 1) {
    const response = await githubFetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      token,
      fetchImpl,
      'application/vnd.github+json',
    )
    const batch = JSON.parse(await response.text())
    if (!Array.isArray(batch))
      throw new Error('GitHub Releases response is invalid')
    releases.push(...batch)
    if (batch.length < 100) return releases
  }
}

async function readModuleConfigs(root) {
  const entries = await readdir(path.resolve(root, 'modules'), {
    withFileTypes: true,
  })
  const configs = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const config = JSON.parse(
        await readFile(
          path.resolve(root, 'modules', entry.name, 'module.config.json'),
          'utf8',
        ),
      )
      if (config.id !== entry.name)
        throw new Error(`Module config id mismatch: ${entry.name}`)
      configs.push(config)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return configs
}

async function readCurrentFeed() {
  try {
    return JSON.parse(await readFile(FEED_PATH, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function highestRelease(releases, versionOf) {
  return [...releases].sort((a, b) =>
    compareVersions(versionOf(b), versionOf(a)),
  )[0]
}

function compareVersions(left, right) {
  const a = left.split('.').map((part) => Number(part))
  const b = right.split('.').map((part) => Number(part))
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function assertNoVersionRollback(current, desired, label) {
  if (current && compareVersions(desired.version, current.version) < 0) {
    throw new Error(
      `${label} would roll back from ${current.version} to ${desired.version}`,
    )
  }
}

function requireAsset(release, name) {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const matches = assets.filter((asset) => asset.name === name)
  if (matches.length !== 1)
    throw new Error(`${release.tag_name} must contain one ${name}`)
  return matches[0]
}

async function downloadReleaseAsset(asset, token, fetchImpl) {
  if (!asset.browser_download_url) {
    throw new Error(
      `Release asset has no download URL: ${asset.name ?? 'unknown'}`,
    )
  }
  return downloadUrl(asset.browser_download_url, token, fetchImpl)
}

async function downloadUrl(url, token, fetchImpl) {
  const response = await githubFetch(
    url,
    token,
    fetchImpl,
    'application/octet-stream',
  )
  return Buffer.from(await response.arrayBuffer())
}

async function githubFetch(url, token, fetchImpl, accept) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok)
    throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  return response
}

function splitReleaseNotes(note) {
  const parts = note
    .split(/^\s*---\s*$/m)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length !== 2)
    throw new Error('Release note must contain two language blocks')
  const [first, second] = parts
  const firstCjk = (first.match(/[一-鿿]/g) ?? []).length
  const secondCjk = (second.match(/[一-鿿]/g) ?? []).length
  return firstCjk <= secondCjk
    ? { en: first, zh: second }
    : { en: second, zh: first }
}

function sign(raw, encodedSecret) {
  if (typeof encodedSecret !== 'string' || !encodedSecret) {
    throw new Error('DISTRIBUTION_SIGNING_SECRET_KEY is required')
  }
  const secret = Buffer.from(encodedSecret, 'base64')
  const keyPair =
    secret.byteLength === nacl.sign.seedLength
      ? nacl.sign.keyPair.fromSeed(secret)
      : secret.byteLength === nacl.sign.secretKeyLength
        ? nacl.sign.keyPair.fromSecretKey(secret)
        : null
  if (!keyPair) throw new Error('Distribution signing secret key is invalid')
  return nacl.sign.detached(raw, keyPair.secretKey)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function encodeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

async function main(args) {
  const command = args[0]
  const values = new Map()
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith('--') || value === undefined)
      throw new Error(`Invalid option: ${option}`)
    values.set(option.slice(2), value)
  }
  if (command === 'reconcile') {
    const result = await reconcileDistribution({
      triggerReleaseId: values.get('trigger-release-id'),
    })
    console.log(
      result.changed
        ? `Published Feed revision ${result.feed.revision}`
        : `Feed revision ${result.feed.revision} is current`,
    )
    return
  }
  if (command === 'assert-new-release') {
    const tag = values.get('tag')
    if (!tag) throw new Error('--tag is required')
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
    const releases = await listReleases(REPOSITORY, token, fetch)
    assertNewReleaseVersion(releases, tag)
    console.log(`Verified that ${tag} advances its product`)
    return
  }
  if (command === 'build-pages') {
    const result = await buildPagesSnapshot({
      outputDir: values.get('output-dir'),
    })
    console.log(
      `Built Pages revision ${result.revision} at ${result.outputDir}`,
    )
    return
  }
  if (command === 'verify-pages') {
    const result = await verifyPagesDeployment({
      baseUrl: values.get('base-url'),
    })
    console.log(`Verified Pages revision ${result.revision}`)
    return
  }
  throw new Error(
    'Usage: distribution.mjs <assert-new-release|reconcile|build-pages|verify-pages> [options]',
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
