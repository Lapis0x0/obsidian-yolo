import { ChatModel } from '../../types/chat-model.types'

import { stripProviderFeatures } from './strip-provider-features'

const baseModel: ChatModel = {
  providerId: 'openrouter',
  id: 'openrouter/google/gemini-3-flash-preview',
  model: 'google/gemini-3-flash-preview',
}

describe('stripProviderFeatures', () => {
  it('forces reasoningType to none and clears builtin tool configuration', () => {
    const stripped = stripProviderFeatures({
      ...baseModel,
      reasoningType: 'gemini',
      builtinToolProvider: 'openrouter',
      builtinTools: {
        openrouter: { webSearch: { enabled: true, engine: 'native' } },
      },
      web_search_options: { search_context_size: 'medium' },
    })

    expect(stripped.reasoningType).toBe('none')
    expect(stripped.builtinToolProvider).toBe('none')
    expect(stripped.builtinTools).toBeUndefined()
    expect(stripped.web_search_options).toBeUndefined()
  })

  it('can preserve the reasoning adapter while clearing hosted tools', () => {
    const stripped = stripProviderFeatures(
      {
        ...baseModel,
        reasoningType: 'gemini',
        builtinToolProvider: 'openrouter',
        builtinTools: {
          openrouter: { webSearch: { enabled: true, engine: 'native' } },
        },
        customParameters: [
          { key: 'thinkingConfig', value: '{"thinkingBudget":4096}' },
        ],
      },
      { preserveReasoning: true },
    )

    expect(stripped.reasoningType).toBe('gemini')
    expect(stripped.builtinToolProvider).toBe('none')
    expect(stripped.builtinTools).toBeUndefined()
    expect(stripped.customParameters).toEqual([])
  })

  it('drops customParameters that fall outside the lightweight allowlist', () => {
    const stripped = stripProviderFeatures({
      ...baseModel,
      customParameters: [
        // hosted tools / search re-injection
        { key: 'tools', value: '[{"type":"openrouter:web_search"}]' },
        { key: 'tool_choice', value: '"auto"' },
        { key: 'plugins', value: '[{"id":"web"}]' },
        { key: 'search_parameters', value: '{"mode":"auto"}' },
        { key: 'web_search_options', value: '{"search_context_size":"low"}' },
        // reasoning families
        { key: 'reasoning', value: '{"enabled":true}' },
        { key: 'reasoning_effort', value: '"high"' },
        { key: 'thinking', value: '{"type":"enabled"}' },
        { key: 'enable_thinking', value: 'true' },
        { key: 'thinking_budget', value: '4096' },
        { key: 'thinkingConfig', value: '{"thinkingBudget":4096}' },
        // gemini-native container fields that would smuggle features in
        { key: 'extra_body', value: '{"tools":[{"type":"web_search"}]}' },
        { key: 'config', value: '{"tools":[{"googleSearch":{}}]}' },
        { key: 'generationConfig', value: '{"thinkingConfig":{}}' },
      ],
    })

    expect(stripped.customParameters).toEqual([])
  })

  it('preserves common sampling / output-shape parameters', () => {
    const allowed = [
      { key: 'temperature', value: '0.3' },
      { key: 'top_p', value: '0.9' },
      { key: 'top_k', value: '40' },
      { key: 'max_tokens', value: '256' },
      { key: 'max_output_tokens', value: '256' },
      { key: 'frequency_penalty', value: '0' },
      { key: 'presence_penalty', value: '0' },
      { key: 'stop', value: '["\\n"]' },
      { key: 'seed', value: '42' },
      { key: 'response_format', value: '{"type":"text"}' },
    ]
    const stripped = stripProviderFeatures({
      ...baseModel,
      customParameters: allowed,
    })
    expect(stripped.customParameters).toEqual(allowed)
  })

  it('keeps unrelated model fields intact', () => {
    const stripped = stripProviderFeatures({
      ...baseModel,
      temperature: 0.3,
      maxOutputTokens: 256,
    })
    expect(stripped.temperature).toBe(0.3)
    expect(stripped.maxOutputTokens).toBe(256)
  })

  it('returns an empty customParameters list when input is undefined', () => {
    const stripped = stripProviderFeatures(baseModel)
    expect(stripped.customParameters).toEqual([])
  })
})
