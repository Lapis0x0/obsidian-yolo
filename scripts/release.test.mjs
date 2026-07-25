import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareRelease, validateModuleConfig } from './release.mjs'

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
