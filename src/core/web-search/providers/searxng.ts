import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type { WebSearchProvider, WebSearchResult } from '../types'
import { searxngOptionsSchema } from '../types'

type SearxngOptions = z.infer<typeof searxngOptionsSchema>

type SearxngResponse = {
  results?: Array<{
    title?: string
    url?: string
    content?: string
  }>
}

export const searxngProvider: WebSearchProvider<SearxngOptions> = {
  type: 'searxng',
  displayName: 'SearXNG',
  supportsScrape: false,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    const baseUrl = (options.baseUrl || '').trim()
    if (!baseUrl) {
      throw new Error('SearXNG base URL is required')
    }
    const params = new URLSearchParams()
    params.set('q', input.query)
    params.set('format', 'json')
    if (options.language && options.language !== 'auto') {
      params.set('language', options.language)
    }
    if (options.engines && options.engines.length > 0) {
      params.set('engines', options.engines.join(','))
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (options.username) {
      const token = btoa(`${options.username}:${options.password ?? ''}`)
      headers.Authorization = `Basic ${token}`
    }

    const response = await webSearchRequest({
      url,
      method: 'GET',
      headers,
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'SearXNG')
    const data = JSON.parse(response.text) as SearxngResponse
    const items = (data.results ?? [])
      .slice(0, common.resultSize)
      .map((it) => ({
        title: it.title ?? it.url ?? '',
        url: it.url ?? '',
        text: it.content ?? '',
      }))
    return { items }
  },
}
