import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type { WebSearchProvider, WebSearchResult } from '../types'
import { anysearchOptionsSchema } from '../types'

type AnySearchOptions = z.infer<typeof anysearchOptionsSchema>

type AnySearchResponse = {
  code?: number
  message?: string
  data?: {
    results?: Array<{
      title?: string
      url?: string
      snippet?: string
      content?: string
    }>
  }
}

export const anysearchProvider: WebSearchProvider<AnySearchOptions> = {
  type: 'anysearch',
  displayName: 'AnySearch',
  supportsScrape: false,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    // AnySearch allows anonymous access (rate-limited per IP), so the API key
    // is optional; when present it unlocks the paid quota.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (options.apiKey) {
      headers.Authorization = `Bearer ${options.apiKey}`
    }

    // AnySearch hard-caps max_results at 20; clamp instead of failing.
    const response = await webSearchRequest({
      url: 'https://api.anysearch.com/v1/search',
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: input.query,
        max_results: Math.min(common.resultSize, 20),
      }),
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'AnySearch')

    const data = JSON.parse(response.text) as AnySearchResponse
    if (data.code !== 0) {
      throw new Error(
        `AnySearch request failed: ${data.message ?? `code ${String(data.code)}`}`,
      )
    }
    // `content` is the full cleaned page body; cap it so large resultSize
    // values stay within model context, falling back to the short snippet.
    const items = (data.data?.results ?? []).map((it) => ({
      title: it.title ?? it.url ?? '',
      url: it.url ?? '',
      text: (it.content ?? it.snippet ?? '').slice(0, 2000),
    }))
    return { items }
  },
}
