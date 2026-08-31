import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  assertNewReleaseVersion,
  buildDesiredSnapshot,
  describeRuntimeComponentArtifacts,
} from './distribution.mjs'

test('requires every product release to advance its published version', () => {
  const releases = [
    { tag_name: '1.7.0', draft: false, prerelease: false },
    { tag_name: '1.8.0', draft: true, prerelease: false },
    { tag_name: 'learning/v0.2.0', draft: false, prerelease: false },
  ]
  assert.doesNotThrow(() => assertNewReleaseVersion(releases, '1.7.0.1'))
  assert.doesNotThrow(() =>
    assertNewReleaseVersion(releases, 'learning/v0.2.1'),
  )
  assert.throws(
    () => assertNewReleaseVersion(releases, '1.6.9'),
    /newer than published 1\.7\.0/,
  )
  assert.throws(
    () => assertNewReleaseVersion(releases, 'learning/v0.2.0'),
    /newer than published learning\/v0\.2\.0/,
  )
})

test('rebuilds the complete current snapshot from published Releases', async () => {
  const bytes = new Map()
  const asset = (tag, name, value) => {
    const url = `https://download.test/${encodeURIComponent(tag)}/${name}`
    bytes.set(url, Buffer.from(value))
    return { name, browser_download_url: url }
  }
  const note =
    '## VERSION Update\n\n- Change\n\n---\n\n## VERSION 更新\n\n- 变化\n'
  const coreManifest = `${JSON.stringify({
    version: '1.7.0',
    minAppVersion: '1.8.0',
  })}\n`
  const moduleManifest = `${JSON.stringify({
    schemaVersion: 1,
    id: 'learning',
    version: '0.2.0',
    hostApi: '^1.4.0',
    dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } },
    variants: [
      { platform: 'desktop', entry: 'entry.js', files: [] },
      { platform: 'mobile', entry: 'entry.js', files: [] },
    ],
  })}\n`
  const releasedConfig = `${JSON.stringify({
    id: 'learning',
    icon: 'book-open',
    localizations: {
      en: { name: 'Released Learning', description: 'Released metadata.' },
      zh: { name: '已发布学习', description: '已发布元数据。' },
      it: { name: 'Apprendimento', description: 'Metadati pubblicati.' },
    },
    hostApi: '^1.4.0',
    platforms: ['desktop', 'mobile'],
    dataSchemas: { settings: { readMin: 0, readMax: 1, write: 1 } },
  })}\n`
  const releases = [
    {
      id: 1,
      tag_name: '1.7.0',
      draft: false,
      prerelease: false,
      html_url: 'https://github.com/Lapis0x0/obsidian-yolo/releases/tag/1.7.0',
      body: note.replaceAll('VERSION', '1.7.0'),
      assets: [
        asset('1.7.0', 'main.js', 'main'),
        asset('1.7.0', 'manifest.json', coreManifest),
        asset('1.7.0', 'styles.css', 'style'),
      ],
    },
    {
      id: 2,
      tag_name: 'learning/v0.2.0',
      draft: false,
      prerelease: false,
      html_url:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/tag/learning/v0.2.0',
      assets: [
        asset('learning/v0.2.0', 'module.json', moduleManifest),
        asset('learning/v0.2.0', 'module-config.json', releasedConfig),
        asset(
          'learning/v0.2.0',
          'release-note.md',
          note.replaceAll('VERSION', '0.2.0'),
        ),
      ],
    },
  ]
  const fetchImpl = async (url) => {
    const body = bytes.get(url)
    return body ? new Response(body) : new Response('missing', { status: 404 })
  }
  const snapshot = await buildDesiredSnapshot({
    repository: 'Lapis0x0/obsidian-yolo',
    token: 'test',
    fetchImpl,
    releases,
    configs: [
      {
        id: 'learning',
        icon: 'graduation-cap',
        localizations: {
          en: { name: 'Learning', description: 'Learn.' },
          zh: { name: '学习', description: '学习。' },
          it: { name: 'Apprendimento', description: 'Impara.' },
        },
      },
    ],
    current: null,
  })
  assert.equal(snapshot.core.version, '1.7.0')
  assert.equal(snapshot.modules[0].version, '0.2.0')
  assert.equal(snapshot.modules[0].icon, 'book-open')
  assert.equal(snapshot.modules[0].localizations.en.name, 'Released Learning')
  assert.equal(
    snapshot.modules[0].manifest.mirrorPath,
    'modules/learning/0.2.0/module.json',
  )
})

