import { RequestUrlParam, requestUrl } from 'obsidian'

import { COPILOT_EDITOR_HEADERS } from './copilotEditorHeaders'
import {
  CopilotOAuthCredential,
  CopilotOAuthStore,
  CopilotSession,
} from './copilotOAuthStore'

// VS Code Copilot's OAuth app; the only client id `copilot_internal/v2/token`
// accepts for a personal GitHub token.
const CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const SCOPE = 'read:user'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_VERIFICATION_URI = 'https://github.com/login/device'
const TOKEN_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token'
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_POLL_INTERVAL_S = 5
// RFC 8628 §3.5: every `slow_down` adds 5 seconds to the polling interval.
const SLOW_DOWN_INCREMENT_MS = 5000
const DEFAULT_DEVICE_CODE_TTL_S = 900
/** Re-exchange once the Copilot token has less than this left. */
export const COPILOT_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

export type CopilotOAuthErrorCode =
  /** The device code expired before the user approved it. */
  | 'device_code_expired'
  /** The user declined the authorization on GitHub. */
  | 'access_denied'
  /** GitHub rejected the stored GitHub token; the user must log in again. */
  | 'reauth_required'
  /** The account has no Copilot subscription, or policy disables it. */
  | 'no_subscription'
  /** Any other network or protocol failure. */
  | 'request_failed'

export class CopilotOAuthError extends Error {
  constructor(
    readonly code: CopilotOAuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CopilotOAuthError'
  }
}

export type CopilotDeviceAuthorization = {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
  /** Epoch milliseconds after which the device code is no longer valid. */
  expiresAt: number
}

/**
 * Login state as the settings panel presents it. `reauth_required` and
 * `no_subscription` still have a stored GitHub token (so disconnect applies),
 * but no usable Copilot token.
 */
export type CopilotOAuthStatus =
  | { state: 'disconnected' }
  | { state: 'connected' }
  | { state: 'reauth_required' }
  | { state: 'no_subscription' }
  | { state: 'error'; message: string }

/** What a model request needs: the bearer token and the origin it targets. */
export type CopilotUsableCredential = CopilotSession

type RequestUrlResponseLike = {
  status: number
  json?: unknown
  text?: string
}

const JSON_ACCEPT_HEADER = { Accept: 'application/json' }

const createAbortError = (): DOMException =>
  new DOMException('Device authorization was cancelled.', 'AbortError')

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) {
    return
  }
  throw signal.reason instanceof Error ? signal.reason : createAbortError()
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfAborted(signal)
    const handleAbort = () => {
      clearTimeout(timeoutId)
      reject(
        signal?.reason instanceof Error ? signal.reason : createAbortError(),
      )
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', handleAbort, { once: true })
  })

const readJsonObject = (
  response: RequestUrlResponseLike,
): Record<string, unknown> => {
  try {
    const json = response.json
    return json && typeof json === 'object'
      ? (json as Record<string, unknown>)
      : {}
  } catch {
    // Obsidian's `json` getter throws when the body is not JSON.
    return {}
  }
}

const describeResponse = (response: RequestUrlResponseLike): string => {
  try {
    const text = response.text?.trim()
    return text ? ` - ${text}` : ''
  } catch {
    return ''
  }
}

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Wraps `requestUrl` so a network-level rejection surfaces as a typed
 * `request_failed` error rather than an arbitrary exception.
 */
const send = async (
  params: RequestUrlParam,
): Promise<RequestUrlResponseLike> => {
  try {
    return await requestUrl({ ...params, throw: false })
  } catch (error) {
    throw new CopilotOAuthError('request_failed', toErrorMessage(error))
  }
}

const isSessionFresh = (session: CopilotSession, now: number): boolean =>
  session.copilotExpiresAt - now > COPILOT_TOKEN_REFRESH_MARGIN_MS

