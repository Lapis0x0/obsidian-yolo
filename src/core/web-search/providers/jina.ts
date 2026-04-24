import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type {
  WebSearchProvider,
  WebSearchResult,
  WebSearchScrapeResult,
} from '../types'
import { jinaOptionsSchema } from '../types'

type JinaOptions = z.infer<typeof jinaOptionsSchema>

type JinaSearchResultItem = {
  title?: string
  url?: string
  content?: string
  description?: string
}

type JinaSearchResponse =
  | JinaSearchResultItem[]
  | { data?: JinaSearchResultItem[] }

export const jinaProvider: WebSearchProvider<JinaOptions> = {
  type: 'jina',
  displayName: 'Jina',
  supportsScrape: true,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    if (!options.apiKey) {
      throw new Error('Jina API key is required')
    }
    // Jina Reader search: GET https://s.jina.ai/<encoded query>
    // See https://github.com/jina-ai/reader#using-sjinaai-for-web-search
    const base = (options.searchUrl || 'https://s.jina.ai/')
      .trim()
      .replace(/\/+$/, '')
    const url = `${base}/${encodeURIComponent(input.query)}`
    const response = await webSearchRequest({
      url,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
        'X-Retain-Images': 'none',
      },
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Jina')
    const parsed = JSON.parse(response.text) as JinaSearchResponse
    const rawItems = Array.isArray(parsed) ? parsed : (parsed.data ?? [])
    const items = rawItems.slice(0, common.resultSize).map((it) => ({
      title: it.title ?? it.url ?? '',
      url: it.url ?? '',
      text: it.content ?? it.description ?? '',
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
