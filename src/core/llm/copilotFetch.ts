import { COPILOT_EDITOR_HEADERS } from '../auth/copilotEditorHeaders'
import type {
  CopilotOAuthService,
  CopilotUsableCredential,
} from '../auth/copilotOAuthService'

import {
  resolveCopilotEndpointFromPath,
  resolveCopilotRequestTraits,
} from './copilotRequestTraits'
import { LLMProviderNotConfiguredException } from './exception'

/** The part of the login service a Copilot request needs. */
export type CopilotCredentialSource = Pick<
  CopilotOAuthService,
  'getUsableCredential' | 'invalidateCopilotToken'
>

/**
 * Returns a usable credential, or throws the "not logged in" error the chat
 * surface shows when the provider has no GitHub login yet.
 */
export const requireCopilotCredential = async (
  source: CopilotCredentialSource,
): Promise<CopilotUsableCredential> => {
  const credential = await source.getUsableCredential()
  if (!credential) {
    throw new LLMProviderNotConfiguredException(
      'GitHub Copilot is not logged in. Please connect your account in settings.',
    )
  }
  return credential
}

/** Headers every Copilot API call carries: the bearer token and editor id. */
export const buildCopilotAuthHeaders = (
  credential: CopilotUsableCredential,
): Record<string, string> => ({
  ...COPILOT_EDITOR_HEADERS,
  Authorization: `Bearer ${credential.copilotToken}`,
})

type NormalizedRequest = {
  url: string
  init: RequestInit
  /**
   * The body as text, so a retry can send it again. `undefined` with a
   * non-empty `init.body` means the body is a one-shot stream.
   */
  bodyText: string | undefined
}

const normalizeRequest = async (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<NormalizedRequest> => {
  if (input instanceof Request) {
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD'
    const bodyText =
      typeof init?.body === 'string'
        ? init.body
        : hasBody && init?.body === undefined
          ? await input.clone().text()
          : undefined
    return {
      url: input.url,
      init: {
        method: input.method,
        headers: input.headers,
        signal: input.signal,
        ...init,
        ...(bodyText !== undefined ? { body: bodyText } : {}),
      },
      bodyText,
    }
  }
  return {
    url: input instanceof URL ? input.toString() : input,
    init: init ?? {},
    bodyText: typeof init?.body === 'string' ? init.body : undefined,
  }
}

/**
 * Where the fetch layer finds the `Copilot-Session-Token` that unlocks a
 * model Copilot Auto picked, and reports a token the server turned down.
 */
export type CopilotSessionTokenSource = {
  find(modelId: string): Promise<string | undefined>
  reject(sessionToken: string): void
}

const readBodyModel = (bodyText: string | undefined): string | undefined => {
  if (!bodyText) return undefined
  try {
    const model = (JSON.parse(bodyText) as { model?: unknown }).model
    return typeof model === 'string' ? model : undefined
  } catch {
    return undefined
  }
}

/**
 * Copilot answers an expired or mismatched Auto session with a 4xx whose
 * message names the session ("Requested model not available for session").
 */
const isSessionRejection = async (response: Response): Promise<boolean> => {
  if (response.status < 400 || response.status >= 500) return false
  const text = await response
    .clone()
    .text()
    .catch(() => '')
  return /session/i.test(text)
}

/** Swaps the placeholder origin the SDK built for the account's API origin. */
const rewriteOrigin = (url: string, apiBaseUrl: string): string => {
  const target = new URL(url)
  const base = new URL(apiBaseUrl)
  target.protocol = base.protocol
  target.host = base.host
  return target.toString()
}

/**
 * Turns the SDK-shaped request into a Copilot one at the fetch layer, where
 * the HTTP body of every request is directly available — no per-call context
 * has to be threaded through, so concurrent requests cannot mix up.
 *
 * The SDK client was built against a placeholder origin and a placeholder
 * key; this swaps in the account's API origin and the current Copilot token,
 * adds the editor headers, and derives `X-Initiator` and
 * `Copilot-Vision-Request` from the body. A 401 means the token went stale
 * before its stated expiry: it is invalidated and the request sent once more
 * with a freshly exchanged one.
 *
 * A request for a model an Auto session unlocks also carries that session's
 * `Copilot-Session-Token`; if the server rejects the session, it is reported
 * so the next request opens a new one.
 */
export const createCopilotFetch = (
  transportFetch: typeof fetch,
  getCredentialSource: () => CopilotCredentialSource,
  sessionTokens?: CopilotSessionTokenSource,
): typeof fetch => {
  return async (input, init) => {
    const source = getCredentialSource()
    const request = await normalizeRequest(input, init)
    const endpoint = resolveCopilotEndpointFromPath(
      new URL(request.url).pathname,
    )
    const traits = endpoint
      ? resolveCopilotRequestTraits(endpoint, request.bodyText)
      : null
    const bodyModel = readBodyModel(request.bodyText)
    const sessionToken =
      sessionTokens && bodyModel
        ? await sessionTokens.find(bodyModel)
        : undefined

    const send = async (
      credential: CopilotUsableCredential,
    ): Promise<Response> => {
      const headers = new Headers(request.init.headers)
      // The SDKs authenticate with the placeholder key under their own
      // header names; Copilot only reads the bearer token set below.
      headers.delete('x-api-key')
      headers.delete('authorization')
      for (const [name, value] of Object.entries(
        buildCopilotAuthHeaders(credential),
      )) {
        headers.set(name, value)
      }
      headers.set('Openai-Intent', 'conversation-edits')
      if (traits) {
        headers.set('X-Initiator', traits.initiator)
        if (traits.hasImage) {
          headers.set('Copilot-Vision-Request', 'true')
        }
      }
      if (sessionToken) {
        headers.set('Copilot-Session-Token', sessionToken)
      }
      return transportFetch(rewriteOrigin(request.url, credential.apiBaseUrl), {
        ...request.init,
        headers,
      })
    }

    const credential = await requireCopilotCredential(source)
    const response = await send(credential)
    if (sessionToken && (await isSessionRejection(response))) {
      sessionTokens?.reject(sessionToken)
      return response
    }
    const replayable =
      request.bodyText !== undefined || request.init.body == null
    if (response.status !== 401 || !replayable) {
      return response
    }

    source.invalidateCopilotToken(credential.copilotToken)
    return send(await requireCopilotCredential(source))
  }
}
