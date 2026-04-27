import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type { WebSearchProvider, WebSearchResult } from '../types'
import { geminiGroundingOptionsSchema } from '../types'

type GeminiOptions = z.infer<typeof geminiGroundingOptionsSchema>

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string }
      }>
    }
  }>
}

export const geminiGroundingProvider: WebSearchProvider<GeminiOptions> = {
  type: 'gemini-grounding',
  displayName: 'Gemini (Grounding)',
  supportsScrape: false,

  async search(input, options, common, signal): Promise<WebSearchResult> {
    if (!options.apiKey) {
      throw new Error('Gemini API key is required')
    }
    const base = (
      options.baseUrl || 'https://generativelanguage.googleapis.com'
    ).replace(/\/+$/, '')
    const model = options.model || 'gemini-2.5-flash'
    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`

    const body: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [{ text: input.query }],
        },
      ],
      tools: [{ google_search: {} }],
    }
    const systemPrompt = options.systemPrompt?.trim()
    if (systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt }],
      }
    }

    const response = await webSearchRequest({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Gemini Grounding')
    const data = JSON.parse(response.text) as GeminiResponse
    const candidate = data.candidates?.[0]
    const answer = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim()

    const seen = new Set<string>()
    const items = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .map((chunk) => chunk.web)
      .filter((web): web is { uri: string; title?: string } =>
        Boolean(web?.uri),
      )
      .filter((web) => {
        if (seen.has(web.uri)) return false
        seen.add(web.uri)
        return true
      })
      .slice(0, common.resultSize)
      .map((web) => ({
        title: web.title || web.uri,
        url: web.uri,
        text: '',
      }))

    return {
      answer: answer || undefined,
      items,
    }
  },
}
