import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'
import { createDesktopNodeFetch } from '../llm/sdkFetch'

import type { AsrHttpResponse } from './httpTransport'
import type { AsrUploadProgressCallback } from './types'

type RawBody = string | ArrayBuffer | Uint8Array
type NodeReadable = import('node:stream').Readable
const UPLOAD_PROGRESS_CHUNK_BYTES = 256 * 1024

export async function sendViaNodeHttp(args: {
  url: string
  method: string
  headers: Record<string, string>
  body?: RawBody
  signal?: AbortSignal
  onUploadProgress?: AsrUploadProgressCallback
}): Promise<AsrHttpResponse> {
  const nodeFetch = createDesktopNodeFetch()
  const { body, headers } = await prepareNodeFetchBody(args.body, {
    headers: args.headers,
    onUploadProgress: args.onUploadProgress,
  })
  const response = await nodeFetch(args.url, {
    method: args.method,
    headers,
    body: body as BodyInit,
    signal: args.signal,
  })
  const text = await response.text()
  return {
    status: response.status,
    json: safeJsonParse(text),
    text,
  }
}

function prepareNodeFetchBody(
  body: RawBody | undefined,
  options: {
    headers: Record<string, string>
    onUploadProgress?: AsrUploadProgressCallback
  },
): Promise<{ body?: RawBody | NodeReadable; headers: Record<string, string> }> {
  if (!body || !options.onUploadProgress) {
    return Promise.resolve({ body, headers: options.headers })
  }
  const buffer = toBuffer(body)
  const headers = { ...options.headers }
  if (!hasHeader(headers, 'content-length')) {
    headers['content-length'] = String(buffer.byteLength)
  }
  return createProgressReadable(buffer, options.onUploadProgress).then(
    (stream) => ({
      body: stream,
      headers,
    }),
  )
}

async function createProgressReadable(
  buffer: Buffer,
  onUploadProgress: AsrUploadProgressCallback,
): Promise<NodeReadable> {
  const { Readable } =
    await loadDesktopNodeModule<typeof import('node:stream')>('node:stream')
  async function* chunks() {
    const totalBytes = buffer.byteLength
    onUploadProgress({ sentBytes: 0, totalBytes })
    for (
      let offset = 0;
      offset < totalBytes;
      offset += UPLOAD_PROGRESS_CHUNK_BYTES
    ) {
      const end = Math.min(totalBytes, offset + UPLOAD_PROGRESS_CHUNK_BYTES)
      onUploadProgress({ sentBytes: end, totalBytes })
      yield buffer.subarray(offset, end)
    }
  }
  return Readable.from(chunks())
}

function toBuffer(body: RawBody): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
}

function hasHeader(
  headers: Record<string, string>,
  headerName: string,
): boolean {
  const lower = headerName.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}

const safeJsonParse = (text: string): unknown => {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
