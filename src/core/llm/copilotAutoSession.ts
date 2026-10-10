import { requestUrl } from 'obsidian'

import type { CopilotUsableCredential } from '../auth/copilotOAuthService'

import {
  CopilotCredentialSource,
  buildCopilotAuthHeaders,
  requireCopilotCredential,
} from './copilotFetch'
import type { CopilotCatalogModel } from './copilotModelCatalog'

/** The model id that asks Copilot to pick the model itself. */
export const COPILOT_AUTO_MODEL_ID = 'auto'

/** Routing preference sent to `/auto`; Copilot offers efficiency/balance/intelligence/fast. */
const AUTO_TIER = 'balance'
/** The routing prompt only needs to convey the task, not carry the request. */
const MAX_ROUTING_PROMPT_CHARS = 2000
/** Re-route this long before the session token's stated expiry. */
const SESSION_EXPIRY_MARGIN_MS = 5 * 60 * 1000

export type CopilotAutoSession = {
  /** Sent as `Copilot-Session-Token`; valid only for `selectedModel`. */
  sessionToken: string
  selectedModel: Pick<CopilotCatalogModel, 'id' | 'supportedEndpoints'>
  /** Epoch milliseconds. */
  expiresAt: number
}

export type CopilotAutoRoutingInput = {
  prompt: string
  hasImage: boolean
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined

export const parseCopilotAutoSession = (
  json: unknown,
): CopilotAutoSession | null => {
  const body = asRecord(json)
  const selected = asRecord(body?.selected_model)
  const sessionToken = body?.session_token
  const id = selected?.id
  const expiresAt = body?.expires_at
  if (
    typeof sessionToken !== 'string' ||
    !sessionToken ||
    typeof id !== 'string' ||
    !id ||
    typeof expiresAt !== 'number'
  ) {
    return null
  }
  return {
    sessionToken,
    selectedModel: {
      id,
      supportedEndpoints: Array.isArray(selected?.supported_endpoints)
        ? selected.supported_endpoints.filter(
            (path): path is string => typeof path === 'string',
          )
        : [],
    },
    expiresAt: expiresAt * 1000,
  }
}

const requestAutoSession = async (
  source: CopilotCredentialSource,
  input: CopilotAutoRoutingInput,
): Promise<CopilotAutoSession> => {
  const post = (credential: CopilotUsableCredential) =>
    requestUrl({
      url: `${credential.apiBaseUrl}/auto`,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...buildCopilotAuthHeaders(credential),
      },
      body: JSON.stringify({
        prompt: input.prompt.slice(0, MAX_ROUTING_PROMPT_CHARS),
        tier: AUTO_TIER,
        ...(input.hasImage ? { has_image: true } : {}),
      }),
      throw: false,
    })

  let credential = await requireCopilotCredential(source)
  let response = await post(credential)
  if (response.status === 401) {
    source.invalidateCopilotToken(credential.copilotToken)
    credential = await requireCopilotCredential(source)
    response = await post(credential)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `GitHub Copilot Auto could not pick a model: ${response.status}`,
    )
  }
  const session = parseCopilotAutoSession(response.json)
  if (!session) {
    throw new Error('GitHub Copilot Auto returned an unexpected response.')
  }
  return session
}

/** Per-provider session, shared by concurrent callers while it is fetched. */
const sessions = new Map<string, Promise<CopilotAutoSession>>()

/**
 * The provider's Auto session: the model Copilot picked and the token that
 * unlocks it. One session per provider is reused until it nears expiry or the
 * server rejects it, so a conversation keeps one model (and its prompt cache)
 * instead of being re-routed every turn. `input` only steers the pick when a
 * new session is opened.
 */
export const getCopilotAutoSession = (
  providerId: string,
  source: CopilotCredentialSource,
  input: CopilotAutoRoutingInput,
): Promise<CopilotAutoSession> => {
  const cached = sessions.get(providerId)
  if (cached) {
    return cached.then((session) =>
      session.expiresAt - SESSION_EXPIRY_MARGIN_MS > Date.now()
        ? session
        : refresh(providerId, cached, source, input),
    )
  }
  return refresh(providerId, undefined, source, input)
}

const refresh = (
  providerId: string,
  stale: Promise<CopilotAutoSession> | undefined,
  source: CopilotCredentialSource,
  input: CopilotAutoRoutingInput,
): Promise<CopilotAutoSession> => {
  // Another caller may already have replaced the stale session.
  const current = sessions.get(providerId)
  if (current && current !== stale) {
    return current
  }
  const pending = requestAutoSession(source, input)
  sessions.set(providerId, pending)
  pending.catch(() => {
    if (sessions.get(providerId) === pending) {
      sessions.delete(providerId)
    }
  })
  return pending
}

/**
 * The session token for a request naming `modelId`, if an Auto session of
 * this provider unlocks that model. Read by the fetch layer, which only sees
 * the request body.
 */
export const findCopilotAutoSessionToken = async (
  providerId: string,
  modelId: string,
): Promise<string | undefined> => {
  const pending = sessions.get(providerId)
  if (!pending) return undefined
  const session = await pending.catch(() => undefined)
  return session?.selectedModel.id === modelId
    ? session.sessionToken
    : undefined
}

/** Forgets a session the server rejected, so the next request re-routes. */
export const invalidateCopilotAutoSession = (
  providerId: string,
  sessionToken: string,
): void => {
  const pending = sessions.get(providerId)
  if (!pending) return
  void pending
    .then((session) => {
      if (
        session.sessionToken === sessionToken &&
        sessions.get(providerId) === pending
      ) {
        sessions.delete(providerId)
      }
    })
    .catch(() => undefined)
}

/** Drops a provider's session after its login changes or it is removed. */
export const clearCopilotAutoSession = (providerId: string): void => {
  sessions.delete(providerId)
}
