import type { ChatModel } from '../../types/chat-model.types'
import type {
  LLMProvider,
  RequestTransportMode,
} from '../../types/provider.types'

import type { BaseLLMProvider } from './base'

const MAX_ERROR_RESPONSE_BYTES = 64 * 1024
const MAX_USER_ERROR_MESSAGE_CHARS = 2_000
// The response body is persisted with the conversation, so it is bounded well
// below the 64KB we are willing to read for the console log.
const MAX_PERSISTED_ERROR_BODY_CHARS = 4_000
const ERROR_REPORTED_HEADER = 'x-yolo-error-reported'
const reportedErrors = new WeakSet<object>()

export type ProviderErrorProtocol = 'openai' | 'passthrough'

type ProviderErrorFetchContext = {
  providerId: string
  protocol: ProviderErrorProtocol
  transportMode: RequestTransportMode
}

type LimitedBody = {
  text: string
  truncated: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// The OpenAI and Anthropic SDKs compose their thrown message as
// `${status} ${JSON.stringify(body.error)}` whenever the body carries no
// `message` of its own. That is a serialized object, not something to show a
// user as an explanation.
const isUsableProviderMessage = (value: string): boolean => {
  const message = value.trim().replace(/^\d{3}\s+/, '')
  if (!message) return false
  return message !== '[object Object]' && !/^[[{]/.test(message)
}

export const extractProviderErrorMessage = (
  value: unknown,
  depth = 0,
): string | null => {
  if (depth > 5 || value == null) return null
  if (typeof value === 'string') {
    const message = value.trim()
    if (!isUsableProviderMessage(message)) {
      return null
    }
    return message
  }
  if (!isRecord(value)) return null

  const directKeys = ['message', 'msg', 'detail', 'error_description'] as const
  for (const key of directKeys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && isUsableProviderMessage(candidate)) {
      return candidate.trim()
    }
  }

  const nestedError = value.error
  if (typeof nestedError === 'string' && isUsableProviderMessage(nestedError)) {
    return nestedError.trim()
  }
  const nestedMessage = extractProviderErrorMessage(nestedError, depth + 1)
  if (nestedMessage) return nestedMessage

  if (Array.isArray(value.errors)) {
    for (const item of value.errors) {
      const itemMessage = extractProviderErrorMessage(item, depth + 1)
      if (itemMessage) return itemMessage
    }
  }

  // Providers do not agree on one error envelope. After checking the known
  // fields above, descend into nested containers so a response such as
  // `{ detail: { reason: { message: '...' } } }` still reaches the user. Only
  // containers — accepting a bare string here would return whichever unrelated
  // field (`request_id`, `type`, …) happens to come first in key order.
  for (const [key, nested] of Object.entries(value)) {
    if (
      key === 'message' ||
      key === 'msg' ||
      key === 'error_description' ||
      key === 'error' ||
      key === 'errors'
    ) {
      continue
    }
    if (typeof nested !== 'object' || nested === null) continue
    const nestedMessage = extractProviderErrorMessage(nested, depth + 1)
    if (nestedMessage) return nestedMessage
  }

  return null
}

const readResponseBodyLimited = async (
  response: Response,
): Promise<LimitedBody> => {
  if (!response.body) return { text: '', truncated: false }

  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  let truncated = false

  const append = (chunk: Uint8Array): boolean => {
    const remaining = MAX_ERROR_RESPONSE_BYTES - bytesRead
    if (remaining <= 0) {
      truncated = true
      return false
    }

    const accepted =
      chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk
    text += decoder.decode(accepted, { stream: true })
    bytesRead += accepted.byteLength
    if (accepted.byteLength < chunk.byteLength) {
      truncated = true
      return false
    }
    return true
  }

  const body = response.body as unknown
  if (body instanceof Uint8Array) {
    append(body)
    text += decoder.decode()
    return { text, truncated }
  }

  const streamBody = body as {
    getReader?: () => ReadableStreamDefaultReader<Uint8Array>
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
  }
  if (typeof streamBody.getReader === 'function') {
    const reader = streamBody.getReader()

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        if (!append(value)) break
      }
      text += decoder.decode()
    } finally {
      if (truncated) {
        void reader.cancel().catch(() => undefined)
      } else {
        reader.releaseLock()
      }
    }

    return { text, truncated }
  }

  const createAsyncIterator = streamBody[Symbol.asyncIterator]
  if (createAsyncIterator) {
    const iterable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => createAsyncIterator.call(streamBody),
    }
    for await (const chunk of iterable) {
      const bytes =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : new Uint8Array(chunk as ArrayBuffer)
      if (!append(bytes)) break
    }
    text += decoder.decode()
    return { text, truncated }
  }

  const fallback = await response.text()
  append(new TextEncoder().encode(fallback))
  text += decoder.decode()
  return { text, truncated }
}

const getRequestUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url

const getRequestMethod = (
  input: RequestInfo | URL,
  init?: RequestInit,
): string => init?.method ?? (input instanceof Request ? input.method : 'GET')

const getRequestModel = (init?: RequestInit): string | undefined => {
  if (typeof init?.body !== 'string') return undefined
  const body = parseJson(init.body)
  if (!isRecord(body)) return undefined
  return typeof body.model === 'string' ? body.model : undefined
}

const getRequestId = (headers: Headers): string | undefined => {
  for (const name of [
    'x-request-id',
    'request-id',
    'cf-ray',
    'x-amzn-requestid',
  ]) {
    const value = headers.get(name)
    if (value) return value
  }
  return undefined
}

const withReportedHeader = (headers: Headers): Headers => {
  const next = new Headers(headers)
  next.set(ERROR_REPORTED_HEADER, '1')
  return next
}

const normalizeOpenAIErrorBody = (
  parsedBody: unknown,
  message: string,
): string | null => {
  if (!isRecord(parsedBody)) return null

  const existingError = parsedBody.error
  if (
    typeof existingError === 'string' ||
    (isRecord(existingError) &&
      typeof existingError.message === 'string' &&
      existingError.message.trim())
  ) {
    return null
  }

  // The SDKs carry only `body.error` onto the error they throw, so fold the
  // rest of the body into it. Replacing `error` outright would strip exactly
  // the fields the detail view exists to show — a `{ code, msg, data }`
  // envelope would survive as nothing but the message we just extracted.
  const bodyWithoutError: Record<string, unknown> = { ...parsedBody }
  delete bodyWithoutError.error

  return JSON.stringify({
    ...parsedBody,
    error: {
      ...bodyWithoutError,
      ...(isRecord(existingError) ? existingError : {}),
      message,
    },
  })
}

