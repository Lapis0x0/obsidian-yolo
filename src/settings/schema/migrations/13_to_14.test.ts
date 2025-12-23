import { migrateFrom13To14 } from './13_to_14'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('migrateFrom13To14', () => {
  it('should populate default tab completion options when missing', () => {
    const result = migrateFrom13To14({
      version: 13,
      continuationOptions: {},
    })

    expect(result.version).toBe(14)
    expect(result.continuationOptions).toHaveProperty('tabCompletionOptions')
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = result.continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    expect(tabOptions).toMatchObject({
      triggerDelayMs: 3000,
      minContextLength: 20,
      maxBeforeChars: 3000,
      maxAfterChars: 1000,
      maxSuggestionLength: 240,
      temperature: 0.5,
      requestTimeoutMs: 12000,
      maxRetries: 0,
    })
  })

  it('should normalize existing tab completion options', () => {
    const result = migrateFrom13To14({
      version: 13,
      continuationOptions: {
        tabCompletionOptions: {
          triggerDelayMs: '5000',
          minContextLength: '5',
          maxContextChars: 8000,
          maxSuggestionLength: '600',
          temperature: '0.8',
          requestTimeoutMs: '20000',
          maxRetries: '3',
        },
      },
    })

    expect(result.version).toBe(14)
    if (!isRecord(result.continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = result.continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    expect(tabOptions).toMatchObject({
      triggerDelayMs: 5000,
      minContextLength: 5,
      maxBeforeChars: 8000,
      maxAfterChars: 1000,
      maxSuggestionLength: 600,
      temperature: 0.8,
      requestTimeoutMs: 20000,
      maxRetries: 3,
    })
  })
})