test('takes the artifact set from the selected Core tag, the bytes from the store', async () => {
  // The tag still decides *which* artifacts a Core version shipped — that is
  // what its committed registry.json records. Only the bytes moved: they come
  // from the version-independent `runtime-assets` store, so reconcile running
  // on main can mirror any released version correctly.
  const version = '1.7.0'
  const repository = 'Lapis0x0/obsidian-yolo'
  const bytes = Buffer.from('runtime entry')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const registry = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      components: [
        {
          id: 'tokenizer',
          entry: 'runtime-components/tokenizer/dist/entry.js',
          byteSize: bytes.byteLength,
          sha256,
        },
      ],
    }),
  )
  const fetchImpl = runtimeAssetFetch(repository, version, registry, {
    [`${sha256}-entry.js`]: bytes,
  })

  const [artifact] = await describeRuntimeComponentArtifacts({
    repository,
    version,
    fetchImpl,
  })

  assert.equal(
    artifact.mirrorPath,
    `runtime-components/sha256/${sha256}/entry.js`,
  )
  assert.equal(artifact.sha256, sha256)
  assert.deepEqual(artifact.bytes, bytes)
})

test('rejects a runtime component that differs from its tagged registry', async () => {
  const version = '1.7.0'
  const repository = 'Lapis0x0/obsidian-yolo'
  const root = `https://raw.githubusercontent.com/${repository}/${version}/runtime-components`
  const registry = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      components: [
        {
          id: 'tokenizer',
          entry: 'runtime-components/tokenizer/dist/entry.js',
          byteSize: 3,
          sha256: createHash('sha256').update('abc').digest('hex'),
        },
      ],
    }),
  )
  const fetchImpl = async (url) =>
    new Response(url === `${root}/registry.json` ? registry : 'xyz')

  await assert.rejects(
    describeRuntimeComponentArtifacts({ repository, version, fetchImpl }),
    /integrity mismatch/,
  )
})

/**
 * Serves the tagged `registry.json` over Git Raw and every artifact out of
 * the permanent `runtime-assets` Release, keyed by its content-addressed
 * attachment name — the two places `describeRuntimeComponentArtifacts` now
 * reads from.
 */
function runtimeAssetFetch(repository, version, registry, attachments) {
  const registryUrl = `https://raw.githubusercontent.com/${repository}/${version}/runtime-components/registry.json`
  const releaseRoot = `https://github.com/${repository}/releases/download/runtime-assets/`
  return async (url) => {
    if (url === registryUrl) return new Response(registry)
    if (url.startsWith(releaseRoot)) {
      const body =
        attachments[decodeURIComponent(url.slice(releaseRoot.length))]
      if (body) return new Response(body)
    }
    return new Response('missing', { status: 404 })
  }
}

test('reads a historical schema-v1 registry with no assets field at all', async () => {
  // A pre-P0 release only ever wrote schema v1 — no `assets` key on any
  // component. `describeRuntimeComponentArtifacts` reads whichever Core
  // version is requested (not necessarily the current one), so it must
  // keep working against these old tags going forward.
  const version = '1.6.0'
  const repository = 'Lapis0x0/obsidian-yolo'
  const bytes = Buffer.from('old entry')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const registry = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      components: [
        {
          id: 'tokenizer',
          entry: 'runtime-components/tokenizer/dist/entry.js',
          byteSize: bytes.byteLength,
          sha256,
        },
      ],
    }),
  )
  const fetchImpl = runtimeAssetFetch(repository, version, registry, {
    [`${sha256}-entry.js`]: bytes,
  })

  const artifacts = await describeRuntimeComponentArtifacts({
    repository,
    version,
    fetchImpl,
  })

  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].name, 'entry.js')
})

