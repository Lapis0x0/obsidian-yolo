import { Platform, requestUrl } from 'obsidian'

import type { AsrTransportMode } from '../../settings/schema/setting.types'

/**
 * Thin uniform interface over the three ASR transports.
 *
 *   - `auto`      → browser fetch, then desktop Node fetch, then Obsidian
 *     requestUrl on CORS/network errors.
 *   - `obsidian`  → `requestUrl` from the Obsidian API. Bypasses CORS/proxy
 *     quirks on Electron desktop and is the default for almost every LLM
 *     provider here. Does NOT honour AbortSignal — callers check
 *     `signal.aborted` after the call returns.
 *   - `browser`   → native `window.fetch`. Honours AbortSignal and tends to
 *     play nicer with enterprise gateways that strip headers added by the
 *     Obsidian shim.
 *   - `node`      → desktop Node fetch, lazy-loaded on desktop only, using the
 *     same proxy-aware fetch path as LLM providers. On mobile (no Node
 *     runtime) we transparently fall back to the `obsidian` path so the
 *     setting is portable.
 */
export type AsrHttpResponse = {
  status: number
  /** Parsed JSON when the response was JSON; null otherwise. */
  json: unknown
  /** Raw response text — used to surface error bodies in messages. */
  text: string
}

export async function sendAsrJsonRequest(args: {
  url: string
  body: unknown
  headers: Record<string, string>
  transportMode: AsrTransportMode
  signal?: AbortSignal
}): Promise<AsrHttpResponse> {
  const { url, body, headers, transportMode, signal } = args
  const payload = JSON.stringify(body)
  const merged: Record<string, string> = {
    ...headers,
    'Content-Type': 'application/json',
  }
  return sendRaw({
    url,
    method: 'POST',
    headers: merged,
    body: payload,
    transportMode,
    signal,
  })
}

/**
 * Multipart variant for the `/audio/transcriptions` endpoint. We hand-assemble
 * the body and feed it through the chosen transport.
 */
export async function sendAsrMultipartRequest(args: {
  url: string
  body: ArrayBuffer
  boundary: string
  headers: Record<string, string>
  transportMode: AsrTransportMode
  signal?: AbortSignal
}): Promise<AsrHttpResponse> {
  const { url, body, boundary, headers, transportMode, signal } = args
  const merged: Record<string, string> = {
    ...headers,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  }
  return sendRaw({
    url,
    method: 'POST',
    headers: merged,
    body,
    transportMode,
    signal,
  })
}

// ---- Internal dispatch ----------------------------------------------------

type RawBody = string | ArrayBuffer | Uint8Array

async function sendRaw(args: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: RawBody
  transportMode: AsrTransportMode
  signal?: AbortSignal
}): Promise<AsrHttpResponse> {
  const { url, method, headers, body, transportMode, signal } = args

  if (transportMode === 'auto') {
    return sendViaAuto({ url, method, headers, body, signal })
  }

  if (transportMode === 'browser') {
    return sendViaBrowserFetch({ url, method, headers, body, signal })
  }

  if (transportMode === 'node' && Platform.isDesktopApp) {
    // Lazy-load the node:http transport to keep node builtins out of the
    // mobile bundle. See `nodeHttpTransport.ts` for the project convention.
    const { sendViaNodeHttp } = await import('./nodeHttpTransport')
    return sendViaNodeHttp({ url, method, headers, body, signal })
  }

  // 'obsidian' (default) and 'node' on mobile both fall through to requestUrl.
  return sendViaObsidianRequest({ url, method, headers, body })
}

async function sendViaAuto(args: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: RawBody
  signal?: AbortSignal
}): Promise<AsrHttpResponse> {
  try {
    return await sendViaBrowserFetch(args)
  } catch (browserError) {
    if (args.signal?.aborted) throw browserError
    if (Platform.isDesktopApp) {
      try {
        const { sendViaNodeHttp } = await import('./nodeHttpTransport')
        return await sendViaNodeHttp(args)
      } catch (nodeError) {
        if (args.signal?.aborted) throw nodeError
      }
    }
    return sendViaObsidianRequest(args)
  }
}

async function sendViaBrowserFetch(args: {
  url: string
  method: string
  headers: Record<string, string>
  body: RawBody
  signal?: AbortSignal
}): Promise<AsrHttpResponse> {
  // The whole point of `browser` mode is opting into native fetch when
  // requestUrl mangles a particular endpoint. The user explicitly picked it.
  // eslint-disable-next-line no-restricted-globals -- explicit browser mode
  const response = await fetch(args.url, {
    method: args.method,
    headers: args.headers,
    body: args.body as BodyInit,
    signal: args.signal,
  })
  const text = await response.text()
  return { status: response.status, json: safeJsonParse(text), text }
}

async function sendViaObsidianRequest(args: {
  url: string
  method: string
  headers: Record<string, string>
  body: RawBody
}): Promise<AsrHttpResponse> {
  const response = await requestUrl({
    url: args.url,
    method: args.method,
    headers: args.headers,
    body: args.body as ArrayBuffer,
    throw: false,
  })
  let parsed: unknown = null
  try {
    parsed = response.json
  } catch {
    parsed = null
  }
  return { status: response.status, json: parsed, text: response.text ?? '' }
}

const safeJsonParse = (text: string): unknown => {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
