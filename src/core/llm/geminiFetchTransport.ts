/* oxlint-disable no-restricted-globals — transport layer uses global fetch intentionally */
import type { GenerateContentResponse as GeminiGenerateContentResponse } from '@google/genai'

import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { loadDesktopNodeModule } from '../../utils/platform/desktopNodeModule'
import { LLMRateLimitExceededException } from './exception'
import { ModelRequestPolicy, runWithModelRequestPolicy } from './requestPolicy'

type NodeReadable = import('node:stream').Readable
type StreamSource = ReadableStream<Uint8Array> | NodeReadable

type ParseNonStreaming = (
  body: GeminiGenerateContentResponse,
  model: string,
  responseId: string,
) => LLMResponseNonStreaming

type ParseStreamingChunk = (
  body: GeminiGenerateContentResponse,
  model: string,
  responseId: string,
) => LLMResponseStreaming

export type GeminiFetchRequest = {
  url: string
  headers: Headers
  body: string
}

// Some Gemini-flavored endpoints wrap the actual response (e.g. Code Assist's
// `{ response, traceId }`). Providers supply an unwrap to surface the native
// `GeminiGenerateContentResponse` shape. Default is identity.
export type GeminiUnwrap = (raw: unknown) => GeminiGenerateContentResponse & {
  responseId?: string
}

export type GeminiTransportContext = {
  providerLabel: string
  requestPolicy?: ModelRequestPolicy
  unwrap?: GeminiUnwrap
}

const defaultUnwrap: GeminiUnwrap = (raw) =>
  raw as GeminiGenerateContentResponse & { responseId?: string }

const withAcceptSse = (headers: Headers): Headers => {
  const next = new Headers(headers)
  next.set('Accept', 'text/event-stream')
  return next
}

export async function geminiGenerateViaFetch({
  fetchImpl,
  request,
  model,
  signal,
  parse,
  context,
}: {
  fetchImpl: typeof fetch
  request: GeminiFetchRequest
  model: string
  signal?: AbortSignal
  parse: ParseNonStreaming
  context: GeminiTransportContext
}): Promise<LLMResponseNonStreaming> {
  const response = await runWithModelRequestPolicy({
    requestPolicy: context.requestPolicy,
    signal,
    run: (requestSignal) =>
      fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: requestSignal,
      }),
  })

  if (!response.ok) {
    await throwForBadResponse(response, context.providerLabel)
  }

  const raw = (await response.json()) as unknown
  const unwrapped = (context.unwrap ?? defaultUnwrap)(raw)
  return parse(unwrapped, model, unwrapped.responseId ?? crypto.randomUUID())
}

export async function geminiStreamViaFetch({
  fetchImpl,
  request,
  model,
  signal,
  parse,
  context,
}: {
  fetchImpl: typeof fetch
  request: GeminiFetchRequest
  model: string
  signal?: AbortSignal
  parse: ParseStreamingChunk
  context: GeminiTransportContext
}): Promise<AsyncIterable<LLMResponseStreaming>> {
  const headers = withAcceptSse(request.headers)
  const response = await runWithModelRequestPolicy({
    requestPolicy: context.requestPolicy,
    signal,
    run: (requestSignal) =>
      fetchImpl(request.url, {
        method: 'POST',
        headers,
        body: request.body,
        signal: requestSignal,
      }),
  })

  if (!response.ok) {
    await throwForBadResponse(response, context.providerLabel)
  }

  if (!response.body) {
    throw new Error(
      `${context.providerLabel} streaming response body is missing.`,
    )
  }

  return streamFromSse({
    stream: response.body,
    model,
    parse,
    unwrap: context.unwrap ?? defaultUnwrap,
    signal,
  })
}

