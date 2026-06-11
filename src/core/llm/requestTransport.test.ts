import { Platform } from 'obsidian'

import {
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
    ;(Platform as { isDesktop: boolean }).isDesktop = true
  })

  describe('resolveRequestTransportMode', () => {
    it('uses the current platform value from per-platform settings', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: {
            requestTransportMode: {
              desktop: 'node',
              mobile: 'browser',
            },
          },
          hasCustomBaseUrl: false,
        }),
      ).toBe('node')
      ;(Platform as { isDesktop: boolean }).isDesktop = false

      expect(
        resolveRequestTransportMode({
          additionalSettings: {
            requestTransportMode: {
              desktop: 'node',
              mobile: 'browser',
            },
          },
          hasCustomBaseUrl: false,
        }),
      ).toBe('browser')
    })

    it('maps legacy string values without cross-platform node leakage', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: {
            requestTransportMode: 'node',
          },
          hasCustomBaseUrl: true,
        }),
      ).toBe('node')
      ;(Platform as { isDesktop: boolean }).isDesktop = false

      expect(
        resolveRequestTransportMode({
          additionalSettings: {
            requestTransportMode: 'node',
          },
          hasCustomBaseUrl: true,
        }),
      ).toBe('browser')
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

    it('defaults to node on desktop and browser on mobile', () => {
      expect(
        resolveRequestTransportMode({
          additionalSettings: undefined,
          hasCustomBaseUrl: true,
        }),
      ).toBe('node')
      ;(Platform as { isDesktop: boolean }).isDesktop = false

      expect(
        resolveRequestTransportMode({
          additionalSettings: undefined,
          hasCustomBaseUrl: true,
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

    it('does not fall back when the selected path fails', async () => {
      const browser = jest
        .fn<Promise<string>, []>()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      const obsidian = jest.fn(async () => 'obsidian')

      await expect(
        runWithRequestTransport({
          mode: 'browser',
          runBrowser: browser,
          runObsidian: obsidian,
        }),
      ).rejects.toThrow('Failed to fetch')

      expect(browser).toHaveBeenCalledTimes(1)
      expect(obsidian).not.toHaveBeenCalled()
    })

    it('uses node path in node mode', async () => {
      const browser = jest.fn(async () => 'browser')
      const node = jest.fn(async () => 'node')
      const obsidian = jest.fn(async () => 'obsidian')
      await expect(
        runWithRequestTransport({
          mode: 'node',
          runBrowser: browser,
          runNode: node,
          runObsidian: obsidian,
        }),
      ).resolves.toBe('node')
      expect(node).toHaveBeenCalledTimes(1)
      expect(browser).not.toHaveBeenCalled()
      expect(obsidian).not.toHaveBeenCalled()
    })
  })

  describe('runWithRequestTransportForStream', () => {
    it('uses the selected browser stream without fallback', async () => {
      const browserStream = (async function* () {
        yield 'a'
        yield 'b'
      })()
      const createBrowserStream = jest.fn(async () => browserStream)
      const createObsidianStream = jest.fn(async () =>
        (async function* () {
          yield 'obsidian'
        })(),
      )

      const stream = await runWithRequestTransportForStream({
        mode: 'browser',
        createBrowserStream,
        createObsidianStream,
      })

      await expect(collectStream(stream)).resolves.toEqual(['a', 'b'])
      expect(createBrowserStream).toHaveBeenCalledTimes(1)
      expect(createObsidianStream).not.toHaveBeenCalled()
    })

    it('adds a mobile suggestion when browser streaming fails', async () => {
      ;(Platform as { isDesktop: boolean }).isDesktop = false

      const createBrowserStream = jest.fn(async () =>
        (async function* () {
          throw new Error('stream failed')
          yield 'unreachable'
        })(),
      )
      const createObsidianStream = jest.fn(async () =>
        (async function* () {
          yield 'obsidian'
        })(),
      )

      const stream = await runWithRequestTransportForStream({
        mode: 'browser',
        createBrowserStream,
        createObsidianStream,
      })

      await expect(collectStream(stream)).rejects.toThrow(
        'Obsidian built-in request',
      )
      expect(createObsidianStream).not.toHaveBeenCalled()
    })
  })
})
