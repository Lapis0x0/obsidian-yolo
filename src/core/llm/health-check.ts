import { YoloSettings } from '../../settings/schema/setting.types'
import { ChatModel } from '../../types/chat-model.types'
import { EmbeddingModel } from '../../types/embedding-model.types'
import { getEmbeddingModelClient } from '../rag/embedding'

import {
  LLMAPIKeyInvalidException,
  LLMAPIKeyNotSetException,
  LLMModelNotFoundException,
  LLMRateLimitExceededException,
} from './exception'
import { getProviderClient } from './manager'

export const HEALTH_CHECK_TIMEOUT_MS = 15000

export type HealthStatus = 'ok' | 'fail' | 'timeout'

export type HealthResult =
  | {
      status: 'ok'
      totalMs: number
      // chat metric: time-to-first-token
      firstTokenMs?: number
      // embedding metrics
      latencyMs?: number
      dimension?: number
    }
  | { status: 'timeout'; totalMs: number }
  | { status: 'fail'; code?: number; message: string }

export type HealthCheckOptions = {
  signal: AbortSignal
  timeoutMs?: number
}

/**
 * Thrown when a health check is cancelled by the caller (stop button / unmount).
 * The hook layer discards these instead of writing a result, so a cancelled
 * model returns to its previous (idle) state rather than showing as failed.
 */
export class HealthCheckAbortedError extends Error {
  constructor() {
    super('Health check aborted')
    this.name = 'HealthCheckAbortedError'
  }
}

/**
 * Best-effort HTTP status extraction across the various error shapes the
 * provider clients surface: OpenAI/Anthropic SDK errors carry `status`, AWS
 * Bedrock uses `$metadata.httpStatusCode`, and the project's wrapped
 * exceptions chain the original error under `rawError` / `cause`.
 */
function extractHttpStatus(error: unknown): number | undefined {
  const visited = new Set<unknown>()
  const visit = (value: unknown): number | undefined => {
    if (!value || typeof value !== 'object' || visited.has(value)) {
      return undefined
    }
    visited.add(value)
    const obj = value as Record<string, unknown>

    if (typeof obj.status === 'number') return obj.status
    if (typeof obj.statusCode === 'number') return obj.statusCode
    // `code` is only an HTTP status when numeric — some SDKs use string codes
    // like 'model_not_found', which we must not treat as a status.
    if (typeof obj.code === 'number') return obj.code

    const metadata = obj.$metadata
    if (
      metadata &&
      typeof metadata === 'object' &&
      typeof (metadata as Record<string, unknown>).httpStatusCode === 'number'
    ) {
      return (metadata as Record<string, unknown>).httpStatusCode as number
    }

    return visit(obj.rawError) ?? visit(obj.cause)
  }
  return visit(error)
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true
  }
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name
    if (name === 'AbortError' || name === 'HealthCheckAbortedError') {
      return true
    }
  }
  return false
}

function mapErrorToResult(error: unknown): HealthResult {
  let code: number | undefined
  if (error instanceof LLMModelNotFoundException) {
    code = 404
  } else if (
    error instanceof LLMAPIKeyInvalidException ||
    error instanceof LLMAPIKeyNotSetException
  ) {
    code = 401
  } else if (error instanceof LLMRateLimitExceededException) {
    code = 429
  } else {
    code = extractHttpStatus(error)
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)

  return { status: 'fail', code, message }
}

/**
 * Send a minimal streaming request to measure time-to-first-token (TTFT).
 *
 * We deliberately do NOT compute throughput (tok/s): a minimal probe generates
 * only a handful of tokens, and on buffered transports they all arrive at once,
 * so the decode window collapses toward zero and any tok/s figure is noise.
 * TTFT is the only streaming metric meaningful on such a probe.
 *
 * Timeout semantics are a flat total budget (default 15s) — unlike
 * single-turn.ts which clears its timeout after the first chunk. A health
 * check wants the whole request bounded.
 *
 * Cancellation note: most transports forward `signal` to the underlying
 * fetch/SDK, but Obsidian's `requestUrl`-based transport can only check abort
 * before/after a request — an in-flight request may keep running after stop().
 * The hook layer's run-id + controller-identity guard prevents such late
 * results from being written back.
 */
