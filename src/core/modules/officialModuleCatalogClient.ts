import {
  type RequestUrlParam,
  type RequestUrlResponse,
  requestUrl,
} from 'obsidian'

import { isModuleReleaseUrlAllowed } from './moduleReleaseUrl'
import {
  type OfficialModuleCatalogV1,
  parseOfficialModuleCatalog,
} from './officialModuleCatalog'

export const OFFICIAL_MODULE_CATALOG_URL =
  'https://cdn.jsdelivr.net/gh/Lapis0x0/obsidian-yolo@main/modules/catalog-v1.json'
export const OFFICIAL_MODULE_CATALOG_FALLBACK_URL =
  'https://raw.githubusercontent.com/Lapis0x0/obsidian-yolo/main/modules/catalog-v1.json'
export const OFFICIAL_MODULE_RELEASE_REPOSITORIES = Object.freeze([
  Object.freeze({ owner: 'Lapis0x0', repo: 'obsidian-yolo' }),
])

const CATALOG_MAX_BYTES = 1_000_000
const CACHE_MAX_BYTES = 7_000_000
const CACHE_SCHEMA_VERSION = 1
const CACHE_READ_TIMEOUT_MS = 1_000
// Synced device clocks can briefly disagree without making a cache untrustworthy.
const CACHE_CLOCK_SKEW_MS = 5 * 60 * 1_000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const UNAVAILABLE_MESSAGE = 'Official module catalog is unavailable'

export type OfficialModuleCatalogRequest = (
  request: RequestUrlParam,
) => Promise<RequestUrlResponse>

