import {
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  SmartComposerSettings,
} from '../../settings/schema/setting.types'
import { RequestTransportMode } from '../../types/provider.types'

export type ModelRequestPolicy = {
  timeoutMs: number
}

export class ModelRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Model request timed out after ${timeoutMs}ms.`)
    this.name = 'ModelRequestTimeoutError'
  }
}

export const DEFAULT_MODEL_REQUEST_POLICY: ModelRequestPolicy = {
  timeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
}

export const resolveModelRequestPolicy = (
  settings: Pick<SmartComposerSettings, 'continuationOptions'>,
): ModelRequestPolicy => {
  const timeoutMs = Math.min(
    600000,
    Math.max(
      1000,
      settings.continuationOptions?.primaryRequestTimeoutMs ??
        DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    ),
  )

  return {
    timeoutMs,
  }
}

export const resolveSdkMaxRetries = (_?: {
  requestPolicy?: ModelRequestPolicy
  requestTransportMode?: RequestTransportMode
}): number => 0

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

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

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

  return runWithTimeout({
    timeoutMs: policy.timeoutMs,
    signal,
    run,
  })
}
