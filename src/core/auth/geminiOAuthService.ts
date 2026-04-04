import { requestUrl } from 'obsidian'

import { GeminiOAuthCredential, GeminiOAuthStore } from './geminiOAuthStore'
import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'

const GOOGLE_ISSUER = 'https://accounts.google.com'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT =
  'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORT = 8085
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}/oauth2callback`
const CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'
const CLIENT_SECRET = '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'
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')
const FREE_TIER_ID = 'free-tier'
const LEGACY_TIER_ID = 'legacy-tier'

type PkceCodes = {
  verifier: string
  challenge: string
}

type PendingBrowserAuthorization = {
  state: string
  pkce: PkceCodes
  resolve: (credential: GeminiOAuthCredential) => void
  reject: (error: Error) => void
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

type GoogleUserInfo = {
  email?: string
}

type LoadCodeAssistResponse = {
  cloudaicompanionProject?: string | { id?: string }
  currentTier?: { id?: string }
  allowedTiers?: Array<{
    id?: string
    isDefault?: boolean
  }>
  ineligibleTiers?: Array<{
    reasonCode?: string
    reasonMessage?: string
    validationUrl?: string
    validationLearnMoreUrl?: string
  }>
}

type OnboardUserResponse = {
  name?: string
  done?: boolean
  response?: {
    cloudaicompanionProject?: {
      id?: string
    }
  }
}

type RetrieveUserQuotaResponse = {
  buckets?: Array<{
    modelId?: string
  }>
}

type CreateServer = typeof import('node:http').createServer
type IncomingMessage = import('node:http').IncomingMessage
type Server = import('node:http').Server
type ServerResponse = import('node:http').ServerResponse

export type GeminiOAuthBrowserAuthorization = {
  authorizationUrl: string
  redirectUri: string
  complete: Promise<GeminiOAuthCredential>
}

const base64UrlEncode = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const generateRandomString = (length: number): string => {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((value) => chars[value % chars.length])
    .join('')
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

export function buildAuthorizeUrl(pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  })

  const url = new URL(`${GOOGLE_ISSUER}/o/oauth2/v2/auth`)
  url.search = params.toString()
  url.hash = 'obsidian-yolo'
  return url.toString()
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

const normalizeProjectId = (
  value?: string | { id?: string },
): string | undefined => {
  if (!value) {
    return undefined
  }
  if (typeof value === 'string') {
    return value.trim() || undefined
  }
  if (typeof value.id === 'string') {
    return value.id.trim() || undefined
  }
  return undefined
}

const buildCodeAssistHeaders = (
  accessToken: string,
  model = 'gemini-code-assist',
): Record<string, string> => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${accessToken}`,
  'User-Agent': `GeminiCLI/0.1.21/${model} (obsidian-yolo)`,
  'x-activity-request-id': crypto.randomUUID(),
})

export class GeminiOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeminiOAuthError'
  }
}

export class GeminiOAuthService {
  private oauthServer: Server | null = null
  private pendingBrowserAuthorization: PendingBrowserAuthorization | null = null

  constructor(private readonly store: GeminiOAuthStore) {}

  async getCredential(): Promise<GeminiOAuthCredential | null> {
    return this.store.get()
  }

  async clearCredential(): Promise<void> {
    this.cancelPendingBrowserAuthorization('Gemini OAuth login was cancelled.')
    await this.store.clear()
  }

