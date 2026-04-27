import type { z } from 'zod'

import { ensureSuccess, webSearchRequest } from '../http'
import type { WebSearchProvider, WebSearchResult } from '../types'
import { bingOptionsSchema } from '../types'

type BingOptions = z.infer<typeof bingOptionsSchema>

const BING_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export const bingProvider: WebSearchProvider<BingOptions> = {
  type: 'bing',
  displayName: 'Bing (no key)',
  supportsScrape: false,

  async search(input, _options, common, signal): Promise<WebSearchResult> {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(input.query)}&setlang=en-US`
    const response = await webSearchRequest({
      url,
      method: 'GET',
      headers: {
        'User-Agent': BING_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeoutMs: common.searchTimeoutMs,
      signal,
    })
    ensureSuccess(response, 'Bing')

    const items = parseBingHtml(response.text).slice(0, common.resultSize)
    if (items.length === 0) {
      throw new Error(
        'Bing returned no parseable results. The page layout may have changed or the request was rate-limited.',
      )
    }
    return { items }
  },
}

function parseBingHtml(html: string) {
  const items: { title: string; url: string; text: string }[] = []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const nodes = doc.querySelectorAll('li.b_algo')
  nodes.forEach((node) => {
    const titleEl = node.querySelector('h2')
    const linkEl = node.querySelector('h2 a')
    const captionEl = node.querySelector('.b_caption p')
    const url = linkEl?.getAttribute('href') ?? ''
    const title = titleEl?.textContent?.trim() ?? ''
    const text = captionEl?.textContent?.trim() ?? ''
    if (url && title) {
      items.push({ title, url, text })
    }
  })
  return items
}
