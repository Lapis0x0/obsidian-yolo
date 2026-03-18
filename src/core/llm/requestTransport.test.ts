import {
  resolveRequestTransportMode,
  runWithRequestTransportForStream,
  runWithRequestTransport,
  shouldRetryWithObsidianTransport,
} from './requestTransport'

const collectStream = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const chunks: T[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

describe('requestTransport', () => {
  describe('resolveRequestTransportMode', () => {
    it('uses explicit requestTransportMode when provided', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: {
            requestTransportMode: 'obsidian',
            useObsidianRequestUrl: false,
          },
          hasCustomBaseUrl: false,
        }),
      ).toBe('obsidian')
    })

    it('maps legacy useObsidianRequestUrl setting', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: {
            useObsidianRequestUrl: true,
          },
          hasCustomBaseUrl: false,
        }),
      ).toBe('obsidian')
      expect(
        resolveRequestTransportMode({
          additionalSettings: {
            useObsidianRequestUrl: false,
          },
          hasCustomBaseUrl: true,
        }),
      ).toBe('browser')
    })

    it('defaults to auto when baseUrl exists and no settings provided', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: undefined,
          hasCustomBaseUrl: true,
        }),
      ).toBe('auto')
    })

    it('defaults to auto when baseUrl is absent', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: undefined,
          hasCustomBaseUrl: false,
        }),
      ).toBe('auto')
    })
  })

  describe('shouldRetryWithObsidianTransport', () => {
    it('detects CORS/network errors from nested causes', () => {
      const error = new Error('Connection error') as Error & { cause?: unknown }
      error.cause = new TypeError('Failed to fetch')
      expect(shouldRetryWithObsidianTransport(error)).toBe(true)
    })

    it('does not retry unrelated errors', () => {
      expect(
        shouldRetryWithObsidianTransport(new Error('401 unauthorized')),
      ).toBe(false)
    })
  })

  describe('runWithRequestTransport', () => {
    it('uses browser path in browser mode', async () => {
      const browser = jest.fn(async () => 'browser')
      const obsidian = jest.fn(async () => 'obsidian')
      await expect(
        runWithRequestTransport({
          mode: 'browser',
          runBrowser: browser,
          runObsidian: obsidian,
        }),
      ).resolves.toBe('browser')
      expect(browser).toHaveBeenCalledTimes(1)
      expect(obsidian).not.toHaveBeenCalled()
    })

    it('falls back to obsidian once in auto mode for CORS-like errors', async () => {
      const browser = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      const obsidian = jest.fn(async () => 'obsidian')
      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: browser,
          runObsidian: obsidian,
        }),
      ).resolves.toBe('obsidian')
      expect(browser).toHaveBeenCalledTimes(1)
      expect(obsidian).toHaveBeenCalledTimes(1)
    })
  })

  describe('runWithRequestTransportForStream', () => {
    it('falls back during iteration when browser stream fails before first chunk', async () => {
      const browser = jest.fn(async () => ({
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              throw new TypeError('Failed to fetch')
            },
          }
        },
      }))
      const obsidian = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'fallback-chunk'
        },
      }))

      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        createBrowserStream: browser,
        createObsidianStream: obsidian,
      })

      await expect(collectStream(stream)).resolves.toEqual(['fallback-chunk'])
      expect(browser).toHaveBeenCalledTimes(1)
      expect(obsidian).toHaveBeenCalledTimes(1)
    })

    it('does not fallback after browser stream already yielded chunks', async () => {
      const browser = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'first'
          throw new TypeError('Failed to fetch')
        },
      }))
      const obsidian = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'should-not-use'
        },
      }))

      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        createBrowserStream: browser,
        createObsidianStream: obsidian,
      })

      const iterator = stream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: 'first',
      })
      await expect(iterator.next()).rejects.toThrow('Failed to fetch')
      expect(obsidian).not.toHaveBeenCalled()
    })
  })
})
