import { createHash } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const OFFICIAL_REPOSITORY = 'Lapis0x0/obsidian-yolo'
const RELEASE_ROOT = `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/`
const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SHA256 = /^[a-f0-9]{64}$/
const NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const DANGEROUS_NAMESPACES = new Set(['__proto__', 'prototype', 'constructor'])
const FILE_ROLES = new Set([
  'entry',
  'style',
  'worker',
  'wasm',
  'model',
  'data',
])
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

export async function updateModuleCatalog({
  catalogPath = path.resolve('modules/catalog-v1.json'),
  manifestUrl,
  expectedId,
  expectedVersion,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const release = parseOfficialUrl(manifestUrl, 'module.json')
  const manifestBytes = await fetchBytes(
    manifestUrl,
    MAX_MANIFEST_BYTES,
    'module manifest',
    fetchImpl,
  )
  const manifestHash = sha256(manifestBytes)
  const manifest = parseManifest(parseJson(manifestBytes, 'Module manifest'))

  assertEqual(manifest.id, expectedId, 'Manifest module id')
  assertEqual(manifest.version, expectedVersion, 'Manifest version')
  assertEqual(release.tag, `${manifest.id}/v${manifest.version}`, 'Release tag')

  const files = collectFiles(manifest, release.parent)
  await Promise.all(
    files.map(async (file) => {
      const bytes = await fetchBytes(
        file.url,
        file.byteSize,
        `artifact ${file.name}`,
        fetchImpl,
      )
      assertEqual(bytes.byteLength, file.byteSize, `${file.name} byteSize`)
      assertEqual(sha256(bytes), file.sha256, `${file.name} sha256`)
    }),
  )
  await Promise.all(
    manifest.variants.map(async ({ platform }) => {
      const name = `ready.${platform}.${manifestHash}.json`
      const bytes = await fetchBytes(
        `${release.urlRoot}/${name}`,
        MAX_MANIFEST_BYTES,
        `${platform} ready marker`,
        fetchImpl,
      )
      const marker = asObject(
        parseJson(bytes, `${platform} ready marker`),
        name,
      )
      assertExactKeys(
        marker,
        ['schemaVersion', 'id', 'version', 'platform', 'manifestSha256'],
        name,
      )
      assertEqual(marker.schemaVersion, 1, `${name} schemaVersion`)
      assertEqual(marker.id, manifest.id, `${name} id`)
      assertEqual(marker.version, manifest.version, `${name} version`)
      assertEqual(marker.platform, platform, `${name} platform`)
      assertEqual(marker.manifestSha256, manifestHash, `${name} manifestSha256`)
    }),
  )

  const currentText = await readFile(catalogPath, 'utf8')
  if (Buffer.byteLength(currentText) > 1_000_000) {
    throw new Error('Catalog exceeds its size limit')
  }
  const catalog = validateCatalog(JSON.parse(currentText))
  const moduleIndex = catalog.modules.findIndex(({ id }) => id === manifest.id)
  const moduleEntry =
    moduleIndex === -1
      ? { id: manifest.id, versions: [] }
      : catalog.modules[moduleIndex]
  const versionIndex = moduleEntry.versions.findIndex(
    ({ version }) => semverKey(version) === semverKey(manifest.version),
  )
  const priorVersion = moduleEntry.versions[versionIndex]
  if (priorVersion && priorVersion.manifest.sha256 !== manifestHash) {
    throw new Error(
      `Refusing to replace ${manifest.id} ${manifest.version}: catalog hash ${priorVersion.manifest.sha256} differs from published hash ${manifestHash}`,
    )
  }

  const nextVersion = {
    version: manifest.version,
    hostApi: manifest.hostApi,
    platforms: manifest.variants.map(({ platform }) => platform).sort(),
    dataSchemas: sortObject(manifest.dataSchemas),
    manifestUrl,
    manifest: { byteSize: manifestBytes.byteLength, sha256: manifestHash },
  }
  const versions = [...moduleEntry.versions]
  if (versionIndex === -1) versions.push(nextVersion)
  else versions[versionIndex] = nextVersion
  versions.sort(compareVersionsDescending)

  const nextModule = { ...moduleEntry, versions }
  const modules = [...catalog.modules]
  if (moduleIndex === -1) modules.push(nextModule)
  else modules[moduleIndex] = nextModule
  modules.sort((left, right) => left.id.localeCompare(right.id, 'en'))

  const nextCatalog = validateCatalog({ schemaVersion: 1, modules })
  const output = `${JSON.stringify(nextCatalog, null, 2)}\n`
  if (Buffer.byteLength(output) > 1_000_000) {
    throw new Error('Generated catalog exceeds its size limit')
  }
  validateCatalog(JSON.parse(output))
  if (output === currentText) return { changed: false, manifestHash }
  await atomicWrite(catalogPath, output)
  return { changed: true, manifestHash }
}

export function validateCatalog(value) {
  assertBoundedStrings(value)
  const catalog = asObject(value, 'Catalog')
  assertExactKeys(catalog, ['schemaVersion', 'modules'], 'Catalog')
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.modules)) {
    throw new Error('Catalog is invalid')
  }
  if (catalog.modules.length > 100)
    throw new Error('Catalog has too many modules')
  const ids = new Set()
  const modules = catalog.modules.map((rawModule, moduleIndex) => {
    const label = `Catalog module ${moduleIndex}`
    const module = asObject(rawModule, label)
    assertAllowedKeys(module, ['id', 'name', 'description', 'versions'], label)
    if (
      typeof module.id !== 'string' ||
      !MODULE_ID.test(module.id) ||
      (module.name !== undefined && typeof module.name !== 'string') ||
      (module.description !== undefined &&
        typeof module.description !== 'string') ||
      !Array.isArray(module.versions) ||
      module.versions.length === 0 ||
      module.versions.length > 200
    ) {
      throw new Error(`${label} is invalid`)
    }
    if (ids.has(module.id)) throw new Error(`Duplicate module id ${module.id}`)
    ids.add(module.id)
    const versionKeys = new Set()
    const versions = module.versions.map((rawVersion, versionIndex) => {
      const versionLabel = `${label} version ${versionIndex}`
      const entry = asObject(rawVersion, versionLabel)
      assertExactKeys(
        entry,
        [
          'version',
          'hostApi',
          'platforms',
          'dataSchemas',
          'manifestUrl',
          'manifest',
        ],
        versionLabel,
      )
      if (
        typeof entry.version !== 'string' ||
        !SEMVER.test(entry.version) ||
        typeof entry.hostApi !== 'string' ||
        !isHostApiRange(entry.hostApi) ||
        !Array.isArray(entry.platforms) ||
        entry.platforms.length === 0 ||
        entry.platforms.length > 2 ||
        entry.platforms.some(
          (item) => item !== 'desktop' && item !== 'mobile',
        ) ||
        new Set(entry.platforms).size !== entry.platforms.length
      ) {
        throw new Error(`${versionLabel} is invalid`)
      }
      const key = semverKey(entry.version)
      if (versionKeys.has(key)) throw new Error(`${versionLabel} is duplicated`)
      versionKeys.add(key)
      const release = parseOfficialUrl(entry.manifestUrl, 'module.json')
      assertEqual(
        release.tag,
        `${module.id}/v${entry.version}`,
        `${versionLabel} release tag`,
      )
      const manifest = asObject(entry.manifest, `${versionLabel} manifest`)
      assertExactKeys(
        manifest,
        ['byteSize', 'sha256'],
        `${versionLabel} manifest`,
      )
      if (
        !Number.isSafeInteger(manifest.byteSize) ||
        manifest.byteSize <= 0 ||
        manifest.byteSize > MAX_MANIFEST_BYTES ||
        typeof manifest.sha256 !== 'string' ||
        !SHA256.test(manifest.sha256)
      ) {
        throw new Error(`${versionLabel} manifest is invalid`)
      }
      return {
        version: entry.version,
        hostApi: entry.hostApi,
        platforms: [...entry.platforms].sort(),
        dataSchemas: parseDataSchemas(entry.dataSchemas, versionLabel, false),
        manifestUrl: entry.manifestUrl,
        manifest: { byteSize: manifest.byteSize, sha256: manifest.sha256 },
      }
    })
    versions.sort(compareVersionsDescending)
    return {
      id: module.id,
      ...(module.name !== undefined ? { name: module.name } : {}),
      ...(module.description !== undefined
        ? { description: module.description }
        : {}),
      versions,
    }
  })
  modules.sort((left, right) => left.id.localeCompare(right.id, 'en'))
  return { schemaVersion: 1, modules }
}

