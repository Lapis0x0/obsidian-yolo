import { Platform } from 'obsidian'

import type { TtsTransportMode } from '../../settings/schema/setting.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { runWithRequestTransport } from '../llm/requestTransport'
import { createBrowserFetch, createDesktopNodeFetch } from '../llm/sdkFetch'

type RawBody = string | ArrayBuffer | Uint8Array

const AUTO_RETRY_MESSAGE_PATTERNS = [
  'access-control-allow-origin',
  'blocked by cors policy',
  'cors',
  'econnrefused',
  'enotfound',
  'etimedout',
  'failed to fetch',
  'fetch failed',
  'load failed',
  'networkerror',
  'preflight request',
]

export type TtsHttpResponse = {
  status: number
  headers: Headers
  body: ArrayBuffer
  text: string
  json: unknown
}

export async function sendTtsHttpRequest(args: {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: RawBody
  transportMode: TtsTransportMode
  signal?: AbortSignal
}): Promise<TtsHttpResponse> {
  const {
    url,
    method = 'POST',
    headers = {},
    body,
    transportMode,
    signal,
  } = args

  const run = (transportFetch: typeof fetch) =>
    fetchToTtsResponse(
      transportFetch(url, {
        method,
        headers,
        body: body as BodyInit,
        signal,
      }),
    )

  if (transportMode === 'auto') {
    return runTtsAutoTransport({ run, signal })
  }

  return runWithRequestTransport({
    mode: transportMode,
    runBrowser: () => run(createBrowserFetch()),
    runObsidian: () => run(createObsidianFetch()),
    runNode: () => run(createDesktopNodeFetch()),
  })
}

const runTtsAutoTransport = async ({
  run,
  signal,
}: {
  run: (transportFetch: typeof fetch) => Promise<TtsHttpResponse>
  signal?: AbortSignal
}): Promise<TtsHttpResponse> => {
  if (Platform.isDesktop) {
    try {
      return await run(createDesktopNodeFetch())
    } catch (nodeError) {
      if (signal?.aborted || !shouldRetryWithNextTransport(nodeError)) {
        throw nodeError
      }
      return run(createBrowserFetch())
    }
  }

  try {
    return await run(createBrowserFetch())
  } catch (browserError) {
    if (signal?.aborted || !shouldRetryWithNextTransport(browserError)) {
      throw browserError
    }
    return run(createObsidianFetch())
  }
}

async function fetchToTtsResponse(
  responsePromise: Promise<Response>,
): Promise<TtsHttpResponse> {
  const response = await responsePromise
  const body = await response.arrayBuffer()
  const text = decodeTextBody(body)
  return {
    status: response.status,
    headers: response.headers,
    body,
    text,
    json: safeJsonParse(text),
  }
}

const decodeTextBody = (body: ArrayBuffer): string => {
  if (body.byteLength === 0) return ''
  try {
    return new TextDecoder().decode(body)
  } catch {
    return ''
  }
}

const safeJsonParse = (text: string): unknown => {
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const shouldRetryWithNextTransport = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  const normalized = message.toLowerCase()
  return AUTO_RETRY_MESSAGE_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  )
}
