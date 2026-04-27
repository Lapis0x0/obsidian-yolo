import { getWebSearchProvider } from './registry'
import type {
  WebSearchProviderOptions,
  WebSearchResult,
  WebSearchScrapeResult,
  WebSearchSettings,
} from './types'

const SHORT_ID_LENGTH = 6

function shortId(): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + SHORT_ID_LENGTH)
}

export function resolveActiveWebSearchProvider(
  settings: WebSearchSettings,
): WebSearchProviderOptions | undefined {
  if (settings.providers.length === 0) return undefined
  if (settings.defaultProviderId) {
    const match = settings.providers.find(
      (p) => p.id === settings.defaultProviderId,
    )
    if (match) return match
  }
  return settings.providers[0]
}

export async function runWebSearch({
  settings,
  query,
  topic,
  signal,
}: {
  settings: WebSearchSettings
  query: string
  topic?: string
  signal?: AbortSignal
}): Promise<WebSearchResult & { providerType: string; providerName: string }> {
  const options = resolveActiveWebSearchProvider(settings)
  if (!options) {
    throw new Error('No web search provider is configured.')
  }
  const provider = getWebSearchProvider(options)
  const result = await provider.search(
    { query, topic },
    options,
    settings.common,
    signal,
  )
  const items = result.items.slice(0, settings.common.resultSize).map((it) => ({
    ...it,
    id: it.id || shortId(),
  }))
  return {
    ...result,
    items,
    providerType: provider.type,
    providerName: options.name || provider.displayName,
  }
}

export async function runWebScrape({
  settings,
  url,
  signal,
}: {
  settings: WebSearchSettings
  url: string
  signal?: AbortSignal
}): Promise<WebSearchScrapeResult & { providerName: string }> {
  const options = resolveActiveWebSearchProvider(settings)
  if (!options) {
    throw new Error('No web search provider is configured.')
  }
  const provider = getWebSearchProvider(options)
  if (!provider.supportsScrape || !provider.scrape) {
    throw new Error(
      `Provider "${options.name}" (${provider.type}) does not support scraping.`,
    )
  }
  const result = await provider.scrape(
    { url },
    options,
    settings.common,
    signal,
  )
  return { ...result, providerName: options.name || provider.displayName }
}

export function isWebSearchToolReady(settings: WebSearchSettings): boolean {
  return resolveActiveWebSearchProvider(settings) !== undefined
}

export function activeProviderSupportsScrape(
  settings: WebSearchSettings,
): boolean {
  const options = resolveActiveWebSearchProvider(settings)
  if (!options) return false
  return getWebSearchProvider(options).supportsScrape
}
