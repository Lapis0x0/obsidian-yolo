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
import { isOfficialModuleArtifactSourceUrl } from './officialModuleArtifactSources'

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
  return async (downloadRequest) => {
    assertDownloadRequest(downloadRequest)
    const transport = Promise.resolve().then(() =>
      request({
        url: downloadRequest.url,
        method: 'GET',
        throw: false,
      }),
    )
    const response = await withTimeout(
      transport,
      validatedTimeoutMs,
      downloadRequest.signal,
    )
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
    const maximumBytes = maximumBytesFor(downloadRequest.kind)
    if (contentLength !== null && contentLength > maximumBytes) {
      throw new Error('Official module artifact exceeds the byte limit')
    }
    if (!(response.arrayBuffer instanceof ArrayBuffer)) {
      throw new Error('Official module artifact response body is invalid')
    }

    const bytes = new Uint8Array(response.arrayBuffer)
    if (bytes.byteLength > maximumBytes) {
      throw new Error('Official module artifact exceeds the byte limit')
    }
    return bytes.slice()
  }
}

function assertDownloadRequest(value: unknown): asserts value is Readonly<{
  kind: 'manifest' | 'artifact'
  url: string
  byteSize: number
  signal?: AbortSignal
}> {
  if (!isPlainRecord(value)) {
    throw new TypeError('Official module artifact download request is invalid')
  }
  const keys = Reflect.ownKeys(value)
  if (
    (keys.length !== 3 && keys.length !== 4) ||
    !keys.includes('kind') ||
    !keys.includes('url') ||
    !keys.includes('byteSize') ||
    (keys.length === 4 && !keys.includes('signal')) ||
    (value.kind !== 'manifest' && value.kind !== 'artifact') ||
    typeof value.url !== 'string' ||
    !isOfficialModuleArtifactSourceUrl(value.url) ||
    !Number.isSafeInteger(value.byteSize) ||
    (value.byteSize as number) <= 0 ||
    (value.byteSize as number) > maximumBytesFor(value.kind) ||
    !isAbortSignal(value.signal)
  ) {
    throw new TypeError('Official module artifact download request is invalid')
  }
}

function maximumBytesFor(kind: 'manifest' | 'artifact'): number {
  return kind === 'manifest'
    ? MAX_MODULE_MANIFEST_BYTES
    : MAX_MODULE_ARTIFACT_FILE_BYTES
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      settle()
    }
    const abort = (): void => {
      finish(() =>
        reject(new Error('Official module artifact request aborted')),
      )
    }
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error('Official module artifact request timed out')),
      )
    }, timeoutMs)
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        finish(() => resolve(value))
      },
      (error: unknown) => {
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        )
      },
    )
  })
}

function isAbortSignal(value: unknown): value is AbortSignal | undefined {
  return (
    value === undefined ||
    (Boolean(value) &&
      typeof value === 'object' &&
      typeof (value as AbortSignal).aborted === 'boolean' &&
      typeof (value as AbortSignal).addEventListener === 'function' &&
      typeof (value as AbortSignal).removeEventListener === 'function')
  )
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
