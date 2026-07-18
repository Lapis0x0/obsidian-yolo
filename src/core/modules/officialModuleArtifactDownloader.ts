import {
  type RequestUrlParam,
  type RequestUrlResponse,
  requestUrl,
} from 'obsidian'

import type { ModuleArtifactInstallerOptions } from './moduleArtifactInstaller'
import {
  MAX_MODULE_ARTIFACT_FILE_BYTES,
  MAX_MODULE_MANIFEST_BYTES,
} from './moduleStore'
import { isOfficialModuleReleaseUrl } from './officialModuleCatalogClient'

export type OfficialModuleArtifactRequest = (
  request: RequestUrlParam,
) => Promise<RequestUrlResponse>

export type OfficialModuleArtifactDownloaderOptions = Readonly<{
  requestUrl?: OfficialModuleArtifactRequest
  timeoutMs?: number
}>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

export function createOfficialModuleArtifactDownloader(
  options: OfficialModuleArtifactDownloaderOptions = {},
): ModuleArtifactInstallerOptions['download'] {
  if (!isPlainRecord(options)) {
    throw new TypeError(
      'Official module artifact downloader options are invalid',
    )
  }
  const optionKeys = Reflect.ownKeys(options)
  if (
    optionKeys.some((key) => key !== 'requestUrl' && key !== 'timeoutMs') ||
    optionKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(options, key)
      return !descriptor || !('value' in descriptor) || !descriptor.enumerable
    })
  ) {
    throw new TypeError(
      'Official module artifact downloader options are invalid',
    )
  }
  const request = Object.prototype.hasOwnProperty.call(options, 'requestUrl')
    ? options.requestUrl
    : requestUrl
  const timeoutMs = Object.prototype.hasOwnProperty.call(options, 'timeoutMs')
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  if (typeof request !== 'function') {
    throw new TypeError('Official module artifact request must be a function')
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) <= 0 ||
    (timeoutMs as number) > MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError('Official module artifact timeout is invalid')
  }
  const validatedTimeoutMs = timeoutMs as number
  let requestInFlight: Promise<RequestUrlResponse> | null = null

  return async (downloadRequest) => {
    assertDownloadRequest(downloadRequest)
    if (requestInFlight) {
      throw new Error(
        'A previous official module artifact request is still in progress',
      )
    }

    const transport = Promise.resolve().then(() =>
      request({
        url: downloadRequest.url,
        method: 'GET',
        throw: false,
      }),
    )
    requestInFlight = transport
    void transport.then(
      () => {
        if (requestInFlight === transport) requestInFlight = null
      },
      () => {
        if (requestInFlight === transport) requestInFlight = null
      },
    )
    const response = await withTimeout(transport, validatedTimeoutMs)
    if (
      !response ||
      typeof response !== 'object' ||
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300
    ) {
      throw new Error('Official module artifact request was not successful')
    }

    const contentLength = readContentLength(response.headers)
    if (contentLength !== null && contentLength > downloadRequest.byteSize) {
      throw new Error('Official module artifact exceeds its expected byte size')
    }
    if (!(response.arrayBuffer instanceof ArrayBuffer)) {
      throw new Error('Official module artifact response body is invalid')
    }

    const bytes = new Uint8Array(response.arrayBuffer)
    if (bytes.byteLength !== downloadRequest.byteSize) {
      throw new Error(
        `Official module artifact size mismatch: expected ${downloadRequest.byteSize}, received ${bytes.byteLength}`,
      )
    }
    return bytes.slice()
  }
}

function assertDownloadRequest(value: unknown): asserts value is Readonly<{
  kind: 'manifest' | 'artifact'
  url: string
  byteSize: number
}> {
  if (!isPlainRecord(value)) {
    throw new TypeError('Official module artifact download request is invalid')
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 3 ||
    !keys.includes('kind') ||
    !keys.includes('url') ||
    !keys.includes('byteSize') ||
    (value.kind !== 'manifest' && value.kind !== 'artifact') ||
    typeof value.url !== 'string' ||
    !isOfficialModuleReleaseUrl(value.url) ||
    !Number.isSafeInteger(value.byteSize) ||
    (value.byteSize as number) <= 0 ||
    (value.byteSize as number) > maximumBytesFor(value.kind)
  ) {
    throw new TypeError('Official module artifact download request is invalid')
  }
}

function maximumBytesFor(kind: 'manifest' | 'artifact'): number {
  return kind === 'manifest'
    ? MAX_MODULE_MANIFEST_BYTES
    : MAX_MODULE_ARTIFACT_FILE_BYTES
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('Official module artifact request timed out'))
    }, timeoutMs)
    operation.then(
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

function readContentLength(headers: unknown): number | null {
  if (!isPlainRecord(headers)) {
    throw new Error('Official module artifact response headers are invalid')
  }
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'content-length')
    .map(([, value]) => value)
  if (values.length === 0) return null
  if (
    values.length !== 1 ||
    typeof values[0] !== 'string' ||
    !/^(?:0|[1-9]\d*)$/.test(values[0])
  ) {
    throw new Error('Official module artifact Content-Length is invalid')
  }
  const length = Number(values[0])
  if (!Number.isSafeInteger(length)) {
    throw new Error('Official module artifact Content-Length is invalid')
  }
  return length
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
