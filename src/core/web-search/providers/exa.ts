import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type { WebSearchProvider, WebSearchResult } from '../types'
import { exaOptionsSchema } from '../types'

type ExaOptions = z.infer<typeof exaOptionsSchema>

type ExaSearchResponse = {
  results?: Array<{
    title?: string | null
    url?: string
    text?: string
  }>
}

export const exaProvider: WebSearchProvider<ExaOptions> = {
  type: 'exa',
  displayName: 'Exa',
  supportsScrape: false,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    if (!options.apiKey) {
      throw new Error('Exa API key is required')
    }
    // Exa only returns page contents when explicitly requested; cap the
    // per-result text so large resultSize values stay within model context.
    const body: Record<string, unknown> = {
      query: input.query,
      type: 'auto',
      numResults: common.resultSize,
      contents: {
        text: { maxCharacters: 2000 },
      },
    }
    // Exa has no general "topic" concept; only news maps cleanly to a category.
    if (input.topic === 'news') {
      body.category = 'news'
    }

    const response = await webSearchRequest({
      url: 'https://api.exa.ai/search',
      method: 'POST',
      headers: {
        'x-api-key': options.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Exa')

    const data = JSON.parse(response.text) as ExaSearchResponse
    const items = (data.results ?? []).map((it) => ({
      title: it.title ?? it.url ?? '',
      url: it.url ?? '',
      text: it.text ?? '',
    }))
    return { items }
  },
}
