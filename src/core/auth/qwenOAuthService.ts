import { requestUrl } from 'obsidian'

import { QwenOAuthCredential, QwenOAuthStore } from './qwenOAuthStore'

const ISSUER = 'https://chat.qwen.ai'
const DEVICE_CODE_ENDPOINT = `${ISSUER}/api/v1/oauth2/device/code`
const TOKEN_ENDPOINT = `${ISSUER}/api/v1/oauth2/token`
const CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const SCOPE = 'openid profile email model.completion'
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_POLL_INTERVAL_MS = 10000

type PkceCodes = {
  verifier: string
  challenge: string
}

type PendingBrowserAuthorization = {
  cancelled: boolean
  resolve: (credential: QwenOAuthCredential) => void
  reject: (error: Error) => void
}

type DeviceAuthorizationResponse = {
  device_code?: string
  user_code?: string
  verification_uri?: string
  verification_uri_complete?: string
  expires_in?: number
  error?: string
  error_description?: string
}

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  resource_url?: string
  error?: string
  error_description?: string
}

type RequestLikeResponse = {
  status: number
  json?: unknown
  text?: string
}

export type QwenOAuthBrowserAuthorization = {
  authorizationUrl: string
  complete: Promise<QwenOAuthCredential>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const generateCodeVerifier = (): string =>
  base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)

const base64UrlEncode = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateCodeVerifier()
  const encoder = new TextEncoder()
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  return {
    verifier,
    challenge: base64UrlEncode(hash),
  }
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

const buildFormBody = (fields: Record<string, string>): string =>
  new URLSearchParams(fields).toString()

const describeErrorResponse = (response: RequestLikeResponse): string => {
  const json = response.json as
    | { error?: string; error_description?: string }
    | undefined

  const details =
    json?.error_description ?? json?.error ?? response.text?.trim() ?? ''

  return details ? ` - ${details}` : ''
}

export class QwenOAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QwenOAuthError'
  }
}

export class QwenOAuthService {
  private pendingBrowserAuthorization: PendingBrowserAuthorization | null = null

  constructor(private readonly store: QwenOAuthStore) {}

  async getCredential(): Promise<QwenOAuthCredential | null> {
    return this.store.get()
  }

  async clearCredential(): Promise<void> {
    this.cancelPendingBrowserAuthorization('Qwen OAuth login was cancelled.')
    await this.store.clear()
  }

  async beginBrowserAuthorization(): Promise<QwenOAuthBrowserAuthorization> {
    if (this.pendingBrowserAuthorization) {
      throw new QwenOAuthError(
        'Another Qwen OAuth login is already in progress.',
      )
    }

    const pkce = await generatePKCE()
    const deviceAuth = await this.requestDeviceAuthorization(pkce.challenge)

    const complete = new Promise<QwenOAuthCredential>((resolve, reject) => {
      this.pendingBrowserAuthorization = {
        cancelled: false,
        resolve,
        reject,
      }

      void this.pollForCredential({
        deviceCode: deviceAuth.device_code,
        codeVerifier: pkce.verifier,
        expiresInSec: deviceAuth.expires_in,
      }).then(resolve, reject)
    }).finally(() => {
      this.pendingBrowserAuthorization = null
    })

    return {
      authorizationUrl:
        deviceAuth.verification_uri_complete ?? deviceAuth.verification_uri,
      complete,
    }
  }

  cancelPendingBrowserAuthorization(
    message = 'Qwen OAuth login was cancelled.',
  ): void {
    if (!this.pendingBrowserAuthorization) {
      return
    }

    this.pendingBrowserAuthorization.cancelled = true
    this.pendingBrowserAuthorization.reject(new QwenOAuthError(message))
    this.pendingBrowserAuthorization = null
  }

  async getUsableCredential(): Promise<QwenOAuthCredential | null> {
    const credential = await this.store.get()
    if (!credential) {
      return null
    }

    if (!this.store.isExpired(credential)) {
      return credential
    }

    return this.refreshCredential({
      refreshToken: credential.refreshToken,
      resourceUrl: credential.resourceUrl,
    })
  }

  async refreshCredential(
    credential: Pick<QwenOAuthCredential, 'refreshToken' | 'resourceUrl'>,
  ): Promise<QwenOAuthCredential> {
    try {
      const response = await requestUrl({
        url: TOKEN_ENDPOINT,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        headers: {
          Accept: 'application/json',
        },
        body: buildFormBody({
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken,
          client_id: CLIENT_ID,
        }),
        throw: false,
      })

      if (response.status < 200 || response.status >= 300) {
        throw new QwenOAuthError(
          `Token refresh failed: ${response.status}${describeErrorResponse(response)}`,
        )
      }

      return this.persistCredentialFromTokenResponse(response.json, credential)
    } catch (error) {
      throw new QwenOAuthError(
        `Failed to refresh Qwen OAuth token: ${toErrorMessage(error)}`,
      )
    }
  }

