import {
  type RequestUrlParam,
  type RequestUrlResponse,
  requestUrl,
} from 'obsidian'

import {
  DISTRIBUTION_FEED_MAX_BYTES,
  type DistributionFeedV1,
  verifyAndParseDistributionFeed,
} from './distributionFeed'

export const DISTRIBUTION_FEED_URL = 'https://updates.yoloapp.dev/feed-v1.json'
export const DISTRIBUTION_FEED_SIGNATURE_URL =
  'https://updates.yoloapp.dev/feed-v1.sig'
export const DISTRIBUTION_FEED_FALLBACK_URL =
  'https://raw.githubusercontent.com/Lapis0x0/obsidian-yolo/main/distribution/feed-v1.json'
export const DISTRIBUTION_FEED_SIGNATURE_FALLBACK_URL =
  'https://raw.githubusercontent.com/Lapis0x0/obsidian-yolo/main/distribution/feed-v1.sig'

const CACHE_SCHEMA_VERSION = 1
const CACHE_MAX_BYTES = 3_000_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export type DistributionFeedRequest = (
  request: RequestUrlParam,
) => Promise<RequestUrlResponse>

export type DistributionFeedCacheAdapter = Readonly<{
  stat(
    path: string,
  ): Promise<Readonly<{ type: 'file' | 'folder'; size: number }> | null>
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  write(path: string, data: string): Promise<void>
}>

export type DistributionFeedClientOptions = Readonly<{
  adapter: DistributionFeedCacheAdapter
  cachePath: string
  timeoutMs: number
  requestUrl?: DistributionFeedRequest
  now?: () => number
  publicKeyBase64?: string
}>

type ValidatedFeed = Readonly<{
  raw: string
  signature: string
  feed: DistributionFeedV1
  fetchedAt: number
}>

export class DistributionFeedUnavailableError extends Error {
  constructor() {
    super('YOLO update Feed is unavailable')
    this.name = 'DistributionFeedUnavailableError'
  }
}