  async beginBrowserAuthorization(): Promise<GeminiOAuthBrowserAuthorization> {
    if (this.pendingBrowserAuthorization) {
      throw new GeminiOAuthError(
        'Another Gemini OAuth login is already in progress.',
      )
    }

    await this.ensureOAuthServer()
    const pkce = await generatePKCE()
    const state = generateState()
    const authorizationUrl = buildAuthorizeUrl(pkce, state)

    const complete = new Promise<GeminiOAuthCredential>((resolve, reject) => {
      const timeoutId = setTimeout(
        () => {
          if (!this.pendingBrowserAuthorization) {
            return
          }
          this.pendingBrowserAuthorization = null
          reject(
            new GeminiOAuthError(
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
      redirectUri: REDIRECT_URI,
      complete,
    }
  }

  cancelPendingBrowserAuthorization(
    message = 'Gemini OAuth login was cancelled.',
  ) {
    if (!this.pendingBrowserAuthorization) {
      return
    }

    this.pendingBrowserAuthorization.reject(new GeminiOAuthError(message))
    this.pendingBrowserAuthorization = null
  }

  async refreshCredential(
    credential: Pick<
      GeminiOAuthCredential,
      'refreshToken' | 'email' | 'projectId' | 'managedProjectId'
    >,
  ): Promise<GeminiOAuthCredential> {
    const response = await requestUrl({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new GeminiOAuthError(
        `Token refresh failed: ${response.status}${this.describeErrorResponse(response)}`,
      )
    }

    const next = this.toCredential(
      response.json as TokenResponse,
      credential.refreshToken,
      credential.email,
      credential.projectId,
      credential.managedProjectId,
    )
    await this.store.set(next)
    return next
  }

  async getUsableCredential(): Promise<GeminiOAuthCredential | null> {
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
      throw new GeminiOAuthError(
        `Failed to refresh Gemini OAuth token: ${toErrorMessage(error)}`,
      )
    }
  }

  async ensureProjectContext(
    credential: GeminiOAuthCredential,
    configuredProjectId?: string,
    model?: string,
  ): Promise<GeminiOAuthCredential> {
    const requestedProjectId = configuredProjectId?.trim() || undefined
    if (!requestedProjectId && credential.managedProjectId) {
      return credential
    }

    const loadPayload = await this.loadManagedProject(
      credential.accessToken,
      requestedProjectId,
      model,
    )
    if (!loadPayload) {
      if (requestedProjectId) {
        return credential
      }
      throw new GeminiOAuthError(
        'Gemini OAuth requires a Google Cloud project for this account. Configure `projectId` in the provider settings and try again.',
      )
    }

    const managedProjectId = normalizeProjectId(
      loadPayload.cloudaicompanionProject,
    )
    if (managedProjectId) {
      const next = {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresAt,
        updatedAt: credential.updatedAt,
        ...(credential.email ? { email: credential.email } : {}),
        ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
        managedProjectId,
      }
      await this.store.set(next)
      return next
    }

    const validationTier = loadPayload.ineligibleTiers?.find(
      (tier) =>
        tier.reasonCode?.trim().toUpperCase() === 'VALIDATION_REQUIRED' &&
        !!tier.validationUrl?.trim(),
    )
    if (validationTier) {
      throw new GeminiOAuthError(
        validationTier.reasonMessage?.trim() ||
          'Google account validation is required before using Gemini OAuth.',
      )
    }

    const tierId =
      loadPayload.allowedTiers?.find((tier) => tier?.isDefault)?.id ??
      loadPayload.allowedTiers?.[0]?.id ??
      LEGACY_TIER_ID

    if (tierId !== FREE_TIER_ID && !requestedProjectId) {
      throw new GeminiOAuthError(
        'This Google account requires a Google Cloud project. Please fill in `projectId` in the Gemini OAuth provider settings.',
      )
    }

    const onboardedProjectId = await this.onboardManagedProject(
      credential.accessToken,
      tierId,
      requestedProjectId,
      model,
    )
    if (!onboardedProjectId) {
      if (requestedProjectId) {
        return credential
      }
      throw new GeminiOAuthError(
        'Failed to resolve a Gemini OAuth project for this account.',
      )
    }

    const next = {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAt,
      updatedAt: credential.updatedAt,
      ...(credential.email ? { email: credential.email } : {}),
      ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
      managedProjectId: onboardedProjectId,
    }
    await this.store.set(next)
    return next
  }

  async listAvailableModels(
    configuredProjectId?: string,
  ): Promise<string[] | null> {
    const credential = await this.getUsableCredential()
    if (!credential) {
      return null
    }

    const contextualCredential = await this.ensureProjectContext(
      credential,
      configuredProjectId,
    )
    const project =
      contextualCredential.managedProjectId ?? contextualCredential.projectId
    if (!project) {
      return null
    }

    const response = await this.retrieveUserQuota(
      contextualCredential.accessToken,
      project,
    )
    const modelIds = Array.from(
      new Set(
        (response?.buckets ?? [])
          .map((bucket) => bucket.modelId?.trim())
          .filter((modelId): modelId is string => Boolean(modelId)),
      ),
    ).sort()

    return modelIds.length > 0 ? modelIds : null
  }

  private async exchangeAuthorizationCode(input: {
    code: string
    codeVerifier: string
  }): Promise<GeminiOAuthCredential> {
    const response = await requestUrl({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code_verifier: input.codeVerifier,
      }).toString(),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new GeminiOAuthError(
        `Token exchange failed: ${response.status}${this.describeErrorResponse(response)}`,
      )
    }

    const tokenResponse = response.json as TokenResponse
    const userInfo = await this.fetchUserInfo(tokenResponse.access_token)
    return this.toCredential(
      tokenResponse,
      undefined,
      userInfo?.email,
      undefined,
      undefined,
    )
  }

  private toCredential(
    tokens: TokenResponse,
    fallbackRefreshToken?: string,
    email?: string,
    projectId?: string,
    managedProjectId?: string,
  ): GeminiOAuthCredential {
    const refreshToken = tokens.refresh_token ?? fallbackRefreshToken
    if (!refreshToken) {
      throw new GeminiOAuthError(
        'Missing refresh token in Google OAuth response.',
      )
    }

    return {
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      updatedAt: Date.now(),
      ...(email ? { email } : {}),
      ...(projectId ? { projectId } : {}),
      ...(managedProjectId ? { managedProjectId } : {}),
    }
  }

  private async fetchUserInfo(
    accessToken: string,
  ): Promise<GoogleUserInfo | null> {
    const response = await requestUrl({
      url: GOOGLE_USERINFO_ENDPOINT,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      return null
    }

    return (response.json as GoogleUserInfo) ?? null
  }

  private async ensureOAuthServer(): Promise<void> {
    if (this.oauthServer) {
      return
    }

    await new Promise<void>((resolve, reject) => {
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
          resolve()
        }

        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(CALLBACK_PORT, CALLBACK_HOST)
      })()
    }).catch((error: unknown) => {
      throw new GeminiOAuthError(
        `Failed to start local OAuth callback server on ${REDIRECT_URI}: ${toErrorMessage(error)}`,
      )
    })
  }

  private async handleOAuthRequest(
    rawUrl: string,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(rawUrl, `http://${CALLBACK_HOST}:${CALLBACK_PORT}`)

    if (url.pathname !== '/oauth2callback') {
      this.respondHtml(res, 404, 'Not found')
      return
    }

    const error = url.searchParams.get('error')
    const errorDescription = url.searchParams.get('error_description')
    if (error) {
      const message = errorDescription || error
      this.pendingBrowserAuthorization?.reject(new GeminiOAuthError(message))
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
        new GeminiOAuthError('Invalid state returned from Gemini OAuth.'),
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
      })
      await this.store.set(credential)
      pending.resolve(credential)
      this.respondHtml(
        res,
        200,
        'Google authorization successful. You can close this window.',
      )
    } catch (oauthError) {
      pending.reject(
        oauthError instanceof Error
          ? oauthError
          : new GeminiOAuthError('Unknown OAuth callback error'),
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

  private async loadManagedProject(
    accessToken: string,
    projectId?: string,
    model?: string,
  ): Promise<LoadCodeAssistResponse | null> {
    const body: Record<string, unknown> = {
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        ...(projectId ? { duetProject: projectId } : {}),
      },
      ...(projectId ? { cloudaicompanionProject: projectId } : {}),
    }

    const response = await requestUrl({
      url: `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
      method: 'POST',
      headers: buildCodeAssistHeaders(accessToken, model),
      body: JSON.stringify(body),
      throw: false,
    }).catch(() => null)

    if (!response || response.status < 200 || response.status >= 300) {
      return null
    }

    return response.json as LoadCodeAssistResponse
  }

  private async onboardManagedProject(
    accessToken: string,
    tierId: string,
    projectId?: string,
    model?: string,
  ): Promise<string | undefined> {
    const body: Record<string, unknown> = {
      tierId,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        ...(projectId && tierId !== FREE_TIER_ID
          ? { duetProject: projectId }
          : {}),
      },
    }
    if (projectId && tierId !== FREE_TIER_ID) {
      body.cloudaicompanionProject = projectId
    }

    const response = await requestUrl({
      url: `${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
      method: 'POST',
      headers: buildCodeAssistHeaders(accessToken, model),
      body: JSON.stringify(body),
      throw: false,
    }).catch(() => null)

    if (!response || response.status < 200 || response.status >= 300) {
      return undefined
    }

    let payload = response.json as OnboardUserResponse
    if (!payload.done && payload.name) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const pollResponse = await requestUrl({
          url: `${CODE_ASSIST_ENDPOINT}/v1internal/${payload.name}`,
          method: 'GET',
          headers: buildCodeAssistHeaders(accessToken, model),
          throw: false,
        }).catch(() => null)

        if (
          !pollResponse ||
          pollResponse.status < 200 ||
          pollResponse.status >= 300
        ) {
          return undefined
        }

        payload = pollResponse.json as OnboardUserResponse
        if (payload.done) {
          break
        }
      }
    }

    return (
      normalizeProjectId(payload.response?.cloudaicompanionProject) ?? projectId
    )
  }

  private async retrieveUserQuota(
    accessToken: string,
    projectId: string,
    model?: string,
  ): Promise<RetrieveUserQuotaResponse | null> {
    const response = await requestUrl({
      url: `${CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`,
      method: 'POST',
      headers: buildCodeAssistHeaders(accessToken, model),
      body: JSON.stringify({ project: projectId }),
      throw: false,
    }).catch(() => null)

    if (!response || response.status < 200 || response.status >= 300) {
      return null
    }

    return response.json as RetrieveUserQuotaResponse
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