  private async requestDeviceAuthorization(
    codeChallenge: string,
  ): Promise<
    Required<
      Pick<
        DeviceAuthorizationResponse,
        | 'device_code'
        | 'verification_uri'
        | 'verification_uri_complete'
        | 'expires_in'
      >
    >
  > {
    const response = await requestUrl({
      url: DEVICE_CODE_ENDPOINT,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        Accept: 'application/json',
      },
      body: buildFormBody({
        client_id: CLIENT_ID,
        scope: SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
      throw: false,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new QwenOAuthError(
        `Failed to start Qwen OAuth device authorization: ${response.status}${describeErrorResponse(response)}`,
      )
    }

    const json = (response.json ?? {}) as DeviceAuthorizationResponse
    if (
      typeof json.device_code !== 'string' ||
      typeof json.verification_uri !== 'string' ||
      typeof json.verification_uri_complete !== 'string' ||
      typeof json.expires_in !== 'number'
    ) {
      throw new QwenOAuthError(
        json.error_description ||
          'Invalid Qwen OAuth device authorization response.',
      )
    }

    return {
      device_code: json.device_code,
      verification_uri: json.verification_uri,
      verification_uri_complete: json.verification_uri_complete,
      expires_in: json.expires_in,
    }
  }

  private async pollForCredential({
    deviceCode,
    codeVerifier,
    expiresInSec,
  }: {
    deviceCode: string
    codeVerifier: string
    expiresInSec: number
  }): Promise<QwenOAuthCredential> {
    const startedAt = Date.now()
    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS

    while (Date.now() - startedAt < expiresInSec * 1000) {
      if (this.pendingBrowserAuthorization?.cancelled) {
        throw new QwenOAuthError('Qwen OAuth login was cancelled.')
      }

      const response = await requestUrl({
        url: TOKEN_ENDPOINT,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        headers: {
          Accept: 'application/json',
        },
        body: buildFormBody({
          grant_type: DEVICE_GRANT_TYPE,
          client_id: CLIENT_ID,
          device_code: deviceCode,
          code_verifier: codeVerifier,
        }),
        throw: false,
      })

      if (response.status >= 200 && response.status < 300) {
        return await this.persistCredentialFromTokenResponse(response.json)
      }

      const payload = (response.json ?? {}) as TokenResponse
      if (
        response.status === 400 &&
        payload.error === 'authorization_pending'
      ) {
        await sleep(pollIntervalMs)
        continue
      }

      if (response.status === 429 && payload.error === 'slow_down') {
        pollIntervalMs = Math.min(
          Math.round(pollIntervalMs * 1.5),
          MAX_POLL_INTERVAL_MS,
        )
        await sleep(pollIntervalMs)
        continue
      }

      throw new QwenOAuthError(
        `Failed to complete Qwen OAuth login: ${response.status}${describeErrorResponse(response)}`,
      )
    }

    throw new QwenOAuthError(
      'Qwen OAuth authentication timed out. Please try again.',
    )
  }

  private async persistCredentialFromTokenResponse(
    tokenResponse: unknown,
    previous?: Pick<QwenOAuthCredential, 'refreshToken' | 'resourceUrl'>,
  ): Promise<QwenOAuthCredential> {
    const json = (tokenResponse ?? {}) as TokenResponse
    if (typeof json.error === 'string') {
      throw new QwenOAuthError(
        json.error_description ||
          `Qwen OAuth token request failed: ${json.error}`,
      )
    }

    if (typeof json.access_token !== 'string') {
      throw new QwenOAuthError('Missing access token in Qwen OAuth response.')
    }

    const refreshToken =
      typeof json.refresh_token === 'string'
        ? json.refresh_token
        : previous?.refreshToken
    if (!refreshToken) {
      throw new QwenOAuthError('Missing refresh token in Qwen OAuth response.')
    }

    const resourceUrl =
      typeof json.resource_url === 'string'
        ? json.resource_url
        : previous?.resourceUrl
    if (!resourceUrl) {
      throw new QwenOAuthError('Missing resource URL in Qwen OAuth response.')
    }

    const expiresInSec =
      typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
        ? json.expires_in
        : 3600

    const credential: QwenOAuthCredential = {
      accessToken: json.access_token,
      refreshToken,
      resourceUrl,
      expiresAt: Date.now() + expiresInSec * 1000,
      updatedAt: Date.now(),
    }
    await this.store.set(credential)
    return credential
  }
}
