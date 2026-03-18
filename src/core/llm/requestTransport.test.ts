import {
  clearRequestTransportMemoryForTests,
  createRequestTransportMemoryKey,
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
  beforeEach(() => {
    clearRequestTransportMemoryForTests()
  })

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

    it('defaults to browser when baseUrl is absent', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: undefined,
          hasCustomBaseUrl: false,
        }),
      ).toBe('browser')
    })

    it('uses remembered obsidian mode when auto has memory', async () => {
      const memoryKey = createRequestTransportMemoryKey({
        providerType: 'openai-compatible',
        providerId: 'p1',
        baseUrl: 'https://example.com/v1',
      })

      await runWithRequestTransport({
        mode: 'auto',
        memoryKey,
        runBrowser: async () => {
          throw new TypeError('Failed to fetch')
        },
        runObsidian: async () => 'ok',
      })

      expect(
        resolveRequestTransportMode({
          additionalSettings: { requestTransportMode: 'auto' },
          hasCustomBaseUrl: true,
          memoryKey,
        }),
      ).toBe('obsidian')
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

    it('invokes auto-promote callback when fallback succeeds', async () => {
      const onAutoPromoteToObsidian = jest.fn()

      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: async () => {
            throw new TypeError('Failed to fetch')
          },
          runObsidian: async () => 'ok',
          onAutoPromoteToObsidian,
        }),
      ).resolves.toBe('ok')

      expect(onAutoPromoteToObsidian).toHaveBeenCalledTimes(1)
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

    it('invokes auto-promote callback when stream fallback succeeds', async () => {
      const onAutoPromoteToObsidian = jest.fn()
      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        createBrowserStream: async () => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new TypeError('Failed to fetch')
              },
            }
          },
        }),
        createObsidianStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'ok'
          },
        }),
        onAutoPromoteToObsidian,
      })

      await expect(collectStream(stream)).resolves.toEqual(['ok'])
      expect(onAutoPromoteToObsidian).toHaveBeenCalledTimes(1)
    })

    it('promotes immediately when browser stream creation fails', async () => {
      const onAutoPromoteToObsidian = jest.fn()
      const createObsidianStream = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'ok'
        },
      }))

      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        createBrowserStream: async () => {
          throw new TypeError('Failed to fetch')
        },
        createObsidianStream,
        onAutoPromoteToObsidian,
      })

      await expect(collectStream(stream)).resolves.toEqual(['ok'])
      expect(createObsidianStream).toHaveBeenCalledTimes(1)
      expect(onAutoPromoteToObsidian).toHaveBeenCalledTimes(1)
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
