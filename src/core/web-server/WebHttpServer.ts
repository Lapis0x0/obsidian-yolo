import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { WebRouter } from './WebRouter'
import { WebSseHub } from './WebSseHub'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export type WebServerConfig = {
  port: number
  host?: string
  webUiDir?: string
  staticFileOverrides?: Record<string, string>
}

export class WebHttpServer {
  public readonly router = new WebRouter()
  public readonly sseHub = new WebSseHub()
  private server: ReturnType<typeof createServer> | null = null

  constructor(private readonly config: WebServerConfig) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        this.server = createServer((req, res) => this.handleRequest(req, res))
        this.server.listen(this.config.port, this.config.host, () => {
          const addr = this.server?.address()
          const port = typeof addr === 'object' && addr ? addr.port : this.config.port
          const host =
            typeof addr === 'object' && addr ? addr.address : this.config.host
          console.log(`[YOLO] Web server listening on ${host}:${port}`)
          resolve(port)
        })
        this.server.on('error', (err) => {
          console.error('[YOLO] Web server error:', err)
          reject(err)
        })
      } catch (err) {
        console.error('[YOLO] Failed to create web server:', err)
        reject(err)
      }
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.sseHub.disconnectAll()
      this.server.close(() => resolve())
      this.server = null
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const startTime = Date.now()
    const requestUrl = this.sanitizeUrlForLog(req.url ?? '/')
    const logRequest = (status: number) => {
      console.log(
        `[YOLO Web] ${req.method} ${requestUrl} → ${status} (${Date.now() - startTime}ms)`,
      )
    }

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      logRequest(204)
      return
    }

    const url = req.url ?? '/'
    const pathname = url.split('?')[0] || '/'

    // Route matching
    const route = this.router.resolve(req.method ?? 'GET', url)
    if (route) {
      void route.handler(req, res, route.params)
      logRequest(200)
      return
    }

    // Static file serving
    if (this.config.webUiDir && (pathname === '/' || !pathname.includes('..'))) {
      this.serveStatic(pathname, res)
      return
    }

    // 404
    logRequest(404)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }

  private sanitizeUrlForLog(url: string): string {
    return url
  }

  private serveStatic(pathname: string, res: ServerResponse): void {
    const filePath = this.resolveStaticFilePath(pathname)
    if (!filePath) {
      console.warn(`[YOLO Web] Static serving disabled: no webUiDir configured`)
      res.writeHead(404)
      res.end()
      return
    }

    console.log(`[YOLO Web] Static: ${pathname} → ${filePath}`)
    if (!existsSync(filePath)) {
      console.warn(`[YOLO Web] File not found: ${filePath}`)
      res.writeHead(404)
      res.end()
      return
    }

    try {
      const content = readFileSync(filePath)
      const ext = extname(filePath)
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' })
      res.end(content)
    } catch (err) {
      console.error(`[YOLO Web] Failed to read static file ${filePath}:`, err)
      res.writeHead(500)
      res.end()
    }
  }

  private resolveStaticFilePath(pathname: string): string | null {
    const overridePath = this.config.staticFileOverrides?.[pathname]
    if (overridePath) {
      return overridePath
    }

    const dir = this.config.webUiDir
    if (!dir) {
      return null
    }

    return pathname === '/' ? join(dir, 'index.html') : join(dir, pathname)
  }

  json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  readJson(req: IncomingMessage): Promise<unknown> {
    return this.readBuffer(req).then((buffer) =>
      JSON.parse(buffer.toString('utf-8')),
    )
  }

  readBuffer(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          resolve(Buffer.concat(chunks))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }
}
