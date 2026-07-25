import {
  type RequestUrlParam,
  type RequestUrlResponse,
  requestUrl,
} from 'obsidian'

import type { RuntimeComponentDownload } from './runtimeComponentInstaller'

export const RUNTIME_COMPONENT_SOURCE_TIMEOUT_MS = 30_000

type RuntimeComponentRequest = (
  request: RequestUrlParam,
) => Promise<RequestUrlResponse>

export function createRuntimeComponentDownloader(
  options: Readonly<{
    requestUrl?: RuntimeComponentRequest
    timeoutMs?: number
  }> = {},
): RuntimeComponentDownload {
  const request = options.requestUrl ?? requestUrl
  const timeoutMs = options.timeoutMs ?? RUNTIME_COMPONENT_SOURCE_TIMEOUT_MS
  if (
    typeof request !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new TypeError('Runtime component downloader options are invalid')
  }
  return async ({ source, signal }) => {
    const response = await withTimeout(
      Promise.resolve().then(() =>
        request({ url: source, method: 'GET', throw: false }),
      ),
      timeoutMs,
      signal,
    )
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Runtime component request failed with HTTP ${response.status}`,
      )
    }
    if (!(response.arrayBuffer instanceof ArrayBuffer)) {
      throw new Error('Runtime component response body is invalid')
    }
    return new Uint8Array(response.arrayBuffer).slice()
  }
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
      finish(() => reject(new Error('Runtime component request aborted')))
    }
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Runtime component request timed out after ${timeoutMs} ms`,
          ),
        ),
      )
    }, timeoutMs)
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        ),
    )
  })
}
