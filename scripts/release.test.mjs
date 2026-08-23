import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  prepareRelease,
  validateModuleConfig,
  validateRuntimeComponentArtifacts,
} from './release.mjs'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Builds a minimal but complete runtime-components tree under `root`: the
 * 3 asset-less components plus `embedding-engine` with one declared asset,
 * mirroring exactly what `npm run runtime:build` produces (registry.json,
 * each component.config.json, each dist/entry.js, and the asset's local
 * source file at the same path `runtimeComponentAssetSources.mjs` maps
 * `embedding-engine` to). Returns the asset bytes so a test can mutate the
 * registry's declared hash without touching the file `resolveRuntimeComponentAssetSource`
 * reads.
 */
async function writeRuntimeComponentFixture(root) {
  const entryBytes = { tokenizer: 't', 'pdf-engine': 'p', 'bash-engine': 'b' }
  const assetBytes = Buffer.from('fixture wasm bytes')
  const components = []
  for (const [id, content] of Object.entries(entryBytes)) {
    const bytes = Buffer.from(content)
    await mkdir(path.join(root, `runtime-components/${id}/dist`), {
      recursive: true,
    })
    await writeFile(
      path.join(root, `runtime-components/${id}/dist/entry.js`),
      bytes,
    )
    await writeFile(
      path.join(root, `runtime-components/${id}/component.config.json`),
      JSON.stringify({
        schemaVersion: 2,
        id,
        platforms: ['desktop', 'mobile'],
        nameKey: 'name',
        descriptionKey: 'description',
        impactKey: 'impact',
        entry: 'dist/entry.js',
      }),
    )
    components.push({
      id,
      platforms: ['desktop', 'mobile'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: `runtime-components/${id}/dist/entry.js`,
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
    })
  }

  const embeddingEntryBytes = Buffer.from('embedding entry')
  await mkdir(
    path.join(root, 'runtime-components/embedding-engine/dist/assets'),
    { recursive: true },
  )
  await writeFile(
    path.join(root, 'runtime-components/embedding-engine/dist/entry.js'),
    embeddingEntryBytes,
  )
  await writeFile(
    path.join(
      root,
      'runtime-components/embedding-engine/component.config.json',
    ),
    JSON.stringify({
      schemaVersion: 2,
      id: 'embedding-engine',
      platforms: ['desktop'],
      nameKey: 'name',
      descriptionKey: 'description',
      impactKey: 'impact',
      entry: 'dist/entry.js',
      assets: ['ort-wasm-simd-threaded.wasm'],
    }),
  )
  // `resolveRuntimeComponentAssetSource('embedding-engine', name)` always
  // resolves to `node_modules/onnxruntime-web/dist/${name}` — the fixture
  // has to place the asset there too, not under dist/assets (a build
  // output the check never reads from).
  await mkdir(path.join(root, 'node_modules/onnxruntime-web/dist'), {
    recursive: true,
  })
  await writeFile(
    path.join(
      root,
      'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    ),
    assetBytes,
  )
  components.push({
    id: 'embedding-engine',
    platforms: ['desktop'],
    nameKey: 'name',
    descriptionKey: 'description',
    impactKey: 'impact',
    entry: 'runtime-components/embedding-engine/dist/entry.js',
    byteSize: embeddingEntryBytes.byteLength,
    sha256: sha256(embeddingEntryBytes),
    assets: [
      {
        name: 'ort-wasm-simd-threaded.wasm',
        path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
        byteSize: assetBytes.byteLength,
        sha256: sha256(assetBytes),
      },
    ],
  })

  await writeFile(
    path.join(root, 'runtime-components/registry.json'),
    JSON.stringify({
      schemaVersion: 2,
      components: components.sort((a, b) => a.id.localeCompare(b.id)),
    }),
  )
  return { assetBytes }
}

test('validateModuleConfig rejects schemas the client cannot parse', () => {
  const config = {
    id: 'learning',
    icon: 'graduation-cap',
    localizations: {
      en: { name: 'Learning', description: 'Learn.' },
    },
    hostApi: '^1.4.0',
    platforms: ['desktop', 'mobile'],
    dataSchemas: {
      settings: { readMin: '0', readMax: 1, write: 1 },
    },
  }
  assert.throws(
    () => validateModuleConfig(config, 'learning'),
    /data schema is invalid/,
  )
})

test('prepareRelease synchronizes Core version sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yolo-release-'))
  await Promise.all([
    writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ version: '1.0.0', minAppVersion: '1.8.0' }),
    ),
    writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ version: '1.0.0' }),
    ),
    writeFile(
      path.join(root, 'versions.json'),
      JSON.stringify({ '1.0.0': '1.8.0' }),
    ),
  ])

  assert.deepEqual(await prepareRelease(root, 'core', '1.0.1'), {
    product: 'core',
    version: '1.0.1',
    tag: '1.0.1',
  })
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'manifest.json'))).version,
    '1.0.1',
  )
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'package.json'))).version,
    '1.0.1',
  )
  assert.equal(
    JSON.parse(await readFile(path.join(root, 'versions.json')))['1.0.1'],
    '1.8.0',
  )
})

test('validateRuntimeComponentArtifacts accepts a complete v2 registry with a synchronized asset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yolo-release-'))
  await writeRuntimeComponentFixture(root)

  await assert.doesNotReject(validateRuntimeComponentArtifacts(root))
})

test('validateRuntimeComponentArtifacts rejects an asset whose declared hash drifted from its local source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yolo-release-'))
  await writeRuntimeComponentFixture(root)

  const registryPath = path.join(root, 'runtime-components/registry.json')
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  const embeddingEngine = registry.components.find(
    (component) => component.id === 'embedding-engine',
  )
  // Simulate someone bumping the onnxruntime-web dependency (so the local
  // node_modules bytes changed) without rerunning `npm run runtime:build`
  // to refresh registry.json's declared hash.
  embeddingEngine.assets[0].sha256 = 'f'.repeat(64)
  await writeFile(registryPath, JSON.stringify(registry))

  await assert.rejects(
    validateRuntimeComponentArtifacts(root),
    /Runtime component asset is not synchronized: embedding-engine\/ort-wasm-simd-threaded\.wasm/,
  )
})

test('validateRuntimeComponentArtifacts rejects a registry missing a known component id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yolo-release-'))
  await writeRuntimeComponentFixture(root)

  const registryPath = path.join(root, 'runtime-components/registry.json')
  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  registry.components = registry.components.filter(
    (component) => component.id !== 'embedding-engine',
  )
  await writeFile(registryPath, JSON.stringify(registry))

  await assert.rejects(
    validateRuntimeComponentArtifacts(root),
    /Runtime component registry is invalid/,
  )
})
