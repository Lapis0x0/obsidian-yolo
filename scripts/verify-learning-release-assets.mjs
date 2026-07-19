import { createHash } from 'node:crypto'
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export async function cleanupOwnedDraftRelease({
  repository,
  tag,
  releaseId,
  targetCommit,
  ownerMarker,
  token,
  apiBase = 'https://api.github.com',
  fetchImpl = fetch,
}) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`)
  }
  if (!tag || !targetCommit || !ownerMarker || !token) {
    throw new Error(
      'A tag, target commit, owner marker, and GitHub token are required',
    )
  }
  if (!/^\d+$/.test(String(releaseId))) {
    throw new Error('A numeric Release id is required')
  }

  const apiUrl = `${apiBase}/repos/${repository}/releases/${releaseId}`
  const response = await githubRequest(apiUrl, token, fetchImpl)
  if (response.status === 404) return { deleted: false, reason: 'not-found' }
  if (!response.ok) {
    throw new Error(`GET ${apiUrl} failed with HTTP ${response.status}`)
  }

  const release = parseJson(Buffer.from(await response.arrayBuffer()), apiUrl)
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error('Refusing to delete a Release with an invalid id')
  }
  assertEqual(String(release.id), String(releaseId), 'Release id')
  assertEqual(release.tag_name, tag, 'Release tag')
  assertEqual(release.target_commitish, targetCommit, 'Release target commit')
  assertEqual(release.draft, true, 'Release draft state')
  if (
    typeof release.body !== 'string' ||
    !release.body.startsWith(`<!-- ${ownerMarker} -->`)
  ) {
    throw new Error(
      'Refusing to delete a Release not owned by this workflow run',
    )
  }

  const deleteUrl = `${apiBase}/repos/${repository}/releases/${release.id}`
  const deleteResponse = await githubRequest(deleteUrl, token, fetchImpl, {
    method: 'DELETE',
  })
  if (!deleteResponse.ok) {
    throw new Error(
      `DELETE ${deleteUrl} failed with HTTP ${deleteResponse.status}`,
    )
  }
  return { deleted: true, releaseId: release.id }
}

export async function verifyLearningReleaseAssets({
  repository,
  tag,
  releaseId,
  targetCommit,
  assetDir,
  metadataOut,
  token,
  apiBase = 'https://api.github.com',
  downloadBase = `https://github.com/${repository}/releases/download`,
  fetchImpl = fetch,
  githubOutput,
  expectedDraft = true,
}) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`)
  }
  if (!tag || !/^\d+$/.test(String(releaseId))) {
    throw new Error('A tag and numeric Release id are required')
  }
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required')

  const encodedTag = encodeURIComponent(tag)
  const apiUrl = `${apiBase}/repos/${repository}/releases/${releaseId}`
  const release = await fetchJson(apiUrl, token, fetchImpl)
  assertEqual(String(release.id), String(releaseId), 'Release id')
  assertEqual(release.tag_name, tag, 'Release tag')
  assertEqual(release.target_commitish, targetCommit, 'Release target commit')
  assertEqual(release.draft, expectedDraft, 'Release draft state')
  assertEqual(release.prerelease, false, 'Release prerelease state')
  if (!Array.isArray(release.assets))
    throw new Error('Release assets must be an array')

  const remoteAssets = new Map()
  for (const asset of release.assets) {
    if (
      !asset ||
      typeof asset.name !== 'string' ||
      remoteAssets.has(asset.name)
    ) {
      throw new Error(`Invalid or duplicate Release asset: ${asset?.name}`)
    }
    const canonicalUrl = `${downloadBase}/${encodedTag}/${encodeURIComponent(asset.name)}`
    const publishedBrowserUrl = `${downloadBase}/${tag}/${encodeURIComponent(asset.name)}`
    if (!expectedDraft) {
      assertOneOf(
        asset.browser_download_url,
        [canonicalUrl, publishedBrowserUrl],
        `${asset.name} published URL`,
      )
    }
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
      throw new Error(`${asset.name} has an invalid GitHub asset id`)
    }
    assertEqual(
      asset.url,
      `${apiBase}/repos/${repository}/releases/assets/${asset.id}`,
      `${asset.name} API URL`,
    )
    remoteAssets.set(asset.name, asset)
  }

  const moduleAsset = requireAsset(remoteAssets, 'module.json')
  const moduleBytes = await fetchBytes(moduleAsset.url, token, fetchImpl)
  verifyApiSize(moduleAsset, moduleBytes)
  const manifestSha256 = sha256(moduleBytes)
  const manifest = parseJson(moduleBytes, 'module.json')
  if (!Array.isArray(manifest.variants) || manifest.variants.length === 0) {
    throw new Error('module.json variants must be a non-empty array')
  }

  const expectedNames = new Set(['module.json'])
  const declarations = new Map()
  const platforms = new Set()
  for (const variant of manifest.variants) {
    if (
      !variant ||
      typeof variant.platform !== 'string' ||
      platforms.has(variant.platform)
    ) {
      throw new Error(
        `Invalid or duplicate manifest platform: ${variant?.platform}`,
      )
    }
    platforms.add(variant.platform)
    if (!Array.isArray(variant.files)) {
      throw new Error(`${variant.platform} manifest files must be an array`)
    }
    for (const file of variant.files) {
      validateDeclaration(file, variant.platform)
      expectedNames.add(file.path)
      const prior = declarations.get(file.path)
      if (prior && JSON.stringify(prior) !== JSON.stringify(file)) {
        throw new Error(`${file.path} has inconsistent cross-platform metadata`)
      }
      declarations.set(file.path, file)
    }
  }

  assertSetEqual(
    new Set(remoteAssets.keys()),
    expectedNames,
    'remote asset closure',
  )

  const localEntries = await readdir(assetDir, { withFileTypes: true })
  if (localEntries.some((entry) => !entry.isFile())) {
    throw new Error('Local release asset directory contains a non-file entry')
  }
  assertSetEqual(
    new Set(localEntries.map((entry) => entry.name)),
    expectedNames,
    'local asset closure',
  )

  const verifiedAssets = []
  for (const name of [...expectedNames].sort()) {
    const asset = requireAsset(remoteAssets, name)
    const bytes =
      name === 'module.json'
        ? moduleBytes
        : await fetchBytes(asset.url, token, fetchImpl)
    verifyApiSize(asset, bytes)
    const digest = sha256(bytes)

    const declaration = declarations.get(name)
    if (declaration) {
      assertEqual(
        bytes.byteLength,
        declaration.byteSize,
        `${name} manifest byteSize`,
      )
      assertEqual(digest, declaration.sha256, `${name} manifest SHA-256`)
      assertEqual(
        declaration.url,
        `${downloadBase}/${encodedTag}/${encodeURIComponent(name)}`,
        `${name} manifest URL`,
      )
    }
    const localBytes = await readFile(path.join(assetDir, name))
    assertEqual(
      bytes.byteLength,
      localBytes.byteLength,
      `${name} local byte size`,
    )
    assertEqual(digest, sha256(localBytes), `${name} local SHA-256`)
    verifiedAssets.push({
      name,
      byteSize: bytes.byteLength,
      sha256: digest,
      url: `${downloadBase}/${encodedTag}/${encodeURIComponent(name)}`,
    })
  }

  const metadata = {
    schemaVersion: 1,
    repository,
    releaseId: Number(release.id),
    tag,
    releaseUrl: release.html_url,
    apiUrl,
    targetCommitish: release.target_commitish,
    version: manifest.version,
    manifest: {
      url: `${downloadBase}/${encodedTag}/module.json`,
      byteSize: moduleBytes.byteLength,
      sha256: manifestSha256,
    },
    assets: verifiedAssets,
  }
  await writeFile(metadataOut, `${JSON.stringify(metadata, null, 2)}\n`)

  if (githubOutput) {
    const outputs = {
      release_id: metadata.releaseId,
      release_tag: metadata.tag,
      release_url: metadata.releaseUrl,
      manifest_url: metadata.manifest.url,
      manifest_byte_size: metadata.manifest.byteSize,
      manifest_sha256: metadata.manifest.sha256,
      release_version: metadata.version,
      metadata_path: metadataOut,
    }
    await appendFile(
      githubOutput,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    )
  }
  return metadata
}

function validateDeclaration(file, platform) {
  if (!file || typeof file.path !== 'string' || file.path !== file.name) {
    throw new Error(`${platform} contains an invalid file name/path`)
  }
  if (path.posix.basename(file.path) !== file.path) {
    throw new Error(`${platform} contains a non-flat asset path: ${file.path}`)
  }
  if (!Number.isSafeInteger(file.byteSize) || file.byteSize <= 0) {
    throw new Error(`${file.path} has invalid byteSize`)
  }
  if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new Error(`${file.path} has invalid SHA-256`)
  }
  if (typeof file.url !== 'string')
    throw new Error(`${file.path} has invalid URL`)
}

async function fetchJson(url, token, fetchImpl) {
  return parseJson(
    await fetchBytes(url, token, fetchImpl, 'application/vnd.github+json'),
    url,
  )
}

async function fetchBytes(
  url,
  token,
  fetchImpl,
  accept = 'application/octet-stream',
) {
  const response = await githubRequest(url, token, fetchImpl, {
    headers: { Accept: accept },
  })
  if (!response.ok)
    throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function githubRequest(url, token, fetchImpl, options = {}) {
  return fetchImpl(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
    redirect: 'follow',
  })
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function requireAsset(assets, name) {
  const asset = assets.get(name)
  if (!asset) throw new Error(`Release is missing asset: ${name}`)
  return asset
}

function verifyApiSize(asset, bytes) {
  assertEqual(bytes.byteLength, asset.size, `${asset.name} API byte size`)
}

function assertSetEqual(actual, expected, label) {
  const actualValues = [...actual].sort()
  const expectedValues = [...expected].sort()
  assertEqual(
    JSON.stringify(actualValues),
    JSON.stringify(expectedValues),
    label,
  )
}

function assertOneOf(actual, expected, label) {
  if (!expected.includes(actual)) {
    throw new Error(
      `${label} mismatch: expected one of ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    )
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    )
  }
}

