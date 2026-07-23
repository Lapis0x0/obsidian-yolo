import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cleanupOwnedDraftRelease,
  verifyLearningReleaseAssets,
} from './verify-learning-release-assets.mjs'

const repository = 'owner/repository'
const tag = 'learning/v1.2.3'
const releaseId = 42
const apiBase = 'https://api.example.test'
const downloadBase = `https://downloads.example.test/${repository}`
const ownerMarker = 'learning-release-owner:123:1'

test('verifies the remote release closure and writes catalog metadata', async () => {
  const fixture = await createFixture()
  try {
    const metadata = await verifyLearningReleaseAssets({
      repository,
      tag,
      releaseId,
      targetCommit: 'test-commit',
      assetDir: fixture.directory,
      metadataOut: fixture.metadataPath,
      token: 'test-token',
      apiBase,
      downloadBase,
      fetchImpl: fixture.fetchImpl,
    })

    assert.equal(metadata.manifest.sha256, fixture.manifestSha256)
    assert.equal(
      metadata.manifest.byteSize,
      fixture.assets.get('module.json').length,
    )
    assert.deepEqual(
      metadata.assets.map(({ name }) => name),
      [...fixture.assets.keys()].sort(),
    )
    assert.deepEqual(
      JSON.parse(await readFile(fixture.metadataPath, 'utf8')),
      metadata,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('verifies draft assets before GitHub assigns canonical download URLs', async () => {
  const fixture = await createFixture({ draftDownloadTag: 'untagged-test' })
  try {
    const metadata = await verifyLearningReleaseAssets({
      repository,
      tag,
      releaseId,
      targetCommit: 'test-commit',
      assetDir: fixture.directory,
      metadataOut: fixture.metadataPath,
      token: 'test-token',
      apiBase,
      downloadBase,
      fetchImpl: fixture.fetchImpl,
    })

    assert.equal(
      metadata.manifest.url,
      `${downloadBase}/${encodeURIComponent(tag)}/module.json`,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('independently verifies published release assets', async () => {
  const fixture = await createFixture({ draft: false, draftDownloadTag: tag })
  try {
    const metadata = await verifyLearningReleaseAssets({
      repository,
      tag,
      releaseId,
      targetCommit: 'test-commit',
      assetDir: fixture.directory,
      metadataOut: fixture.metadataPath,
      token: 'test-token',
      apiBase,
      downloadBase,
      fetchImpl: fixture.fetchImpl,
      expectedDraft: false,
    })

    assert.equal(metadata.version, '1.2.3')
    assert.equal(
      metadata.manifest.url,
      `${downloadBase}/${encodeURIComponent(tag)}/module.json`,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects an undeclared remote asset', async () => {
  const fixture = await createFixture({ extraAsset: true })
  try {
    await assert.rejects(
      verifyLearningReleaseAssets({
        repository,
        tag,
        releaseId,
        targetCommit: 'test-commit',
        assetDir: fixture.directory,
        metadataOut: fixture.metadataPath,
        token: 'test-token',
        apiBase,
        downloadBase,
        fetchImpl: fixture.fetchImpl,
      }),
      /remote asset closure mismatch/,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects downloaded bytes that do not match the manifest SHA-256', async () => {
  const fixture = await createFixture({ corruptEntryDownload: true })
  try {
    await assert.rejects(
      verifyLearningReleaseAssets({
        repository,
        tag,
        releaseId,
        targetCommit: 'test-commit',
        assetDir: fixture.directory,
        metadataOut: fixture.metadataPath,
        token: 'test-token',
        apiBase,
        downloadBase,
        fetchImpl: fixture.fetchImpl,
      }),
      /entry\.js manifest SHA-256 mismatch/,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('deletes only the matching draft owned by this workflow run', async () => {
  const requests = []
  const release = cleanupRelease()
  const result = await cleanupOwnedDraftRelease({
    repository,
    tag,
    releaseId,
    targetCommit: 'test-commit',
    ownerMarker,
    token: 'test-token',
    apiBase,
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method ?? 'GET' })
      return options.method === 'DELETE'
        ? response('', 204)
        : response(JSON.stringify(release))
    },
  })

  assert.deepEqual(result, { deleted: true, releaseId })
  assert.deepEqual(requests, [
    {
      url: `${apiBase}/repos/${repository}/releases/${releaseId}`,
      method: 'GET',
    },
    {
      url: `${apiBase}/repos/${repository}/releases/${releaseId}`,
      method: 'DELETE',
    },
  ])
})

for (const [name, change, error] of [
  ['pre-existing release', { body: 'unowned' }, /not owned/],
  ['published release', { draft: false }, /draft state mismatch/],
  ['different commit', { target_commitish: 'other' }, /target commit mismatch/],
  ['different release id', { id: 99 }, /Release id mismatch/],
]) {
  test(`refuses to delete a ${name}`, async () => {
    let deleteRequested = false
    await assert.rejects(
      cleanupOwnedDraftRelease({
        repository,
        tag,
        releaseId,
        targetCommit: 'test-commit',
        ownerMarker,
        token: 'test-token',
        apiBase,
        fetchImpl: async (_url, options) => {
          if (options.method === 'DELETE') deleteRequested = true
          return response(JSON.stringify({ ...cleanupRelease(), ...change }))
        },
      }),
      error,
    )
    assert.equal(deleteRequested, false)
  })
}

function cleanupRelease() {
  return {
    id: releaseId,
    tag_name: tag,
    target_commitish: 'test-commit',
    draft: true,
    body: `<!-- ${ownerMarker} -->`,
  }
}

async function createFixture({
  extraAsset = false,
  corruptEntryDownload = false,
  draft = true,
  draftDownloadTag,
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'learning-release-'))
  const entry = Buffer.from('export default true\n')
  const style = Buffer.from('.learning { display: block; }\n')
  const encodedTag = encodeURIComponent(tag)
  const url = (name) =>
    `${downloadBase}/${encodedTag}/${encodeURIComponent(name)}`
  const releaseUrl = (name) =>
    `${downloadBase}/${draftDownloadTag ?? encodedTag}/${encodeURIComponent(name)}`
  const manifest = {
    schemaVersion: 1,
    id: 'learning',
    version: '1.2.3',
    hostApi: '^1.3.0',
    dataSchemas: {
      settings: { readMin: 0, readMax: 1, write: 1 },
    },
    variants: ['desktop', 'mobile'].map((platform) => ({
      platform,
      entry: 'entry.js',
      files: [
        declaration('entry', 'entry.js', entry, url('entry.js')),
        declaration('style', 'style.css', style, url('style.css')),
      ],
    })),
  }
  const moduleBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const releaseNote = Buffer.from(
    '## 1.2.3 Learning update\n\n- Update\n\n---\n\n## 1.2.3 学习模式更新\n\n- 更新\n',
  )
  const moduleConfig = Buffer.from(
    `${JSON.stringify({
      id: 'learning',
      icon: 'graduation-cap',
      localizations: {
        en: { name: 'Learning', description: 'Learn.' },
        zh: { name: '学习', description: '学习。' },
        it: { name: 'Apprendimento', description: 'Impara.' },
      },
      hostApi: '^1.3.0',
      platforms: ['desktop', 'mobile'],
      dataSchemas: manifest.dataSchemas,
    })}\n`,
  )
  const manifestSha256 = hash(moduleBytes)
  const assets = new Map([
    ['entry.js', entry],
    ['module-config.json', moduleConfig],
    ['module.json', moduleBytes],
    ['release-note.md', releaseNote],
    ['style.css', style],
  ])
  for (const [name, bytes] of assets) {
    await writeFile(path.join(directory, name), bytes)
  }

  const downloadedAssets = new Map(assets)
  if (extraAsset)
    downloadedAssets.set('unexpected.txt', Buffer.from('unexpected'))
  if (corruptEntryDownload) {
    downloadedAssets.set('entry.js', Buffer.from('export default false'))
  }
  const release = {
    id: releaseId,
    tag_name: tag,
    draft,
    prerelease: false,
    html_url: `https://github.com/${repository}/releases/tag/${encodedTag}`,
    target_commitish: 'test-commit',
    body: `<!-- ${ownerMarker} -->\n\n${releaseNote.toString('utf8')}`,
    assets: [...downloadedAssets].map(([name, bytes], index) => ({
      id: 1000 + index,
      name,
      size: bytes.length,
      browser_download_url: releaseUrl(name),
      url: `${apiBase}/repos/${repository}/releases/assets/${1000 + index}`,
    })),
  }
  const apiUrl = `${apiBase}/repos/${repository}/releases/${releaseId}`
  const fetchImpl = async (requestUrl) => {
    if (requestUrl === apiUrl) return response(JSON.stringify(release))
    const releaseAsset = release.assets.find(({ url }) => requestUrl === url)
    const bytes = releaseAsset && downloadedAssets.get(releaseAsset.name)
    return bytes ? response(bytes) : response('not found', 404)
  }

  return {
    assets,
    directory,
    fetchImpl,
    manifestSha256,
    metadataPath: path.join(directory, 'metadata.json'),
  }
}

function declaration(role, name, bytes, url) {
  return {
    role,
    name,
    path: name,
    byteSize: bytes.length,
    sha256: hash(bytes),
    url,
    storage: 'module',
  }
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function response(body, status = 200) {
  return new Response(status === 204 ? null : body, { status })
}
