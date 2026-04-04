import { ChatModel } from '../../types/chat-model.types'

import {
  applyKnownMaxContextTokensToChatModels,
  normalizeModelContextLookupKey,
  resolveKnownMaxContextTokens,
} from './model-context-registry'

describe('model-context-registry', () => {
  it('normalizes provider-prefixed model ids', () => {
    expect(normalizeModelContextLookupKey('openai/gpt-4.1')).toBe('gpt-4.1')
    expect(normalizeModelContextLookupKey('models/gemini-2.5-pro')).toBe(
      'gemini-2.5-pro',
    )
    expect(normalizeModelContextLookupKey('claude-sonnet-4.0')).toBe(
      'claude-sonnet-4.0',
    )
  })

  it('resolves known max context tokens for separator variants', () => {
    expect(resolveKnownMaxContextTokens('anthropic/claude-sonnet-4.0')).toBe(
      200000,
    )
    expect(resolveKnownMaxContextTokens('gemini-2.5-flash')).toBe(1048576)
    expect(resolveKnownMaxContextTokens('openrouter/grok-4-fast')).toBe(2000000)
  })

  it('fills missing values without overwriting existing ones', () => {
    const models: ChatModel[] = [
      {
        providerId: 'openai',
        id: 'openai/gpt-4.1',
        model: 'gpt-4.1',
      },
      {
        providerId: 'openai',
        id: 'openai/gpt-4o',
        model: 'gpt-4o',
        maxContextTokens: 999999,
      },
    ]

    const result = applyKnownMaxContextTokensToChatModels(models)

    expect(result.changed).toBe(true)
    expect(result.chatModels[0].maxContextTokens).toBe(1047576)
    expect(result.chatModels[1].maxContextTokens).toBe(999999)
  })
})
