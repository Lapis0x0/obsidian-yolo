import { Platform } from 'obsidian'

import type { RequestTransportMode } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'
import { shouldBypassProxy } from '../../utils/net/proxyBypass'
import { resolveSystemProxy } from '../../utils/net/systemProxyResolver'

type RequestOptions = import('node:http').RequestOptions

let nodeFetchPromise: Promise<typeof fetch> | null = null
let desktopProxyAgent: RequestOptions['agent'] | null | undefined

type NodeFetchRequestInit = RequestInit & {
  agent?: RequestOptions['agent']
}

export type DesktopNodeFetchOptions = {
  agent?: RequestOptions['agent']
}

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

const envHasProxy = (env: NodeJS.ProcessEnv): boolean =>
  PROXY_ENV_KEYS.some((key) => typeof env[key] === 'string' && env[key]?.trim())

const getDesktopProxyAgent = async (): Promise<
  RequestOptions['agent'] | undefined
> => {
  if (desktopProxyAgent !== undefined) {
    return desktopProxyAgent ?? undefined
  }

  const [{ ProxyAgent }, { getProxyForUrl }] = await Promise.all([
    import('proxy-agent'),
    import('proxy-from-env'),
  ])

  // proxy-agent@6.5.0 accepts `Promise<string>` from getProxyForUrl.
  // Decision order per URL:
  //   1. Local/private destinations — always DIRECT (matches curl/VS Code).
  //   2. Explicit HTTP(S)_PROXY/NO_PROXY env — honor the user's override.
  //   3. Otherwise delegate to Chromium via @electron/remote, giving parity
  //      with Obsidian's requestUrl and globalThis.fetch on all 3 OSes.
  desktopProxyAgent = new ProxyAgent({
    getProxyForUrl: async (url: string): Promise<string> => {
      if (shouldBypassProxy(url)) return ''
      if (envHasProxy(process.env)) return getProxyForUrl(url)
      return resolveSystemProxy(url)
    },
  })
  return desktopProxyAgent
}

const loadNodeFetch = async (): Promise<typeof fetch> => {
  if (!nodeFetchPromise) {
    nodeFetchPromise = import('node-fetch/lib/index.js').then(
      (module) =>
        ((module as unknown as { default?: typeof fetch }).default ??
          module) as unknown as typeof fetch,
    )
  }

  return nodeFetchPromise
}

export const createDesktopNodeFetch = (
  options: DesktopNodeFetchOptions = {},
): typeof fetch => {
  return async (input, init) => {
    if (!Platform.isDesktop) {
      throw new Error(
        'Node request transport is only available on desktop Obsidian.',
      )
    }

    const nodeFetch = await loadNodeFetch()
    const defaultAgent = options.agent ?? (await getDesktopProxyAgent())
    const baseInit = init as NodeFetchRequestInit | undefined
    const requestInit: NodeFetchRequestInit | undefined = init
      ? {
          ...init,
          agent: baseInit?.agent ?? defaultAgent,
        }
      : defaultAgent
        ? { agent: defaultAgent }
        : undefined

    return nodeFetch(input, requestInit)
  }
}

export const createSdkFetchForTransportMode = (
  mode: RequestTransportMode,
): typeof fetch | undefined => {
  if (mode === 'obsidian') {
    return createObsidianFetch()
  }

  if (mode === 'node') {
    return createDesktopNodeFetch()
  }

  return undefined
}
