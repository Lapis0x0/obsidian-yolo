/**
 * Tests for the proxy resolution + SOCKS fail-fast contract of
 * `createDesktopMcpFetch`. Verifies parity with the legacy
 * `createProxyAgent` semantics in `remoteTransport.ts`.
 */
import { Platform } from 'obsidian'

jest.mock('obsidian', () => ({
  Platform: { isDesktop: true },
}))

type FetchArgs = [input: unknown, init?: { dispatcher?: unknown }]
const undiciFetchMock = jest.fn(
  async (..._args: FetchArgs) => new Response('ok'),
)
const proxyAgentCtor = jest.fn()

jest.mock(
  'undici',
  () => ({
    fetch: (...args: FetchArgs) => undiciFetchMock(...args),
    ProxyAgent: function (this: { uri: string }, uri: string) {
      this.uri = uri
      proxyAgentCtor(uri)
    },
  }),
  { virtual: true },
)

const getProxyForUrlMock = jest.fn<string, [string]>()

jest.mock('proxy-from-env', () => ({
  getProxyForUrl: (url: string) => getProxyForUrlMock(url),
}))

const resolveSystemProxyMock = jest.fn<Promise<string>, [string]>()

jest.mock('../../utils/net/systemProxyResolver', () => ({
  resolveSystemProxy: (url: string) => resolveSystemProxyMock(url),
}))

import { createDesktopMcpFetch } from './desktopMcpFetch'

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

const stripProxyEnv = () => {
  const saved: Record<string, string | undefined> = {}
  for (const key of PROXY_ENV_KEYS) {
    saved[key] = process.env[key]
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- iterating a fixed allowlist of proxy env keys to isolate test state
    delete process.env[key]
  }
  return () => {
    for (const key of PROXY_ENV_KEYS) {
      const v = saved[key]
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- restoring the same fixed allowlist of proxy env keys
      if (v === undefined) delete process.env[key]
      else process.env[key] = v
    }
  }
}

