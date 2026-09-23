// eslint-disable-next-line import/no-nodejs-modules -- the dispatcher returns real http/https agents for DIRECT; the test asserts on their types
import * as http from 'node:http'
// eslint-disable-next-line import/no-nodejs-modules -- see above
import * as https from 'node:https'

import type { AgentConnectOpts } from 'agent-base'

import { ProxyDispatcherAgent } from './proxyDispatcherAgent'

type FakeAgent = { kind: string; proxy: string; destroy: jest.Mock }

const mockCreated: FakeAgent[] = []

const mockAgentClass = (kind: string) =>
  jest.fn().mockImplementation((proxy: string) => {
    const agent: FakeAgent = { kind, proxy, destroy: jest.fn() }
    mockCreated.push(agent)
    return agent
  })

jest.mock('http-proxy-agent', () => ({
  HttpProxyAgent: mockAgentClass('http'),
}))
jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: mockAgentClass('https'),
}))
jest.mock('socks-proxy-agent', () => ({
  SocksProxyAgent: mockAgentClass('socks'),
}))

const request = (
  host: string,
  path = '/v1/chat',
  headers: Record<string, string> = {},
): http.ClientRequest =>
  ({
    path,
    getHeader: (name: string) =>
      name === 'host' ? host : headers[name.toLowerCase()],
  }) as unknown as http.ClientRequest

const secure = { secureEndpoint: true } as AgentConnectOpts
const plain = { secureEndpoint: false } as AgentConnectOpts

beforeEach(() => {
  mockCreated.length = 0
})

describe('ProxyDispatcherAgent', () => {
  it('resolves the proxy from the full target URL, using ws/wss for websocket upgrades', async () => {
    const getProxyForUrl = jest.fn().mockReturnValue('')
    const agent = new ProxyDispatcherAgent(getProxyForUrl)

    await agent.connect(request('api.example.com'), secure)
    await agent.connect(request('api.example.com:8080', '/a?b=1'), plain)
    await agent.connect(
      request('ws.example.com', '/socket', { upgrade: 'websocket' }),
      secure,
    )
    await agent.connect(
      request('ws.example.com', '/socket', { upgrade: 'websocket' }),
      plain,
    )

    expect(getProxyForUrl.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.com/v1/chat',
      'http://api.example.com:8080/a?b=1',
      'wss://ws.example.com/socket',
      'ws://ws.example.com/socket',
    ])
  })

  it('goes direct through plain http/https agents when no proxy applies', async () => {
    const agent = new ProxyDispatcherAgent(async () => '')

    expect(await agent.connect(request('a.com'), secure)).toBeInstanceOf(
      https.Agent,
    )
    const direct = await agent.connect(request('a.com'), plain)
    expect(direct).toBeInstanceOf(http.Agent)
    expect(direct).not.toBeInstanceOf(https.Agent)
    expect(mockCreated).toHaveLength(0)
  })

  it.each([
    ['http://proxy:8080', plain, 'http'],
    ['http://proxy:8080', secure, 'https'],
    ['https://proxy:8443', plain, 'http'],
    ['https://proxy:8443', secure, 'https'],
    ['socks://proxy:1080', plain, 'socks'],
    ['socks4://proxy:1080', secure, 'socks'],
    ['socks4a://proxy:1080', plain, 'socks'],
    ['socks5://proxy:1080', secure, 'socks'],
    ['socks5h://proxy:1080', plain, 'socks'],
  ] as const)(
    'maps %s (secure=%p) to the %s proxy agent',
    async (proxy, opts, kind) => {
      const agent = new ProxyDispatcherAgent(() => proxy)
      const result = (await agent.connect(
        request('a.com'),
        opts,
      )) as unknown as FakeAgent
      expect(result).toMatchObject({ kind, proxy })
    },
  )

  it('tunnels websocket upgrades through the CONNECT agent even for ws://', async () => {
    const agent = new ProxyDispatcherAgent(() => 'http://proxy:8080')
    const result = (await agent.connect(
      request('a.com', '/', { upgrade: 'websocket' }),
      plain,
    )) as unknown as FakeAgent
    expect(result.kind).toBe('https')
  })

  it('rejects unsupported proxy protocols, including pac+', async () => {
    for (const proxy of [
      'pac+https://example.com/proxy.pac',
      'ftp://proxy:21',
    ]) {
      const agent = new ProxyDispatcherAgent(() => proxy)
      await expect(agent.connect(request('a.com'), secure)).rejects.toThrow(
        `Unsupported protocol for proxy URL: ${proxy}`,
      )
    }
  })

  it('caches one agent per target protocol and proxy URL', async () => {
    let proxy = 'http://p1:8080'
    const agent = new ProxyDispatcherAgent(() => proxy)

    const first = await agent.connect(request('a.com'), secure)
    expect(await agent.connect(request('b.com'), secure)).toBe(first)
    const plainAgent = await agent.connect(request('a.com'), plain)
    expect(plainAgent).not.toBe(first)
    proxy = 'http://p2:8080'
    expect(await agent.connect(request('a.com'), secure)).not.toBe(first)
    expect(mockCreated).toHaveLength(3)
  })

  it('shares one agent between concurrent first requests for the same key', async () => {
    const agent = new ProxyDispatcherAgent(() => 'socks5://proxy:1080')
    const [a, b] = await Promise.all([
      agent.connect(request('a.com'), secure),
      agent.connect(request('b.com'), secure),
    ])
    expect(a).toBe(b)
  })

  it('evicts and destroys the least recently used agent beyond 20 entries', async () => {
    let proxy = ''
    const agent = new ProxyDispatcherAgent(() => proxy)
    const connectVia = async (port: number) => {
      proxy = `http://proxy:${port}`
      return (await agent.connect(
        request('a.com'),
        secure,
      )) as unknown as FakeAgent
    }

    const oldest = await connectVia(1)
    const touched = await connectVia(2)
    for (let port = 3; port <= 20; port++) await connectVia(port)
    // Touch port 2 so port 1 stays least recently used.
    expect(await connectVia(2)).toBe(touched)
    await connectVia(21)

    expect(oldest.destroy).toHaveBeenCalledTimes(1)
    expect(touched.destroy).not.toHaveBeenCalled()
    expect(await connectVia(1)).not.toBe(oldest)
  })

  it('destroys every cached proxy agent on destroy()', async () => {
    let proxy = 'http://p1:8080'
    const agent = new ProxyDispatcherAgent(() => proxy)
    await agent.connect(request('a.com'), secure)
    proxy = 'socks5://p2:1080'
    await agent.connect(request('a.com'), secure)

    agent.destroy()

    expect(mockCreated).toHaveLength(2)
    for (const cached of mockCreated) {
      expect(cached.destroy).toHaveBeenCalledTimes(1)
    }
  })
})