export class CopilotOAuthService {
  /** The exchange currently in flight; concurrent callers share it. */
  private exchangeInFlight: Promise<CopilotUsableCredential | null> | null =
    null
  /**
   * Bumped whenever the stored GitHub token is replaced or removed, so an
   * exchange started for the previous token cannot write its result back.
   */
  private credentialGeneration = 0
  /** A Copilot token a request reported as rejected (see invalidate). */
  private rejectedCopilotToken: string | null = null

  constructor(private readonly store: CopilotOAuthStore) {}

  async getCredential(): Promise<CopilotOAuthCredential | null> {
    return this.store.get()
  }

  async clearCredential(): Promise<void> {
    this.credentialGeneration += 1
    this.exchangeInFlight = null
    await this.store.clear()
  }

  async beginDeviceAuthorization(): Promise<CopilotDeviceAuthorization> {
    const response = await send({
      url: DEVICE_CODE_URL,
      method: 'POST',
      headers: {
        ...JSON_ACCEPT_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPE,
      }).toString(),
    })

    if (response.status < 200 || response.status >= 300) {
      throw new CopilotOAuthError(
        'request_failed',
        `Failed to start GitHub device authorization: ${response.status}${describeResponse(response)}`,
      )
    }

    const data = readJsonObject(response)
    if (
      typeof data.device_code !== 'string' ||
      typeof data.user_code !== 'string'
    ) {
      throw new CopilotOAuthError(
        'request_failed',
        'GitHub device authorization returned an invalid payload',
      )
    }