function parseManifest(value) {
  const manifest = asObject(value, 'Module manifest')
  assertExactKeys(
    manifest,
    ['schemaVersion', 'id', 'version', 'hostApi', 'dataSchemas', 'variants'],
    'Module manifest',
  )
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.id !== 'string' ||
    !MODULE_ID.test(manifest.id) ||
    typeof manifest.version !== 'string' ||
    !SEMVER.test(manifest.version) ||
    typeof manifest.hostApi !== 'string' ||
    !isHostApiRange(manifest.hostApi) ||
    !Array.isArray(manifest.variants) ||
    manifest.variants.length === 0 ||
    manifest.variants.length > 2
  ) {
    throw new Error('Module manifest is invalid')
  }
  const platforms = new Set()
  const variants = manifest.variants.map((rawVariant, index) => {
    const label = `Module variant ${index}`
    const variant = asObject(rawVariant, label)
    assertExactKeys(variant, ['platform', 'entry', 'files'], label)
    if (
      (variant.platform !== 'desktop' && variant.platform !== 'mobile') ||
      platforms.has(variant.platform) ||
      typeof variant.entry !== 'string' ||
      !isSafeRelativePath(variant.entry) ||
      !Array.isArray(variant.files) ||
      variant.files.length === 0 ||
      variant.files.length > 64
    ) {
      throw new Error(`${label} is invalid`)
    }
    platforms.add(variant.platform)
    const paths = new Set()
    const names = new Set()
    const files = variant.files.map((rawFile, fileIndex) => {
      const fileLabel = `${label} file ${fileIndex}`
      const file = asObject(rawFile, fileLabel)
      assertExactKeys(
        file,
        ['role', 'name', 'path', 'byteSize', 'sha256', 'url', 'storage'],
        fileLabel,
      )
      if (
        !FILE_ROLES.has(file.role) ||
        typeof file.name !== 'string' ||
        !isSafeSegment(file.name) ||
        typeof file.path !== 'string' ||
        !isSafeRelativePath(file.path) ||
        !Number.isSafeInteger(file.byteSize) ||
        file.byteSize < 0 ||
        file.byteSize > MAX_FILE_BYTES ||
        typeof file.sha256 !== 'string' ||
        !SHA256.test(file.sha256) ||
        file.storage !== 'module'
      ) {
        throw new Error(`${fileLabel} is invalid`)
      }
      const url = parseOfficialUrl(file.url, file.name)
      const canonicalPath = file.path.toLowerCase()
      const canonicalName = file.name.toLowerCase()
      if (
        canonicalPath === 'module.json' ||
        canonicalPath === 'ready.json' ||
        /^ready\.(?:desktop|mobile)\.[a-f0-9]{64}\.json$/.test(canonicalPath) ||
        paths.has(canonicalPath) ||
        names.has(canonicalName)
      ) {
        throw new Error(`${fileLabel} is duplicated`)
      }
      paths.add(canonicalPath)
      names.add(canonicalName)
      return { ...file, sha256: file.sha256, releaseParent: url.parent }
    })
    const entries = files.filter(({ role }) => role === 'entry')
    if (entries.length !== 1 || entries[0].path !== variant.entry) {
      throw new Error(`${label} must declare its single entry file`)
    }
    return { platform: variant.platform, entry: variant.entry, files }
  })
  return {
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    hostApi: manifest.hostApi,
    dataSchemas: parseDataSchemas(
      manifest.dataSchemas,
      'Module manifest',
      true,
    ),
    variants,
  }
}

