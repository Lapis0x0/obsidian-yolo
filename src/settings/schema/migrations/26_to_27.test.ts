import { migrateFrom26To27 } from './26_to_27'

describe('Migrate from version 26 to 27', () => {
  it('should add default quick ask context values when missing', () => {
    const result = migrateFrom26To27({ version: 26 })
    expect(result.version).toBe(27)
    expect(result).toMatchObject({
      continuationOptions: {
        quickAskContextBeforeChars: 5000,
        quickAskContextAfterChars: 2000,
      },
    })
  })

  it('should keep existing quick ask context values', () => {
    const result = migrateFrom26To27({
      version: 26,
      continuationOptions: {
        quickAskContextBeforeChars: 1234,
        quickAskContextAfterChars: 4321,
      },
    })
    expect(result.version).toBe(27)
    expect(result.continuationOptions).toMatchObject({
      quickAskContextBeforeChars: 1234,
      quickAskContextAfterChars: 4321,
    })
  })
})