// Buffered variant: obsidian's `requestUrl` cannot expose a streaming body, so
// the caller hands us the full SSE text and we replay it as an async iterable.
export async function geminiStreamViaBufferedFetch({
  fetchImpl,
  request,
  model,
  signal,
  parse,
  context,
}: {
  fetchImpl: typeof fetch
  request: GeminiFetchRequest
  model: string
  signal?: AbortSignal
  parse: ParseStreamingChunk
  context: GeminiTransportContext
}): Promise<AsyncIterable<LLMResponseStreaming>> {
  const headers = withAcceptSse(request.headers)
  const response = await runWithModelRequestPolicy({
    requestPolicy: context.requestPolicy,
    signal,
    run: (requestSignal) =>
      fetchImpl(request.url, {
        method: 'POST',
        headers,
        body: request.body,
        signal: requestSignal,
      }),
  })

  if (!response.ok) {
    await throwForBadResponse(response, context.providerLabel)
  }

  const text = await response.text()
  return streamFromSseText({
    text,
    model,
    parse,
    unwrap: context.unwrap ?? defaultUnwrap,
  })
}

// Generic JSON POST (used by Gemini embeddings — no SSE, custom response shape).
export async function geminiJsonFetch<T>({
  fetchImpl,
  request,
  signal,
  context,
}: {
  fetchImpl: typeof fetch
  request: GeminiFetchRequest
  signal?: AbortSignal
  context: Pick<GeminiTransportContext, 'providerLabel' | 'requestPolicy'>
}): Promise<T> {
  const response = await runWithModelRequestPolicy({
    requestPolicy: context.requestPolicy,
    signal,
    run: (requestSignal) =>
      fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: requestSignal,
      }),
  })

  if (!response.ok) {
    await throwForBadResponse(response, context.providerLabel)
  }

  return (await response.json()) as T
}

async function throwForBadResponse(
  response: Response,
  providerLabel: string,
): Promise<never> {
  const text = await response.text().catch(() => '')
  if (response.status === 429) {
    throw new LLMRateLimitExceededException(
      `${providerLabel} rate limit exceeded: ${text || response.statusText}`,
    )
  }
  throw new Error(
    `${providerLabel} request failed (${response.status} ${response.statusText})${
      text ? `: ${text}` : ''
    }`,
  )
}

async function* streamFromSse({
  stream,
  model,
  parse,
  unwrap,
  signal,
}: {
  stream: StreamSource
  model: string
  parse: ParseStreamingChunk
  unwrap: GeminiUnwrap
  signal?: AbortSignal
}): AsyncGenerator<LLMResponseStreaming> {
  const reader = (await toReadableStream(stream)).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const chunk = parseSseLine(line, model, parse, unwrap)
        if (chunk) {
          yield chunk
        }
      }
    }
    if (buffer.trim()) {
      const chunk = parseSseLine(buffer, model, parse, unwrap)
      if (chunk) {
        yield chunk
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function streamFromSseText({
  text,
  model,
  parse,
  unwrap,
}: {
  text: string
  model: string
  parse: ParseStreamingChunk
  unwrap: GeminiUnwrap
}): AsyncIterable<LLMResponseStreaming> {
  const chunks = text
    .split(/\r?\n/)
    .map((line) => parseSseLine(line, model, parse, unwrap))
    .filter((chunk): chunk is LLMResponseStreaming => Boolean(chunk))
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  }
}

function parseSseLine(
  line: string,
  model: string,
  parse: ParseStreamingChunk,
  unwrap: GeminiUnwrap,
): LLMResponseStreaming | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) {
    return null
  }
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') {
    return null
  }
  const raw = JSON.parse(data) as unknown
  const unwrapped = unwrap(raw)
  return parse(unwrapped, model, unwrapped.responseId ?? crypto.randomUUID())
}

async function toReadableStream(
  stream: StreamSource,
): Promise<ReadableStream<Uint8Array>> {
  if ('getReader' in stream) {
    return stream
  }

  const { Readable } =
    await loadDesktopNodeModule<typeof import('node:stream')>('node:stream')
  const readableWithToWeb = Readable as typeof Readable & {
    toWeb?: (stream: NodeReadable) => ReadableStream<Uint8Array>
  }
  if (typeof readableWithToWeb.toWeb === 'function') {
    return readableWithToWeb.toWeb(stream)
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer | string) => {
        const value =
          typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk)
        controller.enqueue(value)
      })
      stream.once('end', () => controller.close())
      stream.once('error', (error) => controller.error(error))
    },
    cancel() {
      stream.destroy()
    },
  })
}
