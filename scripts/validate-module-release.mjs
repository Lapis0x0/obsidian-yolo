import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const repository = 'Lapis0x0/obsidian-yolo'
const args = parseArgs(process.argv.slice(2))
const id = args.module
const moduleDir = path.resolve('modules', id)
const artifactDir = path.resolve(
  args['output-dir'] ?? path.join(moduleDir, 'release'),
)
const [packageJson, config] = await Promise.all([
  readJson(path.join(moduleDir, 'package.json')),
  readJson(path.join(moduleDir, 'module.config.json')),
])
const version = packageJson.version
if (config.id !== id) throw new Error(`Module config id must be ${id}`)
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Module package version must be stable X.Y.Z: ${id}`)
}
const expectedTag = `${id}/v${version}`
const tag = process.env.MODULE_RELEASE_TAG || expectedTag
if (tag !== expectedTag) {
  throw new Error(`Module release tag must be ${expectedTag}, received ${tag}`)
}
if (args.build) {
  const build = spawnSync(
    process.execPath,
    [
      'scripts/build-first-party-modules.mjs',
      '--module',
      id,
      '--output-dir',
      artifactDir,
      '--release-tag',
      tag,
    ],
    { stdio: 'inherit' },
  )
  if (build.status !== 0) throw new Error(`${id} release build failed`)
  await Promise.all([
    copyFile(
      path.join(moduleDir, 'latest-release-note.md'),
      path.join(artifactDir, 'release-note.md'),
    ),
    copyFile(
      path.join(moduleDir, 'module.config.json'),
      path.join(artifactDir, 'module-config.json'),
    ),
  ])
}

const [manifestBytes, noteBytes, releasedConfigBytes] = await Promise.all([
  readFile(path.join(artifactDir, 'module.json')),
  readFile(path.join(artifactDir, 'release-note.md')),
  readFile(path.join(artifactDir, 'module-config.json')),
])
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const releasedConfig = JSON.parse(releasedConfigBytes.toString('utf8'))
if (
  manifest.schemaVersion !== 1 ||
  manifest.id !== id ||
  manifest.version !== version ||
  manifest.hostApi !== config.hostApi ||
  JSON.stringify(manifest.dataSchemas) !== JSON.stringify(config.dataSchemas) ||
  JSON.stringify(releasedConfig) !== JSON.stringify(config) ||
  !Array.isArray(manifest.variants) ||
  manifest.variants.length !== config.platforms.length
) {
  throw new Error(`${id} release metadata is inconsistent`)
}
validateReleaseNote(noteBytes, version)

const expectedNames = new Set([
  'module.json',
  'module-config.json',
  'release-note.md',
])
const canonicalFiles = new Map()
const releaseRoot = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`
for (const variant of manifest.variants) {
  if (
    !config.platforms.includes(variant.platform) ||
    !Array.isArray(variant.files)
  ) {
    throw new Error(`${id} manifest platform is invalid`)
  }
  const entries = variant.files.filter((file) => file.role === 'entry')
  if (entries.length !== 1 || variant.entry !== entries[0].path) {
    throw new Error(`${id} manifest entry is invalid`)
  }
  for (const file of variant.files) {
    if (
      !file ||
      typeof file.name !== 'string' ||
      file.path !== file.name ||
      !Number.isSafeInteger(file.byteSize) ||
      file.byteSize <= 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      file.url !== `${releaseRoot}/${encodeURIComponent(file.name)}` ||
      file.storage !== 'module'
    ) {
      throw new Error(`${id} manifest file is invalid`)
    }
    const previous = canonicalFiles.get(file.path)
    if (previous && JSON.stringify(previous) !== JSON.stringify(file)) {
      throw new Error(`${id} manifest file differs across platforms`)
    }
    canonicalFiles.set(file.path, file)
    expectedNames.add(file.path)
  }
}
for (const [filePath, descriptor] of canonicalFiles) {
  const bytes = await readFile(path.join(artifactDir, filePath))
  if (
    bytes.byteLength !== descriptor.byteSize ||
    sha256(bytes) !== descriptor.sha256
  ) {
    throw new Error(`${id} artifact integrity mismatch: ${filePath}`)
  }
}
const directoryEntries = await readdir(artifactDir, { withFileTypes: true })
if (
  directoryEntries.some((entry) => !entry.isFile()) ||
  JSON.stringify(directoryEntries.map((entry) => entry.name).sort()) !==
    JSON.stringify([...expectedNames].sort())
) {
  throw new Error(`${id} release asset closure is invalid`)
}
console.log(`Validated ${id} ${version} release assets for ${tag}`)

function parseArgs(values) {
  const parsed = Object.create(null)
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index]
    if (option === '--build') {
      parsed.build = true
      continue
    }
    if (option !== '--module' && option !== '--output-dir') {
      throw new Error(`Unknown option: ${option}`)
    }
    const value = values[index + 1]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${option}`)
    parsed[option.slice(2)] = value
    index += 1
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(parsed.module ?? '')) {
    throw new Error('--module is required')
  }
  return parsed
}

function validateReleaseNote(bytes, version) {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    throw new Error('Module release note has invalid byte size')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const blocks = text.split(/^\s*---\s*$/m)
  if (blocks.length !== 2 || blocks.some((block) => !block.trim())) {
    throw new Error('Module release note must contain two language blocks')
  }
  if (
    blocks.some(
      (block) => block.match(/^##\s+(\d+\.\d+\.\d+)\b/m)?.[1] !== version,
    )
  ) {
    throw new Error(`Module release note headings must use ${version}`)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}
