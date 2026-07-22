import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

const repository = 'Lapis0x0/obsidian-yolo'
const hostApi = '^1.4.0'
const dataSchemas = {
  settings: { readMin: 0, readMax: 1, write: 1 },
}
const artifactPlatforms = ['desktop', 'mobile']
const expectedArtifactRoles = new Map([
  ['entry.js', 'entry'],
  ['style.css', 'style'],
])
const artifactDir = path.resolve('modules', 'learning', 'release')
const releaseNoteSource = path.resolve(
  'modules',
  'learning',
  'latest-release-note.md',
)
const learningPackage = await readJson('modules/learning/package.json')
const version = learningPackage.version

if (
  !/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(
    learningPackage.yoloModule.previewVersion,
  )
) {
  throw new Error('Learning preview version must be a prerelease semver')
}
assertEqual(
  learningPackage.yoloModule.previewTag,
  `module-learning-v${learningPackage.yoloModule.previewVersion}`,
  'Learning preview tag',
)
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(
    `Learning package version must be X.Y.Z, received: ${version}`,
  )
}
assertEqual(
  learningPackage.yoloModule.releaseTagPrefix,
  'learning/v',
  'Learning release tag prefix',
)

const expectedTag = `learning/v${version}`
const tag = process.env.LEARNING_RELEASE_TAG || expectedTag
if (tag !== expectedTag) {
  throw new Error(
    `Learning release tag ${JSON.stringify(tag)} does not match package version; expected ${expectedTag}`,
  )
}
const encodedTag = encodeURIComponent(tag)
assertEqual(
  encodedTag,
  `learning%2Fv${version}`,
  'canonical encoded Learning tag',
)

const args = process.argv.slice(2)
const allowedArgs = new Set([
  '--build',
  '--materialize-version',
  '--verify-versioned',
])
if (args.some((arg) => !allowedArgs.has(arg))) {
  throw new Error(
    `Unknown option: ${args.find((arg) => !allowedArgs.has(arg))}`,
  )
}
if (args.includes('--materialize-version') && !args.includes('--build')) {
  throw new Error('--materialize-version requires --build')
}
if (args.includes('--build')) {
  const build = spawnSync(
    process.execPath,
    [
      'scripts/build-first-party-modules.mjs',
      '--module',
      'learning',
      '--output-dir',
      artifactDir,
      '--release-tag',
      tag,
    ],
    { stdio: 'inherit' },
  )
  if (build.status !== 0) {
    throw new Error(`Learning release build failed with status ${build.status}`)
  }
  await copyFile(releaseNoteSource, path.join(artifactDir, 'release-note.md'))
}

const releaseNoteBytes = await readFile(
  path.join(artifactDir, 'release-note.md'),
)
validateReleaseNote(releaseNoteBytes, version)

const manifestPath = path.join(artifactDir, 'module.json')
const manifestBytes = await readFile(manifestPath)
const manifest = JSON.parse(manifestBytes.toString('utf8'))
assertKeys(
  manifest,
  ['schemaVersion', 'id', 'version', 'hostApi', 'dataSchemas', 'variants'],
  'manifest',
)
assertEqual(manifest.schemaVersion, 1, 'manifest schemaVersion')
assertEqual(manifest.id, 'learning', 'manifest id')
assertEqual(manifest.version, version, 'manifest version')
assertEqual(manifest.hostApi, hostApi, 'manifest hostApi')
assertJsonEqual(manifest.dataSchemas, dataSchemas, 'manifest dataSchemas')
assertArray(manifest.variants, 'manifest variants')
assertEqual(manifest.variants.length, artifactPlatforms.length, 'variant count')

