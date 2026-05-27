import type { AsrHttpResponse } from './httpTransport'
import { createDesktopNodeFetch } from '../llm/sdkFetch'

type RawBody = string | ArrayBuffer | Uint8Array

export async function sendViaNodeHttp(args: {
  url: string
  method: string
  headers: Record<string, string>
  body: RawBody
  signal?: AbortSignal
}): Promise<AsrHttpResponse> {
  const nodeFetch = createDesktopNodeFetch()
  const response = await nodeFetch(args.url, {
    method: args.method,
    headers: args.headers,
    body: args.body as BodyInit,
    signal: args.signal,
  })
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
