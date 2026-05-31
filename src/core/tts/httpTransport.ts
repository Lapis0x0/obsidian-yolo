import type { TtsTransportMode } from '../../settings/schema/setting.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { runWithRequestTransport } from '../llm/requestTransport'
import { createBrowserFetch, createDesktopNodeFetch } from '../llm/sdkFetch'

type RawBody = string | ArrayBuffer | Uint8Array

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

  return runWithRequestTransport({
    mode: transportMode,
    runBrowser: () => run(createBrowserFetch()),
    runObsidian: () => run(createObsidianFetch()),
    runNode: () => run(createDesktopNodeFetch()),
  })
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