export const createProviderErrorFetch =
  (baseFetch: typeof fetch, context: ProviderErrorFetchContext): typeof fetch =>
  async (input, init) => {
    const response = await baseFetch(input, init)
    if (response.ok) return response

    let body: LimitedBody = { text: '', truncated: false }
    let bodyReadError: unknown
    try {
      body = await readResponseBodyLimited(response.clone())
    } catch (error) {
      bodyReadError = error
    }

    const parsedBody = body.text ? parseJson(body.text) : undefined
    const message = extractProviderErrorMessage(parsedBody)
    console.error('[YOLO][LLM] Provider request failed', {
      providerId: context.providerId,
      transportMode: context.transportMode,
      method: getRequestMethod(input, init),
      url: getRequestUrl(input),
      model: getRequestModel(init),
      status: response.status,
      statusText: response.statusText,
      requestId: getRequestId(response.headers),
      contentType: response.headers.get('content-type') ?? undefined,
      responseBody: parsedBody ?? body.text,
      responseBodyTruncated: body.truncated,
      ...(bodyReadError ? { bodyReadError } : {}),
    })

    const headers = withReportedHeader(response.headers)
    if (
      context.protocol === 'openai' &&
      !body.truncated &&
      parsedBody !== undefined &&
      message
    ) {
      const normalizedBody = normalizeOpenAIErrorBody(parsedBody, message)
      if (normalizedBody) {
        headers.set('content-type', 'application/json')
        headers.delete('content-length')
        return new Response(normalizedBody, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

const readNumericStatus = (value: unknown, depth = 0): number | undefined => {
  if (depth > 5 || !isRecord(value)) return undefined
  if (typeof value.status === 'number') return value.status
  for (const nested of [value.rawError, value.cause, value.error]) {
    const status = readNumericStatus(nested, depth + 1)
    if (status !== undefined) return status
  }
  return undefined
}

const truncateErrorBody = (text: string): string =>
  text.length <= MAX_PERSISTED_ERROR_BODY_CHARS
    ? text
    : `${text.slice(0, MAX_PERSISTED_ERROR_BODY_CHARS)}…`

const stringifyErrorBody = (value: unknown): string | undefined => {
  try {
    const text = JSON.stringify(value, null, 2)
    return text ? truncateErrorBody(text) : undefined
  } catch {
    // Circular or otherwise unserializable; keep looking at nested SDK fields.
    return undefined
  }
}

const readErrorResponseBody = (
  value: unknown,
  depth = 0,
): string | undefined => {
  if (depth > 5 || !isRecord(value)) return undefined
  if (typeof value.responseBody === 'string' && value.responseBody.trim()) {
    return truncateErrorBody(value.responseBody)
  }
  if (isRecord(value.error)) {
    const body = stringifyErrorBody(value.error)
    if (body) return body
  }
  for (const nested of [value.rawError, value.cause]) {
    const body = readErrorResponseBody(nested, depth + 1)
    if (body) return body
  }
  return undefined
}

const wasReported = (value: unknown, depth = 0): boolean => {
  if (depth > 5 || !isRecord(value)) return false
  if (reportedErrors.has(value)) return true

  const headers = value.headers
  if (isRecord(headers) && headers[ERROR_REPORTED_HEADER] === '1') return true
  if (
    headers instanceof Headers &&
    headers.get(ERROR_REPORTED_HEADER) === '1'
  ) {
    return true
  }

  return [value.rawError, value.cause, value.error].some((nested) =>
    wasReported(nested, depth + 1),
  )
}

export const isProviderAbortError = (error: unknown): boolean => {
  if (!isRecord(error)) return false
  const name = typeof error.name === 'string' ? error.name : ''
  if (name === 'AbortError' || name === 'APIUserAbortError') return true
  return (
    isProviderAbortError(error.cause) || isProviderAbortError(error.rawError)
  )
}

const extractThrownErrorDetail = (error: unknown): string | null => {
  if (!isRecord(error)) return extractProviderErrorMessage(error)

  for (const nested of [error.error, error.rawError, error.cause]) {
    const nestedMessage = extractProviderErrorMessage(nested)
    if (nestedMessage && !/status code \(no body\)/i.test(nestedMessage)) {
      return nestedMessage
    }
  }

  const ownMessage = extractProviderErrorMessage(error)
  if (!ownMessage || /status code \(no body\)/i.test(ownMessage)) return null
  return ownMessage
}

export class ProviderRequestError extends Error {
  readonly suppressCauseInUserMessage = true

  constructor(
    readonly providerId: string,
    readonly status: number,
    readonly providerMessage: string | null,
    readonly rawError: unknown,
    readonly responseBody?: string,
  ) {
    const visibleMessage =
      providerMessage && providerMessage.length <= MAX_USER_ERROR_MESSAGE_CHARS
        ? `: ${providerMessage}`
        : ''
    super(`${providerId} request failed (${status})${visibleMessage}`)
    this.name = 'ProviderRequestError'
  }
}

const normalizeThrownProviderError = (
  providerId: string,
  error: unknown,
): unknown => {
  if (error instanceof ProviderRequestError) return error
  const status = readNumericStatus(error)
  if (status === undefined) return error
  return new ProviderRequestError(
    providerId,
    status,
    extractThrownErrorDetail(error),
    error,
    readErrorResponseBody(error),
  )
}

const reportUnreportedError = ({
  providerId,
  operation,
  model,
  error,
}: {
  providerId: string
  operation: string
  model?: string
  error: unknown
}) => {
  if (wasReported(error)) return
  if (isRecord(error)) {
    reportedErrors.add(error)
  }
  console.error('[YOLO][LLM] Provider request failed', {
    providerId,
    operation,
    model,
    error,
  })
}

const wrapStreamErrors = <T>({
  stream,
  providerId,
  model,
}: {
  stream: AsyncIterable<T>
  providerId: string
  model?: string
}): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    try {
      for await (const chunk of stream) yield chunk
    } catch (error) {
      if (isProviderAbortError(error)) throw error
      reportUnreportedError({
        providerId,
        operation: 'streamResponse',
        model,
        error,
      })
      throw normalizeThrownProviderError(providerId, error)
    }
  },
})

export const withProviderErrorReporting = <
  T extends BaseLLMProvider<LLMProvider>,
>(
  client: T,
  providerId: string,
): T => {
  const wrappedMethods = new Map<PropertyKey, unknown>()

  return new Proxy(client, {
    get(target, property, receiver) {
      if (
        property !== 'generateResponse' &&
        property !== 'streamResponse' &&
        property !== 'getEmbedding'
      ) {
        return Reflect.get(target, property, receiver)
      }

      const cached = wrappedMethods.get(property)
      if (cached) return cached

      const original = Reflect.get(target, property, target) as (
        ...args: unknown[]
      ) => unknown
      const wrapped = async (...args: unknown[]) => {
        const modelArg = args[0]
        const model =
          typeof modelArg === 'string'
            ? modelArg
            : (modelArg as ChatModel | undefined)?.model
        try {
          const result = await original.apply(target, args)
          return property === 'streamResponse'
            ? wrapStreamErrors({
                stream: result as AsyncIterable<unknown>,
                providerId,
                model,
              })
            : result
        } catch (error) {
          if (isProviderAbortError(error)) throw error
          reportUnreportedError({
            providerId,
            operation: String(property),
            model,
            error,
          })
          throw normalizeThrownProviderError(providerId, error)
        }
      }
      wrappedMethods.set(property, wrapped)
      return wrapped
    },
  })
}
