import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  copyRuntimeComponentReleaseAssets,
  listRuntimeComponentReleaseAssets,
} from './runtimeComponentReleaseAssets.mjs'

async function writeRegistryFixture(root) {
  await mkdir(path.join(root, 'runtime-components'), { recursive: true })
  await writeFile(
    path.join(root, 'runtime-components/registry.json'),
    JSON.stringify({
      schemaVersion: 2,
      components: [
        {
          id: 'bash-engine',
          entry: 'runtime-components/bash-engine/dist/entry.js',
          byteSize: 1,
          sha256: 'a'.repeat(64),
        },
        {
          id: 'embedding-engine',
          entry: 'runtime-components/embedding-engine/dist/entry.js',
          byteSize: 1,
          sha256: 'a'.repeat(64),
          assets: [
            {
              name: 'ort-wasm-simd-threaded.wasm',
              path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
              byteSize: 3,
              sha256: 'b'.repeat(64),
            },
            {
              name: 'ort-wasm-simd-threaded.mjs',
              path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.mjs',
              byteSize: 3,
              sha256: 'c'.repeat(64),
            },
          ],
        },
      ],
    }),
  )
}

test('listRuntimeComponentReleaseAssets folds each asset to {componentId}-{name}', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yolo-rc-assets-'))
  await writeRegistryFixture(root)

  const entries = await listRuntimeComponentReleaseAssets(root)

  // bash-engine declares no assets — only embedding-engine's 2 show up.
  assert.deepEqual(
    entries.map((entry) => entry.releaseName),
    [
      'embedding-engine-ort-wasm-simd-threaded.wasm',
      'embedding-engine-ort-wasm-simd-threaded.mjs',
    ],
  )
  assert.equal(
    entries[0].sourcePath,
    path.join(
      root,
      'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
    ),
  )
})

test('copyRuntimeComponentReleaseAssets writes every asset under its flat release name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yolo-rc-assets-'))
  await writeRegistryFixture(root)
  await mkdir(
    path.join(root, 'runtime-components/embedding-engine/dist/assets'),
    { recursive: true },
  )
  await writeFile(
    path.join(
      root,
      'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
    ),
    'wasm bytes',
  )
  await writeFile(
    path.join(
      root,
      'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.mjs',
    ),
    'mjs bytes',
  )
  const destDir = path.join(root, 'core-release')

  const entries = await copyRuntimeComponentReleaseAssets(destDir, root)

  assert.equal(entries.length, 2)
  assert.equal(
    (
      await readFile(
        path.join(destDir, 'embedding-engine-ort-wasm-simd-threaded.wasm'),
        'utf8',
      )
    ).toString(),
    'wasm bytes',
  )
  assert.equal(
    (
      await readFile(
        path.join(destDir, 'embedding-engine-ort-wasm-simd-threaded.mjs'),
        'utf8',
      )
    ).toString(),
    'mjs bytes',
  )
})
