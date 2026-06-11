import type { AsrTransportMode } from '../../settings/schema/setting.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import type { UploadProgressFetch } from '../llm/fetchTypes'
import {
  resolveExplicitRequestTransportMode,
  runWithRequestTransport,
} from '../llm/requestTransport'
import { createBrowserFetch, createDesktopNodeFetch } from '../llm/sdkFetch'

import type { AsrUploadProgressCallback } from './types'

/**
 * ASR HTTP requests intentionally share the LLM/TTS fetch wrappers so proxy
 * handling, debug capture, mobile `node` normalization, and upload progress
 * behavior stay in one place.
 */
export type AsrHttpResponse = {
  status: number
  /** Parsed JSON when the response was JSON; null otherwise. */
  json: unknown
  /** Raw response text, used to surface error bodies in messages. */
  text: string
}

export async function sendAsrJsonRequest(args: {
  url: string
  body: unknown
  headers: Record<string, string>
  transportMode: AsrTransportMode
  signal?: AbortSignal
  onUploadProgress?: AsrUploadProgressCallback
}): Promise<AsrHttpResponse> {
  const payload = JSON.stringify(args.body)
  return sendRaw({
    url: args.url,
    method: 'POST',
    headers: {
      ...args.headers,
      'Content-Type': 'application/json',
    },
    body: payload,
    transportMode: args.transportMode,
    signal: args.signal,
    onUploadProgress: args.onUploadProgress,
  })
}

export async function sendAsrRawRequest(args: {
  url: string
  method?: 'GET' | 'POST'
  headers: Record<string, string>
  body?: RawBody
  transportMode: AsrTransportMode
  signal?: AbortSignal
  onUploadProgress?: AsrUploadProgressCallback
}): Promise<AsrHttpResponse> {
  return sendRaw({
    url: args.url,
    method: args.method ?? 'POST',
    headers: args.headers,
    body: args.body,
    transportMode: args.transportMode,
    signal: args.signal,
    onUploadProgress: args.onUploadProgress,
  })
}

/**
 * Multipart variant for the `/audio/transcriptions` endpoint. We hand-assemble
 * the body and feed it through the chosen shared transport.
 */
export async function sendAsrMultipartRequest(args: {
  url: string
  body: ArrayBuffer
  boundary: string
  headers: Record<string, string>
  transportMode: AsrTransportMode
  signal?: AbortSignal
  onUploadProgress?: AsrUploadProgressCallback
}): Promise<AsrHttpResponse> {
  return sendRaw({
    url: args.url,
    method: 'POST',
    headers: {
      ...args.headers,
      'Content-Type': `multipart/form-data; boundary=${args.boundary}`,
    },
    body: args.body,
    transportMode: args.transportMode,
    signal: args.signal,
    onUploadProgress: args.onUploadProgress,
  })
}

type RawBody = string | ArrayBuffer | Uint8Array

async function sendRaw(args: {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: RawBody
  transportMode: AsrTransportMode
  signal?: AbortSignal
  onUploadProgress?: AsrUploadProgressCallback
}): Promise<AsrHttpResponse> {
  const mode = resolveExplicitRequestTransportMode(args.transportMode)
  const run = (transportFetch: typeof fetch): Promise<AsrHttpResponse> =>
    fetchToAsrResponse(
      (transportFetch as UploadProgressFetch)(args.url, {
        method: args.method,
        headers: args.headers,
        body: args.body as BodyInit,
        signal: args.signal,
        onUploadProgress: args.onUploadProgress,
      }),
    )

  return runWithRequestTransport({
    mode,
    runBrowser: () => run(createBrowserFetch()),
    runObsidian: () => run(createObsidianFetch()),
    runNode: () => run(createDesktopNodeFetch()),
  })
}

async function fetchToAsrResponse(
  responsePromise: Promise<Response>,
): Promise<AsrHttpResponse> {
  const response = await responsePromise
  const text = await response.text()
  return {
    status: response.status,
    json: safeJsonParse(text),
    text,
  }
}

const safeJsonParse = (text: string): unknown => {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
