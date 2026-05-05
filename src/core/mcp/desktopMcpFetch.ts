/**
 * MCP-only desktop fetch backed by Chromium's `globalThis.fetch` so that
 * `StreamableHTTPClientTransport` receives a working WHATWG `ReadableStream`
 * body for SSE streaming.
 *
 * Why not undici: undici@6 in Electron renderer has multiple incompatibilities
 * — timer `.unref()` crash and chunked-body decoder not pumping data through.
 * Chromium fetch handles SSE natively and uses the system proxy automatically
 * (Electron resolves it via Chromium's network stack), which covers the common
 * case (macOS system proxy, Clash TUN/system mode, Windows network proxy, etc).
 *
 * Trade-off: shell-only `HTTP_PROXY` / `HTTPS_PROXY` env vars without an
 * accompanying system proxy are not honored. Affected users should configure
 * the proxy at the OS / Clash system level.
 *
 * Why not Obsidian `requestUrl`: it is buffered (no ReadableStream), which
 * silently breaks SSE consumption in the SDK.
 */
import { Platform } from 'obsidian'

import { envHasProxy } from '../../utils/net/proxyEnv'

export type DesktopMcpFetchOptions = {
  /**
   * Shell environment merged from `shellEnvSync()` upstream. Only used to
   * detect env-only proxy configuration and emit a one-time warning so users
   * understand why their `HTTP_PROXY` is being ignored.
   */
  env: Record<string, string>
}

let envProxyWarningEmitted = false

export const createDesktopMcpFetch = (
  options: DesktopMcpFetchOptions,
): typeof fetch => {
  if (!envProxyWarningEmitted && envHasProxy(options.env)) {
    envProxyWarningEmitted = true
    console.warn(
      '[YOLO] MCP HTTP transport uses Chromium fetch and respects the system proxy, ' +
        'not shell HTTP_PROXY/HTTPS_PROXY env vars. If your MCP server requires a proxy, ' +
        'configure it at the OS or Clash system level.',
    )
  }

  return async (input, init) => {
    if (!Platform.isDesktop) {
      throw new Error(
        'MCP remote HTTP transport is only available on desktop Obsidian.',
      )
    }
    return globalThis.fetch(input, init)
  }
}