function parseArgs(
  args,
  required = [
    'repository',
    'tag',
    'release-id',
    'target-commit',
    'asset-dir',
    'metadata-out',
  ],
) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid command-line argument: ${option ?? ''}`)
    }
    values.set(option.slice(2), value)
  }
  for (const name of required) {
    if (!values.has(name)) throw new Error(`Missing required option: --${name}`)
  }
  return Object.fromEntries(values)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cleanup = process.argv[2] === '--cleanup-owned-draft'
  const allowPublished = process.argv.includes('--allow-published')
  const rawArgs = process.argv.slice(cleanup ? 3 : 2)
  const args = parseArgs(
    rawArgs.filter((arg) => arg !== '--allow-published'),
    cleanup
      ? ['repository', 'tag', 'target-commit', 'owner-marker']
      : undefined,
  )
  if (cleanup) {
    const result = await cleanupOwnedDraftRelease({
      repository: args.repository,
      tag: args.tag,
      releaseId: args['release-id'],
      targetCommit: args['target-commit'],
      ownerMarker: args['owner-marker'],
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    })
    console.log(
      result.deleted
        ? `Deleted failed draft Learning Release ${args.tag}`
        : `No draft Learning Release to delete for ${args.tag}`,
    )
  } else {
    await verifyLearningReleaseAssets({
      repository: args.repository,
      tag: args.tag,
      releaseId: args['release-id'],
      targetCommit: args['target-commit'],
      assetDir: path.resolve(args['asset-dir']),
      metadataOut: path.resolve(args['metadata-out']),
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
      githubOutput: process.env.GITHUB_OUTPUT,
      expectedDraft: !allowPublished,
    })
    console.log(
      `Verified ${allowPublished ? 'published' : 'draft'} Learning Release ${args.tag}`,
    )
  }
}
