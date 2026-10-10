import { requestUrl } from 'obsidian'

import type { CopilotUsableCredential } from '../auth/copilotOAuthService'

import {
  CopilotCredentialSource,
  buildCopilotAuthHeaders,
  requireCopilotCredential,
} from './copilotFetch'
import type { CopilotEndpoint } from './copilotRequestTraits'

/** One chat model the account can pick, as Copilot's `/models` reports it. */
export type CopilotCatalogModel = {
  id: string
  /** Paths the model is served on, e.g. `/chat/completions`, `/v1/messages`. */
  supportedEndpoints: string[]
  limits: {
    maxContextWindowTokens?: number
    maxPromptTokens?: number
    maxOutputTokens?: number
  }
  supports: {
    toolCalls?: boolean
    parallelToolCalls?: boolean
    vision?: boolean
    streaming?: boolean
  }
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

/**
 * Keeps the models the account may pick by id: chat-type, offered in
 * Copilot's own model picker, and not disabled by policy (a model with no
 * `policy` needs no opt-in).
 *
 * On Free and Student plans every model reports `model_picker_enabled: false`
 * — those plans reach models only through Auto (`copilotAutoSession.ts`), and
 * requesting one by id answers `model_not_supported` — so their list is empty
 * and Auto is all they get.
 */
export const parseCopilotModelCatalog = (
  json: unknown,
): CopilotCatalogModel[] => {
  const data = asRecord(json)?.data
  if (!Array.isArray(data)) {
    return []
  }

  return data.flatMap((entry): CopilotCatalogModel[] => {
    const model = asRecord(entry)
    const id = optionalString(model?.id)
    if (!model || !id) return []

    const capabilities = asRecord(model.capabilities)
    if (capabilities?.type !== 'chat') return []
    if (model.model_picker_enabled !== true) return []
    const policy = asRecord(model.policy)
    if (policy && policy.state !== 'enabled') return []

    const limits = asRecord(capabilities.limits)
    const supports = asRecord(capabilities.supports)
    return [
      {
        id,
        supportedEndpoints: Array.isArray(model.supported_endpoints)
          ? model.supported_endpoints.filter(
              (path): path is string => typeof path === 'string',
            )
          : [],
        limits: {
          maxContextWindowTokens: optionalNumber(
            limits?.max_context_window_tokens,
          ),
          maxPromptTokens: optionalNumber(limits?.max_prompt_tokens),
          maxOutputTokens: optionalNumber(limits?.max_output_tokens),
        },
        supports: {
          toolCalls: optionalBoolean(supports?.tool_calls),
          parallelToolCalls: optionalBoolean(supports?.parallel_tool_calls),
          vision: optionalBoolean(supports?.vision),
          streaming: optionalBoolean(supports?.streaming),
        },
      },
    ]
  })
}

/**
 * The wire format a model is called through. Anthropic's Messages API is
 * preferred when served, then Responses, then Chat Completions. A model the
 * catalog does not list (a hand-typed id) goes to Chat Completions, the one
 * endpoint every Copilot chat model is served on.
 */
export const selectCopilotEndpoint = (
  model: Pick<CopilotCatalogModel, 'supportedEndpoints'> | undefined,
): CopilotEndpoint => {
  const endpoints = model?.supportedEndpoints ?? []
  if (endpoints.includes('/v1/messages')) return 'messages'
  if (endpoints.includes('/responses')) return 'responses'
  return 'chat'
}

const fetchCatalog = async (
  source: CopilotCredentialSource,
): Promise<CopilotCatalogModel[]> => {
  const get = (credential: CopilotUsableCredential) =>
    requestUrl({
      url: `${credential.apiBaseUrl}/models`,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...buildCopilotAuthHeaders(credential),
      },
      throw: false,
    })

  let credential = await requireCopilotCredential(source)
  let response = await get(credential)
  if (response.status === 401) {
    // Same as a model request: a stale token is exchanged once more.
    source.invalidateCopilotToken(credential.copilotToken)
    credential = await requireCopilotCredential(source)
    response = await get(credential)
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch GitHub Copilot models: ${response.status}`)
  }
  return parseCopilotModelCatalog(response.json)
}

/** Per-provider catalog, shared by concurrent callers while it loads. */
const catalogs = new Map<string, Promise<CopilotCatalogModel[]>>()

/**
 * The provider's model catalog, fetched once per session. `refresh` fetches
 * it again (the settings "fetch models" action). A failed fetch is not kept,
 * so the next call tries again.
 */
export const getCopilotModelCatalog = (
  providerId: string,
  source: CopilotCredentialSource,
  options?: { refresh?: boolean },
): Promise<CopilotCatalogModel[]> => {
  const cached = catalogs.get(providerId)
  if (cached && !options?.refresh) {
    return cached
  }

  const pending = fetchCatalog(source)
  catalogs.set(providerId, pending)
  pending.catch(() => {
    if (catalogs.get(providerId) === pending) {
      catalogs.delete(providerId)
    }
  })
  return pending
}

/** Drops a provider's catalog after its login changes or it is removed. */
export const clearCopilotModelCatalog = (providerId: string): void => {
  catalogs.delete(providerId)
}
