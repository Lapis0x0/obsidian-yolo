/**
 * Tests for `createDesktopMcpFetch`.
 *
 * `globalThis.fetch` is mocked to always throw a CORS-like error, so all
 * tests exercise the `node-fetch` fallback path (including the per-host
 * caching logic that skips `globalThis.fetch` after the first failure).
 */
import { Platform } from 'obsidian'

const originalFetch = globalThis.fetch

beforeAll(() => {
  ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = jest
    .fn()
    .mockRejectedValue(new TypeError('Failed to fetch'))
})

afterAll(() => {
  ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch
})

jest.mock('obsidian', () => ({ Platform: { isDesktop: true } }))

type NodeFetchArgs = [input: unknown, init?: { agent?: unknown }]
const nodeFetchMock = jest.fn(
  async (..._args: NodeFetchArgs) => new Response('ok'),
)

jest.mock(
  'node-fetch/lib/index.js',
  () => ({ default: (...args: NodeFetchArgs) => nodeFetchMock(...args) }),
  { virtual: true },
)

const proxyAgentCtor = jest.fn()
const proxyAgentInstance = { _proxyAgent: true }

jest.mock(
  'proxy-agent',
  () => ({
    ProxyAgent: jest.fn().mockImplementation((..._args: unknown[]) => {
      proxyAgentCtor(..._args)
      return proxyAgentInstance
    }),
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
    delete process.env[key]
  }
  return () => {
    for (const key of PROXY_ENV_KEYS) {
      const v = saved[key]
      if (v === undefined) delete process.env[key]
      else process.env[key] = v
    }
  }
}

describe('desktopMcpFetch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    nodeFetchMock.mockResolvedValue(new Response('ok'))
    resolveSystemProxyMock.mockResolvedValue('')
    getProxyForUrlMock.mockReturnValue('')
  })

  it('throws on non-desktop platforms', async () => {
    ;(Platform as { isDesktop: boolean }).isDesktop = false
    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await expect(fetchFn('https://example.com')).rejects.toThrow(
        /only available on desktop/,
      )
      expect(nodeFetchMock).not.toHaveBeenCalled()
    } finally {
      ;(Platform as { isDesktop: boolean }).isDesktop = true
    }
  })

  it('fails fast on socks5 proxy', async () => {
    const restore = stripProxyEnv()
    getProxyForUrlMock.mockReturnValue('socks5://127.0.0.1:1080')
    try {
      const fetchFn = createDesktopMcpFetch({
        env: { ALL_PROXY: 'socks5://127.0.0.1:1080' },
      })
      await expect(fetchFn('https://example.com/mcp')).rejects.toThrow(
        /SOCKS proxy is not supported/i,
      )
      expect(nodeFetchMock).not.toHaveBeenCalled()
      expect(proxyAgentCtor).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('bypasses system proxy for loopback', async () => {
    const restore = stripProxyEnv()
    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await fetchFn('http://127.0.0.1:3005/mcp')
      expect(resolveSystemProxyMock).not.toHaveBeenCalled()
      expect(nodeFetchMock).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('returns node-fetch response with working json/text', async () => {
    const restore = stripProxyEnv()
    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      const res = await fetchFn('http://127.0.0.1:3005/mcp')
      expect(res.status).toBe(200)
      expect(typeof res.json).toBe('function')
      expect(typeof res.text).toBe('function')
    } finally {
      restore()
    }
  })

  it('passes proxy-agent to node-fetch', async () => {
    const restore = stripProxyEnv()
    resolveSystemProxyMock.mockResolvedValue('http://corp.proxy:8080')
    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await fetchFn('https://corp.example.com/mcp')
      expect(proxyAgentCtor).toHaveBeenCalledTimes(1)
      const init = nodeFetchMock.mock.calls[0][1] as { agent?: unknown }
      expect(init?.agent).toBe(proxyAgentInstance)
    } finally {
      restore()
    }
  })

  it('caches proxy-agent per factory', async () => {
    const restore = stripProxyEnv()
    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      await fetchFn('https://a.example.com')
      await fetchFn('https://b.example.com')
      expect(proxyAgentCtor).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('succeeds with empty system proxy', async () => {
    const restore = stripProxyEnv()
    resolveSystemProxyMock.mockResolvedValue('')
    try {
      const fetchFn = createDesktopMcpFetch({ env: {} })
      const res = await fetchFn('https://anywhere.example.com')
      expect(res.status).toBe(200)
    } finally {
      restore()
    }
  })

  it('fails fast on socks5:// system proxy', async () => {
    const restore = stripProxyEnv()
    resolveSystemProxyMock.mockResolvedValue('socks5://127.0.0.1:1080')
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