function collectFiles(manifest, releaseParent) {
  const byPath = new Map()
  const directories = new Set()
  let total = 0
  for (const variant of manifest.variants) {
    for (const file of variant.files) {
      if (file.releaseParent !== releaseParent) {
        throw new Error(`${file.name} is not in the manifest release`)
      }
      const key = file.path.toLowerCase()
      const prior = byPath.get(key)
      const comparable = { ...file }
      delete comparable.releaseParent
      if (prior && !sameFile(prior, comparable)) {
        throw new Error(`Conflicting artifact path ${file.path}`)
      }
      if (!prior) {
        byPath.set(key, comparable)
        total += file.byteSize
        const parts = key.split('/')
        for (let index = 1; index < parts.length; index += 1) {
          directories.add(parts.slice(0, index).join('/'))
        }
      }
    }
  }
  if (total > MAX_TOTAL_BYTES)
    throw new Error('Artifacts exceed total size limit')
  for (const filePath of byPath.keys()) {
    if (directories.has(filePath)) {
      throw new Error(`Artifact path ${filePath} aliases a directory`)
    }
  }
  return [...byPath.values()]
}

function parseDataSchemas(value, label, allowEmpty) {
  const schemas = asObject(value, `${label} dataSchemas`)
  const entries = Object.entries(schemas)
  if ((!allowEmpty && entries.length === 0) || entries.length > 32) {
    throw new Error(`${label} dataSchemas is invalid`)
  }
  const output = {}
  for (const [namespace, rawSchema] of entries.sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    if (!NAMESPACE.test(namespace) || DANGEROUS_NAMESPACES.has(namespace)) {
      throw new Error(`${label} data schema namespace is invalid`)
    }
    const schema = asObject(rawSchema, `${label} data schema ${namespace}`)
    assertExactKeys(
      schema,
      ['readMin', 'readMax', 'write'],
      `${label} data schema ${namespace}`,
    )
    if (
      !isSchemaVersion(schema.readMin) ||
      !isSchemaVersion(schema.readMax) ||
      !isSchemaVersion(schema.write) ||
      schema.readMin > schema.readMax ||
      schema.write < schema.readMin ||
      schema.write > schema.readMax
    ) {
      throw new Error(`${label} data schema ${namespace} is invalid`)
    }
    output[namespace] = {
      readMin: schema.readMin,
      readMax: schema.readMax,
      write: schema.write,
    }
  }
  return output
}

