import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  RUNTIME_ASSET_TAG,
  copyRuntimeComponentReleaseAssets,
  listRegistryRuntimeAssets,
  listRuntimeComponentReleaseAssets,
  runtimeAssetReleaseName,
} from './runtimeComponentReleaseAssets.mjs'

const BASH_ENTRY_SHA = 'a'.repeat(64)
const EMBEDDING_ENTRY_SHA = 'b'.repeat(64)
const WASM_SHA = 'c'.repeat(64)
const MJS_SHA = 'd'.repeat(64)

function registryFixture() {
  return {
    schemaVersion: 2,
    components: [
      {
        id: 'bash-engine',
        entry: 'runtime-components/bash-engine/dist/entry.js',
        byteSize: 10,
        sha256: BASH_ENTRY_SHA,
      },
      {
        id: 'embedding-engine',
        entry: 'runtime-components/embedding-engine/dist/entry.js',
        byteSize: 15,
        sha256: EMBEDDING_ENTRY_SHA,
        assets: [
          {
            name: 'ort-wasm-simd-threaded.wasm',
            path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
            byteSize: 10,
            sha256: WASM_SHA,
          },
          {
            name: 'ort-wasm-simd-threaded.mjs',
            path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.mjs',
            byteSize: 9,
            sha256: MJS_SHA,
          },
        ],
      },
    ],
  }
}

async function writeRegistryFixture(root) {
  await mkdir(path.join(root, 'runtime-components'), { recursive: true })
  await writeFile(
    path.join(root, 'runtime-components/registry.json'),
    JSON.stringify(registryFixture()),
  )
}

test('every artifact — entry.js included — is named by its own hash', () => {
  const entries = listRegistryRuntimeAssets(registryFixture())

  assert.deepEqual(
    entries.map((entry) => entry.releaseName),
    [
      `${BASH_ENTRY_SHA}-entry.js`,
      `${EMBEDDING_ENTRY_SHA}-entry.js`,
      `${WASM_SHA}-ort-wasm-simd-threaded.wasm`,
      `${MJS_SHA}-ort-wasm-simd-threaded.mjs`,
    ],
  )
})

// Four components all ship a file called `entry.js` into one flat Release
// namespace; only the hash keeps them apart.
test('components sharing a filename never collide', () => {
  const entries = listRegistryRuntimeAssets(registryFixture())
  const entryJs = entries.filter((entry) => entry.name === 'entry.js')

  assert.equal(entryJs.length, 2)
  assert.notEqual(entryJs[0].releaseName, entryJs[1].releaseName)
})

// The upgrade path the whole scheme exists to serve: new bytes append, they
// never replace what an already-shipped version still asks for.
test('changing an artifact yields a new name, leaving the old one addressable', () => {
  const before = listRegistryRuntimeAssets(registryFixture())
  const upgraded = registryFixture()
  upgraded.components[1].assets[0].sha256 = 'e'.repeat(64)
  const after = listRegistryRuntimeAssets(upgraded)

  assert.notEqual(after[2].releaseName, before[2].releaseName)
  assert.equal(after[0].releaseName, before[0].releaseName)
})

test('a malformed hash never reaches a Release name', () => {
  assert.throws(() => runtimeAssetReleaseName('nope', 'entry.js'))
  assert.throws(() => runtimeAssetReleaseName('A'.repeat(64), 'entry.js'))
})

test('listRuntimeComponentReleaseAssets resolves sources against the root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yolo-rc-assets-'))
  await writeRegistryFixture(root)

  const entries = await listRuntimeComponentReleaseAssets(root)

  assert.equal(
    entries[0].sourcePath,
    path.join(root, 'runtime-components/bash-engine/dist/entry.js'),
  )
  assert.equal(
    entries[2].sourcePath,
    path.join(
      root,
      'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
    ),
  )
})

test('copyRuntimeComponentReleaseAssets stages every artifact under its Release name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yolo-rc-assets-'))
  await writeRegistryFixture(root)
  for (const [file, contents] of [
    ['runtime-components/bash-engine/dist/entry.js', 'bash entry'],
    ['runtime-components/embedding-engine/dist/entry.js', 'embedding entry'],
    [
      'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
      'wasm bytes',
    ],
    [
      'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.mjs',
      'mjs bytes',
    ],
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), contents)
  }
  const destDir = path.join(root, 'runtime-assets')

  const entries = await copyRuntimeComponentReleaseAssets(destDir, root)

  assert.equal(entries.length, 4)
  assert.equal(
    await readFile(path.join(destDir, `${BASH_ENTRY_SHA}-entry.js`), 'utf8'),
    'bash entry',
  )
  assert.equal(
    await readFile(
      path.join(destDir, `${EMBEDDING_ENTRY_SHA}-entry.js`),
      'utf8',
    ),
    'embedding entry',
  )
  assert.equal(
    await readFile(
      path.join(destDir, `${WASM_SHA}-ort-wasm-simd-threaded.wasm`),
      'utf8',
    ),
    'wasm bytes',
  )
})

// `runtimeComponentManifest.ts` builds the download URL for the same bytes
// this module uploads, and can't import a `scripts/` module (it is compiled
// into the host bundle), so it repeats the tag and the name format. A drift
// here would be invisible until a real user hit a 404 on the fallback, so
// check it rather than trusting the comment on both sides.
test('matches the Release tag and name format duplicated in runtimeComponentManifest.ts', async () => {
  const source = await readFile(
    new URL(
      '../src/core/runtime-components/runtimeComponentManifest.ts',
      import.meta.url,
    ),
    'utf8',
  )

  assert.match(source, new RegExp(`RUNTIME_ASSET_TAG = '${RUNTIME_ASSET_TAG}'`))
  assert.match(
    source,
    /releases\/download\/\$\{RUNTIME_ASSET_TAG\}\/\$\{sha256\}-\$\{name\}/,
  )
})
