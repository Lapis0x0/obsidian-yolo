import { requestUrl } from 'obsidian'

import { ChatGPTOAuthCredential, ChatGPTOAuthStore } from './chatgptOAuthStore'
import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const DEVICE_VERIFICATION_URI = `${ISSUER}/codex/device`
const DEVICE_CODE_POLL_MARGIN_MS = 3000
const BROWSER_OAUTH_PORTS = [1455, 1456, 1457]
const OAUTH_CALLBACK_HOST = 'localhost'

type PkceCodes = {
  verifier: string
  challenge: string
}

type PendingBrowserAuthorization = {
  state: string
  pkce: PkceCodes
  resolve: (credential: ChatGPTOAuthCredential) => void
  reject: (error: Error) => void
}

type TokenResponse = {
  id_token?: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

type DeviceAuthorizationResponse = {
  device_auth_id: string
  user_code: string
  interval?: string
}

type DeviceTokenResponse =
  | {
      authorization_code: string
      code_verifier: string
    }
  | {
      error?: string
    }

export type ChatGPTOAuthDeviceAuthorization = {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  intervalMs: number
}

export type ChatGPTOAuthBrowserAuthorization = {
  authorizationUrl: string
  redirectUri: string
  complete: Promise<ChatGPTOAuthCredential>
}

export type IdTokenClaims = {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
  }
}

type CreateServer = typeof import('node:http').createServer
type IncomingMessage = import('node:http').IncomingMessage
type Server = import('node:http').Server
type ServerResponse = import('node:http').ServerResponse
type AddressInfo = import('node:net').AddressInfo

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const generateRandomString = (length: number): string => {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((value) => chars[value % chars.length])
    .join('')
}

const base64UrlEncode = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const generateState = (): string => {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  return {
    verifier,
    challenge: base64UrlEncode(hash),
  }
}

export function buildAuthorizeUrl(
  redirectUri: string,
  pkce: PkceCodes,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'opencode',
  })

  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Unknown error'
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined

  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(
  claims: IdTokenClaims,
): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(
  tokens: Pick<TokenResponse, 'id_token' | 'access_token'>,
): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    if (claims) {
      const accountId = extractAccountIdFromClaims(claims)
      if (accountId) {
        return accountId
      }
    }
  }

  const accessClaims = parseJwtClaims(tokens.access_token)
  return accessClaims ? extractAccountIdFromClaims(accessClaims) : undefined
}

export class ChatGPTOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatGPTOAuthError'
  }
}

export class ChatGPTOAuthService {
  private oauthServer: Server | null = null
  private oauthPort: number | null = null
  private pendingBrowserAuthorization: PendingBrowserAuthorization | null = null

  constructor(private readonly store: ChatGPTOAuthStore) {}

  async getCredential(): Promise<ChatGPTOAuthCredential | null> {
    return this.store.get()
  }

  async clearCredential(): Promise<void> {
    this.cancelPendingBrowserAuthorization('ChatGPT OAuth login was cancelled.')
    await this.store.clear()
  }

  async beginBrowserAuthorization(): Promise<ChatGPTOAuthBrowserAuthorization> {
    if (this.pendingBrowserAuthorization) {
      throw new ChatGPTOAuthError(
        'Another ChatGPT OAuth login is already in progress.',
      )
    }

    const redirectUri = await this.ensureOAuthServer()
    const pkce = await generatePKCE()
    const state = generateState()
    const authorizationUrl = buildAuthorizeUrl(redirectUri, pkce, state)

    const complete = new Promise<ChatGPTOAuthCredential>((resolve, reject) => {
      const timeoutId = setTimeout(
        () => {
          if (!this.pendingBrowserAuthorization) {
            return
          }
          this.pendingBrowserAuthorization = null
          reject(
            new ChatGPTOAuthError(
              'OAuth callback timeout - authorization took too long',
            ),
          )
        },
        5 * 60 * 1000,
      )

      this.pendingBrowserAuthorization = {
        state,
        pkce,
        resolve: (credential) => {
          clearTimeout(timeoutId)
          this.pendingBrowserAuthorization = null
          resolve(credential)
        },
        reject: (error) => {
          clearTimeout(timeoutId)
          this.pendingBrowserAuthorization = null
          reject(error)
        },
      }
    })

    return {
      authorizationUrl,
      redirectUri,
      complete,
    }
  }

