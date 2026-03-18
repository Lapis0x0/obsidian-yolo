import { RequestTransportMode } from '../../types/provider.types'

type RequestTransportSettings = {
  requestTransportMode?: RequestTransportMode
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

export const resolveRequestTransportMode = ({
  additionalSettings,
  hasCustomBaseUrl: _hasCustomBaseUrl,
}: {
  additionalSettings?: RequestTransportSettings
  hasCustomBaseUrl: boolean
}): RequestTransportMode => {
  if (additionalSettings?.requestTransportMode) {
    return additionalSettings.requestTransportMode
  }

  if (typeof additionalSettings?.useObsidianRequestUrl === 'boolean') {
    return additionalSettings.useObsidianRequestUrl ? 'obsidian' : 'browser'
  }

  return 'auto'
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
}: {
  mode: RequestTransportMode
  runBrowser: () => Promise<T>
  runObsidian: () => Promise<T>
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
    return runObsidian()
  }
}

const createAutoFallbackStream = <T>({
  browserStream,
  createObsidianStream,
}: {
  browserStream: AsyncIterable<T>
  createObsidianStream: () => Promise<AsyncIterable<T>>
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
      for await (const chunk of obsidianStream) {
        yield chunk
      }
    },
  }
}

export const runWithRequestTransportForStream = async <T>({
  mode,
  createBrowserStream,
  createObsidianStream,
}: {
  mode: RequestTransportMode
  createBrowserStream: () => Promise<AsyncIterable<T>>
  createObsidianStream: () => Promise<AsyncIterable<T>>
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
    })
  } catch (error) {
    if (!shouldRetryWithObsidianTransport(error)) {
      throw error
    }
    return createObsidianStream()
  }
}
