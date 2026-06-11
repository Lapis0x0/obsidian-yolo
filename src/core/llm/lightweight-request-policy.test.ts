import { ChatModel } from '../../types/chat-model.types'

import {
  applyLightweightRequestPolicy,
  stripHeavyProviderFeatures,
  stripHostedToolOptions,
} from './lightweight-request-policy'

const baseModel: ChatModel = {
  providerId: 'openrouter',
  id: 'openrouter/google/gemini-3-flash-preview',
  model: 'google/gemini-3-flash-preview',
}

describe('lightweight request policy', () => {
  it('keeps reasoningType while clearing builtin tool configuration', () => {
    const stripped = stripHeavyProviderFeatures({
      ...baseModel,
      reasoningType: 'gemini',
      builtinToolProvider: 'openrouter',
      builtinTools: {
        openrouter: { webSearch: { enabled: true, engine: 'native' } },
      },
      web_search_options: { search_context_size: 'medium' },
    })

    expect(stripped.reasoningType).toBe('gemini')
    expect(stripped.builtinToolProvider).toBe('none')
    expect(stripped.builtinTools).toBeUndefined()
    expect(stripped.web_search_options).toBeUndefined()
  })

  it('drops customParameters that fall outside the lightweight allowlist', () => {
    const stripped = stripHeavyProviderFeatures({
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
    const stripped = stripHeavyProviderFeatures({
      ...baseModel,
      customParameters: allowed,
    })
    expect(stripped.customParameters).toEqual(allowed)
  })

  it('keeps unrelated model fields intact', () => {
    const stripped = stripHeavyProviderFeatures({
      ...baseModel,
      temperature: 0.3,
      maxOutputTokens: 256,
    })
    expect(stripped.temperature).toBe(0.3)
    expect(stripped.maxOutputTokens).toBe(256)
  })

  it('returns an empty customParameters list when input is undefined', () => {
    const stripped = stripHeavyProviderFeatures(baseModel)
    expect(stripped.customParameters).toEqual([])
  })

  it('clears call-level hosted tool options', () => {
    expect(
      stripHostedToolOptions({
        signal: new AbortController().signal,
        debugTraceId: 'trace-1',
        geminiTools: { useWebSearch: true, useUrlContext: true },
      }),
    ).toMatchObject({
      debugTraceId: 'trace-1',
      geminiTools: undefined,
    })
  })

  it('applies model and call-level lightweight policy together', () => {
    const result = applyLightweightRequestPolicy({
      model: {
        ...baseModel,
        reasoningType: 'openai',
        builtinToolProvider: 'gpt',
        builtinTools: { gpt: { webSearch: { enabled: true } } },
      },
      options: { geminiTools: { useWebSearch: true } },
    })

    expect(result.model.reasoningType).toBe('openai')
    expect(result.model.builtinToolProvider).toBe('none')
    expect(result.options.geminiTools).toBeUndefined()
  })
})