describe('desktopMcpFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    undiciFetchMock.mockResolvedValue(new Response('ok'))
    resolveSystemProxyMock.mockResolvedValue('')
    getProxyForUrlMock.mockReturnValue('')
  })

  it('throws on non-desktop platforms without touching undici / proxy mocks', async () => {
    ;(Platform as { isDesktop: boolean }).isDesktop = false
    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await expect(fetchFn('https://example.com')).rejects.toThrow(
        /only available on desktop/,
      )
      // Mobile-safety contract: the platform check must precede any lazy
      // import / proxy resolution work. None of the network-side mocks
      // should fire on this code path.
      expect(undiciFetchMock).not.toHaveBeenCalled()
      expect(proxyAgentCtor).not.toHaveBeenCalled()
      expect(resolveSystemProxyMock).not.toHaveBeenCalled()
      expect(getProxyForUrlMock).not.toHaveBeenCalled()
    } finally {
      ;(Platform as { isDesktop: boolean }).isDesktop = true
    }
  })

  it('fails fast when env resolves to socks5:// (env path, not just system proxy)', async () => {
    const restore = stripProxyEnv()
    getProxyForUrlMock.mockReturnValue('socks5://127.0.0.1:1080')

    try {
      const fetchFn = createDesktopMcpFetch({
        env: { ALL_PROXY: 'socks5://127.0.0.1:1080' },
      })
      await expect(fetchFn('https://example.com/mcp')).rejects.toThrow(
        /SOCKS proxy is not supported/i,
      )
      // Env path resolved the proxy; the request must short-circuit before
      // touching undici.
      expect(undiciFetchMock).not.toHaveBeenCalled()
      expect(proxyAgentCtor).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('bypasses proxy for loopback / private destinations', async () => {
    const restore = stripProxyEnv()
    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await fetchFn('http://127.0.0.1:3005/mcp')

      expect(proxyAgentCtor).not.toHaveBeenCalled()
      expect(resolveSystemProxyMock).not.toHaveBeenCalled()
      expect(undiciFetchMock).toHaveBeenCalledTimes(1)
      const init = undiciFetchMock.mock.calls[0][1]
      expect(init?.dispatcher).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('honors shell env proxy via temporary process.env swap (env parity)', async () => {
    const restore = stripProxyEnv()
    process.env.HTTPS_PROXY = 'http://process-only.local:3128'

    // Implementation must swap process.env so getProxyForUrl observes the
    // shell-supplied value, not the long-lived process value.
    getProxyForUrlMock.mockImplementation(
      () => process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '',
    )

    try {
      const fetchFn = createDesktopMcpFetch({
        env: { HTTPS_PROXY: 'http://shell-proxy.local:8080' },
      })
      await fetchFn('https://example.com/mcp')

      expect(proxyAgentCtor).toHaveBeenCalledWith(
        'http://shell-proxy.local:8080',
      )
      // process.env restored after the swap.
      expect(process.env.HTTPS_PROXY).toBe('http://process-only.local:3128')
    } finally {
      restore()
    }
  })

  it('respects lowercase env keys and NO_PROXY (env parity)', async () => {
    const restore = stripProxyEnv()
    getProxyForUrlMock.mockImplementation((url) => {
      // emulate proxy-from-env: NO_PROXY hits → ''
      if (process.env.no_proxy && url.includes('skip.example.com')) return ''
      return process.env.http_proxy ?? ''
    })

    try {
      const fetchFn = createDesktopMcpFetch({
        env: {
          http_proxy: 'http://lower-case.local:3128',
          no_proxy: 'skip.example.com',
        },
      })

      await fetchFn('http://other.example.com/mcp')
      expect(proxyAgentCtor).toHaveBeenCalledWith(
        'http://lower-case.local:3128',
      )

      proxyAgentCtor.mockClear()
      await fetchFn('http://skip.example.com/mcp')
      expect(proxyAgentCtor).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('falls back to resolveSystemProxy when no env proxy is set', async () => {
    const restore = stripProxyEnv()
    resolveSystemProxyMock.mockResolvedValue('http://system-proxy.corp:8080')

    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await fetchFn('https://corp.example.com/mcp')

      expect(resolveSystemProxyMock).toHaveBeenCalledWith(
        'https://corp.example.com/mcp',
      )
      expect(proxyAgentCtor).toHaveBeenCalledWith(
        'http://system-proxy.corp:8080',
      )
    } finally {
      restore()
    }
  })

  it('caches ProxyAgent per proxy URI across requests', async () => {
    const restore = stripProxyEnv()
    resolveSystemProxyMock.mockResolvedValue('http://cached.corp:8080')

    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await fetchFn('https://a.example.com')
      await fetchFn('https://b.example.com')

      expect(proxyAgentCtor).toHaveBeenCalledTimes(1)
      expect(proxyAgentCtor).toHaveBeenCalledWith('http://cached.corp:8080')
    } finally {
      restore()
    }
  })

  it('preserves resolveSystemProxy silent degrade (empty string → direct)', async () => {
    const restore = stripProxyEnv()
    resolveSystemProxyMock.mockResolvedValue('')

    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await fetchFn('https://anywhere.example.com')

      expect(proxyAgentCtor).not.toHaveBeenCalled()
      const init = undiciFetchMock.mock.calls[0][1]
      expect(init?.dispatcher).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('fails fast on socks5:// resolved proxy (no fallback)', async () => {
    const restore = stripProxyEnv()
    resolveSystemProxyMock.mockResolvedValue('socks5://127.0.0.1:1080')

    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await expect(fetchFn('https://example.com/mcp')).rejects.toThrow(
        /SOCKS proxy is not supported/i,
      )

      expect(undiciFetchMock).not.toHaveBeenCalled()
      expect(proxyAgentCtor).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('fails fast on socks4:// resolved proxy', async () => {
    const restore = stripProxyEnv()
    resolveSystemProxyMock.mockResolvedValue('socks4://127.0.0.1:1080')

    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await expect(fetchFn('https://example.com/mcp')).rejects.toThrow(
        /SOCKS proxy is not supported/i,
      )
    } finally {
      restore()
    }
  })
})
