import { requestUrl } from 'obsidian'

import { createLLMDebugFetch } from '../../core/llm/debugCapture'
import type { UploadProgressFetch } from '../../core/llm/fetchTypes'

type ObsidianFetch = UploadProgressFetch

const toHeadersRecord = (
  headers?: HeadersInit,
): Record<string, string> | undefined => {
  if (!headers) return undefined

  if (headers instanceof Headers) {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
      record[key] = value
    })
    return record
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key, String(value)]),
    )
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  )
}

const sanitizeHeaders = (
  headers?: Record<string, string>,
): Record<string, string> | undefined => {
  if (!headers) return undefined
  const blocked = new Set([
    'accept-encoding',
    'content-length',
    'connection',
    'host',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    'user-agent',
  ])
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (blocked.has(lower) || lower.startsWith('sec-')) continue
    sanitized[key] = value
  }
  return sanitized
}

const toRequestUrlBody = async (
  body?: BodyInit | null,
): Promise<string | ArrayBuffer | undefined> => {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer) return body
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }
  if (body instanceof Blob) {
    return await body.arrayBuffer()
  }

  throw new Error('Unsupported request body type for requestUrl')
}

const getRequestUrlBodyByteLength = (
  body: string | ArrayBuffer | undefined,
): number => {
  if (body === undefined) return 0
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength
  return body.byteLength
}

const throwIfAborted = (signal?: AbortSignal | null): void => {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

export const createObsidianFetch = (): ObsidianFetch => {
  const obsidianFetch: ObsidianFetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input.toString()
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    const headers = toHeadersRecord(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    const hasExplicitBody = typeof init?.body !== 'undefined'
    const shouldReadRequestBody =
      !hasExplicitBody &&
      input instanceof Request &&
      input.method !== 'GET' &&
      input.method !== 'HEAD'
    const body = await toRequestUrlBody(
      hasExplicitBody
        ? init?.body
        : shouldReadRequestBody
          ? await input.arrayBuffer()
          : null,
    )

    throwIfAborted(init?.signal)

    const response = await requestUrl({
      url,
      method,
      headers: sanitizeHeaders(headers),
      body,
      throw: false,
    })

    throwIfAborted(init?.signal)

    if (init?.onUploadProgress && body !== undefined) {
      // Obsidian's requestUrl does not expose streaming upload progress. Keep
      // the ASR UI moving by reporting completion once the request returns.
      const totalBytes = getRequestUrlBodyByteLength(body)
      init.onUploadProgress({ sentBytes: totalBytes, totalBytes })
    }

    return new Response(response.arrayBuffer, {
      status: response.status,
      headers: response.headers,
    })
  }
  return createLLMDebugFetch(obsidianFetch as typeof fetch, 'obsidian')
}
