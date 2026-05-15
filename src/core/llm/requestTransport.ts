import { Platform } from 'obsidian'

import { RequestTransportMode } from '../../types/provider.types'

import { inheritLLMDebugTraceSignal } from './debugCapture'

export type AutoPromotedTransportMode = Extract<
  RequestTransportMode,
  'browser' | 'node' | 'obsidian'
>

type RequestTransportSettings = {
  requestTransportMode?: RequestTransportMode
  useObsidianRequestUrl?: boolean
}

const AUTO_OBSIDIAN_MEMORY_TTL_MS = 24 * 60 * 60 * 1000
const AUTO_STREAM_ATTEMPT_FIRST_CHUNK_TIMEOUT_MS = 3000

type RequestTransportMemoryEntry = {
  preferredMode: AutoPromotedTransportMode
  expiresAt: number
}

const requestTransportMemory = new Map<string, RequestTransportMemoryEntry>()

const CORS_RETRY_MESSAGE_PATTERNS = [
  'access-control-allow-origin',
  'blocked by cors policy',
  'cors',
  'failed to fetch',
  'load failed',
  'networkerror',
  'preflight request',
]

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

const getRememberedMode = (memoryKey?: string): RequestTransportMode | null => {
  if (!memoryKey) {
    return null
  }

  const memory = requestTransportMemory.get(memoryKey)
  if (!memory) {
    return null
  }

  if (Date.now() > memory.expiresAt) {
    requestTransportMemory.delete(memoryKey)
    return null
  }

  return memory.preferredMode
}

const rememberTransportMode = (
  preferredMode: AutoPromotedTransportMode,
  memoryKey?: string,
): void => {
  if (!memoryKey) {
    return
  }

  requestTransportMemory.set(memoryKey, {
    preferredMode,
    expiresAt: Date.now() + AUTO_OBSIDIAN_MEMORY_TTL_MS,
  })
}

