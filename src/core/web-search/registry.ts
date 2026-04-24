import { bingProvider } from './providers/bing'
import { geminiGroundingProvider } from './providers/gemini-grounding'
import { grokSearchProvider } from './providers/grok'
import { jinaProvider } from './providers/jina'
import { searxngProvider } from './providers/searxng'
import { tavilyProvider } from './providers/tavily'
import type { WebSearchProvider, WebSearchProviderOptions } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- discriminated union dispatch
const PROVIDERS: Record<string, WebSearchProvider<any>> = {
  tavily: tavilyProvider,
  jina: jinaProvider,
  searxng: searxngProvider,
  bing: bingProvider,
  'gemini-grounding': geminiGroundingProvider,
  grok: grokSearchProvider,
}

export function getWebSearchProvider(
  options: WebSearchProviderOptions,
): WebSearchProvider {
  const provider = PROVIDERS[options.type]
  if (!provider) {
    throw new Error(`Unknown web search provider type: ${options.type}`)
  }
  return provider as WebSearchProvider
}
