import { RequestTransportMode } from '../../types/provider.types'

export type AutoPromotedTransportMode = Extract<
  RequestTransportMode,
  'node' | 'obsidian'
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

const tryNodeThenObsidian = async <T>({
  runNode,
  runObsidian,
  memoryKey,
  onAutoPromoteTransportMode,
}: {
  runNode?: () => Promise<T>
  runObsidian: () => Promise<T>
  memoryKey?: string
  onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
}): Promise<T> => {
  if (runNode) {
    try {
      const nodeResponse = await runNode()
      rememberTransportMode('node', memoryKey)
      onAutoPromoteTransportMode?.('node')
      return nodeResponse
    } catch (nodeError) {
      if (!shouldRetryWithObsidianTransport(nodeError)) {
        throw nodeError
      }
    }
  }

  const obsidianResponse = await runObsidian()
  rememberTransportMode('obsidian', memoryKey)
  onAutoPromoteTransportMode?.('obsidian')
  return obsidianResponse
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

  try {
    return await runBrowser()
  } catch (error) {
    if (!shouldRetryWithObsidianTransport(error)) {
      throw error
    }
    return tryNodeThenObsidian({
      runNode,
      runObsidian,
      memoryKey,
      onAutoPromoteTransportMode,
    })
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

  return {
    async *[Symbol.asyncIterator]() {
      let yieldedAnyChunk = false
      try {
        const browserStream = await startTimedStreamAttempt({
          transportMode: 'browser',
          createStream: createBrowserStream,
        })
        for await (const chunk of browserStream) {
          yieldedAnyChunk = true
          yield chunk
        }
        return
      } catch (error) {
        if (yieldedAnyChunk || !shouldRetryWithNextTransport(error)) {
          throw error
        }
      }

      const streamFactories = [
        ...(createNodeStream
          ? [
              {
                mode: 'node' as const,
                createStream: (attemptSignal?: AbortSignal) =>
                  createNodeStream(attemptSignal),
                timed: true as const,
              },
            ]
          : []),
        {
          mode: 'obsidian' as const,
          createStream: (attemptSignal?: AbortSignal) =>
            createObsidianStream(attemptSignal ?? signal),
          timed: false as const,
        },
      ]

      let lastError: unknown
      for (const { mode: fallbackMode, createStream, timed } of streamFactories) {
        try {
          const fallbackStream =
            timed && fallbackMode === 'node'
              ? await startTimedStreamAttempt({
                  transportMode: 'node',
                  createStream,
                })
              : await createStream(signal)
          let remembered = false
          for await (const chunk of fallbackStream) {
            if (!remembered) {
              rememberTransportMode(fallbackMode, memoryKey)
              onAutoPromoteTransportMode?.(fallbackMode)
              remembered = true
            }
            yield chunk
          }
          if (!remembered) {
            rememberTransportMode(fallbackMode, memoryKey)
            onAutoPromoteTransportMode?.(fallbackMode)
          }
          return
        } catch (fallbackError) {
          lastError = fallbackError
          if (
            fallbackMode === 'node' &&
            shouldRetryWithNextTransport(fallbackError)
          ) {
            continue
          }
          throw fallbackError
        }
      }

      if (lastError) {
        throw lastError
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
    createNodeStream,
    createObsidianStream,
    memoryKey,
    onAutoPromoteTransportMode,
    signal,
    firstChunkTimeoutMs,
  })
}

export const clearRequestTransportMemoryForTests = (): void => {
  requestTransportMemory.clear()
}