  cancelPendingBrowserAuthorization(
    message = 'ChatGPT OAuth login was cancelled.',
  ) {
    if (!this.pendingBrowserAuthorization) {
      return
    }

    this.pendingBrowserAuthorization.reject(new ChatGPTOAuthError(message))
    this.pendingBrowserAuthorization = null
  }

  async beginDeviceAuthorization(): Promise<ChatGPTOAuthDeviceAuthorization> {
    const response = await requestUrl({
      url: `${ISSUER}/api/accounts/deviceauth/usercode`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'obsidian-yolo/chatgpt-oauth',
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new ChatGPTOAuthError(
        `Failed to start device authorization: ${response.status}${this.describeErrorResponse(response)}`,
      )
    }

    const data = response.json as DeviceAuthorizationResponse
    return {
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      verificationUri: DEVICE_VERIFICATION_URI,
      intervalMs: Math.max(parseInt(data.interval ?? '5', 10) || 5, 1) * 1000,
    }
  }

  async pollDeviceAuthorization(
    authorization: ChatGPTOAuthDeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<ChatGPTOAuthCredential> {
    while (true) {
      signal?.throwIfAborted?.()

      const response = await requestUrl({
        url: `${ISSUER}/api/accounts/deviceauth/token`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'obsidian-yolo/chatgpt-oauth',
        },
        body: JSON.stringify({
          device_auth_id: authorization.deviceAuthId,
          user_code: authorization.userCode,
        }),
        throw: false,
      })

      if (response.status >= 200 && response.status < 300) {
        const data = response.json as DeviceTokenResponse
        if (
          !('authorization_code' in data) ||
          typeof data.authorization_code !== 'string' ||
          typeof data.code_verifier !== 'string'
        ) {
          throw new ChatGPTOAuthError(
            'Device authorization returned an invalid token payload',
          )
        }

        const credential = await this.exchangeAuthorizationCode({
          code: data.authorization_code,
          codeVerifier: data.code_verifier,
          redirectUri: `${ISSUER}/deviceauth/callback`,
        })
        await this.store.set(credential)
        return credential
      }

      if (response.status !== 403 && response.status !== 404) {
        throw new ChatGPTOAuthError(
          `Device authorization polling failed: ${response.status}${this.describeErrorResponse(response)}`,
        )
      }

      await sleep(authorization.intervalMs + DEVICE_CODE_POLL_MARGIN_MS)
    }
  }

  async refreshCredential(
    credential: Pick<ChatGPTOAuthCredential, 'refreshToken' | 'accountId'>,
  ): Promise<ChatGPTOAuthCredential> {
    const response = await requestUrl({
      url: `${ISSUER}/oauth/token`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new ChatGPTOAuthError(
        `Token refresh failed: ${response.status}${this.describeErrorResponse(response)}`,
      )
    }

    const data = response.json as TokenResponse
    const next = this.toCredential(data, credential.accountId)
    await this.store.set(next)
    return next
  }

  async getUsableCredential(): Promise<ChatGPTOAuthCredential | null> {
    const current = await this.store.get()
    if (!current) {
      return null
    }
    if (!this.store.isExpired(current)) {
      return current
    }

    try {
      return await this.refreshCredential(current)
    } catch (error) {
      throw new ChatGPTOAuthError(
        `Failed to refresh ChatGPT OAuth token: ${toErrorMessage(error)}`,
      )
    }
  }

  private async exchangeAuthorizationCode(input: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<ChatGPTOAuthCredential> {
    const response = await requestUrl({
      url: `${ISSUER}/oauth/token`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: CLIENT_ID,
        code_verifier: input.codeVerifier,
      }).toString(),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new ChatGPTOAuthError(
        `Token exchange failed: ${response.status}${this.describeErrorResponse(response)}`,
      )
    }

    return this.toCredential(response.json as TokenResponse)
  }

  private toCredential(
    tokens: TokenResponse,
    fallbackAccountId?: string,
  ): ChatGPTOAuthCredential {
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      updatedAt: Date.now(),
      ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      ...(extractAccountId(tokens) || fallbackAccountId
        ? {
            accountId: extractAccountId(tokens) || fallbackAccountId,
          }
        : {}),
    }
  }

  private async ensureOAuthServer(): Promise<string> {
    if (this.oauthServer && this.oauthPort) {
      return `http://${OAUTH_CALLBACK_HOST}:${this.oauthPort}/auth/callback`
    }

    for (const port of BROWSER_OAUTH_PORTS) {
      try {
        const redirectUri = await this.startOAuthServer(port)
        return redirectUri
      } catch {
        continue
      }
    }

    throw new ChatGPTOAuthError('Failed to start local OAuth callback server.')
  }

  private startOAuthServer(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      void (async () => {
        let createServer: CreateServer
        try {
          ;({ createServer } =
            await loadDesktopNodeModule<typeof import('node:http')>(
              'node:http',
            ))
        } catch (error) {
          reject(error)
          return
        }

        const server = createServer((req, res) => {
          void this.handleOAuthRequest(req.url ?? '/', res)
        })

        const onError = (error: Error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }

        const onListening = () => {
          server.removeListener('error', onError)
          this.oauthServer = server
          this.oauthPort = (server.address() as AddressInfo).port
          resolve(
            `http://${OAUTH_CALLBACK_HOST}:${this.oauthPort}/auth/callback`,
          )
        }

        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, OAUTH_CALLBACK_HOST)
      })()
    })
  }

  private async handleOAuthRequest(
    rawUrl: string,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(rawUrl, `http://${OAUTH_CALLBACK_HOST}`)

    if (url.pathname === '/cancel') {
      this.cancelPendingBrowserAuthorization(
        'ChatGPT OAuth login was cancelled.',
      )
      this.respondHtml(res, 200, 'Login cancelled')
      return
    }

    if (url.pathname !== '/auth/callback') {
      this.respondHtml(res, 404, 'Not found')
      return
    }

    const error = url.searchParams.get('error')
    const errorDescription = url.searchParams.get('error_description')
    if (error) {
      const message = errorDescription || error
      this.pendingBrowserAuthorization?.reject(new ChatGPTOAuthError(message))
      this.pendingBrowserAuthorization = null
      this.respondHtml(res, 400, `Authorization failed: ${message}`)
      return
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state || !this.pendingBrowserAuthorization) {
      this.respondHtml(res, 400, 'Missing authorization code or state')
      return
    }

    if (state !== this.pendingBrowserAuthorization.state) {
      this.pendingBrowserAuthorization.reject(
        new ChatGPTOAuthError('Invalid state returned from ChatGPT OAuth.'),
      )
      this.pendingBrowserAuthorization = null
      this.respondHtml(res, 400, 'Invalid state')
      return
    }

    const pending = this.pendingBrowserAuthorization
    try {
      const credential = await this.exchangeAuthorizationCode({
        code,
        codeVerifier: pending.pkce.verifier,
        redirectUri: `http://${OAUTH_CALLBACK_HOST}:${this.oauthPort}/auth/callback`,
      })
      await this.store.set(credential)
      pending.resolve(credential)
      this.respondHtml(
        res,
        200,
        'Authorization successful. You can close this window.',
      )
    } catch (oauthError) {
      pending.reject(
        oauthError instanceof Error
          ? oauthError
          : new ChatGPTOAuthError('Unknown OAuth callback error'),
      )
      this.respondHtml(
        res,
        500,
        `Authorization failed: ${toErrorMessage(oauthError)}`,
      )
    }
  }

  private respondHtml(
    res: ServerResponse,
    statusCode: number,
    message: string,
  ) {
    res.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
    })
    res.end(
      `<!doctype html><html><body><p>${message}</p><script>setTimeout(() => window.close(), 1500)</script></body></html>`,
    )
  }

  private describeErrorResponse(response: {
    text?: string
    json?: unknown
  }): string {
    if (typeof response.text === 'string' && response.text.trim()) {
      return ` - ${response.text.trim()}`
    }

    if (response.json && typeof response.json === 'object') {
      try {
        return ` - ${JSON.stringify(response.json)}`
      } catch {
        return ''
      }
    }

    return ''
  }
}
