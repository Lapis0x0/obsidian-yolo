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

      const { ProxyAgent } = jest.requireMock('proxy-agent') as {
        ProxyAgent: jest.Mock
      }
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