export type OfficialModuleCatalogCacheAdapter = Readonly<{
  stat(
    path: string,
  ): Promise<Readonly<{ type: 'file' | 'folder'; size: number }> | null>
  read(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  write(path: string, data: string): Promise<void>
}>

export type OfficialModuleCatalogClientOptions = Readonly<{
  adapter: OfficialModuleCatalogCacheAdapter
  cachePath: string
  timeoutMs: number
  now?: () => number
  requestUrl?: OfficialModuleCatalogRequest
}>

type ValidatedCache = Readonly<{
  fetchedAt: number
  catalog: OfficialModuleCatalogV1
}>

export class OfficialModuleCatalogUnavailableError extends Error {
  constructor() {
    super(UNAVAILABLE_MESSAGE)
    this.name = 'OfficialModuleCatalogUnavailableError'
  }
}

/** Checks a release URL against the code-owned first-party repository list. */
export function isOfficialModuleReleaseUrl(value: unknown): value is string {
  return isModuleReleaseUrlAllowed(value, OFFICIAL_MODULE_RELEASE_REPOSITORIES)
}

export class OfficialModuleCatalogClient {
  private readonly cachePath: string
  private readonly now: () => number
  private readonly request: OfficialModuleCatalogRequest
  private cacheWriteGeneration = 0
  private cacheWriteQueue: Promise<void> = Promise.resolve()
  private inFlight: Promise<OfficialModuleCatalogV1> | null = null
  private freshInFlight: Promise<OfficialModuleCatalogV1> | null = null

  constructor(private readonly options: OfficialModuleCatalogClientOptions) {
    if (
      !options ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error('Official module catalog client options are invalid')
    }
    this.cachePath = normalizeCachePath(options.cachePath)
    this.now = options.now ?? Date.now
    this.request = options.requestUrl ?? requestUrl
  }

  /** Loads the last validated snapshot, reaching the network only to bootstrap it. */
  load(): Promise<OfficialModuleCatalogV1> {
    if (this.inFlight) return this.inFlight

    const load = this.loadOnce()
    this.inFlight = load
    void load.then(
      () => {
        if (this.inFlight === load) this.inFlight = null
      },
      () => {
        if (this.inFlight === load) this.inFlight = null
      },
    )
    return load
  }

  /** Loads only from the official endpoint; cached data is never authoritative. */
  loadFresh(): Promise<OfficialModuleCatalogV1> {
    if (this.freshInFlight) return this.freshInFlight

    const load = this.loadFreshOnce()
    this.freshInFlight = load
    void load.then(
      () => {
        if (this.freshInFlight === load) this.freshInFlight = null
      },
      () => {
        if (this.freshInFlight === load) this.freshInFlight = null
      },
    )
    return load
  }

  private async loadOnce(): Promise<OfficialModuleCatalogV1> {
    let currentTime: number
    try {
      currentTime = readCurrentTime(this.now)
    } catch {
      throw new OfficialModuleCatalogUnavailableError()
    }

    const cached = await this.readCache(currentTime)
    if (cached) return cached.catalog

    try {
      return await this.requestFresh(currentTime)
    } catch {
      throw new OfficialModuleCatalogUnavailableError()
    }
  }

  private async loadFreshOnce(): Promise<OfficialModuleCatalogV1> {
    try {
      return await this.requestFresh(readCurrentTime(this.now))
    } catch {
      throw new OfficialModuleCatalogUnavailableError()
    }
  }

  private async requestFresh(
    fetchedAt: number,
  ): Promise<OfficialModuleCatalogV1> {
    /*
     * requestUrl buffers the body before resolving. The fixed code-owned
     * endpoint, Content-Length check, and parser limits validate that buffer;
     * they are not a streaming transport cap.
     */
    let lastError: unknown
    for (const url of [
      OFFICIAL_MODULE_CATALOG_URL,
      OFFICIAL_MODULE_CATALOG_FALLBACK_URL,
    ]) {
      try {
        return await this.requestCatalogSource(url, fetchedAt)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Official module catalog request failed')
  }

  private async requestCatalogSource(
    url: string,
    fetchedAt: number,
  ): Promise<OfficialModuleCatalogV1> {
    const response = await withTimeout(
      this.request({ url, method: 'GET', throw: false }),
      this.options.timeoutMs,
    )
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error('Official module catalog request was not successful')
    }
    if (contentLengthExceedsLimit(response.headers, CATALOG_MAX_BYTES)) {
      throw new Error('Official module catalog exceeds the byte limit')
    }

    const catalog = this.parse(response.text)
    this.enqueueCacheWrite(response.text, fetchedAt)
    return catalog
  }

  private parse(raw: string): OfficialModuleCatalogV1 {
    return parseOfficialModuleCatalog(raw, {
      allowedRepositories: OFFICIAL_MODULE_RELEASE_REPOSITORIES,
    })
  }

  private async readCache(currentTime: number): Promise<ValidatedCache | null> {
    try {
      return await withTimeout(
        this.readCacheUnchecked(currentTime),
        CACHE_READ_TIMEOUT_MS,
      )
    } catch {
      return null
    }
  }

  private async readCacheUnchecked(
    currentTime: number,
  ): Promise<ValidatedCache | null> {
    const stat = await this.options.adapter.stat(this.cachePath)
    if (
      !stat ||
      stat.type !== 'file' ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > CACHE_MAX_BYTES
    ) {
      return null
    }

    const raw = await this.options.adapter.read(this.cachePath)
    if (utf8ByteLength(raw) > CACHE_MAX_BYTES) return null
    const decoded = JSON.parse(raw) as unknown
    if (!isPlainRecord(decoded)) return null
    const keys = Object.keys(decoded)
    if (
      keys.length !== 3 ||
      !keys.includes('schemaVersion') ||
      !keys.includes('fetchedAt') ||
      !keys.includes('catalog') ||
      decoded.schemaVersion !== CACHE_SCHEMA_VERSION ||
      !Number.isSafeInteger(decoded.fetchedAt) ||
      (decoded.fetchedAt as number) < 0 ||
      (decoded.fetchedAt as number) > currentTime + CACHE_CLOCK_SKEW_MS ||
      typeof decoded.catalog !== 'string'
    ) {
      return null
    }
    return Object.freeze({
      fetchedAt: decoded.fetchedAt as number,
      catalog: this.parse(decoded.catalog),
    })
  }

  private async writeCache(
    rawCatalog: string,
    fetchedAt: number,
  ): Promise<void> {
    const envelope = JSON.stringify({
      schemaVersion: CACHE_SCHEMA_VERSION,
      fetchedAt,
      catalog: rawCatalog,
    })
    if (utf8ByteLength(envelope) > CACHE_MAX_BYTES) return

    await ensureParentDirectories(this.options.adapter, this.cachePath)
    await this.options.adapter.write(this.cachePath, envelope)
  }

  private enqueueCacheWrite(rawCatalog: string, fetchedAt: number): void {
    const generation = ++this.cacheWriteGeneration
    const queued = this.cacheWriteQueue.then(async () => {
      if (generation !== this.cacheWriteGeneration) return
      await this.writeCache(rawCatalog, fetchedAt)
    })
    // Keep load() independent of cache I/O and leave the queue usable on error.
    this.cacheWriteQueue = queued.catch(() => undefined)
  }
}

function withTimeout<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('Official module catalog operation timed out'))
    }, timeoutMs)

    request.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function contentLengthExceedsLimit(
  headers: Readonly<Record<string, string>>,
  maxBytes: number,
): boolean {
  const entry = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-length',
  )
  if (!entry || !/^\d+$/.test(entry[1])) return false
  const length = Number(entry[1])
  return Number.isFinite(length) && length > maxBytes
}

async function ensureParentDirectories(
  adapter: OfficialModuleCatalogCacheAdapter,
  filePath: string,
): Promise<void> {
  const parts = filePath.split('/').slice(0, -1)
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    if (!(await adapter.exists(current))) await adapter.mkdir(current)
  }
}

function normalizeCachePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:($|\/)/.test(value) ||
    hasControlCharacters(value)
  ) {
    throw new Error('Official module catalog cache path is invalid')
  }
  const segments = value.split('/')
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new Error('Official module catalog cache path is invalid')
  }
  return segments.join('/')
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function readCurrentTime(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Official module catalog clock is invalid')
  }
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
