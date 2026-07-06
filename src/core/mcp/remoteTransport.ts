import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Platform, type RequestUrlParam, requestUrl } from 'obsidian'

import type { McpServerParameters } from '../../types/mcp.types'
import { createLLMDebugFetch } from '../llm/debugCapture'

import { createDesktopMcpFetch } from './desktopMcpFetch'

type McpRemoteTransportParameters = Extract<
  McpServerParameters,
  { transport: 'http' | 'sse' }
>

type McpRemoteTransportKind = McpRemoteTransportParameters['transport']

export type McpRemoteTransportBackend =
  | 'chromium-fetch'
  | 'obsidian-request-url-json'

type McpRemoteTransportContext = {
  transport: McpRemoteTransportKind
  url: URL
  backend: McpRemoteTransportBackend
}

type McpRemoteTransportFactory = {
  createHttpOptions: (
    params: Extract<McpRemoteTransportParameters, { transport: 'http' }>,
    backend?: McpRemoteTransportBackend,
  ) => StreamableHTTPClientTransportOptions
  createSseOptions: (
    params: Extract<McpRemoteTransportParameters, { transport: 'sse' }>,
  ) => SSEClientTransportOptions
}

type McpRemoteTransportErrorOptions = {
  serverName: string
  action: 'connect' | 'list tools'
  context: McpRemoteTransportContext
  error: unknown
}

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  // undici timeout codes (see scripts spike for issue #252)
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

const CONNECTION_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EHOSTUNREACH',
  // undici socket/network errors
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_DESTROYED',
])

const REQUEST_URL_JSON_BACKEND_TIMEOUT_MS = 60_000

function createRequestInit(
  headers?: Record<string, string>,
): RequestInit | undefined {
  return headers ? { headers } : undefined
}

function headersInitToRecord(
  headers?: HeadersInit | null,
): Record<string, string> {
  if (!headers) {
    return {}
  }

  if (headers instanceof Headers) {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
      record[key] = value
    })
    return record
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }

  return { ...headers }
}

function getHeaderValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase()
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedName,
  )
  return entry?.[1]
}

async function requestBodyToBufferedBody(
  body: BodyInit | null | undefined,
): Promise<RequestUrlParam['body'] | undefined> {
  if (body === null || body === undefined) {
    return undefined
  }

  if (typeof body === 'string' || body instanceof ArrayBuffer) {
    return body
  }

  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }

  if (body instanceof URLSearchParams) {
    return body.toString()
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.arrayBuffer()
  }

  throw new Error(
    'MCP HTTP JSON backend only supports buffered request bodies.',
  )
}

function requestInputToUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}

function getRequestMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (init?.method) {
    return init.method
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method
  }

  return 'GET'
}

function getRequestHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
): Record<string, string> {
  const inputHeaders =
    typeof Request !== 'undefined' && input instanceof Request
      ? headersInitToRecord(input.headers)
      : {}
  return {
    ...inputHeaders,
    ...headersInitToRecord(init?.headers),
  }
}

function requestUrlWithAbort(
  params: RequestUrlParam,
  signal?: AbortSignal | null,
) {
  if (signal?.aborted) {
    throw new Error('MCP HTTP JSON backend request aborted')
  }

  const requestPromise = requestUrl(params)

  return new Promise<Awaited<typeof requestPromise>>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
      reject(
        new Error(
          `MCP HTTP JSON backend request timed out after ${REQUEST_URL_JSON_BACKEND_TIMEOUT_MS}ms`,
        ),
      )
    }, REQUEST_URL_JSON_BACKEND_TIMEOUT_MS)

    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('MCP HTTP JSON backend request aborted'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    requestPromise.then(
      (response) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(response)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function createRequestUrlJsonFetch(): typeof fetch {
  return createLLMDebugFetch(async (input, init) => {
    if (!Platform.isDesktop) {
      throw new Error(
        'MCP remote HTTP transport is only available on desktop Obsidian.',
      )
    }

    const url = requestInputToUrl(input)
    const headers = getRequestHeaders(input, init)
    const response = await requestUrlWithAbort(
      {
        url,
        method: getRequestMethod(input, init),
        headers,
        contentType: getHeaderValue(headers, 'content-type'),
        body: await requestBodyToBufferedBody(init?.body),
        throw: false,
      },
      init?.signal,
    )
    const responseHeaders = response.headers ?? {}
    const contentType = getHeaderValue(responseHeaders, 'content-type')

    if (contentType?.toLowerCase().includes('text/event-stream')) {
      throw new Error(
        'MCP HTTP JSON backend does not support text/event-stream responses.',
      )
    }

    return new Response(response.arrayBuffer, {
      status: response.status,
      headers: responseHeaders,
    })
  }, 'mcp')
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : JSON.stringify(error)
}

function getErrorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code
  }

  if (
    error !== null &&
    typeof error === 'object' &&
    'cause' in error &&
    error.cause !== undefined
  ) {
    return getErrorCode(error.cause)
  }

  return undefined
}

