import { requestUrl } from 'obsidian'

import { ChatGPTOAuthCredential, ChatGPTOAuthStore } from './chatgptOAuthStore'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = 'https://auth.openai.com'
const DEVICE_VERIFICATION_URI = `${ISSUER}/codex/device`
const DEVICE_CODE_POLL_MARGIN_MS = 3000

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

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
  constructor(private readonly store: ChatGPTOAuthStore) {}

  async getCredential(): Promise<ChatGPTOAuthCredential | null> {
    return this.store.get()
  }

  async clearCredential(): Promise<void> {
    await this.store.clear()
  }

  async beginDeviceAuthorization(): Promise<ChatGPTOAuthDeviceAuthorization> {
    const response = await requestUrl({
      url: `${ISSUER}/api/accounts/deviceauth/usercode`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    })

    if (response.status < 200 || response.status >= 300) {
      throw new ChatGPTOAuthError(
        `Failed to start device authorization: ${response.status}`,
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
        },
        body: JSON.stringify({
          device_auth_id: authorization.deviceAuthId,
          user_code: authorization.userCode,
        }),
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
          `Device authorization polling failed: ${response.status}`,
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
    })

    if (response.status < 200 || response.status >= 300) {
      throw new ChatGPTOAuthError(`Token refresh failed: ${response.status}`)
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
    })

    if (response.status < 200 || response.status >= 300) {
      throw new ChatGPTOAuthError(`Token exchange failed: ${response.status}`)
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
}
