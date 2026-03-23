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
  browserStream,
  createNodeStream,
  createObsidianStream,
  memoryKey,
  onAutoPromoteTransportMode,
}: {
  browserStream: AsyncIterable<T>
  createNodeStream?: () => Promise<AsyncIterable<T>>
  createObsidianStream: () => Promise<AsyncIterable<T>>
  memoryKey?: string
  onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
}): AsyncIterable<T> => {
  return {
    async *[Symbol.asyncIterator]() {
      let yieldedAnyChunk = false
      try {
        for await (const chunk of browserStream) {
          yieldedAnyChunk = true
          yield chunk
        }
        return
      } catch (error) {
        if (yieldedAnyChunk || !shouldRetryWithObsidianTransport(error)) {
          throw error
        }
      }

      const streamFactories = [
        ...(createNodeStream
          ? [{ mode: 'node' as const, createStream: createNodeStream }]
          : []),
        { mode: 'obsidian' as const, createStream: createObsidianStream },
      ]

      let lastError: unknown
      for (const { mode: fallbackMode, createStream } of streamFactories) {
        try {
          const fallbackStream = await createStream()
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
            shouldRetryWithObsidianTransport(fallbackError)
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
}: {
  mode: RequestTransportMode
  createBrowserStream: () => Promise<AsyncIterable<T>>
  createObsidianStream: () => Promise<AsyncIterable<T>>
  createNodeStream?: () => Promise<AsyncIterable<T>>
  memoryKey?: string
  onAutoPromoteTransportMode?: (mode: AutoPromotedTransportMode) => void
}): Promise<AsyncIterable<T>> => {
  if (mode === 'browser') {
    return createBrowserStream()
  }

  if (mode === 'obsidian') {
    return createObsidianStream()
  }

  if (mode === 'node') {
    if (!createNodeStream) {
      throw new Error('Node request transport is not configured.')
    }
    return createNodeStream()
  }

  try {
    const browserStream = await createBrowserStream()
    return createAutoFallbackStream({
      browserStream,
      createNodeStream,
      createObsidianStream,
      memoryKey,
      onAutoPromoteTransportMode,
    })
  } catch (error) {
    if (!shouldRetryWithObsidianTransport(error)) {
      throw error
    }
    return createAutoFallbackStream({
      browserStream: {
        async *[Symbol.asyncIterator]() {
          throw error
        },
      },
      createNodeStream,
      createObsidianStream,
      memoryKey,
      onAutoPromoteTransportMode,
    })
  }
}

export const clearRequestTransportMemoryForTests = (): void => {
  requestTransportMemory.clear()
}
