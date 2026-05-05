import { htmlToMarkdown } from 'obsidian'

import {
  YoutubeTranscript,
  isYoutubeUrl,
} from '../../utils/chat/youtube-transcript'

import { ensureSuccess, webSearchRequest } from './http'
import type { WebSearchScrapeResult } from './types'

/**
 * Generic URL → markdown scraper used when the active provider does not
 * expose a specialized extract API. Static-HTML only (no JS rendering),
 * so quality on SPA / heavily JS-rendered pages is limited compared to
 * Tavily/Jina, but it gives every provider (Bing, Zhipu, ...) and the
 * mentionable URL-fetch path a single shared implementation.
 */
export async function scrapeUrlGeneric(
  url: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<WebSearchScrapeResult> {
  if (isYoutubeUrl(url)) {
    try {
      const { title, transcript } = await raceWithTimeoutAndSignal(
        YoutubeTranscript.fetchTranscriptAndMetadata(url),
        options,
      )
      const content = `Title: ${title}\nVideo Transcript:\n${transcript
        .map((t) => `${t.offset}: ${t.text}`)
        .join('\n')}`
      return { url, content, title }
    } catch (error) {
      // Captions disabled / unavailable / timeout / aborted: fall through to
      // the generic HTTP scrape so the caller still gets the page content.
      console.warn(
        `YouTube transcript unavailable for ${url}, falling back to HTML scrape`,
        error,
      )
    }
  }

  const response = await webSearchRequest({
    url,
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  ensureSuccess(response, 'Generic scrape')

  const markdown = htmlToMarkdown(response.text)
  const titleMatch = response.text.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = titleMatch?.[1]?.trim() || undefined
  return { url, content: markdown, title }
}

async function raceWithTimeoutAndSignal<T>(
  promise: Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const { timeoutMs, signal } = options
  if (!timeoutMs && !signal) return promise

  if (signal?.aborted) {
    throw new Error('Aborted')
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const onAbort = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(new Error('Aborted'))
    }

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`Timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
