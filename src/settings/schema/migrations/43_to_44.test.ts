import { migrateFrom43To44 } from './43_to_44'

describe('migrateFrom43To44', () => {
  it('migrates the legacy 24-hour auto update interval to 0', () => {
    const result = migrateFrom43To44({
      version: 43,
      ragOptions: {
        autoUpdateIntervalHours: 24,
      },
    })

    expect(result.version).toBe(44)
    expect(
      (result.ragOptions as { autoUpdateIntervalHours: number })
        .autoUpdateIntervalHours,
    ).toBe(0)
  })

  it('preserves custom auto update interval values', () => {
    const result = migrateFrom43To44({
      version: 43,
      ragOptions: {
        autoUpdateIntervalHours: 6,
      },
    })

    expect(
      (result.ragOptions as { autoUpdateIntervalHours: number })
        .autoUpdateIntervalHours,
    ).toBe(6)
  })
})
