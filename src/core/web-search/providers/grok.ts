import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type { WebSearchProvider, WebSearchResult } from '../types'
import { grokSearchOptionsSchema } from '../types'

type GrokOptions = z.infer<typeof grokSearchOptionsSchema>

type GrokResponse = {
  output?: Array<{
    type?: string
    role?: string
    content?: Array<{
      type?: string
      text?: string
      annotations?: Array<{
        type?: string
        url?: string
        title?: string
      }>
    }>
  }>
}

export const grokSearchProvider: WebSearchProvider<GrokOptions> = {
  type: 'grok',
  displayName: 'Grok',
  supportsScrape: false,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    if (!options.apiKey) {
      throw new Error('Grok API key is required')
    }

    const tools: Array<Record<string, unknown>> = [{ type: 'web_search' }]
    // x_search is an xAI-native built-in tool; aggregators such as OpenRouter
    // reject it with `invalid_union` on tools[].type. Only inject when the
    // request actually targets xAI's own Responses endpoint.
    const baseUrl = options.baseUrl || 'https://api.x.ai/v1/responses'
    const isNativeXai = /(^|\.)x\.ai(\/|:|$)/i.test(new URL(baseUrl).host)
    if (options.enableX && isNativeXai) {
      tools.push({ type: 'x_search' })
    }

    const body = {
      model: options.model || 'grok-4-latest',
      input: [
        { role: 'system', content: options.systemPrompt ?? '' },
        { role: 'user', content: input.query },
      ],
      tools,
      store: false,
    }

    const response = await webSearchRequest({
      url: baseUrl,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Grok')

    const data = JSON.parse(response.text) as GrokResponse
    const message = data.output?.find(
      (o) => o.type === 'message' && o.role === 'assistant',
    )
    const textContent = message?.content?.find((c) => c.type === 'output_text')

    const answer = textContent?.text?.trim() || undefined
    const seen = new Set<string>()
    const items = (textContent?.annotations ?? [])
      .filter(
        (a): a is { type: string; url: string; title?: string } =>
          a.type === 'url_citation' &&
          typeof a.url === 'string' &&
          a.url.length > 0,
      )
      .filter((a) => {
        if (seen.has(a.url)) return false
        seen.add(a.url)
        return true
      })
      .slice(0, common.resultSize)
      .map((a) => ({
        title: a.title || a.url,
        url: a.url,
        text: '',
      }))

    return { answer, items }
  },
}