function sameFile(left, right) {
  return (
    left.role === right.role &&
    left.name === right.name &&
    left.path === right.path &&
    left.byteSize === right.byteSize &&
    left.sha256 === right.sha256 &&
    left.url === right.url &&
    left.storage === right.storage
  )
}

function parseOfficialUrl(value, expectedAsset) {
  if (typeof value !== 'string' || !value.startsWith(RELEASE_ROOT)) {
    throw new Error(`URL must use the official repository: ${value}`)
  }
  const suffix = value.slice(RELEASE_ROOT.length)
  const parts = suffix.split('/')
  if (
    parts.length !== 2 ||
    parts[1] !== expectedAsset ||
    !isSafeSegment(expectedAsset)
  ) {
    throw new Error(`Official release URL is not canonical: ${value}`)
  }
  let tag
  try {
    tag = decodeURIComponent(parts[0])
  } catch {
    throw new Error(`Official release URL has an invalid tag: ${value}`)
  }
  if (!MODULE_ID.test(tag.split('/v')[0] ?? '') || !/^.+\/v.+$/.test(tag)) {
    throw new Error(`Official release URL has an invalid tag: ${value}`)
  }
  const canonicalTag = encodeURIComponent(tag)
  if (parts[0] !== canonicalTag)
    throw new Error(`Official release URL is not canonical: ${value}`)
  return {
    tag,
    parent: `${OFFICIAL_REPOSITORY.toLowerCase()}/${canonicalTag}`,
    urlRoot: `${RELEASE_ROOT}${canonicalTag}`,
  }
}

async function fetchBytes(url, maxBytes, label, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/octet-stream' },
    redirect: 'follow',
  })
  if (!response?.ok)
    throw new Error(
      `Unable to fetch ${label}: HTTP ${response?.status ?? 'unknown'}`,
    )
  const declaredLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} exceeds its size limit`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes)
    throw new Error(`${label} exceeds its size limit`)
  return bytes
}

async function atomicWrite(filePath, contents) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o644)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, filePath)
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`)
  }
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value)
  const unknown = actual.find((key) => !keys.includes(key))
  const missing = keys.find((key) => !actual.includes(key))
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`)
  if (missing) throw new Error(`${label} is missing field ${missing}`)
}

function assertAllowedKeys(value, keys, label) {
  const unknown = Object.keys(value).find((key) => !keys.includes(key))
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`)
}

