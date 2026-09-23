import { requestUrl } from 'obsidian'

import { LLMProvider } from '../../types/provider.types'
import { normalizeGeminiProviderBaseUrl } from '../../utils/llm/provider-base-url'
import { toProviderHeadersRecord } from '../../utils/llm/provider-headers'

import { extractModelIdentifier } from './modelCatalogIdentifiers'

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

type GeminiListModelsResponse = {
  models?: unknown[]
  nextPageToken?: string
  error?: { message?: string }
}

// Error bodies are best-effort; a success body that isn't JSON must throw
// rather than read as an empty listing.
const parseErrorBody = (text: string): GeminiListModelsResponse => {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object'
      ? (parsed as GeminiListModelsResponse)
      : {}
  } catch {
    return {}
  }
}

/**
 * Lists every model id the Gemini Developer API exposes to this key, following
 * `nextPageToken` until the listing ends. Ids come back without the `models/`
 * prefix ("models/gemini-2.5-pro" -> "gemini-2.5-pro"), in API order; callers
 * decide which ones are relevant to them.
 */
export async function listGeminiModelIds(
  provider: Pick<LLMProvider, 'apiKey' | 'baseUrl' | 'customHeaders'>,
): Promise<string[]> {
  const baseUrl = provider.baseUrl
    ? normalizeGeminiProviderBaseUrl(provider.baseUrl)
    : DEFAULT_GEMINI_BASE_URL
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-goog-api-key': provider.apiKey ?? '',
    ...(toProviderHeadersRecord(provider.customHeaders) ?? {}),
  }

  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${baseUrl}/v1beta/models`)
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const response = await requestUrl({
      url: url.toString(),
      method: 'GET',
      headers,
      throw: false,
    })
    if (response.status < 200 || response.status >= 300) {
      const detail = parseErrorBody(response.text).error?.message
      throw new Error(`HTTP ${response.status}${detail ? ` ${detail}` : ''}`)
    }

    const json = JSON.parse(response.text) as GeminiListModelsResponse
    for (const entry of json.models ?? []) {
      const raw = extractModelIdentifier(entry)
      if (!raw) continue
      ids.push(raw.includes('/') ? raw.split('/').pop()! : raw)
    }
    pageToken = json.nextPageToken || undefined
  } while (pageToken)

  return ids
}