test('mirrors a schema-v2 registry component together with its declared assets', async () => {
  const version = '1.8.0'
  const repository = 'Lapis0x0/obsidian-yolo'
  const entryBytes = Buffer.from('embedding entry')
  const entrySha256 = createHash('sha256').update(entryBytes).digest('hex')
  const assetBytes = Buffer.from('wasm glue')
  const assetSha256 = createHash('sha256').update(assetBytes).digest('hex')
  const registry = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      components: [
        {
          id: 'embedding-engine',
          entry: 'runtime-components/embedding-engine/dist/entry.js',
          byteSize: entryBytes.byteLength,
          sha256: entrySha256,
          assets: [
            {
              name: 'ort-wasm-simd-threaded.mjs',
              path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.mjs',
              byteSize: assetBytes.byteLength,
              sha256: assetSha256,
            },
          ],
        },
      ],
    }),
  )
  const fetchImpl = runtimeAssetFetch(repository, version, registry, {
    [`${entrySha256}-entry.js`]: entryBytes,
    [`${assetSha256}-ort-wasm-simd-threaded.mjs`]: assetBytes,
  })

  const artifacts = await describeRuntimeComponentArtifacts({
    repository,
    version,
    fetchImpl,
  })

  // An asset is no longer a special case: entry.js and assets are fetched
  // from the same content-addressed store and mirrored under the same shape.
  assert.equal(artifacts.length, 2)
  assert.equal(artifacts[0].name, 'entry.js')
  assert.equal(
    artifacts[0].mirrorPath,
    `runtime-components/sha256/${entrySha256}/entry.js`,
  )
  assert.equal(
    artifacts[0].canonicalUrl,
    `https://github.com/${repository}/releases/download/runtime-assets/${entrySha256}-entry.js`,
  )
  assert.equal(artifacts[1].name, 'ort-wasm-simd-threaded.mjs')
  assert.equal(
    artifacts[1].mirrorPath,
    `runtime-components/sha256/${assetSha256}/ort-wasm-simd-threaded.mjs`,
  )
  assert.equal(
    artifacts[1].canonicalUrl,
    `https://github.com/${repository}/releases/download/runtime-assets/${assetSha256}-ort-wasm-simd-threaded.mjs`,
  )
  assert.deepEqual(artifacts[1].bytes, assetBytes)
})

test('rejects an asset whose published bytes do not match its declared hash', async () => {
  // The registry pins a hash the store does not actually hold — a stand-in
  // for a wrong or tampered attachment. Nothing may be mirrored on the
  // strength of the URL alone.
  const version = '1.8.0'
  const repository = 'Lapis0x0/obsidian-yolo'
  const entryBytes = Buffer.from('embedding entry')
  const entrySha256 = createHash('sha256').update(entryBytes).digest('hex')
  const declaredAssetSha256 = createHash('sha256').update('abc').digest('hex')
  const registry = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      components: [
        {
          id: 'embedding-engine',
          entry: 'runtime-components/embedding-engine/dist/entry.js',
          byteSize: entryBytes.byteLength,
          sha256: entrySha256,
          assets: [
            {
              name: 'ort-wasm-simd-threaded.wasm',
              path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
              byteSize: 3,
              sha256: declaredAssetSha256,
            },
          ],
        },
      ],
    }),
  )
  const fetchImpl = runtimeAssetFetch(repository, version, registry, {
    [`${entrySha256}-entry.js`]: entryBytes,
    [`${declaredAssetSha256}-ort-wasm-simd-threaded.wasm`]:
      Buffer.from('not abc'),
  })

  await assert.rejects(
    describeRuntimeComponentArtifacts({ repository, version, fetchImpl }),
    /integrity mismatch/,
  )
})

test('rejects a v2 registry with a path-traversing asset name', async () => {
  const version = '1.8.0'
  const repository = 'Lapis0x0/obsidian-yolo'
  const entryBytes = Buffer.from('embedding entry')
  const entrySha256 = createHash('sha256').update(entryBytes).digest('hex')
  const root = `https://raw.githubusercontent.com/${repository}/${version}/runtime-components`
  const registry = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      components: [
        {
          id: 'embedding-engine',
          entry: 'runtime-components/embedding-engine/dist/entry.js',
          byteSize: entryBytes.byteLength,
          sha256: entrySha256,
          assets: [
            {
              name: '../entry.js',
              path: 'runtime-components/embedding-engine/dist/assets/../entry.js',
              byteSize: 3,
              sha256: createHash('sha256').update('abc').digest('hex'),
            },
          ],
        },
      ],
    }),
  )
  const fetchImpl = async (url) =>
    new Response(url === `${root}/registry.json` ? registry : 'xyz')

  await assert.rejects(
    describeRuntimeComponentArtifacts({ repository, version, fetchImpl }),
    /Runtime component registry is invalid/,
  )
})
