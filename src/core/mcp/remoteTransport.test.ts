import { createDesktopMcpFetch } from './desktopMcpFetch'
import {
  classifyRemoteTransportError,
  createMcpRemoteTransportError,
  createMcpRemoteTransportFactory,
  getMcpRemoteTransportContext,
  getMcpRemoteTransportDiagnostics,
} from './remoteTransport'

// jest.mock is hoisted by ts-jest above imports, so order with imports is fine.
jest.mock('./desktopMcpFetch', () => ({
  createDesktopMcpFetch: jest.fn(),
}))

describe('remoteTransport', () => {
  const mockedCreateDesktopMcpFetch =
    createDesktopMcpFetch as jest.MockedFunction<typeof createDesktopMcpFetch>

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shares one MCP fetch backend for http and sse transports', () => {
    const sharedFetch = jest.fn() as unknown as typeof fetch
    mockedCreateDesktopMcpFetch.mockReturnValue(sharedFetch)

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

    expect(mockedCreateDesktopMcpFetch).toHaveBeenCalledTimes(1)
    expect(mockedCreateDesktopMcpFetch).toHaveBeenCalledWith({ env: {} })
    expect(httpOptions.fetch).toBe(sharedFetch)
    expect(sseOptions.fetch).toBe(sharedFetch)
    expect(httpOptions.requestInit).toEqual({ headers })
    expect(sseOptions.requestInit).toEqual({ headers })
    expect(sseOptions.eventSourceInit).toEqual({ headers })
  })

  it('forwards shell env into desktopMcpFetch', () => {
    mockedCreateDesktopMcpFetch.mockReturnValue(
      jest.fn() as unknown as typeof fetch,
    )

    createMcpRemoteTransportFactory({
      env: { HTTPS_PROXY: 'http://shell-proxy.local:8080' },
    })

    expect(mockedCreateDesktopMcpFetch).toHaveBeenCalledWith({
      env: { HTTPS_PROXY: 'http://shell-proxy.local:8080' },
    })
  })

  it('classifies legacy node error codes', () => {
    const econnrefused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    })
    expect(classifyRemoteTransportError(econnrefused)).toBe(
      'network connection failed',
    )

    const etimedout = Object.assign(new Error('socket hang up'), {
      code: 'ETIMEDOUT',
    })
    expect(classifyRemoteTransportError(etimedout)).toBe('request timed out')
  })

  it('classifies undici error codes (issue #252)', () => {
    const wrap = (code: string, msg = 'inner') => {
      const outer = new TypeError('fetch failed')
      ;(outer as unknown as { cause: unknown }).cause = Object.assign(
        new Error(msg),
        { code },
      )
      return outer
    }

    // Timeouts (all three undici timeout variants must collapse).
    expect(classifyRemoteTransportError(wrap('UND_ERR_HEADERS_TIMEOUT'))).toBe(
      'request timed out',
    )
    expect(classifyRemoteTransportError(wrap('UND_ERR_BODY_TIMEOUT'))).toBe(
      'request timed out',
    )
    expect(classifyRemoteTransportError(wrap('UND_ERR_CONNECT_TIMEOUT'))).toBe(
      'request timed out',
    )

    // Connection / socket family.
    expect(classifyRemoteTransportError(wrap('UND_ERR_SOCKET'))).toBe(
      'network connection failed',
    )
    expect(classifyRemoteTransportError(wrap('UND_ERR_CLOSED'))).toBe(
      'network connection failed',
    )
    expect(classifyRemoteTransportError(wrap('UND_ERR_DESTROYED'))).toBe(
      'network connection failed',
    )
  })

  it('classifies SOCKS fail-fast as proxy negotiation failed', () => {
    const socksErr = Object.assign(
      new Error(
        'SOCKS proxy is not supported by Streamable HTTP MCP transport (resolved proxy: socks5://127.0.0.1:1080).',
      ),
      { code: 'YOLO_MCP_SOCKS_UNSUPPORTED' },
    )
    expect(classifyRemoteTransportError(socksErr)).toBe(
      'proxy negotiation failed',
    )
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
      { code: 'ECONNREFUSED' },
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
