import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  RUNTIME_COMPONENT_ASSET_NAME_PATTERN,
  isValidRuntimeComponentAssetName,
} from './runtimeComponentAssetName.mjs'

test('accepts plain basenames, rejects separators and traversal', () => {
  for (const name of [
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.jsep.mjs',
    'a',
    'a.b_c-d',
  ]) {
    assert.equal(isValidRuntimeComponentAssetName(name), true, name)
  }
  for (const name of [
    '../entry.js',
    '..',
    '.',
    '/etc/passwd',
    'a/b',
    'a\\b',
    '',
    '.hidden',
    '-leading-dash',
    undefined,
    null,
    42,
  ]) {
    assert.equal(isValidRuntimeComponentAssetName(name), false, String(name))
  }
})

// `src/core/runtime-components/runtimeComponentManifest.ts` can't import
// this file (TypeScript compiled into the host bundle vs. a plain Node
// script), so it keeps its own copy of the same pattern. This is a
// consistency check, not a functional one — it fails loudly if the two
// drift instead of silently accepting different asset names on the host
// side than on the build/distribution side.
test('matches the pattern duplicated in runtimeComponentManifest.ts', async () => {
  const source = await readFile(
    new URL(
      '../src/core/runtime-components/runtimeComponentManifest.ts',
      import.meta.url,
    ),
    'utf8',
  )
  assert.match(
    source,
    new RegExp(
      `ASSET_NAME_PATTERN = ${escapeForRegExp(
        RUNTIME_COMPONENT_ASSET_NAME_PATTERN.toString(),
      )}`,
    ),
  )
})

function escapeForRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
