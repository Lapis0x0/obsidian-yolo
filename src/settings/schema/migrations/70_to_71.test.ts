import { migrateFrom70To71 } from './70_to_71'

describe('migrateFrom70To71', () => {
  it('bumps version and defaults pluginUpdateAutoDownloadEnabled to true', () => {
    const result = migrateFrom70To71({ version: 70 })

    expect(result.version).toBe(71)
    expect(result.pluginUpdateAutoDownloadEnabled).toBe(true)
  })

  it('preserves an explicit false value', () => {
    const result = migrateFrom70To71({
      version: 70,
      pluginUpdateAutoDownloadEnabled: false,
    })

    expect(result.pluginUpdateAutoDownloadEnabled).toBe(false)
  })
})
