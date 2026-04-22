import { createDesktopNodeFetch } from '../llm/sdkFetch'

import {
  createMcpRemoteTransportError,
  createMcpRemoteTransportFactory,
  getMcpRemoteTransportContext,
  getMcpRemoteTransportDiagnostics,
} from './remoteTransport'

jest.mock('../llm/sdkFetch', () => ({
  createDesktopNodeFetch: jest.fn(),
}))

jest.mock('proxy-from-env', () => ({
  getProxyForUrl: jest.fn(
    () => process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '',
  ),
}))

jest.mock('proxy-agent', () => ({
  ProxyAgent: jest.fn().mockImplementation((options) => ({
    options,
  })),
}))

jest.mock('../../utils/net/systemProxyResolver', () => ({
  resolveSystemProxy: jest.fn().mockResolvedValue(''),
}))

/** Must match `PROXY_ENV_KEYS` in `remoteTransport.ts` — any set value makes `envHasProxy` true. */
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

describe('remoteTransport', () => {
  const mockedCreateDesktopNodeFetch =
    createDesktopNodeFetch as jest.MockedFunction<typeof createDesktopNodeFetch>

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shares one Node fetch backend for MCP http and sse transports', () => {
    const sharedFetch = jest.fn() as unknown as typeof fetch
    mockedCreateDesktopNodeFetch.mockReturnValue(sharedFetch)

    const factory = createMcpRemoteTransportFactory({ env: {} })
    const headers = { Authorization: 'Bearer token' }

    const httpOptions = factory.createHttpOptions({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers,
    })
    const sseOptions = factory.createSseOptions({
      transport: 'sse',
      url: 'https://example.com/sse',
      headers,
    })

    expect(mockedCreateDesktopNodeFetch).toHaveBeenCalledTimes(1)
    expect(httpOptions.fetch).toBe(sharedFetch)
    expect(sseOptions.fetch).toBe(sharedFetch)
    expect(httpOptions.requestInit).toEqual({ headers })
    expect(sseOptions.requestInit).toEqual({ headers })
    expect(sseOptions.eventSourceInit).toEqual({ headers })
  })

  it('resolves proxy configuration from provided shell env values', async () => {
    mockedCreateDesktopNodeFetch.mockReturnValue(
      jest.fn() as unknown as typeof fetch,
    )

    const previousHttpsProxy = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://process-proxy.local:3128'

    try {
      createMcpRemoteTransportFactory({
        env: {
          HTTPS_PROXY: 'http://shell-proxy.local:8080',
        },
      })

      const { ProxyAgent } = jest.requireMock('proxy-agent')
      const proxyAgentOptions = ProxyAgent.mock.calls[0][0] as {
        getProxyForUrl: (url: string) => string | Promise<string>
      }

      await expect(
        Promise.resolve(
          proxyAgentOptions.getProxyForUrl('https://example.com'),
        ),
      ).resolves.toBe('http://shell-proxy.local:8080')
      expect(process.env.HTTPS_PROXY).toBe('http://process-proxy.local:3128')
    } finally {
      if (previousHttpsProxy === undefined) {
        delete process.env.HTTPS_PROXY
      } else {
        process.env.HTTPS_PROXY = previousHttpsProxy
      }
    }
  })

  it('falls back to resolveSystemProxy when no env proxy is present', async () => {
    mockedCreateDesktopNodeFetch.mockReturnValue(
      jest.fn() as unknown as typeof fetch,
    )

    const { resolveSystemProxy } = jest.requireMock(
      '../../utils/net/systemProxyResolver',
    )
    resolveSystemProxy.mockResolvedValueOnce('http://system-proxy.corp:8080')

    const previousProxyEnv: Partial<
      Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>
    > = {}
    for (const key of PROXY_ENV_KEYS) {
      previousProxyEnv[key] = process.env[key]
      delete process.env[key]
    }

    try {
      createMcpRemoteTransportFactory({ env: {} })

      const { ProxyAgent } = jest.requireMock('proxy-agent')
      const proxyAgentOptions = ProxyAgent.mock.calls[0][0] as {
        getProxyForUrl: (url: string) => string | Promise<string>
      }

      await expect(
        Promise.resolve(
          proxyAgentOptions.getProxyForUrl('https://example.com'),
        ),
      ).resolves.toBe('http://system-proxy.corp:8080')
      expect(resolveSystemProxy).toHaveBeenCalledWith('https://example.com')
    } finally {
      for (const key of PROXY_ENV_KEYS) {
        const value = previousProxyEnv[key]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it('creates actionable diagnostics for remote transport failures', () => {
    const context = getMcpRemoteTransportContext({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    })

    expect(context).not.toBeNull()
    expect(getMcpRemoteTransportDiagnostics(context!)).toEqual({
      remoteTransport: 'node',
      transport: 'http',
      protocol: 'https:',
      host: 'example.com',
    })

    const error = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:8080'),
      {
        code: 'ECONNREFUSED',
      },
    )

    const wrapped = createMcpRemoteTransportError({
      serverName: 'demo',
      action: 'connect',
      context: context!,
      error,
    })

    expect(wrapped.message).toContain(
      'Failed to connect to MCP server demo via Node HTTP transport',
    )
    expect(wrapped.message).toContain('(https://example.com)')
    expect(wrapped.message).toContain('network connection failed')
    expect(wrapped.message).toContain('ECONNREFUSED')
  })
})
