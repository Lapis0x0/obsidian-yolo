/**
 * MCP-only desktop fetch built on `undici` so that
 * `StreamableHTTPClientTransport` receives a WHATWG `ReadableStream` body
 * (with `pipeThrough`/`getReader`). `node-fetch@2` returns Node `Readable`,
 * which silently breaks the SDK's SSE consumption — see issue #252.
 *
 * Scope is intentionally narrow: this fetch is **only** wired into
 * `remoteTransport.ts`. The LLM SDK fetch in `core/llm/sdkFetch.ts` is left
 * untouched.
 */
import { Platform } from 'obsidian'

import { shouldBypassProxy } from '../../utils/net/proxyBypass'
import { envHasProxy, withProcessEnv } from '../../utils/net/proxyEnv'
import { resolveSystemProxy } from '../../utils/net/systemProxyResolver'

// Lazy-loaded undici module (desktop-only). Mobile must never reach this path.
type UndiciFetch = typeof globalThis.fetch
// Opaque branded type — undici's `Dispatcher` shape is irrelevant to us; we
// only ever pass it through to `fetch`'s `dispatcher` slot.
type UndiciDispatcher = { readonly __undiciDispatcher: unique symbol }
type UndiciModule = {
  fetch: UndiciFetch
  ProxyAgent: new (uri: string) => UndiciDispatcher
}

let undiciModulePromise: Promise<UndiciModule> | null = null

const loadUndici = (): Promise<UndiciModule> => {
  if (!undiciModulePromise) {
    undiciModulePromise = import('undici').then(
      (mod) =>
        ({
          fetch: mod.fetch as unknown as UndiciFetch,
          ProxyAgent: mod.ProxyAgent as unknown as new (
            uri: string,
          ) => UndiciDispatcher,
        }) satisfies UndiciModule,
    )
  }
  return undiciModulePromise
}

type ProxyFromEnvModule = {
  getProxyForUrl: (url: string) => string
}

let proxyFromEnvPromise: Promise<ProxyFromEnvModule> | null = null

const loadProxyFromEnv = (): Promise<ProxyFromEnvModule> => {
  if (!proxyFromEnvPromise) {
    proxyFromEnvPromise = import('proxy-from-env').then(
      (mod) => mod as ProxyFromEnvModule,
    )
  }
  return proxyFromEnvPromise
}

const isSocksProxy = (uri: string): boolean =>
  /^socks[45]?:\/\//i.test(uri.trim())

class UnsupportedSocksProxyError extends Error {
  readonly code = 'YOLO_MCP_SOCKS_UNSUPPORTED'
  constructor(uri: string) {
    super(
      `SOCKS proxy is not supported by Streamable HTTP MCP transport (resolved proxy: ${uri}). ` +
        `Please configure an HTTP/HTTPS proxy or add this MCP server's host to your bypass list.`,
    )
    this.name = 'UnsupportedSocksProxyError'
  }
}

export type DesktopMcpFetchOptions = {
  /**
   * Shell environment merged from `shellEnvSync()` upstream. May legitimately
   * carry HTTP(S)_PROXY values that are not in `process.env`, so the resolver
   * temporarily swaps `process.env` for `proxy-from-env` to observe them.
   */
  env: Record<string, string>
}

/**
 * Resolve a proxy URI for `targetUrl` using the same precedence as the
 * legacy `createProxyAgent` in `remoteTransport.ts`:
 *   1. Local/private destinations → DIRECT.
 *   2. Explicit env proxy (`*_PROXY` / `NO_PROXY`, mixed case) → `proxy-from-env`.
 *   3. Otherwise → Electron system proxy resolver.
 *
 * `resolveSystemProxy` intentionally degrades to `''` (DIRECT) on PAC
 * `DIRECT` or Electron failures; that behavior is preserved.
 */
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

/**
 * Build the MCP-only desktop fetch. The factory is **synchronous** so the
 * existing `McpRemoteTransportFactory` signature (and `mcpManager.ts`) stay
 * untouched. The returned `fetch` is async and lazy-loads `undici` on first
 * call, with a module-level promise cache.
 */
export const createDesktopMcpFetch = (
  options: DesktopMcpFetchOptions,
): typeof fetch => {
  const resolvedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  }

  // ProxyAgent cache keyed by proxy URI to avoid rebuilding per request.
  const dispatcherCache = new Map<string, UndiciDispatcher>()

  return async (input, init) => {
    if (!Platform.isDesktop) {
      throw new Error(
        'MCP remote HTTP transport is only available on desktop Obsidian.',
      )
    }

    const targetUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    const proxyUri = await resolveProxyUri(targetUrl, resolvedEnv)

    if (proxyUri && isSocksProxy(proxyUri)) {
      throw new UnsupportedSocksProxyError(proxyUri)
    }

    const { fetch: undiciFetch, ProxyAgent } = await loadUndici()

    let dispatcher: UndiciDispatcher | undefined
    if (proxyUri) {
      const cached = dispatcherCache.get(proxyUri)
      if (cached) {
        dispatcher = cached
      } else {
        dispatcher = new ProxyAgent(proxyUri)
        dispatcherCache.set(proxyUri, dispatcher)
      }
    }

    // undici's fetch accepts `dispatcher` on RequestInit but the standard
    // RequestInit type doesn't include it; cast at the boundary only.
    const undiciInit = dispatcher
      ? ({ ...(init ?? {}), dispatcher } as RequestInit)
      : init

    return undiciFetch(input, undiciInit)
  }
}