export class DistributionFeedClient {
  private readonly request: DistributionFeedRequest
  private readonly now: () => number
  private inFlight: Promise<DistributionFeedV1> | null = null
  private freshInFlight: Promise<DistributionFeedV1> | null = null
  private latestValidated: ValidatedFeed | null = null
  private writeGeneration = 0
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: DistributionFeedClientOptions) {
    if (
      !options ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > MAX_TIMER_DELAY_MS ||
      !isSafeRelativePath(options.cachePath)
    ) {
      throw new Error('Distribution Feed client options are invalid')
    }
    this.request = options.requestUrl ?? requestUrl
    this.now = options.now ?? Date.now
  }

  load(): Promise<DistributionFeedV1> {
    if (this.latestValidated) return Promise.resolve(this.latestValidated.feed)
    if (this.inFlight) return this.inFlight
    const operation = this.loadOnce()
    this.inFlight = operation
    void operation.then(
      () => {
        if (this.inFlight === operation) this.inFlight = null
      },
      () => {
        if (this.inFlight === operation) this.inFlight = null
      },
    )
    return operation
  }

  loadFresh(): Promise<DistributionFeedV1> {
    if (this.freshInFlight) return this.freshInFlight
    const operation = this.loadFreshOnce()
    this.freshInFlight = operation
    void operation.then(
      () => {
        if (this.freshInFlight === operation) this.freshInFlight = null
      },
      () => {
        if (this.freshInFlight === operation) this.freshInFlight = null
      },
    )
    return operation
  }

  private async loadOnce(): Promise<DistributionFeedV1> {
    const cached = await this.readCache()
    if (cached) {
      this.accept(cached)
      return cached.feed
    }
    return this.loadFreshOnce()
  }

  private async loadFreshOnce(): Promise<DistributionFeedV1> {
    let lastError: unknown
    for (const source of [
      [DISTRIBUTION_FEED_URL, DISTRIBUTION_FEED_SIGNATURE_URL],
      [
        DISTRIBUTION_FEED_FALLBACK_URL,
        DISTRIBUTION_FEED_SIGNATURE_FALLBACK_URL,
      ],
    ] as const) {
      try {
        const validated = await this.requestSource(source[0], source[1])
        this.accept(validated)
        this.enqueueWrite(validated)
        return validated.feed
      } catch (error) {
        lastError = error
      }
    }
    const cached = this.latestValidated ?? (await this.readCache())
    if (cached) {
      this.accept(cached)
      return cached.feed
    }
    void lastError
    throw new DistributionFeedUnavailableError()
  }

  private async requestSource(
    feedUrl: string,
    signatureUrl: string,
  ): Promise<ValidatedFeed> {
    const [feedResponse, signatureResponse] = await Promise.all([
      withTimeout(
        this.request({ url: feedUrl, method: 'GET', throw: false }),
        this.options.timeoutMs,
      ),
      withTimeout(
        this.request({ url: signatureUrl, method: 'GET', throw: false }),
        this.options.timeoutMs,
      ),
    ])
    if (!isSuccessful(feedResponse) || !isSuccessful(signatureResponse)) {
      throw new Error('Distribution Feed request was not successful')
    }
    if (
      contentLengthExceeds(feedResponse.headers, DISTRIBUTION_FEED_MAX_BYTES) ||
      contentLengthExceeds(signatureResponse.headers, 256) ||
      utf8ByteLength(feedResponse.text) > DISTRIBUTION_FEED_MAX_BYTES ||
      utf8ByteLength(signatureResponse.text) > 256
    ) {
      throw new Error('Distribution Feed response exceeds the byte limit')
    }
    return Object.freeze({
      raw: feedResponse.text,
      signature: signatureResponse.text.trim(),
      feed: verifyAndParseDistributionFeed(
        feedResponse.text,
        signatureResponse.text.trim(),
        { publicKeyBase64: this.options.publicKeyBase64 },
      ),
      fetchedAt: readCurrentTime(this.now),
    })
  }

  private accept(validated: ValidatedFeed): void {
    if (
      this.latestValidated &&
      validated.feed.revision < this.latestValidated.feed.revision
    ) {
      throw new Error('Distribution Feed revision cannot move backwards')
    }
    if (
      this.latestValidated &&
      validated.feed.revision === this.latestValidated.feed.revision &&
      validated.raw !== this.latestValidated.raw
    ) {
      throw new Error('Distribution Feed revision has conflicting bytes')
    }
    this.latestValidated = validated
  }

  private async readCache(): Promise<ValidatedFeed | null> {
    try {
      const stat = await this.options.adapter.stat(this.options.cachePath)
      if (
        !stat ||
        stat.type !== 'file' ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > CACHE_MAX_BYTES
      ) {
        return null
      }
      const rawEnvelope = await this.options.adapter.read(
        this.options.cachePath,
      )
      if (utf8ByteLength(rawEnvelope) > CACHE_MAX_BYTES) return null
      const envelope = JSON.parse(rawEnvelope) as unknown
      if (!isPlainRecord(envelope)) return null
      if (
        envelope.schemaVersion !== CACHE_SCHEMA_VERSION ||
        typeof envelope.feed !== 'string' ||
        typeof envelope.signature !== 'string' ||
        !Number.isSafeInteger(envelope.fetchedAt) ||
        (envelope.fetchedAt as number) < 0
      ) {
        return null
      }
      return Object.freeze({
        raw: envelope.feed,
        signature: envelope.signature,
        feed: verifyAndParseDistributionFeed(
          envelope.feed,
          envelope.signature,
          { publicKeyBase64: this.options.publicKeyBase64 },
        ),
        fetchedAt: envelope.fetchedAt as number,
      })
    } catch {
      return null
    }
  }

  private enqueueWrite(validated: ValidatedFeed): void {
    const generation = ++this.writeGeneration
    const write = this.writeQueue.then(async () => {
      if (generation !== this.writeGeneration) return
      const envelope = JSON.stringify({
        schemaVersion: CACHE_SCHEMA_VERSION,
        fetchedAt: validated.fetchedAt,
        feed: validated.raw,
        signature: validated.signature,
      })
      if (utf8ByteLength(envelope) > CACHE_MAX_BYTES) return
      await ensureParentDirectories(
        this.options.adapter,
        this.options.cachePath,
      )
      await this.options.adapter.write(this.options.cachePath, envelope)
    })
    this.writeQueue = write.catch(() => undefined)
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = globalThis.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('Distribution Feed request timed out'))
    }, timeoutMs)
    operation.then(
      (value) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function isSuccessful(response: RequestUrlResponse): boolean {
  return response.status >= 200 && response.status < 300
}

function contentLengthExceeds(
  headers: Readonly<Record<string, string>>,
  maximum: number,
): boolean {
  const value = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-length',
  )?.[1]
  return Boolean(value && /^\d+$/.test(value) && Number(value) > maximum)
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function readCurrentTime(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Distribution Feed clock is invalid')
  }
  return value
}

function isSafeRelativePath(value: string): boolean {
  return (
    typeof value === 'string' &&
    Boolean(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  )
}

async function ensureParentDirectories(
  adapter: DistributionFeedCacheAdapter,
  filePath: string,
): Promise<void> {
  const parts = filePath.split('/').slice(0, -1)
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (!(await adapter.exists(current))) await adapter.mkdir(current)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
