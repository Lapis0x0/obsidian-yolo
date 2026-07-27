import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'

const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/mcp/oauth/callback'
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

type PendingCallback = {
  ownerId: string
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

type OpenAuthorizationUrl = (url: string) => void

type CallbackServerResponse = {
  writeHead: (statusCode: number, headers: Record<string, string>) => void
  end: (body?: string) => void
}

type CallbackServer = {
  listen: (port: number, host: string) => void
  address: () => string | { port: number } | null
  close: () => void
  once: (
    event: 'error' | 'listening',
    listener: (...args: never[]) => void,
  ) => void
  removeListener: (
    event: 'error' | 'listening',
    listener: (...args: never[]) => void,
  ) => void
}

type CreateServer = (
  listener: (
    request: { url?: string },
    response: CallbackServerResponse,
  ) => void,
) => CallbackServer

export class McpOAuthCallbackServer {
  private server: CallbackServer | null = null
  private redirectUrl: string | null = null
  private readonly pending = new Map<string, PendingCallback>()

  constructor(private readonly openAuthorizationUrl: OpenAuthorizationUrl) {}

  async getRedirectUrl(): Promise<string> {
    if (this.redirectUrl) return this.redirectUrl

    const { createServer } = await loadDesktopNodeModule<{
      createServer: CreateServer
    }>('node:http')
    const server = createServer((request, response) => {
      this.handleRequest(request.url ?? '/', response)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, CALLBACK_HOST)
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Failed to determine the MCP OAuth callback port.')
    }

    this.server = server
    this.redirectUrl = `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`
    return this.redirectUrl
  }

  authorize(ownerId: string, authorizationUrl: URL): Promise<string> {
    const state = authorizationUrl.searchParams.get('state')
    if (!state) {
      throw new Error('OAuth authorization URL is missing state.')
    }
    if (this.pending.has(state)) {
      throw new Error('An OAuth authorization with the same state is pending.')
    }

    const promise = new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(state)
        reject(new Error('OAuth authorization timed out.'))
      }, CALLBACK_TIMEOUT_MS)
      this.pending.set(state, { ownerId, resolve, reject, timeoutId })
    })

    this.openAuthorizationUrl(authorizationUrl.toString())
    return promise
  }

  cancelOwner(ownerId: string): void {
    for (const [state, pending] of this.pending) {
      if (pending.ownerId !== ownerId) continue
      clearTimeout(pending.timeoutId)
      pending.reject(new Error('OAuth authorization was cancelled.'))
      this.pending.delete(state)
    }
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error('OAuth callback server was closed.'))
    }
    this.pending.clear()
    this.server?.close()
    this.server = null
    this.redirectUrl = null
  }

  private handleRequest(
    rawUrl: string,
    response: CallbackServerResponse,
  ): void {
    const url = new URL(rawUrl, `http://${CALLBACK_HOST}`)
    if (url.pathname !== CALLBACK_PATH) {
      this.respond(response, 404, 'Not found')
      return
    }

    const state = url.searchParams.get('state')
    const pending = state ? this.pending.get(state) : undefined
    if (!state || !pending) {
      this.respond(response, 400, 'Invalid or expired OAuth state')
      return
    }

    clearTimeout(pending.timeoutId)
    this.pending.delete(state)
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      const description =
        url.searchParams.get('error_description') ?? oauthError
      pending.reject(new Error(description))
      this.respond(response, 400, `Authorization failed: ${description}`)
      return
    }

    const code = url.searchParams.get('code')
    if (!code) {
      pending.reject(new Error('OAuth callback is missing the code.'))
      this.respond(response, 400, 'Authorization code is missing')
      return
    }

    pending.resolve(code)
    this.respond(
      response,
      200,
      'Authorization successful. You can close this window and return to Obsidian.',
    )
  }

  private respond(
    response: CallbackServerResponse,
    statusCode: number,
    message: string,
  ): void {
    response.writeHead(statusCode, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    response.end(message)
  }
}
