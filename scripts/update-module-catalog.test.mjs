import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { updateModuleCatalog } from './update-module-catalog.mjs'

const root =
  'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.1.0'
const localizations = Object.fromEntries(
  ['en', 'zh', 'it'].map((locale) => [
    locale,
    { name: 'Learning', description: 'Learning description' },
  ]),
)
const catalogModule = (versions = []) => ({
  id: 'learning',
  icon: 'graduation-cap',
  localizations,
  versions,
})

test('preserves schema declarations from a real Learning build', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'learning-build-'))
  const catalogPath = path.join(directory, 'catalog.json')
  const artifactDir = path.join(directory, 'artifact')
  try {
    const build = spawnSync(
      process.execPath,
      [
        'scripts/build-first-party-modules.mjs',
        '--module',
        'learning',
        '--output-dir',
        artifactDir,
        '--release-tag',
        'learning/v0.1.0',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(build.status, 0, build.stderr || build.stdout)
    await writeFile(
      catalogPath,
      JSON.stringify({ schemaVersion: 1, modules: [catalogModule()] }),
    )
    const assets = new Map(
      await Promise.all(
        (await readdir(artifactDir)).map(async (name) => [
          `${root}/${name}`,
          await readFile(path.join(artifactDir, name)),
        ]),
      ),
    )
    assets.set(
      `${root}/release-note.md`,
      await readFile('modules/learning/latest-release-note.md'),
    )

    await updateModuleCatalog({
      catalogPath,
      manifestUrl: `${root}/module.json`,
      expectedId: 'learning',
      expectedVersion: '0.1.0',
      fetchImpl: async (url) => {
        const bytes = assets.get(url)
        return {
          ok: Boolean(bytes),
          status: bytes ? 200 : 404,
          headers: { get: () => (bytes ? String(bytes.byteLength) : null) },
          arrayBuffer: async () => bytes ?? Buffer.alloc(0),
        }
      },
    })

    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
    const builtManifest = JSON.parse(
      await readFile(path.join(artifactDir, 'module.json'), 'utf8'),
    )
    assert.equal(catalog.modules[0].icon, 'graduation-cap')
    assert.equal(catalog.modules[0].versions[0].hostApi, '^1.4.0')
    assert.deepEqual(
      catalog.modules[0].versions[0].dataSchemas,
      builtManifest.dataSchemas,
    )
    assert.equal(
      catalog.modules[0].versions[0].releaseNotes.url,
      `${root}/release-note.md`,
    )
    assert.deepEqual(builtManifest.dataSchemas, {
      settings: { readMin: 0, readMax: 1, write: 1 },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('verifies the complete remote release and deterministically preserves versions', async () => {
  const fixture = releaseFixture()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'module-catalog-'))
  const catalogPath = path.join(directory, 'catalog.json')
  await writeFile(
    catalogPath,
    `${JSON.stringify({ schemaVersion: 1, modules: [catalogModule([oldVersion()])] }, null, 2)}\n`,
  )
  try {
    const first = await updateModuleCatalog({
      catalogPath,
      manifestUrl: `${root}/module.json`,
      expectedId: 'learning',
      expectedVersion: '0.1.0',
      fetchImpl: fixture.fetch,
    })
    assert.equal(first.changed, true)
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
    assert.equal(catalog.modules[0].localizations.en.name, 'Learning')
    assert.deepEqual(
      catalog.modules[0].versions.map(({ version }) => version),
      ['0.1.0', '0.0.9'],
    )
    assert.equal(
      catalog.modules[0].versions[0].manifest.sha256,
      fixture.manifestHash,
    )
    assert.deepEqual(new Set(fixture.requests), new Set(fixture.assets.keys()))

    const second = await updateModuleCatalog({
      catalogPath,
      manifestUrl: `${root}/module.json`,
      expectedId: 'learning',
      expectedVersion: '0.1.0',
      fetchImpl: fixture.fetch,
    })
    assert.equal(second.changed, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('refuses to replace an existing equivalent version with a different hash', async () => {
  const fixture = releaseFixture()
  const directory = await mkdtemp(path.join(os.tmpdir(), 'module-catalog-'))
  const catalogPath = path.join(directory, 'catalog.json')
  const conflicting = {
    ...oldVersion(),
    version: '0.1.0',
    manifestUrl: `${root}/module.json`,
  }
  await writeFile(
    catalogPath,
    JSON.stringify({
      schemaVersion: 1,
      modules: [catalogModule([conflicting])],
    }),
  )
  try {
    await assert.rejects(
      updateModuleCatalog({
        catalogPath,
        manifestUrl: `${root}/module.json`,
        expectedId: 'learning',
        expectedVersion: '0.1.0',
        fetchImpl: fixture.fetch,
      }),
      /Refusing to replace/,
    )
    assert.equal(
      JSON.parse(await readFile(catalogPath, 'utf8')).modules[0].versions[0]
        .manifest.sha256,
      '0'.repeat(64),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('does not write when any published artifact is unavailable or corrupt', async () => {
  for (const mode of ['missing-file', 'corrupt-file']) {
    const fixture = releaseFixture(mode)
    const directory = await mkdtemp(path.join(os.tmpdir(), 'module-catalog-'))
    const catalogPath = path.join(directory, 'catalog.json')
    const original = '{"schemaVersion":1,"modules":[]}'
    await writeFile(catalogPath, original)
    try {
      await assert.rejects(
        updateModuleCatalog({
          catalogPath,
          manifestUrl: `${root}/module.json`,
          expectedId: 'learning',
          expectedVersion: '0.1.0',
          fetchImpl: fixture.fetch,
        }),
      )
      assert.equal(await readFile(catalogPath, 'utf8'), original)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('rejects non-official URLs and manifest identity mismatches', async () => {
  const fixture = releaseFixture()
  await assert.rejects(
    updateModuleCatalog({
      catalogPath: 'unused',
      manifestUrl: 'https://example.com/module.json',
      expectedId: 'learning',
      expectedVersion: '0.1.0',
      fetchImpl: fixture.fetch,
    }),
    /official repository/,
  )
  await assert.rejects(
    updateModuleCatalog({
      catalogPath: 'unused',
      manifestUrl: `${root}/module.json`,
      expectedId: 'other',
      expectedVersion: '0.1.0',
      fetchImpl: fixture.fetch,
    }),
    /module id mismatch/,
  )
})

test('refuses manifests that cannot satisfy the Core catalog schema', async () => {
  const fixture = releaseFixture()
  const manifest = JSON.parse(
    fixture.assets.get(`${root}/module.json`).toString('utf8'),
  )
  manifest.dataSchemas = {}
  fixture.replaceManifest(manifest)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'module-catalog-'))
  const catalogPath = path.join(directory, 'catalog.json')
  await writeFile(
    catalogPath,
    JSON.stringify({ schemaVersion: 1, modules: [catalogModule()] }),
  )
  try {
    await assert.rejects(
      updateModuleCatalog({
        catalogPath,
        manifestUrl: `${root}/module.json`,
        expectedId: 'learning',
        expectedVersion: '0.1.0',
        fetchImpl: fixture.fetch,
      }),
      /dataSchemas is invalid/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function releaseFixture(mode) {
  const fileBytes = Buffer.from('module code')
  const fileHash = hash(fileBytes)
  const manifest = {
    schemaVersion: 1,
    id: 'learning',
    version: '0.1.0',
    hostApi: '^1.0.0',
    dataSchemas: { learning: { readMin: 0, readMax: 1, write: 1 } },
    variants: ['desktop', 'mobile'].map((platform) => ({
      platform,
      entry: 'entry.js',
      files: [
        {
          role: 'entry',
          name: 'entry.js',
          path: 'entry.js',
          byteSize: fileBytes.byteLength,
          sha256: fileHash,
          url: `${root}/entry.js`,
          storage: 'module',
        },
      ],
    })),
  }
  const assets = new Map()
  const releaseNote = Buffer.from(
    '## 0.1.0 Learning update\n\n- Update\n\n---\n\n## 0.1.0 学习模式更新\n\n- 更新\n',
  )
  assets.set(`${root}/release-note.md`, releaseNote)
  if (mode !== 'missing-file') {
    assets.set(
      `${root}/entry.js`,
      mode === 'corrupt-file' ? Buffer.from('bad') : fileBytes,
    )
  }
  let manifestHash
  const replaceManifest = (value) => {
    const manifestBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
    manifestHash = hash(manifestBytes)
    assets.set(`${root}/module.json`, manifestBytes)
  }
  replaceManifest(manifest)
  const requests = []
  return {
    assets,
    get manifestHash() {
      return manifestHash
    },
    replaceManifest,
    requests,
    fetch: async (url) => {
      requests.push(url)
      const bytes = assets.get(url)
      return {
        ok: Boolean(bytes),
        status: bytes ? 200 : 404,
        headers: { get: () => (bytes ? String(bytes.byteLength) : null) },
        arrayBuffer: async () => bytes ?? Buffer.alloc(0),
      }
    },
  }
}

function oldVersion() {
  return {
    version: '0.0.9',
    hostApi: '^1.0.0',
    platforms: ['desktop'],
    dataSchemas: { learning: { readMin: 0, readMax: 1, write: 1 } },
    manifestUrl:
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.0.9/module.json',
    manifest: { byteSize: 10, sha256: '0'.repeat(64) },
  }
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
