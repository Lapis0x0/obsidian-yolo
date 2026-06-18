import { migrateFrom71To72 } from './71_to_72'

describe('migrateFrom71To72', () => {
  it('bumps version and defaults ragOptions.excludeYoloBaseDir to true', () => {
    const result = migrateFrom71To72({ version: 71 })

    expect(result.version).toBe(72)
    expect(
      (result.ragOptions as { excludeYoloBaseDir?: boolean })
        .excludeYoloBaseDir,
    ).toBe(true)
  })

  it('preserves an explicit false value', () => {
    const result = migrateFrom71To72({
      version: 71,
      ragOptions: { excludeYoloBaseDir: false },
    })

    expect(
      (result.ragOptions as { excludeYoloBaseDir?: boolean })
        .excludeYoloBaseDir,
    ).toBe(false)
  })

  it('preserves other ragOptions fields while seeding the flag', () => {
    const result = migrateFrom71To72({
      version: 71,
      ragOptions: { chunkSize: 2000, excludePatterns: ['notes/**'] },
    })

    const ragOptions = result.ragOptions as Record<string, unknown>
    expect(ragOptions.chunkSize).toBe(2000)
    expect(ragOptions.excludePatterns).toEqual(['notes/**'])
    expect(ragOptions.excludeYoloBaseDir).toBe(true)
  })

  it('seeds the flag when ragOptions is missing entirely', () => {
    const result = migrateFrom71To72({ version: 71 })

    expect(
      (result.ragOptions as { excludeYoloBaseDir?: boolean })
        .excludeYoloBaseDir,
    ).toBe(true)
  })
})
