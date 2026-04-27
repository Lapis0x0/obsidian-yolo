import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type {
  WebSearchProvider,
  WebSearchResult,
  WebSearchScrapeResult,
} from '../types'
import { tavilyOptionsSchema } from '../types'

type TavilyOptions = z.infer<typeof tavilyOptionsSchema>

type TavilySearchResponse = {
  answer?: string | null
  results?: Array<{ title?: string; url?: string; content?: string }>
}

type TavilyExtractResponse = {
  results?: Array<{
    url?: string
    raw_content?: string
    title?: string | null
  }>
}

export const tavilyProvider: WebSearchProvider<TavilyOptions> = {
  type: 'tavily',
  displayName: 'Tavily',
  supportsScrape: true,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    if (!options.apiKey) {
      throw new Error('Tavily API key is required')
    }
    // Tavily hard-caps max_results at 20. Our global resultSize allows up to
    // 50, so clamp here instead of failing the request.
    const body: Record<string, unknown> = {
      query: input.query,
      max_results: Math.min(common.resultSize, 20),
      search_depth: options.depth ?? 'advanced',
      include_answer: 'advanced',
    }
    if (input.topic && input.topic !== 'general') {
      body.topic = input.topic
    }

    const response = await webSearchRequest({
      url: 'https://api.tavily.com/search',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Tavily')

    const data = JSON.parse(response.text) as TavilySearchResponse
    const items = (data.results ?? []).map((it) => ({
      title: it.title ?? it.url ?? '',
      url: it.url ?? '',
      text: it.content ?? '',
    }))
    return {
      answer: data.answer ?? undefined,
      items,
    }
  },

  async scrape(input, options, common, signal): Promise<WebSearchScrapeResult> {
    if (!options.apiKey) {
      throw new Error('Tavily API key is required')
    }
    const response = await webSearchRequest({
      url: 'https://api.tavily.com/extract',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ urls: [input.url] }),
      timeoutMs: common.scrapeTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Tavily')

    const data = JSON.parse(response.text) as TavilyExtractResponse
    const first = data.results?.[0]
    if (!first?.raw_content) {
      throw new Error('Tavily extract returned no content')
    }
    return {
      url: first.url ?? input.url,
      content: first.raw_content,
      title: first.title ?? undefined,
    }
  },
}
