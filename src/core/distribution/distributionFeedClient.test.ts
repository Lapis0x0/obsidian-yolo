import type { RequestUrlParam, RequestUrlResponse } from 'obsidian'
import * as nacl from 'tweetnacl'

import {
  DISTRIBUTION_FEED_FALLBACK_URL,
  DISTRIBUTION_FEED_SIGNATURE_FALLBACK_URL,
  DISTRIBUTION_FEED_SIGNATURE_URL,
  DISTRIBUTION_FEED_URL,
  DistributionFeedClient,
  DistributionFeedUnavailableError,
} from './distributionFeedClient'

const encoder = new TextEncoder()

class MemoryCache {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()

  async stat(path: string): Promise<{ type: 'file'; size: number } | null> {
    const value = this.files.get(path)
    return value === undefined
      ? null
      : { type: 'file', size: encoder.encode(value).byteLength }
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new Error('Missing cache')
    return value
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path)
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value)
  }
}

function createSignedFeed(revision = 1) {
  const feed = {
    schemaVersion: 1,
    revision,
    keyId: 'yolo-distribution-2026-01',
    core: {
      version: '1.2.3',
      minAppVersion: '1.5.0',
      releaseUrl:
        'https://github.com/Lapis0x0/obsidian-yolo/releases/tag/1.2.3',
      releaseNotes: { en: 'English note', zh: '中文说明' },
      assets: {
        mainJs: asset('main.js'),
        manifestJson: asset('manifest.json'),
        stylesCss: asset('styles.css'),
      },
    },
    modules: [],
  }
  const raw = `${JSON.stringify(feed, null, 2)}\n`
  const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
  const signature = Buffer.from(
    nacl.sign.detached(encoder.encode(raw), keyPair.secretKey),
  ).toString('base64')
  return {
    raw,
    signature,
    publicKey: Buffer.from(keyPair.publicKey).toString('base64'),
  }
}

function asset(name: string) {
  return {
    name,
    mirrorPath: `core/1.2.3/${name}`,
    canonicalUrl: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/1.2.3/${name}`,
    byteSize: 1,
    sha256: 'a'.repeat(64),
  }
}

function response(text: string, status = 200): RequestUrlResponse {
  const bytes = encoder.encode(text)
  return {
    status,
    headers: { 'content-length': String(bytes.byteLength) },
    text,
    json: null,
    arrayBuffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  }
}

function client(
  cache: MemoryCache,
  requestUrl: (request: RequestUrlParam) => Promise<RequestUrlResponse>,
  signed = createSignedFeed(),
) {
  return new DistributionFeedClient({
    adapter: cache,
    cachePath: 'distribution/feed-v1.json',
    timeoutMs: 1_000,
    requestUrl,
    publicKeyBase64: signed.publicKey,
  })
}

describe('DistributionFeedClient', () => {
  it('loads the signed Cloudflare source first', async () => {
    const signed = createSignedFeed()
    const request = jest.fn(async ({ url }: RequestUrlParam) =>
      response(url.endsWith('.sig') ? signed.signature : signed.raw),
    )

    await expect(
      client(new MemoryCache(), request, signed).loadFresh(),
    ).resolves.toMatchObject({ revision: 1, core: { version: '1.2.3' } })
    expect(request).toHaveBeenCalledWith({
      url: DISTRIBUTION_FEED_URL,
      method: 'GET',
      throw: false,
    })
    expect(request).toHaveBeenCalledWith({
      url: DISTRIBUTION_FEED_SIGNATURE_URL,
      method: 'GET',
      throw: false,
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('falls back to GitHub Raw when Cloudflare is unavailable', async () => {
    const signed = createSignedFeed()
    const request = jest.fn(async ({ url }: RequestUrlParam) => {
      if (url.startsWith('https://updates.yoloapp.dev'))
        return response('', 503)
      return response(url.endsWith('.sig') ? signed.signature : signed.raw)
    })

    await expect(
      client(new MemoryCache(), request, signed).loadFresh(),
    ).resolves.toMatchObject({ revision: 1 })
    expect(request).toHaveBeenCalledWith({
      url: DISTRIBUTION_FEED_FALLBACK_URL,
      method: 'GET',
      throw: false,
    })
    expect(request).toHaveBeenCalledWith({
      url: DISTRIBUTION_FEED_SIGNATURE_FALLBACK_URL,
      method: 'GET',
      throw: false,
    })
  })

  it('uses only a previously validated cache after both networks fail', async () => {
    const signed = createSignedFeed()
    const cache = new MemoryCache()
    const online = jest.fn(async ({ url }: RequestUrlParam) =>
      response(url.endsWith('.sig') ? signed.signature : signed.raw),
    )
    await client(cache, online, signed).loadFresh()
    await Promise.resolve()

    const offline = jest.fn(async () => response('', 503))
    await expect(
      client(cache, offline, signed).loadFresh(),
    ).resolves.toMatchObject({ revision: 1 })
    expect(offline).toHaveBeenCalledTimes(4)
  })

  it('rejects unsigned or tampered metadata without a validated cache', async () => {
    const signed = createSignedFeed()
    const request = jest.fn(async ({ url }: RequestUrlParam) =>
      response(url.endsWith('.sig') ? 'A'.repeat(88) : signed.raw),
    )

    await expect(
      client(new MemoryCache(), request, signed).loadFresh(),
    ).rejects.toBeInstanceOf(DistributionFeedUnavailableError)
  })
})
