import { migrateFrom17To18 } from './17_to_18'

// Legacy defaults for test (before schema v19 changes)
const LEGACY_MAX_AFTER_CHARS = 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('migrateFrom17To18', () => {
  it('should map legacy maxContextChars to maxBeforeChars', () => {
    const result = migrateFrom17To18({
      version: 17,
      continuationOptions: {
        tabCompletionOptions: {
          maxContextChars: 8000,
        },
      },
    })

    expect(result.version).toBe(18)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = result.continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    expect(tabOptions).toMatchObject({
      maxBeforeChars: 8000,
      maxAfterChars: LEGACY_MAX_AFTER_CHARS,
    })
  })

  it('should preserve explicit maxBeforeChars and maxAfterChars', () => {
    const result = migrateFrom17To18({
      version: 17,
      continuationOptions: {
        tabCompletionOptions: {
          maxBeforeChars: 5000,
          maxAfterChars: 1200,
        },
      },
    })

    expect(result.version).toBe(18)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = result.continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    expect(tabOptions).toMatchObject({
      maxBeforeChars: 5000,
      maxAfterChars: 1200,
    })
  })
})