export async function testChatModelHealth(
  settings: YoloSettings,
  model: ChatModel,
  opts: HealthCheckOptions,
): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const providerClient = getProviderClient({
    settings,
    providerId: model.providerId,
  })

  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = () => controller.abort()
  if (opts.signal.aborted) {
    controller.abort()
  } else {
    opts.signal.addEventListener('abort', onExternalAbort)
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const start = performance.now()
  let firstTokenMs: number | undefined

  try {
    const stream = await providerClient.streamResponse(
      model,
      {
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        model: model.model,
        max_tokens: 16,
        stream: true,
      },
      { signal: controller.signal },
    )

    for await (const chunk of stream) {
      if (firstTokenMs === undefined) {
        // TTFT = time until the model emits its first token of any kind. For
        // reasoning models the first emitted token is a reasoning token, so we
        // must count `delta.reasoning` too — otherwise a small `max_tokens`
        // probe can be fully consumed by reasoning, never reach `content`, and
        // the row would inconsistently fall back to showing total time.
        const delta = chunk.choices?.[0]?.delta
        if (delta?.content || delta?.reasoning) {
          firstTokenMs = performance.now() - start
          // The auto-transport stream wrapper's teardown only removes its abort
          // listener; it does not cascade `iterator.return()` to the underlying
          // HTTP/SSE request. Abort explicitly (before break, while the linked
          // listener is still attached) so the in-flight request is cancelled
          // instead of running to completion in the background.
          controller.abort()
          break
        }
      }
    }

    const totalMs = performance.now() - start

    // Guard against false positives: if the stream completed without emitting
    // any content or reasoning tokens, report a failure instead of a
    // misleading 'ok'. This commonly happens when the base URL is missing a
    // path prefix (e.g. `/v1`) and the server returns an empty SSE stream.
    if (firstTokenMs === undefined) {
      return {
        status: 'fail',
        message:
          'No content received from the model — verify the API base URL (e.g. the `/v1` suffix) and that the endpoint returns a non-empty SSE stream.',
      }
    }

    return { status: 'ok', totalMs, firstTokenMs }
  } catch (error) {
    if (opts.signal.aborted && !timedOut) {
      throw new HealthCheckAbortedError()
    }
    if (timedOut) {
      return { status: 'timeout', totalMs: timeoutMs }
    }
    if (isAbortError(error)) {
      throw new HealthCheckAbortedError()
    }
    return mapErrorToResult(error)
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * Probe an embedding model via the shared RAG client so the dimension handling
 * (sending `dimensions` when it differs from the native output, and validating
 * the returned vector length) matches real runtime behaviour. A length
 * mismatch surfaces as a legitimate failure (misconfigured dimension).
 *
 * `getEmbedding` has no AbortSignal, so timeout/stop are implemented by racing
 * the call against a timer and discarding a late result via the hook guard.
 */
export async function testEmbeddingModelHealth(
  settings: YoloSettings,
  model: EmbeddingModel,
  opts: HealthCheckOptions,
): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const client = getEmbeddingModelClient({
    settings,
    embeddingModelId: model.id,
  })

  const start = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onExternalAbort: (() => void) | undefined

  try {
    const outcome = await new Promise<
      | { kind: 'ok'; vector: number[] }
      | { kind: 'timeout' }
      | { kind: 'aborted' }
      | { kind: 'error'; error: unknown }
    >((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
      if (opts.signal.aborted) {
        resolve({ kind: 'aborted' })
      } else {
        onExternalAbort = () => resolve({ kind: 'aborted' })
        opts.signal.addEventListener('abort', onExternalAbort)
      }
      client.getEmbedding('ok').then(
        (vector) => resolve({ kind: 'ok', vector }),
        (error) => resolve({ kind: 'error', error }),
      )
    })

    if (outcome.kind === 'aborted') {
      throw new HealthCheckAbortedError()
    }
    if (outcome.kind === 'timeout') {
      return { status: 'timeout', totalMs: timeoutMs }
    }
    if (outcome.kind === 'error') {
      return mapErrorToResult(outcome.error)
    }
    const totalMs = performance.now() - start
    return {
      status: 'ok',
      totalMs,
      latencyMs: totalMs,
      dimension: outcome.vector.length,
    }
  } catch (error) {
    if (error instanceof HealthCheckAbortedError) {
      throw error
    }
    return mapErrorToResult(error)
  } finally {
    if (timer) clearTimeout(timer)
    if (onExternalAbort) {
      opts.signal.removeEventListener('abort', onExternalAbort)
    }
  }
}
