import { Platform } from 'obsidian'

import { RequestTransportMode } from '../../types/provider.types'

export type AutoPromotedTransportMode = RequestTransportMode

type RequestTransportSettings = {
  requestTransportMode?:
    | RequestTransportMode
    | {
        desktop?: RequestTransportMode
        mobile?: Extract<RequestTransportMode, 'browser' | 'obsidian'>
      }
    | 'auto'
  useObsidianRequestUrl?: boolean
}

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

const normalizeStoredRequestTransportMode = (
  mode: RequestTransportSettings['requestTransportMode'],
): RequestTransportMode | undefined => {
  if (mode && typeof mode === 'object') {
    const platformMode = Platform.isDesktop ? mode.desktop : mode.mobile
    if (
      platformMode === 'browser' ||
      platformMode === 'obsidian' ||
      (Platform.isDesktop && platformMode === 'node')
    ) {
      return platformMode
    }
    return undefined
  }

  if (mode === 'browser' || mode === 'obsidian') {
    return mode
  }

  if (mode === 'node') {
    return Platform.isDesktop ? 'node' : 'browser'
  }

  return undefined
}

export const resolveRequestTransportMode = ({
  additionalSettings,
  hasCustomBaseUrl: _hasCustomBaseUrl,
  memoryKey: _memoryKey,
}: {
  additionalSettings?: RequestTransportSettings
  hasCustomBaseUrl: boolean
  memoryKey?: string
}): RequestTransportMode => {
  const configuredMode = normalizeStoredRequestTransportMode(
    additionalSettings?.requestTransportMode,
  )
  if (configuredMode) {
    return configuredMode
  }

  if (typeof additionalSettings?.useObsidianRequestUrl === 'boolean') {
    return additionalSettings.useObsidianRequestUrl ? 'obsidian' : 'browser'
  }

  return Platform.isDesktop ? 'node' : 'browser'
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
  runNode,
  memoryKey: _memoryKey,
  onAutoPromoteTransportMode: _onAutoPromoteTransportMode,
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

  throw new Error(`Unsupported request transport mode: ${String(mode)}`)
}

const createMobileBrowserStreamWithSuggestion = <T>(
  stream: AsyncIterable<T>,
): AsyncIterable<T> => {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of stream) {
          yield chunk
        }
      } catch (error) {
        throw appendMobileBrowserTransportSuggestion(error)
      }
    },
  }
}

const appendMobileBrowserTransportSuggestion = (error: unknown): Error => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown request transport error'
  return new Error(
    `${message}\n\nBrowser requests on mobile may not support this provider's streaming response. Switch this provider's network request method to Obsidian built-in request and try again.`,
  )
}

export const runWithRequestTransportForStream = async <T>({
  mode,
  createBrowserStream,
  createObsidianStream,
  createNodeStream,
  memoryKey: _memoryKey,
  onAutoPromoteTransportMode: _onAutoPromoteTransportMode,
  signal,
  firstChunkTimeoutMs: _firstChunkTimeoutMs,
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
    try {
      const stream = await createBrowserStream(signal)
      return Platform.isDesktop
        ? stream
        : createMobileBrowserStreamWithSuggestion(stream)
    } catch (error) {
      if (!Platform.isDesktop) {
        throw appendMobileBrowserTransportSuggestion(error)
      }
      throw error
    }
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

  throw new Error(`Unsupported request transport mode: ${String(mode)}`)
}

export const clearRequestTransportMemory = (): void => {}

export const clearRequestTransportMemoryForTests = clearRequestTransportMemory
