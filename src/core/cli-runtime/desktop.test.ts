import { Platform } from 'obsidian'

import { assertCliRuntimeAvailable, isCliRuntimeAvailable } from './desktop'

describe('CLI runtime desktop gate', () => {
  const originalIsDesktop = Platform.isDesktop

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('rejects provider initialization on mobile', () => {
    Platform.isDesktop = false

    expect(isCliRuntimeAvailable()).toBe(false)
    expect(() => assertCliRuntimeAvailable('codex')).toThrow(
      /only available on desktop/,
    )
  })

  it('allows provider initialization on desktop', () => {
    Platform.isDesktop = true

    expect(isCliRuntimeAvailable()).toBe(true)
    expect(() => assertCliRuntimeAvailable('claude-code')).not.toThrow()
  })
})
