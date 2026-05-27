import { Platform } from 'obsidian'

import {
  clearRequestTransportMemoryForTests,
  createRequestTransportMemoryKey,
  resolveRequestTransportMode,
  runWithRequestTransport,
  runWithRequestTransportForStream,
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
    ;(Platform as { isDesktop: boolean }).isDesktop = true
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

    it('accepts explicit node transport mode', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: {
            requestTransportMode: 'node',
          },
          hasCustomBaseUrl: true,
        }),
      ).toBe('node')
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

    it('remembers browser mode when auto falls back from node to browser', async () => {
      const memoryKey = createRequestTransportMemoryKey({
        providerType: 'openai-compatible',
        providerId: 'p1',
        baseUrl: 'https://example.com/v1',
      })

      await runWithRequestTransport({
        mode: 'auto',
        memoryKey,
        runBrowser: async () => 'browser-ok',
        runNode: async () => {
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
      ).toBe('browser')
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

    it('uses node primary in auto mode without invoking browser or obsidian', async () => {
      const browser = jest.fn(async () => 'browser')
      const node = jest.fn(async () => 'node')
      const obsidian = jest.fn(async () => 'obsidian')
      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: browser,
          runNode: node,
          runObsidian: obsidian,
        }),
      ).resolves.toBe('node')
      expect(node).toHaveBeenCalledTimes(1)
      expect(browser).not.toHaveBeenCalled()
      expect(obsidian).not.toHaveBeenCalled()
    })

    it('falls back from node to browser on CORS-like errors in auto mode', async () => {
      const browser = jest.fn(async () => 'browser')
      const node = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      const obsidian = jest.fn(async () => 'obsidian')
      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: browser,
          runNode: node,
          runObsidian: obsidian,
        }),
      ).resolves.toBe('browser')
      expect(node).toHaveBeenCalledTimes(1)
      expect(browser).toHaveBeenCalledTimes(1)
      expect(obsidian).not.toHaveBeenCalled()
    })

    it('throws browser error when both node and browser fail with CORS on desktop', async () => {
      const browserError = new TypeError('Failed to fetch')
      const obsidian = jest.fn(async () => 'obsidian')

      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: async () => {
            throw browserError
          },
          runNode: async () => {
            throw new TypeError('Failed to fetch')
          },
          runObsidian: obsidian,
        }),
      ).rejects.toBe(browserError)

      expect(obsidian).not.toHaveBeenCalled()
    })

    it('throws node error in auto mode when error is not CORS-retryable', async () => {
      const nodeError = new Error('401 unauthorized')
      const browser = jest.fn(async () => 'browser')
      const obsidian = jest.fn(async () => 'obsidian')

      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: browser,
          runNode: async () => {
            throw nodeError
          },
          runObsidian: obsidian,
        }),
      ).rejects.toBe(nodeError)

      expect(browser).not.toHaveBeenCalled()
      expect(obsidian).not.toHaveBeenCalled()
    })

    it('falls back to obsidian on mobile even when runNode is provided', async () => {
      ;(Platform as { isDesktop: boolean }).isDesktop = false
      const obsidian = jest.fn(async () => 'obsidian')
      const node = jest.fn(async () => 'node')

      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: async () => {
            throw new TypeError('Failed to fetch')
          },
          runNode: node,
          runObsidian: obsidian,
        }),
      ).resolves.toBe('obsidian')

      expect(node).not.toHaveBeenCalled()
      expect(obsidian).toHaveBeenCalledTimes(1)
    })

    it('falls back to obsidian on non-desktop (no runNode provided)', async () => {
      const obsidian = jest.fn(async () => 'obsidian')

      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: async () => {
            throw new TypeError('Failed to fetch')
          },
          runObsidian: obsidian,
        }),
      ).resolves.toBe('obsidian')

      expect(obsidian).toHaveBeenCalledTimes(1)
    })

    it('uses node path in node mode', async () => {
      const browser = jest.fn(async () => 'browser')
      const obsidian = jest.fn(async () => 'obsidian')
      const node = jest.fn(async () => 'node')

      await expect(
        runWithRequestTransport({
          mode: 'node',
          runBrowser: browser,
          runObsidian: obsidian,
          runNode: node,
        }),
      ).resolves.toBe('node')
      expect(browser).not.toHaveBeenCalled()
      expect(obsidian).not.toHaveBeenCalled()
      expect(node).toHaveBeenCalledTimes(1)
    })

    it('invokes auto-promote callback when fallback succeeds', async () => {
      const onAutoPromoteTransportMode = jest.fn()

      await expect(
        runWithRequestTransport({
          mode: 'auto',
          runBrowser: async () => 'browser-ok',
          runNode: async () => {
            throw new TypeError('Failed to fetch')
          },
          runObsidian: async () => 'ok',
          onAutoPromoteTransportMode,
        }),
      ).resolves.toBe('browser-ok')

      expect(onAutoPromoteTransportMode).toHaveBeenCalledWith('browser')
    })
  })

  describe('runWithRequestTransportForStream', () => {
    it('falls back to browser stream when node stream fails before first chunk', async () => {
      const browser = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'browser-chunk'
        },
      }))
      const node = jest.fn(async () => ({
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
        createNodeStream: node,
        createObsidianStream: obsidian,
      })

      await expect(collectStream(stream)).resolves.toEqual(['browser-chunk'])
      expect(node).toHaveBeenCalledTimes(1)
      expect(browser).toHaveBeenCalledTimes(1)
      expect(obsidian).not.toHaveBeenCalled()
    })

    it('falls back to browser stream when node stream creation times out', async () => {
      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        firstChunkTimeoutMs: 10,
        createNodeStream: async () =>
          await new Promise<AsyncIterable<string>>(() => {}),
        createBrowserStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'browser-timeout-fallback'
          },
        }),
        createObsidianStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'obsidian-should-not-run'
          },
        }),
      })

      await expect(collectStream(stream)).resolves.toEqual([
        'browser-timeout-fallback',
      ])
    })

    it('falls back to browser stream when node first chunk times out', async () => {
      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        firstChunkTimeoutMs: 10,
        createNodeStream: async () => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () =>
                await new Promise<IteratorResult<string>>(() => {}),
            }
          },
        }),
        createBrowserStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'browser-first-chunk-fallback'
          },
        }),
        createObsidianStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'obsidian-should-not-run'
          },
        }),
      })

      await expect(collectStream(stream)).resolves.toEqual([
        'browser-first-chunk-fallback',
      ])
    })

    it('uses node stream in node mode', async () => {
      const stream = await runWithRequestTransportForStream({
        mode: 'node',
        createBrowserStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'browser'
          },
        }),
        createObsidianStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'obsidian'
          },
        }),
        createNodeStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'node'
          },
        }),
      })

      await expect(collectStream(stream)).resolves.toEqual(['node'])
    })

    it('invokes auto-promote callback when stream fallback succeeds', async () => {
      const onAutoPromoteTransportMode = jest.fn()
      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        createNodeStream: async () => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new TypeError('Failed to fetch')
              },
            }
          },
        }),
        createBrowserStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'browser-ok'
          },
        }),
        createObsidianStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'ok'
          },
        }),
        onAutoPromoteTransportMode,
      })

      await expect(collectStream(stream)).resolves.toEqual(['browser-ok'])
      expect(onAutoPromoteTransportMode).toHaveBeenCalledWith('browser')
    })

    it('throws browser error when both node and browser streams fail with CORS on desktop', async () => {
      const browserError = new TypeError('Failed to fetch from browser')
      const createObsidianStream = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'obsidian-ok'
        },
      }))

      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        createBrowserStream: async () => {
          throw browserError
        },
        createNodeStream: async () => {
          throw new TypeError('Failed to fetch from node')
        },
        createObsidianStream,
      })

      await expect(collectStream(stream)).rejects.toBe(browserError)
      expect(createObsidianStream).not.toHaveBeenCalled()
    })

    it('falls back to obsidian stream on mobile even when createNodeStream is provided', async () => {
      ;(Platform as { isDesktop: boolean }).isDesktop = false
      const createObsidianStream = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'obsidian-mobile'
        },
      }))
      const createNodeStream = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'node-should-not-run'
        },
      }))

      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        createBrowserStream: async () => {
          throw new TypeError('Failed to fetch')
        },
        createNodeStream,
        createObsidianStream,
      })

      await expect(collectStream(stream)).resolves.toEqual(['obsidian-mobile'])
      expect(createNodeStream).not.toHaveBeenCalled()
      expect(createObsidianStream).toHaveBeenCalledTimes(1)
    })

    it('falls back to obsidian stream on non-desktop (no createNodeStream provided)', async () => {
      const onAutoPromoteTransportMode = jest.fn()
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
        onAutoPromoteTransportMode,
      })

      await expect(collectStream(stream)).resolves.toEqual(['ok'])
      expect(createObsidianStream).toHaveBeenCalledTimes(1)
      expect(onAutoPromoteTransportMode).toHaveBeenCalledWith('obsidian')
    })

    it('does not fallback further after browser fallback stream already yielded chunks', async () => {
      const obsidian = jest.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'should-not-run'
        },
      }))
      const stream = await runWithRequestTransportForStream({
        mode: 'auto',
        createNodeStream: async () => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new TypeError('Failed to fetch')
              },
            }
          },
        }),
        createBrowserStream: async () => ({
          async *[Symbol.asyncIterator]() {
            yield 'browser-first'
            throw new TypeError('Failed to fetch')
          },
        }),
        createObsidianStream: obsidian,
      })

      const iterator = stream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: 'browser-first',
      })
      await expect(iterator.next()).rejects.toThrow('Failed to fetch')
      expect(obsidian).not.toHaveBeenCalled()
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
