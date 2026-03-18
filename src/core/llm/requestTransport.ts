import { RequestTransportMode } from '../../types/provider.types'

type RequestTransportSettings = {
  requestTransportMode?: RequestTransportMode
  useObsidianRequestUrl?: boolean
}

const AUTO_OBSIDIAN_MEMORY_TTL_MS = 24 * 60 * 60 * 1000

type RequestTransportMemoryEntry = {
  preferredMode: Extract<RequestTransportMode, 'obsidian'>
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

const rememberObsidianMode = (memoryKey?: string): void => {
  if (!memoryKey) {
    return
  }

  requestTransportMemory.set(memoryKey, {
    preferredMode: 'obsidian',
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
  if (configuredMode === 'browser' || configuredMode === 'obsidian') {
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

export const runWithRequestTransport = async <T>({
  mode,
  runBrowser,
  runObsidian,
  memoryKey,
  onAutoPromoteToObsidian,
}: {
  mode: RequestTransportMode
  runBrowser: () => Promise<T>
  runObsidian: () => Promise<T>
  memoryKey?: string
  onAutoPromoteToObsidian?: () => void
}): Promise<T> => {
  if (mode === 'browser') {
    return runBrowser()
  }

  if (mode === 'obsidian') {
    return runObsidian()
  }

  try {
    return await runBrowser()
  } catch (error) {
    if (!shouldRetryWithObsidianTransport(error)) {
      throw error
    }
    const response = await runObsidian()
    rememberObsidianMode(memoryKey)
    onAutoPromoteToObsidian?.()
    return response
  }
}

const createAutoFallbackStream = <T>({
  browserStream,
  createObsidianStream,
  memoryKey,
  onAutoPromoteToObsidian,
}: {
  browserStream: AsyncIterable<T>
  createObsidianStream: () => Promise<AsyncIterable<T>>
  memoryKey?: string
  onAutoPromoteToObsidian?: () => void
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

      const obsidianStream = await createObsidianStream()
      let remembered = false
      for await (const chunk of obsidianStream) {
        if (!remembered) {
          rememberObsidianMode(memoryKey)
          onAutoPromoteToObsidian?.()
          remembered = true
        }
        yield chunk
      }
      if (!remembered) {
        rememberObsidianMode(memoryKey)
        onAutoPromoteToObsidian?.()
      }
    },
  }
}

export const runWithRequestTransportForStream = async <T>({
  mode,
  createBrowserStream,
  createObsidianStream,
  memoryKey,
  onAutoPromoteToObsidian,
}: {
  mode: RequestTransportMode
  createBrowserStream: () => Promise<AsyncIterable<T>>
  createObsidianStream: () => Promise<AsyncIterable<T>>
  memoryKey?: string
  onAutoPromoteToObsidian?: () => void
}): Promise<AsyncIterable<T>> => {
  if (mode === 'browser') {
    return createBrowserStream()
  }

  if (mode === 'obsidian') {
    return createObsidianStream()
  }

  try {
    const browserStream = await createBrowserStream()
    return createAutoFallbackStream({
      browserStream,
      createObsidianStream,
      memoryKey,
      onAutoPromoteToObsidian,
    })
  } catch (error) {
    if (!shouldRetryWithObsidianTransport(error)) {
      throw error
    }
    const obsidianStream = await createObsidianStream()
    rememberObsidianMode(memoryKey)
    onAutoPromoteToObsidian?.()
    return obsidianStream
  }
}

export const clearRequestTransportMemoryForTests = (): void => {
  requestTransportMemory.clear()
}