function assertBoundedStrings(value) {
  const pending = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (Buffer.byteLength(current) > 4096)
        throw new Error('Catalog string exceeds its size limit')
    } else if (Array.isArray(current)) {
      pending.push(...current)
    } else if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current))
        pending.push(key, child)
    }
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected)
    throw new Error(
      `${label} mismatch: expected ${expected}, received ${actual}`,
    )
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isSchemaVersion(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isSafeSegment(value) {
  if (
    !(
      typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) &&
      value.normalize('NFKC') === value &&
      value !== '.' &&
      value !== '..' &&
      !value.endsWith('.')
    )
  )
    return false
  const baseName = value.split('.')[0].toUpperCase()
  return (
    !['CON', 'PRN', 'AUX', 'NUL'].includes(baseName) &&
    !/^(?:COM|LPT)[1-9]$/.test(baseName)
  )
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.normalize('NFKC') !== value)
    return false
  const parts = value.split('/')
  return parts.length <= 17 && parts.every(isSafeSegment)
}

function isHostApiRange(value) {
  if (!value || value.length > 512 || value.trim() !== value) return false
  const alternatives = value.split('||')
  if (alternatives.length > 8) return false
  return alternatives.every((alternative) => {
    const text = alternative.trim()
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
    if (hyphen) return SEMVER.test(hyphen[1]) && SEMVER.test(hyphen[2])
    const tokens = text.split(/\s+/)
    return (
      tokens.length <= 16 &&
      tokens.every(
        (token) =>
          token === '*' ||
          /^[xX]$/.test(token) ||
          (/^[~^](.+)$/.test(token) && SEMVER.test(token.slice(1))) ||
          (/^(0|[1-9]\d*)\.(?:[xX*]|0|[1-9]\d*)(?:\.(?:[xX*]|0|[1-9]\d*))?$/.test(
            token,
          ) &&
            (/[xX*]/.test(token) || token.split('.').length === 2)) ||
          SEMVER.test(token.replace(/^(?:<=|>=|<|>|=)/, '')),
      )
    )
  })
}

function semverParts(value) {
  const match = SEMVER.exec(value)
  if (!match) throw new Error(`Invalid semantic version ${value}`)
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  }
}

function semverKey(value) {
  const parsed = semverParts(value)
  return `${parsed.core.join('.')}-${parsed.prerelease.map((part) => (/^\d+$/.test(part) ? `n${BigInt(part)}` : `s${part}`)).join('.')}`
}

function compareVersionsDescending(left, right) {
  const a = semverParts(left.version)
  const b = semverParts(right.version)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index])
      return a.core[index] > b.core[index] ? -1 : 1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return a.prerelease.length === b.prerelease.length
      ? left.manifestUrl.localeCompare(right.manifestUrl, 'en')
      : a.prerelease.length === 0
        ? -1
        : 1
  for (
    let index = 0;
    index < Math.max(a.prerelease.length, b.prerelease.length);
    index += 1
  ) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return 1
    if (rightPart === undefined) return -1
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? 1 : -1
    if (leftPart !== rightPart) {
      if (leftNumeric) return BigInt(leftPart) > BigInt(rightPart) ? -1 : 1
      return leftPart > rightPart ? -1 : 1
    }
  }
  return left.manifestUrl.localeCompare(right.manifestUrl, 'en')
}

function sortObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right, 'en'),
    ),
  )
}

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      ![
        '--manifest-url',
        '--expected-id',
        '--expected-version',
        '--catalog',
      ].includes(key) ||
      value === undefined
    ) {
      throw new Error(`Invalid option: ${key ?? ''}`)
    }
    options[key.slice(2).replaceAll('-', '_')] = value
  }
  if (
    !options.manifest_url ||
    !options.expected_id ||
    !options.expected_version
  ) {
    throw new Error(
      'Usage: node scripts/update-module-catalog.mjs --manifest-url <url> --expected-id <id> --expected-version <version> [--catalog <path>]',
    )
  }
  if (
    !MODULE_ID.test(options.expected_id) ||
    !SEMVER.test(options.expected_version)
  ) {
    throw new Error('Expected module id or version is invalid')
  }
  return options
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const result = await updateModuleCatalog({
    manifestUrl: options.manifest_url,
    expectedId: options.expected_id,
    expectedVersion: options.expected_version,
    ...(options.catalog ? { catalogPath: path.resolve(options.catalog) } : {}),
  })
  console.log(
    result.changed
      ? `Updated catalog with ${options.expected_id} ${options.expected_version} (${result.manifestHash})`
      : `Catalog already contains ${options.expected_id} ${options.expected_version} (${result.manifestHash})`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main()
}
