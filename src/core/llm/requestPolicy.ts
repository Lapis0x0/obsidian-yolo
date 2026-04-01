import {
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  SmartComposerSettings,
} from '../../settings/schema/setting.types'
import { RequestTransportMode } from '../../types/provider.types'

export type ModelRequestPolicy = {
  maxRetries: number
  timeoutMs: number
}

export class ModelRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Model request timed out after ${timeoutMs}ms.`)
    this.name = 'ModelRequestTimeoutError'
  }
}

export const DEFAULT_MODEL_REQUEST_POLICY: ModelRequestPolicy = {
  maxRetries: 1,
  timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
}

export const resolveModelRequestPolicy = (
  settings: Pick<SmartComposerSettings, 'continuationOptions'>,
): ModelRequestPolicy => {
  const timeoutMs = Math.min(
    600000,
    Math.max(
      1000,
      settings.continuationOptions?.modelRequestTimeoutMs ??
        DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    ),
  )

  return {
    maxRetries: settings.continuationOptions?.modelRequestAutoRetryEnabled
      ? 1
      : settings.continuationOptions?.modelRequestAutoRetryEnabled === false
        ? 0
        : 1,
    timeoutMs,
  }
}

export const resolveSdkMaxRetries = ({
  requestPolicy,
  requestTransportMode,
}: {
  requestPolicy?: ModelRequestPolicy
  requestTransportMode?: RequestTransportMode
}): number => {
  if (requestTransportMode === 'auto') {
    return 0
  }

  return requestPolicy?.maxRetries ?? 0
}

const createAbortError = (): Error => {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

const createLinkedAbortController = (
  signal?: AbortSignal,
): {
  controller: AbortController
  cleanup: () => void
} => {
  const controller = new AbortController()

  if (!signal) {
    return {
      controller,
      cleanup: () => {},
    }
  }

  if (signal.aborted) {
    controller.abort(signal.reason)
    return {
      controller,
      cleanup: () => {},
    }
  }

  const handleAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', handleAbort, { once: true })

  return {
    controller,
    cleanup: () => signal.removeEventListener('abort', handleAbort),
  }
}

const collectErrorMessages = (error: unknown, depth = 0): string[] => {
  if (depth > 5 || error == null) {
    return []
  }

  if (typeof error === 'string') {
    return [error]
  }

  if (error instanceof Error) {
    const nestedMessages =
      'cause' in error
        ? collectErrorMessages(
            (error as Error & { cause?: unknown }).cause,
            depth + 1,
          )
        : []
    return [error.message, ...nestedMessages]
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    const nested: string[] = []
    if (typeof record.message === 'string') {
      nested.push(record.message)
    }
    if ('cause' in record) {
      nested.push(...collectErrorMessages(record.cause, depth + 1))
    }
    return nested
  }

  return []
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

const shouldRetryModelRequest = (error: unknown): boolean => {
  if (error instanceof ModelRequestTimeoutError) {
    return true
  }

  if (isAbortError(error)) {
    return false
  }

  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined
  if (typeof status === 'number') {
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(status)
  }

  const message = collectErrorMessages(error).join(' ').toLowerCase()
  return [
    'timeout',
    'timed out',
    'temporarily unavailable',
    'service unavailable',
    'unexpected eof',
    'network error',
    'fetch failed',
    'connection reset',
    'econnreset',
    'socket hang up',
  ].some((pattern) => message.includes(pattern))
}

const runWithTimeout = async <T>({
  timeoutMs,
  signal,
  run,
}: {
  timeoutMs: number
  signal?: AbortSignal
  run: (signal: AbortSignal) => Promise<T>
}): Promise<T> => {
  const { controller, cleanup } = createLinkedAbortController(signal)

  if (signal?.aborted) {
    throw createAbortError()
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let didTimeout = false

  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          didTimeout = true
          controller.abort(new ModelRequestTimeoutError(timeoutMs))
          reject(new ModelRequestTimeoutError(timeoutMs))
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    if (didTimeout) {
      throw new ModelRequestTimeoutError(timeoutMs)
    }
    if (signal?.aborted) {
      throw createAbortError()
    }
    throw error
  } finally {
    cleanup()
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

export const runWithModelRequestPolicy = async <T>({
  requestPolicy,
  signal,
  run,
}: {
  requestPolicy?: ModelRequestPolicy
  signal?: AbortSignal
  run: (signal: AbortSignal) => Promise<T>
}): Promise<T> => {
  const policy = requestPolicy ?? DEFAULT_MODEL_REQUEST_POLICY
  let attempts = 0

  while (true) {
    try {
      return await runWithTimeout({
        timeoutMs: policy.timeoutMs,
        signal,
        run,
      })
    } catch (error) {
      if (!shouldRetryModelRequest(error) || attempts >= policy.maxRetries) {
        throw error
      }
      attempts += 1
    }
  }
}
