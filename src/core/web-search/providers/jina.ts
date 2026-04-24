import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type {
  WebSearchProvider,
  WebSearchResult,
  WebSearchScrapeResult,
} from '../types'
import { jinaOptionsSchema } from '../types'

type JinaOptions = z.infer<typeof jinaOptionsSchema>

type JinaSearchResponse = {
  data?: Array<{ title?: string; url?: string; content?: string }>
}

export const jinaProvider: WebSearchProvider<JinaOptions> = {
  type: 'jina',
  displayName: 'Jina',
  supportsScrape: true,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    if (!options.apiKey) {
      throw new Error('Jina API key is required')
    }
    const url = (options.searchUrl || 'https://s.jina.ai/').trim()
    const response = await webSearchRequest({
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ q: input.query }),
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Jina')
    const data = JSON.parse(response.text) as JinaSearchResponse
    const items = (data.data ?? []).slice(0, common.resultSize).map((it) => ({
      title: it.title ?? it.url ?? '',
      url: it.url ?? '',
      text: it.content ?? '',
    }))
    return { items }
  },

  async scrape(input, options, common, signal): Promise<WebSearchScrapeResult> {
    if (!options.apiKey) {
      throw new Error('Jina API key is required')
    }
    const base = (options.scrapeUrl || 'https://r.jina.ai/').trim()
    const url = base.endsWith('/')
      ? `${base}${input.url}`
      : `${base}/${input.url}`
    const response = await webSearchRequest({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'X-Return-Format': 'markdown',
      },
      timeoutMs: common.scrapeTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Jina')
    return {
      url: input.url,
      content: response.text,
    }
  },
}
