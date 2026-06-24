import { requestUrl } from 'obsidian'

import { collectModelIdentifiers } from './modelCatalogIdentifiers'

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

type ChatGPTOAuthModelCatalogOptions = {
  baseUrl?: string
  accessToken: string
  accountId?: string
  headers?: Record<string, string>
  clientVersion: string
}

const collectModelsFromJson = (json: unknown): string[] => {
  const record =
    json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  const buckets: string[] = []

  if (Array.isArray(record?.data)) {
    buckets.push(...collectModelIdentifiers(record.data))
  }
  if (Array.isArray(record?.models)) {
    buckets.push(...collectModelIdentifiers(record.models))
  }
  if (Array.isArray(json)) {
    buckets.push(...collectModelIdentifiers(json))
  }

  return buckets
}

const getModelUrlCandidates = (rawBaseUrl?: string): string[] => {
  const base = (rawBaseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(
    /\/+$/,
    '',
  )
  const baseWithoutVersion = base.replace(/\/v\d+$/, '')
  return Array.from(
    new Set([
      `${base}/models`,
      `${baseWithoutVersion}/models`,
      `${base}/responses/models`,
      `${baseWithoutVersion}/responses/models`,
    ]),
  )
}

const appendClientVersion = (url: string, clientVersion: string): string => {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}client_version=${encodeURIComponent(clientVersion)}`
}

const fetchModelsFromUrl = async (
  url: string,
  headers: Record<string, string>,
): Promise<string[]> => {
  const response = await requestUrl({
    url,
    method: 'GET',
    headers,
  })

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch models from ${url}: ${response.status}`)
  }

  const json = response.json ?? JSON.parse(response.text)
  const models = collectModelsFromJson(json)
  if (models.length === 0) {
    throw new Error(`Empty models list in response from ${url}`)
  }
  return models
}

export async function listChatGPTOAuthModels({
  baseUrl,
  accessToken,
  accountId,
  headers,
  clientVersion,
}: ChatGPTOAuthModelCatalogOptions): Promise<string[]> {
  const oauthHeaders: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    originator: 'opencode',
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    ...(headers ?? {}),
  }
  let lastErr: unknown = null

  for (const url of getModelUrlCandidates(baseUrl)) {
    try {
      const models = await fetchModelsFromUrl(url, oauthHeaders)
      return Array.from(new Set(models)).sort()
    } catch (error) {
      lastErr = error
    }

    try {
      const models = await fetchModelsFromUrl(
        appendClientVersion(url, clientVersion),
        oauthHeaders,
      )
      return Array.from(new Set(models)).sort()
    } catch (error) {
      lastErr = error
    }
  }

  if (lastErr instanceof Error) {
    throw lastErr
  }
  throw new Error('Failed to fetch ChatGPT OAuth models from all endpoints')
}