export const createRequestTransportMemoryKey = ({
  providerType,
  providerId,
  baseUrl,
}: {
  providerType: string
  providerId: string
  baseUrl?: string
}): string => {
  const normalizedBaseUrl = (baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase()
  return `${providerType}::${providerId}::${normalizedBaseUrl}`
}

export const resolveRequestTransportMode = ({
  additionalSettings,
  hasCustomBaseUrl,
  memoryKey,
}: {
  additionalSettings?: RequestTransportSettings
  hasCustomBaseUrl: boolean
  memoryKey?: string
}): RequestTransportMode => {
  const configuredMode = additionalSettings?.requestTransportMode
  if (
    configuredMode === 'browser' ||
    configuredMode === 'obsidian' ||
    configuredMode === 'node'
  ) {
    return configuredMode
  }

  if (typeof additionalSettings?.useObsidianRequestUrl === 'boolean') {
    return additionalSettings.useObsidianRequestUrl ? 'obsidian' : 'browser'
  }

  const fallbackMode: RequestTransportMode =
    configuredMode === 'auto' || hasCustomBaseUrl ? 'auto' : 'browser'

  if (fallbackMode !== 'auto') {
    return fallbackMode
  }

  return getRememberedMode(memoryKey) ?? fallbackMode
}

export const shouldRetryWithObsidianTransport = (error: unknown): boolean => {
  const message = collectErrorMessages(error).join(' ').toLowerCase()
  return CORS_RETRY_MESSAGE_PATTERNS.some((pattern) =>
    message.includes(pattern),
  )
}

class RequestTransportAttemptTimeoutError extends Error {
  constructor(transportMode: 'browser' | 'node') {
    super(`Timed out waiting for first chunk from ${transportMode} transport.`)
    this.name = 'RequestTransportAttemptTimeoutError'
  }
}

const shouldRetryWithNextTransport = (error: unknown): boolean => {
  return (
    error instanceof RequestTransportAttemptTimeoutError ||
    shouldRetryWithObsidianTransport(error)
  )
}

const createLinkedAbortController = (
  signal?: AbortSignal,
): {
  controller: AbortController
  cleanup: () => void
} => {
  const controller = new AbortController()
  inheritLLMDebugTraceSignal({ source: signal, target: controller.signal })

  if (!signal) {
    return {
      controller,
      cleanup: () => {},
    }
  }

  if (signal.aborted) {
    controller.abort()
    return {
      controller,
      cleanup: () => {},
    }
  }

  const handleAbort = () => {
    controller.abort()
  }

  signal.addEventListener('abort', handleAbort, { once: true })

  return {
    controller,
    cleanup: () => signal.removeEventListener('abort', handleAbort),
  }
}

const withTimeout = async <T>({
  run,
  timeoutMs,
  onTimeout,
}: {
  run: () => Promise<T>
  timeoutMs: number
  onTimeout: () => void
}): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          onTimeout()
          reject(new Error('timeout'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

export const runWithRequestTransport = async <T>({
  mode,
  runBrowser,
  runObsidian,
  runNode,
  memoryKey,
  onAutoPromoteTransportMode,
}: {
  mode: RequestTransportMode
  runBrowser: () => Promise<T>
  runObsidian: () => Promise<T>
  runNode?: () => Promise<T>
  memoryKey?: string
  onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
}): Promise<T> => {
  if (mode === 'browser') {
    return runBrowser()
  }

  if (mode === 'obsidian') {
    return runObsidian()
  }

  if (mode === 'node') {
    if (!runNode) {
      throw new Error('Node request transport is not configured.')
    }
    return runNode()
  }

  // Desktop auto order: node → browser → obsidian. Mobile (no node): browser → obsidian.
  // Node is the primary attempt on desktop because it has no CORS surface, honors
  // custom headers, and routes proxy decisions through proxy-agent for parity with
  // Chromium. Browser is the next fallback (covers rare proxy-agent edge cases),
  // and obsidian's requestUrl is the last resort.
  const effectiveRunNode = Platform.isDesktop ? runNode : undefined

  const fallbackAttempts: Array<{
    mode: AutoPromotedTransportMode
    run: () => Promise<T>
  }> = effectiveRunNode
    ? [
        { mode: 'browser', run: runBrowser },
        { mode: 'obsidian', run: runObsidian },
      ]
    : [{ mode: 'obsidian', run: runObsidian }]

  const runPrimary = effectiveRunNode ?? runBrowser

  try {
    return await runPrimary()
  } catch (error) {
    if (!shouldRetryWithObsidianTransport(error)) {
      throw error
    }
    let lastError: unknown = error
    for (const attempt of fallbackAttempts) {
      try {
        const response = await attempt.run()
        rememberTransportMode(attempt.mode, memoryKey)
        onAutoPromoteTransportMode?.(attempt.mode)
        return response
      } catch (fallbackError) {
        lastError = fallbackError
        if (!shouldRetryWithObsidianTransport(fallbackError)) {
          throw fallbackError
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          typeof lastError === 'string'
            ? lastError
            : 'Unknown request transport error',
        )
  }
}

const createAutoFallbackStream = <T>({
  createBrowserStream,
  createNodeStream,
  createObsidianStream,
  memoryKey,
  onAutoPromoteTransportMode,
  signal,
  firstChunkTimeoutMs = AUTO_STREAM_ATTEMPT_FIRST_CHUNK_TIMEOUT_MS,
}: {
  createBrowserStream: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
  createNodeStream?: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
  createObsidianStream: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
  memoryKey?: string
  onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
  signal?: AbortSignal
  firstChunkTimeoutMs?: number
}): AsyncIterable<T> => {
  const startTimedStreamAttempt = async ({
    transportMode,
    createStream,
  }: {
    transportMode: 'browser' | 'node'
    createStream: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
  }): Promise<AsyncIterable<T>> => {
    const { controller, cleanup } = createLinkedAbortController(signal)

    try {
      const stream = await withTimeout({
        run: () => createStream(controller.signal),
        timeoutMs: firstChunkTimeoutMs,
        onTimeout: () => controller.abort(),
      }).catch((error) => {
        if (error instanceof Error && error.message === 'timeout') {
          throw new RequestTransportAttemptTimeoutError(transportMode)
        }
        throw error
      })

      const iterator = stream[Symbol.asyncIterator]()
      const firstResult = await withTimeout({
        run: () => iterator.next(),
        timeoutMs: firstChunkTimeoutMs,
        onTimeout: () => controller.abort(),
      }).catch((error) => {
        if (error instanceof Error && error.message === 'timeout') {
          throw new RequestTransportAttemptTimeoutError(transportMode)
        }
        throw error
      })

      return {
        async *[Symbol.asyncIterator]() {
          try {
            if (!firstResult.done) {
              yield firstResult.value
            }
            if (firstResult.done) {
              return
            }
            while (true) {
              const nextResult = await iterator.next()
              if (nextResult.done) {
                return
              }
              yield nextResult.value
            }
          } finally {
            cleanup()
          }
        },
      }
    } catch (error) {
      cleanup()
      throw error
    }
  }

  // Desktop auto order: node → browser → obsidian. Mobile (no node): browser → obsidian.
  // The primary attempt is timed; fallbacks are timed for browser/node (fast
  // failure on CORS/proxy) and untimed for obsidian's buffered requestUrl.
  const primaryAttempt: {
    mode: 'browser' | 'node'
    createStream: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
  } = createNodeStream
    ? { mode: 'node', createStream: createNodeStream }
    : { mode: 'browser', createStream: createBrowserStream }

  type FallbackAttempt =
    | {
        mode: 'browser' | 'node'
        createStream: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
        timed: true
      }
    | {
        mode: 'obsidian'
        createStream: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
        timed: false
      }

  const fallbackAttempts: FallbackAttempt[] = createNodeStream
    ? [
        {
          mode: 'browser',
          createStream: createBrowserStream,
          timed: true,
        },
        {
          mode: 'obsidian',
          createStream: (attemptSignal?: AbortSignal) =>
            createObsidianStream(attemptSignal ?? signal),
          timed: false,
        },
      ]
    : [
        {
          mode: 'obsidian',
          createStream: (attemptSignal?: AbortSignal) =>
            createObsidianStream(attemptSignal ?? signal),
          timed: false,
        },
      ]

  return {
    async *[Symbol.asyncIterator]() {
      let yieldedAnyChunk = false
      try {
        const primaryStream = await startTimedStreamAttempt({
          transportMode: primaryAttempt.mode,
          createStream: primaryAttempt.createStream,
        })
        for await (const chunk of primaryStream) {
          yieldedAnyChunk = true
          yield chunk
        }
        return
      } catch (error) {
        if (yieldedAnyChunk || !shouldRetryWithNextTransport(error)) {
          throw error
        }
      }

      let lastError: unknown
      for (const attempt of fallbackAttempts) {
        let attemptYieldedChunk = false
        try {
          const fallbackStream = attempt.timed
            ? await startTimedStreamAttempt({
                transportMode: attempt.mode,
                createStream: attempt.createStream,
              })
            : await attempt.createStream(signal)
          let remembered = false
          for await (const chunk of fallbackStream) {
            if (!remembered) {
              rememberTransportMode(attempt.mode, memoryKey)
              onAutoPromoteTransportMode?.(attempt.mode)
              remembered = true
            }
            attemptYieldedChunk = true
            yield chunk
          }
          if (!remembered) {
            rememberTransportMode(attempt.mode, memoryKey)
            onAutoPromoteTransportMode?.(attempt.mode)
          }
          return
        } catch (fallbackError) {
          lastError = fallbackError
          // Once this attempt has yielded chunks, downstream consumers have
          // already seen a partial response — switching transports now would
          // splice two responses together. Bail out with the live error.
          if (attemptYieldedChunk) {
            throw fallbackError
          }
          if (attempt.timed && shouldRetryWithNextTransport(fallbackError)) {
            continue
          }
          throw fallbackError
        }
      }

      if (lastError) {
        throw lastError instanceof Error
          ? lastError
          : new Error(
              typeof lastError === 'string'
                ? lastError
                : 'Unknown request transport error',
            )
      }
    },
  }
}

export const runWithRequestTransportForStream = async <T>({
  mode,
  createBrowserStream,
  createObsidianStream,
  createNodeStream,
  memoryKey,
  onAutoPromoteTransportMode,
  signal,
  firstChunkTimeoutMs,
}: {
  mode: RequestTransportMode
  createBrowserStream: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
  createObsidianStream: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
  createNodeStream?: (signal?: AbortSignal) => Promise<AsyncIterable<T>>
  memoryKey?: string
  onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
  signal?: AbortSignal
  firstChunkTimeoutMs?: number
}): Promise<AsyncIterable<T>> => {
  if (mode === 'browser') {
    return createBrowserStream(signal)
  }

  if (mode === 'obsidian') {
    return createObsidianStream(signal)
  }

  if (mode === 'node') {
    if (!createNodeStream) {
      throw new Error('Node request transport is not configured.')
    }
    return createNodeStream(signal)
  }

  return createAutoFallbackStream({
    createBrowserStream,
    createNodeStream: Platform.isDesktop ? createNodeStream : undefined,
    createObsidianStream,
    memoryKey,
    onAutoPromoteTransportMode,
    signal,
    firstChunkTimeoutMs,
  })
}

export const clearRequestTransportMemory = (): void => {
  requestTransportMemory.clear()
}

export const clearRequestTransportMemoryForTests = clearRequestTransportMemory
