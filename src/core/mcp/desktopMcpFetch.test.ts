import { Platform } from 'obsidian'

jest.mock('obsidian', () => ({
  Platform: { isDesktop: true },
}))

import { createDesktopMcpFetch } from './desktopMcpFetch'

describe('desktopMcpFetch', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: jest.Mock

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = jest.fn(async () => new Response('ok'))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    ;(Platform as { isDesktop: boolean }).isDesktop = true
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('throws on non-desktop without calling globalThis.fetch', async () => {
    ;(Platform as { isDesktop: boolean }).isDesktop = false
    const fn = createDesktopMcpFetch({ env: {} })
    await expect(fn('https://example.com')).rejects.toThrow(/desktop/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards calls to globalThis.fetch on desktop', async () => {
    const fn = createDesktopMcpFetch({ env: {} })
    const res = await fn('https://example.com', { method: 'POST' })
    expect(res).toBeInstanceOf(Response)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://example.com', {
      method: 'POST',
    })
  })

  it('warns exactly once across multiple constructions when env proxy is set', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      createDesktopMcpFetch({
        env: { HTTP_PROXY: 'http://shell-only.local:8080' },
      })
      // Second construction with another env-proxy must NOT warn again,
      // since the warning is module-singleton.
      createDesktopMcpFetch({
        env: { HTTPS_PROXY: 'http://shell-only2.local:8080' },
      })
      const calls = warnSpy.mock.calls.filter((c) =>
        String(c[0] ?? '').includes('Chromium fetch'),
      )
      expect(calls).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
