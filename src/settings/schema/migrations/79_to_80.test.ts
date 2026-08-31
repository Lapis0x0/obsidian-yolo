import { migrateFrom79To80 } from './79_to_80'

describe('migrateFrom79To80', () => {
  it('bumps version and defaults pluginUpdateNoticeEnabled to true', () => {
    const result = migrateFrom79To80({ version: 79 })

    expect(result.version).toBe(80)
    expect(result.pluginUpdateNoticeEnabled).toBe(true)
  })

  it('preserves an explicit false value', () => {
    const result = migrateFrom79To80({
      version: 79,
      pluginUpdateNoticeEnabled: false,
    })

    expect(result.pluginUpdateNoticeEnabled).toBe(false)
  })
})
