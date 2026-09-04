import * as nacl from 'tweetnacl'

import {
  DISTRIBUTION_FEED_KEY_ID,
  projectDistributionFeedCatalog,
  verifyAndParseDistributionFeed,
} from './distributionFeed'

const sha256 = 'a'.repeat(64)

function fixture() {
  const asset = (name: string, mirrorPath: string) => ({
    name,
    mirrorPath,
    canonicalUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.7.0/${name}`,
    byteSize: 10,
    sha256,
  })
  return {
    schemaVersion: 1,
    revision: 1,
    keyId: DISTRIBUTION_FEED_KEY_ID,
    core: {
      version: '1.7.0',
      minAppVersion: '1.8.0',
      releaseUrl:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/tag/1.7.0',
      releaseNotes: { en: '## 1.7.0 Update', zh: '## 1.7.0 更新' },
      assets: {
        mainJs: asset('main.js', 'core/1.7.0/main.js'),
        manifestJson: asset('manifest.json', 'core/1.7.0/manifest.json'),
        stylesCss: asset('styles.css', 'core/1.7.0/styles.css'),
      },
    },
    modules: [
      {
        id: 'learning',
        icon: 'graduation-cap',
        localizations: {
          en: { name: 'Learning', description: 'Learn from notes.' },
          zh: { name: '学习', description: '从笔记中学习。' },
          it: { name: 'Apprendimento', description: 'Impara dalle note.' },
        },
        version: '0.2.0',
        hostApi: '^1.4.0',
        platforms: ['desktop', 'mobile'],
        dataSchemas: {
          settings: { readMin: 0, readMax: 1, write: 1 },
        },
        releaseUrl:
          'https://github.com/Lapis0x0/obsidian-yolo/releases/tag/learning/v0.2.0',
        releaseNotes: { en: '## 0.2.0 Update', zh: '## 0.2.0 更新' },
        releaseNote: {
          name: 'release-note.md',
          canonicalUrl:
            'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.2.0/release-note.md',
          byteSize: 20,
          sha256,
        },
        manifest: {
          name: 'module.json',
          mirrorPath: 'modules/learning/0.2.0/module.json',
          canonicalUrl:
            'https://github.com/Lapis0x0/obsidian-yolo/releases/download/learning%2Fv0.2.0/module.json',
          byteSize: 30,
          sha256,
        },
      },
    ],
  }
}

describe('signed distribution Feed', () => {
  const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
  const publicKeyBase64 = Buffer.from(keyPair.publicKey).toString('base64')

  it('verifies raw bytes and projects one latest module version', () => {
    const raw = `${JSON.stringify(fixture(), null, 2)}\n`
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(raw), keyPair.secretKey),
    ).toString('base64')
    const feed = verifyAndParseDistributionFeed(raw, signature, {
      publicKeyBase64,
    })
    expect(feed.revision).toBe(1)
    expect(
      projectDistributionFeedCatalog(feed).modules[0].versions,
    ).toHaveLength(1)
  })

  it('rejects a changed byte', () => {
    const value = fixture()
    const raw = `${JSON.stringify(value)}\n`
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(raw), keyPair.secretKey),
    ).toString('base64')
    expect(() =>
      verifyAndParseDistributionFeed(raw.replace('1.7.0', '1.7.1'), signature, {
        publicKeyBase64,
      }),
    ).toThrow('signature')
  })

  // A client that rejects a Feed carrying a newer field can never be told about
  // the release that replaces it: update checks return null and there is no
  // online path back. Unknown fields must therefore be ignored, and a change
  // older clients must not apply gets a new schemaVersion instead.
  it('ignores fields a newer publisher added', () => {
    const value = fixture() as Record<string, unknown> & {
      core: Record<string, unknown>
      modules: Record<string, unknown>[]
    }
    value.unknownTopLevel = true
    value.core.unknownCore = { nested: 1 }
    value.modules[0].unknownModule = ['a']
    const raw = `${JSON.stringify(value)}\n`
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(raw), keyPair.secretKey),
    ).toString('base64')

    const feed = verifyAndParseDistributionFeed(raw, signature, {
      publicKeyBase64,
    })
    expect(feed.core.version).toBe('1.7.0')
    expect(feed.modules[0].id).toBe('learning')
    expect(feed).not.toHaveProperty('unknownTopLevel')
    expect(feed.core).not.toHaveProperty('unknownCore')
    expect(feed.modules[0]).not.toHaveProperty('unknownModule')
  })

  it('still rejects a Feed that is missing a required field', () => {
    const value = fixture() as Record<string, unknown>
    delete value.keyId
    const raw = `${JSON.stringify(value)}\n`
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(raw), keyPair.secretKey),
    ).toString('base64')
    expect(() =>
      verifyAndParseDistributionFeed(raw, signature, { publicKeyBase64 }),
    ).toThrow('missing field "keyId"')
  })

  it('binds every canonical download to the described product version', () => {
    const value = fixture()
    value.core.assets.mainJs.canonicalUrl =
      'https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.6.0/main.js'
    const raw = `${JSON.stringify(value)}\n`
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(raw), keyPair.secretKey),
    ).toString('base64')
    expect(() =>
      verifyAndParseDistributionFeed(raw, signature, { publicKeyBase64 }),
    ).toThrow('asset')
  })
})
