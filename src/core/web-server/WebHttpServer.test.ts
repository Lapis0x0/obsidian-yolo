import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { WebHttpServer } from './WebHttpServer'
import { WebRouter } from './WebRouter'
import { ServerResponse, IncomingMessage } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { Writable } from 'stream'

describe('WebHttpServer', () => {
  let server: WebHttpServer
  let tempDir: string | null = null

  beforeEach(() => {
    server = new WebHttpServer({
      port: 0,
      webUiDir: undefined,
    })
  })

  afterEach(async () => {
    await server.stop()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  const mockReqRes = (
    method: string,
    url: string,
    headers: Record<string, string> = {},
  ) => {
    const chunks: Buffer[] = []
    const res = new Writable({
      write(chunk: any, _encoding: any, callback: () => void) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    }) as unknown as ServerResponse
    res.writeHead = jest.fn().mockReturnValue(res)
    res.end = jest.fn()
    res.statusCode = 200
    res.setHeader = jest.fn()
    res.getHeader = jest.fn()

    const req = { method, url, headers } as unknown as IncomingMessage
    req.on = jest.fn()

    return { req, res, chunks }
  }

  describe('CORS headers', () => {
    it('handles OPTIONS preflight', () => {
      const { req, res } = mockReqRes('OPTIONS', '/api/chat/list')
      server.router.get('/api/chat/list', jest.fn())

      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(204)
      expect(res.end).toHaveBeenCalled()
    })

    it('sets CORS headers on all responses', () => {
      const { req, res } = mockReqRes('GET', '/api/bootstrap')
      server.router.get('/api/bootstrap', (_req, res) => {
        server.json(res, 200, { ok: true })
      })

      ;(server as any).handleRequest(req, res)

      expect(res.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        '*',
      )
    })
  })

  describe('api access', () => {
    it('allows requests without token when auth is disabled', () => {
      const { req, res } = mockReqRes('GET', '/api/settings')
      server.router.get('/api/settings', (_req, res) => {
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true }))
      })

      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200)
    })

    it('rejects requests when token is configured but missing', () => {
      server = new WebHttpServer({
        port: 0,
        token: 'secret-token',
      })
      const { req, res } = mockReqRes('GET', '/api/settings')

      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(401, {
        'Content-Type': 'application/json',
      })
    })

    it('allows api requests with matching token query params', () => {
      server = new WebHttpServer({
        port: 0,
        token: 'secret-token',
      })
      const { req, res } = mockReqRes('GET', '/api/settings?token=secret-token')
      server.router.get('/api/settings', (_req, res) => {
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true }))
      })

      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200)
    })

    it('allows event stream routes with matching token query params', () => {
      server = new WebHttpServer({
        port: 0,
        token: 'secret-token',
      })
      const handler = jest.fn((_req, res) => {
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true }))
      })
      server.router.get('/api/agent/stream/:conversationId', handler)
      const { req, res } = mockReqRes(
        'GET',
        '/api/agent/stream/conv-1?token=secret-token',
      )

      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200)
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('routing', () => {
    it('calls matching route handler', () => {
      const handler = jest.fn()
      server.router.get('/api/test', handler)
      const { req, res } = mockReqRes('GET', '/api/test')

      ;(server as any).handleRequest(req, res)

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('returns 404 for unmounted route', () => {
      const { req, res } = mockReqRes('GET', '/api/unknown')

      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(404, {
        'Content-Type': 'application/json',
      })
    })
  })

  describe('json helper', () => {
    it('writes JSON response with status code', () => {
      const { req, res } = mockReqRes('GET', '/api/test')

      server.json(res as any, 200, { message: 'hello' })

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      })
      expect(res.end).toHaveBeenCalledWith(JSON.stringify({ message: 'hello' }))
    })
  })

  describe('static file serving', () => {
    it('serves index.html from webUiDir', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'yolo-web-ui-'))
      const webUiDir = join(tempDir, 'web-ui')
      mkdirSync(webUiDir, { recursive: true })
      writeFileSync(join(webUiDir, 'index.html'), '<html>ok</html>')

      server = new WebHttpServer({
        port: 0,
        webUiDir,
      })

      const { req, res } = mockReqRes('GET', '/')
      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/html',
      })
      expect(
        ((res.end as jest.Mock).mock.calls[0]?.[0] as Buffer).toString('utf-8'),
      ).toBe('<html>ok</html>')
    })

    it('serves overridden styles.css from plugin root', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'yolo-web-style-'))
      const webUiDir = join(tempDir, 'web-ui')
      const stylesPath = join(tempDir, 'styles.css')
      mkdirSync(webUiDir, { recursive: true })
      writeFileSync(join(webUiDir, 'index.html'), '<html>ok</html>')
      writeFileSync(stylesPath, 'body { color: red; }')

      server = new WebHttpServer({
        port: 0,
        webUiDir,
        staticFileOverrides: {
          '/styles.css': stylesPath,
        },
      })

      const { req, res } = mockReqRes('GET', '/styles.css')
      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/css',
      })
      expect(
        ((res.end as jest.Mock).mock.calls[0]?.[0] as Buffer).toString('utf-8'),
      ).toBe('body { color: red; }')
    })

    it('injects token into static asset references for index.html', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'yolo-web-ui-auth-'))
      const webUiDir = join(tempDir, 'web-ui')
      mkdirSync(webUiDir, { recursive: true })
      writeFileSync(
        join(webUiDir, 'index.html'),
        '<link rel="stylesheet" href="app.css" /><script type="module" src="index.js"></script>',
      )

      server = new WebHttpServer({
        port: 0,
        webUiDir,
        token: 'secret-token',
      })

      const { req, res } = mockReqRes('GET', '/?token=secret-token')
      ;(server as any).handleRequest(req, res)

      expect(
        ((res.end as jest.Mock).mock.calls[0]?.[0] as string).includes(
          'app.css?token=secret-token',
        ),
      ).toBe(true)
      expect(
        ((res.end as jest.Mock).mock.calls[0]?.[0] as string).includes(
          'index.js?token=secret-token',
        ),
      ).toBe(true)
    })

    it('serves overridden app.css from plugin root', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'yolo-web-app-style-'))
      const webUiDir = join(tempDir, 'web-ui')
      const appCssPath = join(tempDir, 'app.css')
      mkdirSync(webUiDir, { recursive: true })
      writeFileSync(join(webUiDir, 'index.html'), '<html>ok</html>')
      writeFileSync(appCssPath, 'body { background: black; }')

      server = new WebHttpServer({
        port: 0,
        webUiDir,
        staticFileOverrides: {
          '/app.css': appCssPath,
        },
      })

      const { req, res } = mockReqRes('GET', '/app.css')
      ;(server as any).handleRequest(req, res)

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/css',
      })
      expect(
        ((res.end as jest.Mock).mock.calls[0]?.[0] as Buffer).toString('utf-8'),
      ).toBe('body { background: black; }')
    })
  })

  describe('start/stop lifecycle', () => {
    it('starts and stops without error', async () => {
      const s = new WebHttpServer({
        port: 0,
        host: '127.0.0.1',
      })
      const port = await s.start()
      expect(port).toBeGreaterThan(0)
      await s.stop()
    })

    it('accepts 0.0.0.0 as the listen host', async () => {
      const s = new WebHttpServer({
        port: 0,
        host: '0.0.0.0',
      })
      const port = await s.start()
      expect(port).toBeGreaterThan(0)
      await s.stop()
    })

    it('resolve stop immediately when not running', async () => {
      await expect(server.stop()).resolves.toBeUndefined()
    })
  })
})
