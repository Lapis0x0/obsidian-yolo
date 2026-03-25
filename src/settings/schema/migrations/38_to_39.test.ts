import { migrateFrom38To39 } from './38_to_39'

describe('migrateFrom38To39', () => {
  it('moves applyModelId to chatTitleModelId', () => {
    const result = migrateFrom38To39({
      version: 38,
      chatModelId: 'openai/gpt-5',
      applyModelId: 'openai/gpt-4.1-mini',
    })

    expect(result.version).toBe(39)
    expect(result.chatTitleModelId).toBe('openai/gpt-4.1-mini')
    expect('applyModelId' in result).toBe(false)
  })

  it('keeps existing chatTitleModelId when both fields are present', () => {
    const result = migrateFrom38To39({
      version: 38,
      applyModelId: 'openai/gpt-4.1-mini',
      chatTitleModelId: 'anthropic/claude-sonnet-4.0',
    })

    expect(result.chatTitleModelId).toBe('anthropic/claude-sonnet-4.0')
    expect('applyModelId' in result).toBe(false)
  })
})
