import { ChatModel } from '../../types/chat-model.types'

import { hasHostedWebSearch } from './model-tools'

const model = (enabled: boolean): ChatModel => ({
  providerId: 'DeepSeek',
  id: 'deepseek/deepseek-v4-flash',
  model: 'deepseek-v4-flash',
  builtinToolProvider: enabled ? 'deepseek' : 'none',
  builtinTools: { deepseek: { webSearch: { enabled } } },
})

describe('hasHostedWebSearch', () => {
  it('is on for the transports DeepSeek actually serves it on', () => {
    expect(hasHostedWebSearch(model(true), 'anthropic')).toBe(true)
    expect(hasHostedWebSearch(model(true), 'openai-responses')).toBe(true)
  })

  it('is off on chat/completions even with the toggle left on', () => {
    // Suppressing our own web search here would leave the model with none:
    // DeepSeek rejects hosted tool types on this transport.
    expect(hasHostedWebSearch(model(true), 'openai-compatible')).toBe(false)
    expect(hasHostedWebSearch(model(true), undefined)).toBe(false)
  })

  it('is off when the toggle is off', () => {
    expect(hasHostedWebSearch(model(false), 'anthropic')).toBe(false)
  })
})
