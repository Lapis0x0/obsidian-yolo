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

const toSemver = (version: string): string => {
  const parts = version.split('.')
  return parts.length > 3 ? parts.slice(0, 3).join('.') : version
}

const getModelUrl = (rawBaseUrl?: string, clientVersion?: string): string => {
  const base = (rawBaseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(
    /\/+$/,
    '',
  )
  const ver = toSemver(clientVersion || '1.0.0')
  return `${base}/models?client_version=${encodeURIComponent(ver)}`
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
  const url = getModelUrl(baseUrl, clientVersion)
  const models = await fetchModelsFromUrl(url, oauthHeaders)
  return Array.from(new Set(models)).sort()
}
