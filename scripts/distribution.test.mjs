import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertNewReleaseVersion,
  buildDesiredSnapshot,
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