    const intervalS =
      typeof data.interval === 'number' && data.interval > 0
        ? data.interval
        : DEFAULT_POLL_INTERVAL_S
    const expiresInS =
      typeof data.expires_in === 'number' && data.expires_in > 0
        ? data.expires_in
        : DEFAULT_DEVICE_CODE_TTL_S

    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri:
        typeof data.verification_uri === 'string'
          ? data.verification_uri
          : DEFAULT_VERIFICATION_URI,
      intervalMs: intervalS * 1000,
      expiresAt: Date.now() + expiresInS * 1000,
    }
  }

  /**
   * Polls the token endpoint until the user approves, declines, or the device
   * code expires (RFC 8628 §3.4–3.5). On approval the GitHub token is stored;
   * the Copilot token is exchanged lazily by `getUsableCredential`.
   */
  async pollDeviceAuthorization(
    authorization: CopilotDeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<CopilotOAuthCredential> {
    let intervalMs = authorization.intervalMs

    while (true) {
      throwIfAborted(signal)
      const remainingMs = authorization.expiresAt - Date.now()
      if (remainingMs <= 0) {
        throw new CopilotOAuthError(
          'device_code_expired',
          'The GitHub device code expired before it was approved.',
        )
      }
      await sleep(Math.min(intervalMs, remainingMs), signal)

      const response = await send({
        url: ACCESS_TOKEN_URL,
        method: 'POST',
        headers: {
          ...JSON_ACCEPT_HEADER,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: authorization.deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        }).toString(),
      })
      throwIfAborted(signal)

      // GitHub reports pending/denied states with HTTP 200 and an `error`
      // field; RFC 8628 servers use 400. Both carry the same JSON body.
      const data = readJsonObject(response)
      if (typeof data.access_token === 'string' && data.access_token) {
        const credential: CopilotOAuthCredential = {
          githubToken: data.access_token,
          updatedAt: Date.now(),
        }
        this.credentialGeneration += 1
        this.exchangeInFlight = null
        await this.store.set(credential)
        return credential
      }

      switch (data.error) {
        case 'authorization_pending':
          continue
        case 'slow_down':
          intervalMs =
            typeof data.interval === 'number' && data.interval > 0
              ? data.interval * 1000
              : intervalMs + SLOW_DOWN_INCREMENT_MS
          continue
        case 'expired_token':
          throw new CopilotOAuthError(
            'device_code_expired',
            'The GitHub device code expired before it was approved.',
          )
        case 'access_denied':
          throw new CopilotOAuthError(
            'access_denied',
            'GitHub authorization was declined.',
          )
        default:
          throw new CopilotOAuthError(
            'request_failed',
            `GitHub device authorization polling failed: ${response.status}${describeResponse(response)}`,
          )
      }
    }
  }

  /**
   * Returns a Copilot token with at least five minutes left, exchanging the
   * stored GitHub token when needed. `null` means not logged in. Throws a
   * `CopilotOAuthError` with `reauth_required` / `no_subscription` when
   * GitHub refuses the exchange.
   */
  async getUsableCredential(): Promise<CopilotUsableCredential | null> {
    const stored = await this.store.get()
    if (!stored) {
      return null
    }

    const { session } = stored
    if (
      session &&
      session.copilotToken !== this.rejectedCopilotToken &&
      isSessionFresh(session, Date.now())
    ) {
      return session
    }

    if (!this.exchangeInFlight) {
      const exchange = this.exchange(stored.githubToken)
      this.exchangeInFlight = exchange
      const clearInFlight = () => {
        if (this.exchangeInFlight === exchange) {
          this.exchangeInFlight = null
        }
      }
      exchange.then(clearInFlight, clearInFlight)
    }
    return this.exchangeInFlight
  }

  /**
   * Resolves a usable Copilot token as a side effect, so the status reflects
   * whether GitHub still accepts the login and grants Copilot access.
   */
  async getStatus(): Promise<CopilotOAuthStatus> {
    try {
      const credential = await this.getUsableCredential()
      return credential ? { state: 'connected' } : { state: 'disconnected' }
    } catch (error) {
      if (
        error instanceof CopilotOAuthError &&
        (error.code === 'reauth_required' || error.code === 'no_subscription')
      ) {
        return { state: error.code }
      }
      return { state: 'error', message: toErrorMessage(error) }
    }
  }

  /**
   * Marks a Copilot token as rejected so the next `getUsableCredential`
   * exchanges a new one. Takes the token the failed request used, so a late
   * 401 from an old request cannot discard a token exchanged after it.
   */
  invalidateCopilotToken(copilotToken: string): void {
    this.rejectedCopilotToken = copilotToken
  }

  private async exchange(
    githubToken: string,
  ): Promise<CopilotUsableCredential | null> {
    const generation = this.credentialGeneration
    const response = await send({
      url: TOKEN_EXCHANGE_URL,
      method: 'GET',
      headers: {
        ...JSON_ACCEPT_HEADER,
        ...COPILOT_EDITOR_HEADERS,
        Authorization: `token ${githubToken}`,
      },
    })

    if (response.status === 401) {
      throw new CopilotOAuthError(
        'reauth_required',
        'GitHub rejected the saved login. Log in to GitHub Copilot again.',
      )
    }
    if (response.status === 403) {
      throw new CopilotOAuthError(
        'no_subscription',
        `This GitHub account has no Copilot access${describeResponse(response)}`,
      )
    }
    if (response.status < 200 || response.status >= 300) {
      throw new CopilotOAuthError(
        'request_failed',
        `Copilot token exchange failed: ${response.status}${describeResponse(response)}`,
      )
    }

    const data = readJsonObject(response)
    const endpoints = data.endpoints as { api?: unknown } | undefined
    if (
      typeof data.token !== 'string' ||
      typeof data.expires_at !== 'number' ||
      typeof endpoints?.api !== 'string'
    ) {
      throw new CopilotOAuthError(
        'request_failed',
        'Copilot token exchange returned an invalid payload',
      )
    }

    const session: CopilotSession = {
      copilotToken: data.token,
      copilotExpiresAt: data.expires_at * 1000,
      apiBaseUrl: endpoints.api.replace(/\/+$/, ''),
    }

    // The login was replaced or removed while this exchange was running.
    if (generation !== this.credentialGeneration) {
      return null
    }
    await this.store.set({ githubToken, session, updatedAt: Date.now() })
    return session
  }
}
