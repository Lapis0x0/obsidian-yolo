import OpenAI from 'openai'
import { FinalRequestOptions } from 'openai/core'

const stripStainlessHeaders = (
  headers: RequestInit['headers'],
): RequestInit['headers'] => {
  if (!headers) return headers
  const shouldKeep = (key: string) =>
    !key.toLowerCase().startsWith('x-stainless')

  if (headers instanceof Headers) {
    const next = new Headers()
    headers.forEach((value, key) => {
      if (shouldKeep(key)) {
        next.append(key, value)
      }
    })
    return next
  }

  if (Array.isArray(headers)) {
    return headers.filter(([key]) => shouldKeep(key))
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => shouldKeep(key)),
  )
}

export class NoStainlessOpenAI extends OpenAI {
  override buildRequest<Req>(
    options: FinalRequestOptions<Req>,
    { retryCount = 0 }: { retryCount?: number } = {},
  ): { req: RequestInit; url: string; timeout: number } {
    const req = super.buildRequest(options, { retryCount })
    req.req.headers = stripStainlessHeaders(req.req.headers)

    // Handle Gemini native tools by bypassing OpenAI SDK validation
    if (req.req.body && typeof req.req.body === 'string') {
      try {
        const parsed = JSON.parse(req.req.body)
        // If tools contain Gemini native format (e.g., {googleSearch: {}}),
        // the OpenAI SDK validation will fail. We need to bypass this.
        if (
          parsed &&
          typeof parsed === 'object' &&
          'tools' in parsed &&
          Array.isArray((parsed as { tools?: unknown[] }).tools)
        ) {
          const body = parsed as { tools?: unknown[] }
          const hasGeminiTools = (body.tools ?? []).some(
            (tool): boolean =>
              typeof tool === 'object' &&
              tool !== null &&
              ('googleSearch' in tool || 'urlContext' in tool),
          )
          if (hasGeminiTools) {
            // For Gemini tools, we bypass SDK validation by reconstructing the request
            req.req.body = JSON.stringify(body)
          }
        }
      } catch (parseError) {
        console.debug(
          '[YOLO] Failed to inspect request body while stripping Stainless headers.',
          parseError,
        )
        // If JSON parsing fails, continue with original body unchanged
      }
    }

    return req
  }
}
