import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ProxyAgent } from 'proxy-agent'
// eslint-disable-next-line import/no-extraneous-dependencies -- Desktop MCP transport honors proxy environment variables when present
import { getProxyForUrl } from 'proxy-from-env'

import type { McpServerParameters } from '../../types/mcp.types'
import { createDesktopNodeFetch } from '../llm/sdkFetch'

type McpRemoteTransportParameters = Extract<
  McpServerParameters,
  { transport: 'http' | 'sse' }
>

type McpRemoteTransportKind = McpRemoteTransportParameters['transport']

type McpRemoteTransportContext = {
  transport: McpRemoteTransportKind
  url: URL
}

type McpRemoteTransportFactory = {
  createHttpOptions: (
    params: Extract<McpRemoteTransportParameters, { transport: 'http' }>,
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

const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT'])

const CONNECTION_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EHOSTUNREACH',
])

function withProcessEnv<T>(env: NodeJS.ProcessEnv, cb: () => T): T {
  const previousEnv = process.env
  process.env = env
  try {
    return cb()
  } finally {
    process.env = previousEnv
  }
}

function createProxyAgent(env: Record<string, string>): ProxyAgent {
  const resolvedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
  }

  return new ProxyAgent({
    getProxyForUrl: (url) =>
      withProcessEnv(resolvedEnv, () => getProxyForUrl(url)),
  })
}

function createRequestInit(
  headers?: Record<string, string>,
): RequestInit | undefined {
  return headers ? { headers } : undefined
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

function classifyRemoteTransportError(error: unknown): string {
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
    code !== undefined &&
    (CONNECTION_ERROR_CODES.has(code) ||
      message.includes('fetch failed') ||
      message.includes('network'))
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
): McpRemoteTransportContext | null {
  if (params.transport !== 'http' && params.transport !== 'sse') {
    return null
  }

  return {
    transport: params.transport,
    url: new URL(params.url),
  }
}

export function getMcpRemoteTransportDiagnostics(
  context: McpRemoteTransportContext,
) {
  return {
    remoteTransport: 'node',
    transport: context.transport,
    protocol: context.url.protocol,
    host: context.url.host,
  }
}

export function createMcpRemoteTransportFactory({
  env,
}: {
  env: Record<string, string>
}): McpRemoteTransportFactory {
  const proxyAgent = createProxyAgent(env)
  const fetch = createDesktopNodeFetch({ agent: proxyAgent })

  return {
    createHttpOptions: (params) => ({
      requestInit: createRequestInit(params.headers),
      fetch:
        fetch as import('@modelcontextprotocol/sdk/shared/transport.js').FetchLike,
    }),
    createSseOptions: (params) => ({
      eventSourceInit: params.headers
        ? ({
            headers: params.headers,
          } as SSEClientTransportOptions['eventSourceInit'])
        : undefined,
      requestInit: createRequestInit(params.headers),
      fetch:
        fetch as import('@modelcontextprotocol/sdk/shared/transport.js').FetchLike,
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
    `Failed to ${actionLabel} MCP server ${serverName} via Node ${context.transport.toUpperCase()} transport (${context.url.protocol}//${context.url.host}): ${category}. ${detail}`,
  )
}
