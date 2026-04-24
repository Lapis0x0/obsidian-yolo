import { requestUrl, type RequestUrlParam } from 'obsidian'

export type WebSearchHttpResponse = {
  status: number
  text: string
  headers: Record<string, string>
}

export class WebSearchHttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'WebSearchHttpError'
    this.status = status
    this.body = body
  }
}

// Lightweight wrapper over Obsidian's requestUrl with timeout via AbortSignal.
// requestUrl itself does not honour AbortSignal, so we race against a timer to
// surface cancellation/timeout to the caller. The underlying request may still
// finish in the background; we simply ignore its result.
export async function webSearchRequest(
  params: RequestUrlParam & { timeoutMs?: number; signal?: AbortSignal },
): Promise<WebSearchHttpResponse> {
  const { timeoutMs, signal, ...rest } = params

  const requestPromise = requestUrl({
    ...rest,
    // Avoid throwing on non-2xx so providers can decide based on status.
    throw: false,
  }).then((response) => ({
    status: response.status,
    text: response.text,
    headers: response.headers ?? {},
  }))

  if (!timeoutMs && !signal) {
    return requestPromise
  }

  return new Promise<WebSearchHttpResponse>((resolve, reject) => {
    let settled = false
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(`Web search request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      : null

    const onAbort = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(new Error('Web search request aborted'))
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    requestPromise.then(
      (response) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(response)
      },
      (error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export function ensureSuccess(
  response: WebSearchHttpResponse,
  providerName: string,
): WebSearchHttpResponse {
  if (response.status < 200 || response.status >= 300) {
    throw new WebSearchHttpError(
      `${providerName} request failed (HTTP ${response.status}): ${truncate(response.text, 500)}`,
      response.status,
      response.text,
    )
  }
  return response
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}
