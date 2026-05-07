/**
 * MCP-only desktop fetch with automatic fallback.
 *
 * 1. `globalThis.fetch` (primary):
 *    - Chromium networking -> system proxy, TLS.
 *    - Native WHATWG `ReadableStream` body (`pipeThrough` / `getReader`).
 *    - Supports Streamable HTTP SSE streaming.
 *    - Fails on CORS if the server lacks `Access-Control-Allow-*` headers.
 *
 * 2. `node-fetch@2` (fallback):
 *    - Node.js `http`/`https` -> no CORS, works in any Electron renderer.
 *    - Body is a Node.js `Readable` (no `pipeThrough`), so SSE streaming
 *      may not work, but standard MCP JSON request/response always succeeds.
 *
 * Fallback logic: `globalThis.fetch` is tried first. If it throws a
 * `TypeError: Failed to fetch` (CORS / network error), the request is
 * retried with `node-fetch@2`. Successful backends are cached per host
 * to avoid repeated retries.
 *
 * We avoid the `undici` npm package (timer `.unref()` crash in Electron).
 *
 * Scope: only wired into `remoteTransport.ts`. LLM transport is untouched.
 */
import { Platform } from 'obsidian'

import { shouldBypassProxy } from '../../utils/net/proxyBypass'
import { envHasProxy, withProcessEnv } from '../../utils/net/proxyEnv'
import { resolveSystemProxy } from '../../utils/net/systemProxyResolver'

type RequestOptions = import('node:http').RequestOptions

// ---- proxy utilities (for node-fetch fallback) ----

const isSocksProxy = (uri: string): boolean =>
  /^socks[45]?:\/\//i.test(uri.trim())

class UnsupportedSocksProxyError extends Error {
  readonly code = 'YOLO_MCP_SOCKS_UNSUPPORTED'
  constructor(uri: string) {
    super(`SOCKS proxy is not supported (node-fetch, proxy: ${uri}).`)
    this.name = 'UnsupportedSocksProxyError'
  }
}

type ProxyFromEnvModule = { getProxyForUrl: (url: string) => string }

let proxyFromEnvPromise: Promise<ProxyFromEnvModule> | null = null

const loadProxyFromEnv = (): Promise<ProxyFromEnvModule> => {
  if (!proxyFromEnvPromise)
    proxyFromEnvPromise = import('proxy-from-env').then(
      (mod) => mod as ProxyFromEnvModule,
    )
  return proxyFromEnvPromise
}

const resolveProxyUri = async (
  targetUrl: string,
  resolvedEnv: NodeJS.ProcessEnv,
): Promise<string> => {
  if (shouldBypassProxy(targetUrl)) return ''
  if (envHasProxy(resolvedEnv)) {
    const { getProxyForUrl } = await loadProxyFromEnv()
    return withProcessEnv(resolvedEnv, () => getProxyForUrl(targetUrl))
  }
  return resolveSystemProxy(targetUrl)
}

// ---- node-fetch (fallback) ----

let nodeFetchPromise: Promise<typeof fetch> | null = null

const loadNodeFetch = (): Promise<typeof fetch> => {
  if (!nodeFetchPromise) {
    nodeFetchPromise = import('node-fetch/lib/index.js').then(
      (module) =>
        ((module as unknown as { default?: typeof fetch }).default ??
          module) as unknown as typeof fetch,
    )
  }
  return nodeFetchPromise
}

let proxyAgentPromise: Promise<{
  ProxyAgent: new (...args: unknown[]) => RequestOptions['agent']
}> | null = null

const loadProxyAgent = (): Promise<{
  ProxyAgent: new (...args: unknown[]) => RequestOptions['agent']
}> => {
  if (!proxyAgentPromise) proxyAgentPromise = import('proxy-agent')
  return proxyAgentPromise
}

const createProxyAgent = async (
  resolvedEnv: NodeJS.ProcessEnv,
): Promise<RequestOptions['agent'] | undefined> => {
  const [{ ProxyAgent }, { getProxyForUrl }] = await Promise.all([
    loadProxyAgent(),
    loadProxyFromEnv(),
  ])
  return new ProxyAgent({
    getProxyForUrl: async (url: string): Promise<string> => {
      if (shouldBypassProxy(url)) return ''
      if (envHasProxy(resolvedEnv))
        return withProcessEnv(resolvedEnv, () => getProxyForUrl(url))
      return resolveSystemProxy(url)
    },
  })
}

// ---- fallback routing ----

/**
 * Returns true when the error looks like a CORS / network failure that
 * should trigger a fallback to node-fetch. We only retry on
 * `TypeError: Failed to fetch` which is what Chromium throws for blocked
 * cross-origin requests. Real server errors (4xx/5xx) are NOT retried.
 */
const isCorsLikeError = (error: unknown): boolean =>
  error instanceof TypeError && error.message === 'Failed to fetch'

/**
 * Per-host cache of which transport succeeded last. `true` = globalThis.fetch
 * worked, `false` = node-fetch was needed. Cached so we don't retry CORS
 * failures on every request to the same server.
 */
const hostTransportCache = new Map<string, boolean>()

// ---- factory ----

export type DesktopMcpFetchOptions = { env: Record<string, string> }

export const createDesktopMcpFetch = (
  options: DesktopMcpFetchOptions,
): typeof fetch => {
  const resolvedEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env }
  let nodeFetchFn: typeof fetch | null = null
  let agent: RequestOptions['agent'] | undefined | null

  const makeNodeFetchRequest = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    // SOCKS fail-fast - must happen before creating proxy-agent.
    const targetUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const proxyUri = await resolveProxyUri(targetUrl, resolvedEnv)
    if (proxyUri && isSocksProxy(proxyUri))
      throw new UnsupportedSocksProxyError(proxyUri)

    if (!nodeFetchFn) nodeFetchFn = await loadNodeFetch()
    if (!agent) agent = await createProxyAgent(resolvedEnv)

    const reqInit: RequestInit & {
      agent?: RequestOptions['agent']
    } = init
      ? { ...init, agent: agent ?? undefined }
      : { agent: agent ?? undefined }
    return nodeFetchFn(input, reqInit)
  }

  return async (input, init) => {
    if (!Platform.isDesktop)
      throw new Error(
        'MCP remote HTTP transport is only available on desktop Obsidian.',
      )

    const targetUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const host = new URL(targetUrl).host

    // Use cached transport preference for this host if available.
    const cached = hostTransportCache.get(host)
    if (cached === false) return makeNodeFetchRequest(input, init)

    // Try globalThis.fetch first (streaming support). Fall back to
    // node-fetch on CORS / network failures.
    try {
      const res = await globalThis.fetch(input, init)
      // Success - cache that globalThis.fetch works for this host.
      hostTransportCache.set(host, true)
      return res
    } catch (error) {
      if (isCorsLikeError(error)) {
        // CORS blocked - fall back to node-fetch and cache the decision.
        hostTransportCache.set(host, false)
        return makeNodeFetchRequest(input, init)
      }
      throw error
    }
  }
}
