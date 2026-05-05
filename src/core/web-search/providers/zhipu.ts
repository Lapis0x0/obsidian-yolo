import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type { WebSearchProvider, WebSearchResult } from '../types'
import { zhipuOptionsSchema } from '../types'

type ZhipuOptions = z.infer<typeof zhipuOptionsSchema>

type ZhipuSearchResultItem = {
  title?: string
  content?: string
  link?: string
  media?: string
  icon?: string
  refer?: string
  publish_date?: string
}

type ZhipuSearchResponse = {
  id?: string
  created?: number
  request_id?: string
  search_result?: ZhipuSearchResultItem[]
  search_intent?: Array<{ intent?: string; query?: string; keywords?: string }>
  // Error envelope shape returned by some failure modes
  error?: { message?: string; code?: string }
}

export const zhipuProvider: WebSearchProvider<ZhipuOptions> = {
  type: 'zhipu',
  displayName: 'Zhipu Web Search',
  supportsScrape: false,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    if (!options.apiKey) {
      throw new Error('Zhipu API key is required')
    }

    const query = input.query.trim()
    if (!query) {
      throw new Error('Zhipu search query is required')
    }
    // Zhipu enforces a 70-character limit on search_query. Surface the limit
    // as a clear error so the agent can rewrite a shorter query rather than
    // getting an opaque 400.
    if ([...query].length > 70) {
      throw new Error('Zhipu search query must be 70 characters or fewer')
    }

    // search_pro_sogou only accepts count in {10,20,30,40,50}; round up to the
    // nearest valid bucket. The runner slices results down to resultSize, so
    // over-fetching is fine.
    const count =
      options.searchEngine === 'search_pro_sogou'
        ? Math.min(50, Math.max(10, Math.ceil(common.resultSize / 10) * 10))
        : Math.min(common.resultSize, 50)

    const body: Record<string, unknown> = {
      search_query: query,
      search_engine: options.searchEngine,
      search_intent: false,
      count,
      content_size: options.contentSize,
    }
    if (
      options.searchRecencyFilter &&
      options.searchRecencyFilter !== 'noLimit'
    ) {
      body.search_recency_filter = options.searchRecencyFilter
    }
    // search_domain_filter is not supported by search_pro_quark; skip it
    // there to avoid an API error rather than silently corrupting the call.
    const domainFilter = options.searchDomainFilter.trim()
    if (domainFilter && options.searchEngine !== 'search_pro_quark') {
      body.search_domain_filter = domainFilter
    }

    const response = await webSearchRequest({
      url: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Zhipu')

    const data = JSON.parse(response.text) as ZhipuSearchResponse
    if (data.error) {
      throw new Error(
        `Zhipu request failed${data.error.code ? ` (${data.error.code})` : ''}: ${
          data.error.message ?? 'Unknown error'
        }`,
      )
    }
    const items = (data.search_result ?? []).map((it) => ({
      title: it.title ?? it.link ?? '',
      url: it.link ?? '',
      text: it.content ?? '',
    }))
    return { items }
  },
}
