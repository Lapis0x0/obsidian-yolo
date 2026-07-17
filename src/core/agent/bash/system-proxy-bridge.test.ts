const resolveSystemProxyMock = jest.fn<Promise<string>, [string]>()

jest.mock('../../../utils/net/systemProxyResolver', () => ({
  resolveSystemProxy: (url: string) => resolveSystemProxyMock(url),
}))

/* eslint-disable import/no-nodejs-modules -- desktop-only integration test exercises the loopback HTTP proxy */
import { createServer, request } from 'node:http'
/* eslint-enable import/no-nodejs-modules */

import {
  __test__,
  getSystemProxyBridgeUrl,
  stopSystemProxyBridge,
} from './system-proxy-bridge'

type BridgeRequest = Parameters<
  typeof __test__.prepareSystemProxyRequest
>[0]['request']

const createRequest = (url: string): BridgeRequest => ({ url }) as BridgeRequest

describe('system-proxy-bridge', () => {
  beforeEach(() => {
    resolveSystemProxyMock.mockReset()
  })

  afterEach(async () => {
    await stopSystemProxyBridge()
  })

  it('starts one loopback bridge and reuses it', async () => {
    const firstUrl = await getSystemProxyBridgeUrl()
    const secondUrl = await getSystemProxyBridgeUrl()

    expect(firstUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(secondUrl).toBe(firstUrl)

    const targetServer = createServer((_request, response) => {
      response.end('proxied')
    })
    await new Promise<void>((resolve, reject) => {
      targetServer.once('error', reject)
      targetServer.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = targetServer.address()
      if (!address || typeof address === 'string' || !firstUrl) {
        throw new Error('Expected loopback proxy and target ports.')
      }
      const proxyUrl = new URL(firstUrl)
      const targetUrl = `http://127.0.0.1:${address.port}/test`
      const body = await new Promise<string>((resolve, reject) => {
        const proxyRequest = request(
          {
            hostname: proxyUrl.hostname,
            port: proxyUrl.port,
            path: targetUrl,
            headers: { host: `127.0.0.1:${address.port}` },
          },
          (response) => {
            let responseBody = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => {
              responseBody += chunk
            })
            response.on('end', () => resolve(responseBody))
          },
        )
        proxyRequest.once('error', reject)
        proxyRequest.end()
      })

      expect(body).toBe('proxied')
      expect(resolveSystemProxyMock).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => targetServer.close(() => resolve()))
    }

    await stopSystemProxyBridge()
    await expect(getSystemProxyBridgeUrl()).resolves.toBeNull()
  })

  it('resolves the system proxy from the actual HTTP request URL', async () => {
    resolveSystemProxyMock.mockResolvedValue('http://127.0.0.1:7890')

    const result = await __test__.prepareSystemProxyRequest({
      connectionId: 1,
      request: createRequest('http://example.com/path?q=1'),
      username: '',
      password: '',
      hostname: 'example.com',
      port: 80,
      isHttp: true,
    })

    expect(resolveSystemProxyMock).toHaveBeenCalledWith(
      'http://example.com/path?q=1',
    )
    expect(result).toEqual({
      upstreamProxyUrl: 'http://127.0.0.1:7890',
    })
  })

  it('builds an HTTPS target URL for CONNECT tunnels', async () => {
    resolveSystemProxyMock.mockResolvedValue('socks5://127.0.0.1:1080')

    const result = await __test__.prepareSystemProxyRequest({
      connectionId: 2,
      request: createRequest('github.com:443'),
      username: '',
      password: '',
      hostname: 'github.com',
      port: 443,
      isHttp: false,
    })

    expect(resolveSystemProxyMock).toHaveBeenCalledWith(
      'https://github.com:443',
    )
    expect(result).toEqual({
      upstreamProxyUrl: 'socks5://127.0.0.1:1080',
    })
  })

  it('keeps local targets direct without consulting the system proxy', async () => {
    const result = await __test__.prepareSystemProxyRequest({
      connectionId: 3,
      request: createRequest('http://127.0.0.1:11434/api'),
      username: '',
      password: '',
      hostname: '127.0.0.1',
      port: 11434,
      isHttp: true,
    })

    expect(resolveSystemProxyMock).not.toHaveBeenCalled()
    expect(result).toEqual({ upstreamProxyUrl: null })
  })

  it('keeps Chromium DIRECT results direct', async () => {
    resolveSystemProxyMock.mockResolvedValue('')

    const result = await __test__.prepareSystemProxyRequest({
      connectionId: 4,
      request: createRequest('http://example.com'),
      username: '',
      password: '',
      hostname: 'example.com',
      port: 80,
      isHttp: true,
    })

    expect(result).toEqual({ upstreamProxyUrl: null })
  })
})