const expectedFiles = new Set(['module.json', 'release-note.md'])
const canonicalFiles = new Map()
const releaseRoot = `https://github.com/${repository}/releases/download/${encodedTag}`
for (const [variantIndex, variant] of manifest.variants.entries()) {
  const platform = artifactPlatforms[variantIndex]
  assertKeys(variant, ['platform', 'entry', 'files'], `${platform} variant`)
  assertEqual(variant.platform, platform, `${platform} platform`)
  assertEqual(variant.entry, 'entry.js', `${platform} entry`)
  assertArray(variant.files, `${platform} files`)
  assertEqual(
    variant.files.length,
    expectedArtifactRoles.size,
    `${platform} file count`,
  )

  const names = new Set()
  const paths = new Set()
  for (const file of variant.files) {
    assertKeys(
      file,
      ['role', 'name', 'path', 'byteSize', 'sha256', 'url', 'storage'],
      `${platform} artifact`,
    )
    if (names.has(file.name)) {
      throw new Error(
        `${platform} contains duplicate artifact name: ${file.name}`,
      )
    }
    if (paths.has(file.path)) {
      throw new Error(
        `${platform} contains duplicate artifact path: ${file.path}`,
      )
    }
    names.add(file.name)
    paths.add(file.path)

    const expectedRole = expectedArtifactRoles.get(file.name)
    if (!expectedRole) {
      throw new Error(`${platform} contains unexpected artifact: ${file.name}`)
    }
    assertEqual(file.path, file.name, `${platform} ${file.name} path`)
    assertEqual(file.role, expectedRole, `${platform} ${file.name} role`)
    assertEqual(file.storage, 'module', `${platform} ${file.name} storage`)
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize <= 0) {
      throw new Error(`${platform} ${file.name} has invalid byteSize`)
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`${platform} ${file.name} has invalid sha256`)
    }
    assertEqual(
      file.url,
      `${releaseRoot}/${file.name}`,
      `${platform} ${file.name} canonical encoded URL`,
    )

    expectedFiles.add(file.path)
    const bytes = await readFile(path.join(artifactDir, file.path))
    assertEqual(file.byteSize, bytes.byteLength, `${file.path} byteSize`)
    assertEqual(file.sha256, sha256(bytes), `${file.path} sha256`)

    const priorDefinition = canonicalFiles.get(file.name)
    if (priorDefinition) {
      assertJsonEqual(
        file,
        priorDefinition,
        `${file.name} cross-platform metadata`,
      )
    } else {
      canonicalFiles.set(file.name, file)
    }
  }
  assertJsonEqual(
    [...names].sort(),
    [...expectedArtifactRoles.keys()].sort(),
    `${platform} artifact names`,
  )
  assertEqual(
    variant.files.filter(({ role }) => role === 'entry').length,
    1,
    `${platform} entry role count`,
  )
}

const directoryEntries = await readdir(artifactDir, { withFileTypes: true })
for (const entry of directoryEntries) {
  if (!entry.isFile()) {
    throw new Error(`Release output contains non-file entry: ${entry.name}`)
  }
}
assertJsonEqual(
  directoryEntries.map(({ name }) => name).sort(),
  [...expectedFiles].sort(),
  'release asset closure',
)

const versionedArtifactDir = path.resolve('modules', 'learning', version)
const versionedFiles = [...expectedFiles]
  .filter((name) => name !== 'release-note.md')
  .sort()
if (args.includes('--materialize-version')) {
  const catalog = await readJson('modules/catalog-v1.json')
  const alreadyPublished = catalog.modules?.some(
    (module) =>
      module.id === 'learning' &&
      module.versions?.some((entry) => entry.version === version),
  )
  if (alreadyPublished) {
    throw new Error(`Learning ${version} is already published in the catalog`)
  }
  await rm(versionedArtifactDir, { recursive: true, force: true })
  await mkdir(versionedArtifactDir, { recursive: true })
  await Promise.all(
    versionedFiles.map((name) =>
      copyFile(
        path.join(artifactDir, name),
        path.join(versionedArtifactDir, name),
      ),
    ),
  )
}
if (
  args.includes('--materialize-version') ||
  args.includes('--verify-versioned')
) {
  await verifyVersionedArtifacts(
    artifactDir,
    versionedArtifactDir,
    versionedFiles,
  )
}

console.log(`Validated Learning ${version} release assets for ${tag}`)
console.log(
  `Core parity target: ${releaseRoot}/<asset>; the release workflow exercises generated URLs against the shared Core parser.`,
)

async function verifyVersionedArtifacts(releaseDir, versionDir, files) {
  const entries = await readdir(versionDir, { withFileTypes: true })
  if (
    entries.some((entry) => !entry.isFile()) ||
    JSON.stringify(entries.map(({ name }) => name).sort()) !==
      JSON.stringify(files)
  ) {
    throw new Error(
      `Learning ${version} versioned artifact closure does not match the release`,
    )
  }
  for (const name of files) {
    const [releaseBytes, versionedBytes] = await Promise.all([
      readFile(path.join(releaseDir, name)),
      readFile(path.join(versionDir, name)),
    ])
    if (!releaseBytes.equals(versionedBytes)) {
      throw new Error(
        `Learning ${version} versioned artifact ${name} differs from the release`,
      )
    }
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function validateReleaseNote(bytes, expectedVersion) {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    throw new Error('Learning release note has invalid byte size')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const parts = text.split(/^---$/m)
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    throw new Error(
      'Learning release note must contain English and Chinese blocks',
    )
  }
  for (const [index, part] of parts.entries()) {
    const heading = part.match(/^##\s+(\d+\.\d+\.\d+)\b/m)
    if (heading?.[1] !== expectedVersion) {
      throw new Error(
        `Learning release note ${index === 0 ? 'English' : 'Chinese'} version must be ${expectedVersion}`,
      )
    }
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
}

function assertKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  assertJsonEqual(
    Object.keys(value).sort(),
    [...expectedKeys].sort(),
    `${label} keys`,
  )
}

function assertJsonEqual(actual, expected, label) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), label)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    )
  }
}
