import { WebApiClient } from './WebApiClient'

const mockFetch = jest.fn()
global.fetch = mockFetch

describe('WebApiClient', () => {
  let client: WebApiClient

    beforeEach(() => {
      jest.resetAllMocks()
      client = new WebApiClient('http://localhost:18789')
    })

  describe('getJson', () => {
    it('makes a GET request', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.0.0' }),
      })

      const result = await client.getJson('/api/bootstrap')

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:18789/api/bootstrap',
        {
          headers: {},
        },
      )
      expect(result).toEqual({ version: '1.0.0' })
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      })

      await expect(client.getJson('/api/secret')).rejects.toThrow(
        'GET /api/secret failed: 401',
      )
    })
  })

  describe('postJson', () => {
    it('makes a POST request with JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })

      const result = await client.postJson('/api/settings/update', {
        theme: 'dark',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:18789/api/settings/update',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: '{"theme":"dark"}',
        },
      )
      expect(result).toEqual({ ok: true })
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      })

      await expect(
        client.postJson('/api/chat/save', {}),
      ).rejects.toThrow('POST /api/chat/save failed: 500')
    })
  })

  describe('postArrayBuffer', () => {
    it('makes a POST request with binary body', async () => {
      const body = new Uint8Array([1, 2, 3]).buffer
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })

      const result = await client.postArrayBuffer(
        '/api/vault/write-binary?path=test.bin',
        body,
      )

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:18789/api/vault/write-binary?path=test.bin',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          body,
        },
      )
      expect(result).toEqual({ ok: true })
    })
  })

  describe('openEventSource', () => {
    beforeEach(() => {
      const mockEs = { close: jest.fn(), addEventListener: jest.fn() }
      const ctor = jest.fn().mockImplementation(() => mockEs)
      ;(ctor as any).CONNECTING = 0
      ;(ctor as any).OPEN = 1
      ;(ctor as any).CLOSED = 2
      ;(globalThis as any).EventSource = ctor
    })

    afterEach(() => {
      delete (globalThis as any).EventSource
    })

    it('creates an EventSource without auth query params', () => {
      const es = client.openEventSource('/api/agent/stream/conv-1')

      expect((globalThis as any).EventSource).toHaveBeenCalledWith(
        'http://localhost:18789/api/agent/stream/conv-1',
      )
      expect(es).toBeDefined()
    })

    it('encodes special characters in the path', () => {
      jest.clearAllMocks()
      client.openEventSource('/api/agent/stream/conv 1')

      expect((globalThis as any).EventSource).toHaveBeenCalledWith(
        expect.stringContaining('conv%201'),
      )
    })

    it('appends token to fetch and event stream requests when configured', async () => {
      client = new WebApiClient('http://localhost:18789', 'secret-token')
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })

      await client.getJson('/api/bootstrap')
      client.openEventSource('/api/agent/stream/conv-1')

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:18789/api/bootstrap?token=secret-token',
        {
          headers: {},
        },
      )
      expect((globalThis as any).EventSource).toHaveBeenCalledWith(
        'http://localhost:18789/api/agent/stream/conv-1?token=secret-token',
      )
    })
  })
})
