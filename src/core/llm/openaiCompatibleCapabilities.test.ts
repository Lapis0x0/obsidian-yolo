import {
  applyOpenAICompatibleCapabilities,
  resolveOpenAICompatibleHostCapabilities,
} from './openaiCompatibleCapabilities'

describe('openaiCompatibleCapabilities', () => {
  it('applies dashscope thinking fields', () => {
    const request: Record<string, unknown> = {}

    applyOpenAICompatibleCapabilities({
      request,
      reasoningType: 'gemini',
      reasoningLevel: 'low',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })

    expect(request.enable_thinking).toBe(true)
    expect(request.thinking_budget).toBe(4096)
  })

  it('applies volcengine-style thinking fields', () => {
    const request: Record<string, unknown> = {}

    applyOpenAICompatibleCapabilities({
      request,
      reasoningType: 'gemini',
      reasoningLevel: 'medium',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    })

    expect(request.thinking).toEqual({ type: 'enabled' })
  })

  it('keeps default openai-compatible thinking fields for gemini family', () => {
    const request: Record<string, unknown> = {}

    applyOpenAICompatibleCapabilities({
      request,
      reasoningType: 'gemini',
      reasoningLevel: 'medium',
      baseUrl: 'https://example-proxy.ai/v1',
    })

    expect(request.thinking_config).toEqual({
      thinking_budget: 8192,
      include_thoughts: true,
    })
  })

  it('applies OpenAI-style reasoning effort on generic proxy', () => {
    const request: Record<string, unknown> = {}

    applyOpenAICompatibleCapabilities({
      request,
      reasoningType: 'openai',
      reasoningLevel: 'high',
      baseUrl: 'https://example-proxy.ai/v1',
    })

    expect(request.reasoning_effort).toBe('high')
    expect(request.reasoning).toEqual({ effort: 'high' })
  })

  it('disables stream options for mistral host', () => {
    const capabilities = resolveOpenAICompatibleHostCapabilities(
      'https://api.mistral.ai/v1',
    )

    expect(capabilities.disableStreamOptions).toBe(true)
  })

  it('skips reasoning fields for mistral host', () => {
    const request: Record<string, unknown> = { stream_options: { include_usage: true } }

    applyOpenAICompatibleCapabilities({
      request,
      reasoningType: 'openai',
      reasoningLevel: 'high',
      baseUrl: 'https://api.mistral.ai/v1',
    })

    expect(request.stream_options).toBeUndefined()
    expect(request.reasoning_effort).toBeUndefined()
  })
})
