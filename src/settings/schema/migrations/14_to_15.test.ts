import { DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT } from '../setting.types'

import { migrateFrom14To15 } from './14_to_15'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

describe('migrateFrom14To15', () => {
  it('should add defaults when options missing', () => {
    const result = migrateFrom14To15({
      version: 14,
      continuationOptions: {},
    })

    expect(result.version).toBe(15)
    const continuationOptions = result.continuationOptions
    if (!isRecord(continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    expect(tabOptions).toMatchObject({
      maxTokens: 64,
      maxSuggestionLength: 2000,
    })
    const systemPrompt = continuationOptions.tabCompletionSystemPrompt
    if (typeof systemPrompt !== 'string') {
      throw new Error('Expected tabCompletionSystemPrompt to be a string')
    }
    expect(systemPrompt).toBe(DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT)
  })

  it('should preserve existing values', () => {
    const result = migrateFrom14To15({
      version: 14,
      continuationOptions: {
        tabCompletionOptions: {
          maxTokens: 120,
        },
        tabCompletionSystemPrompt: 'Custom prompt',
      },
    })

    expect(result.version).toBe(15)
    const continuationOptions = result.continuationOptions
    if (!isRecord(continuationOptions)) {
      throw new Error('Expected continuationOptions to be an object')
    }
    const tabOptions = continuationOptions.tabCompletionOptions
    if (!isRecord(tabOptions)) {
      throw new Error('Expected tabCompletionOptions to be an object')
    }
    const maxTokens = tabOptions.maxTokens
    if (typeof maxTokens !== 'number') {
      throw new Error('Expected maxTokens to be a number')
    }
    expect(maxTokens).toBe(120)
    const systemPrompt = continuationOptions.tabCompletionSystemPrompt
    if (typeof systemPrompt !== 'string') {
      throw new Error('Expected tabCompletionSystemPrompt to be a string')
    }
    expect(systemPrompt).toBe('Custom prompt')
  })
})
