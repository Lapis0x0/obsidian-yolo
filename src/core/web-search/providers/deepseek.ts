import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type {
  WebSearchProvider,
  WebSearchResult,
  WebSearchScrapeResult,
} from '../types'
import { deepseekSearchOptionsSchema } from '../types'

type DeepSeekSearchOptions = z.infer<typeof deepseekSearchOptionsSchema>

type DeepSeekSearchResponse = {
  results?: Array<{
    title?: string
    url?: string
    snippet?: string
    summary?: string
  }>
}

type DeepSeekFetchResponse = {
  title?: string
  content?: string
}

// See https://api-docs.deepseek.com/zh-cn/guides/search
export const deepseekSearchProvider: WebSearchProvider<DeepSeekSearchOptions> =
  {
    type: 'deepseek',
    displayName: 'DeepSeek',
    supportsScrape: true,

    async search(input, options, common, signal): Promise<WebSearchResult> {
      if (!options.apiKey) {
        throw new Error('DeepSeek API key is required')
      }
      const response = await webSearchRequest({
        url: 'https://api.deepseek.com/v1/tools/search',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: input.query, count: common.resultSize }),
        timeoutMs: common.searchTimeoutMs,
        signal,
      })
      ensureSuccess(response, 'DeepSeek')

      const data = JSON.parse(response.text) as DeepSeekSearchResponse
      // `summary` is the model-facing long abstract; `snippet` is the short
      // UI-facing one, kept only as a fallback.
      const items = (data.results ?? []).map((it) => ({
        title: it.title ?? it.url ?? '',
        url: it.url ?? '',
        text: it.summary || it.snippet || '',
      }))
      return { items }
    },

    async scrape(
      input,
      options,
      common,
      signal,
    ): Promise<WebSearchScrapeResult> {
      if (!options.apiKey) {
        throw new Error('DeepSeek API key is required')
      }
      const response = await webSearchRequest({
        url: 'https://api.deepseek.com/v1/tools/fetch',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: input.url }),
        timeoutMs: common.scrapeTimeoutMs,
        signal,
      })
      ensureSuccess(response, 'DeepSeek')

      const data = JSON.parse(response.text) as DeepSeekFetchResponse
      if (!data.content) {
        throw new Error('DeepSeek fetch returned no content')
      }
      return {
        url: input.url,
        content: data.content,
        title: data.title || undefined,
      }
    },
  }