export function classifyRemoteTransportError(error: unknown): string {
  const code = getErrorCode(error)
  const message = getErrorMessage(error).toLowerCase()

  if (
    code !== undefined &&
    (TIMEOUT_ERROR_CODES.has(code) || message.includes('timeout'))
  ) {
    return 'request timed out'
  }

  if (
    code !== undefined &&
    (TLS_ERROR_CODES.has(code) ||
      message.includes('certificate') ||
      message.includes('tls'))
  ) {
    return 'TLS/certificate negotiation failed'
  }

  if (
    message.includes('proxy') ||
    message.includes('socks') ||
    message.includes('pac')
  ) {
    return 'proxy negotiation failed'
  }

  if (
    (code !== undefined && CONNECTION_ERROR_CODES.has(code)) ||
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('network')
  ) {
    return 'network connection failed'
  }

  if (
    message.includes('401') ||
    message.includes('403') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  ) {
    return 'authentication failed'
  }

  if (
    message.includes('404') ||
    message.includes('405') ||
    message.includes('5xx') ||
    message.includes('bad gateway') ||
    message.includes('service unavailable')
  ) {
    return 'server responded with an HTTP error'
  }

  if (
    message.includes('eventsource') ||
    message.includes('stream') ||
    message.includes('premature close') ||
    message.includes('terminated')
  ) {
    return 'streaming connection was interrupted'
  }

  return 'remote transport failed'
}

export function getMcpRemoteTransportContext(
  params: McpServerParameters,
  backend: McpRemoteTransportBackend = 'chromium-fetch',
): McpRemoteTransportContext | null {
  if (params.transport !== 'http' && params.transport !== 'sse') {
    return null
  }

  return {
    transport: params.transport,
    url: new URL(params.url),
    backend,
  }
}

export function getMcpRemoteTransportDiagnostics(
  context: McpRemoteTransportContext,
) {
  return {
    remoteTransport: context.backend,
    transport: context.transport,
    protocol: context.url.protocol,
    host: context.url.host,
  }
}

export function shouldRetryMcpHttpWithJsonBackend({
  params,
  error,
}: {
  params: McpServerParameters
  error: unknown
}): boolean {
  if (params.transport !== 'http') {
    return false
  }

  const message = getErrorMessage(error).toLowerCase()
  return (
    message.includes('failed to fetch') ||
    message.includes('load failed') ||
    message.includes('networkerror when attempting to fetch resource')
  )
}

export function createMcpRemoteTransportFactory({
  env,
}: {
  env: Record<string, string>
}): McpRemoteTransportFactory {
  // Backed by Chromium's `globalThis.fetch` (via createDesktopMcpFetch) so
  // the MCP SDK's `StreamableHTTPClientTransport` receives a working WHATWG
  // ReadableStream body for SSE streaming. Earlier attempts using
  // `node-fetch@2` (no streams) and `undici` (renderer-incompatible) both
  // failed in the Electron renderer environment.
  const chromiumFetch = createDesktopMcpFetch({ env })
  let requestUrlJsonFetch: typeof fetch | null = null

  return {
    createHttpOptions: (params, backend = 'chromium-fetch') => {
      if (backend === 'obsidian-request-url-json') {
        requestUrlJsonFetch ??= createRequestUrlJsonFetch()
      }

      const fetch =
        backend === 'obsidian-request-url-json'
          ? requestUrlJsonFetch
          : chromiumFetch

      return {
        requestInit: createRequestInit(params.headers),
        fetch:
          fetch as import('@modelcontextprotocol/sdk/shared/transport.js').FetchLike,
      }
    },
    createSseOptions: (params) => ({
      eventSourceInit: params.headers
        ? ({
            headers: params.headers,
          } as SSEClientTransportOptions['eventSourceInit'])
        : undefined,
      requestInit: createRequestInit(params.headers),
      fetch:
        chromiumFetch as import('@modelcontextprotocol/sdk/shared/transport.js').FetchLike,
    }),
  }
}

export function createMcpRemoteTransportError({
  serverName,
  action,
  context,
  error,
}: McpRemoteTransportErrorOptions): Error {
  const category = classifyRemoteTransportError(error)
  const detail = getErrorMessage(error)
  const actionLabel = action === 'connect' ? 'connect to' : 'list tools for'

  return new Error(
    `Failed to ${actionLabel} MCP server ${serverName} via ${context.transport.toUpperCase()} transport (${context.url.protocol}//${context.url.host}): ${category}. ${detail}`,
  )
}
