import { ChatModel } from '../../types/chat-model.types'

import {
  applyOpenAICompatibleCapabilities,
  resolveOpenAICompatibleHostCapabilities,
} from './openaiCompatibleCapabilities'

const baseModel: Extract<ChatModel, { providerType: 'openai-compatible' }> = {
  providerType: 'openai-compatible',
  providerId: 'provider-1',
  id: 'model-1',
  model: 'test-model',
  thinking: {
    enabled: true,
    thinking_budget: 256,
  },
  reasoning: {
    enabled: true,
    reasoning_effort: 'medium',
  },
}

describe('openaiCompatibleCapabilities', () => {
  it('applies dashscope thinking fields', () => {
    const request: Record<string, unknown> = {}

    applyOpenAICompatibleCapabilities({
      request,
      model: baseModel,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })

    expect(request.enable_thinking).toBe(true)
    expect(request.thinking_budget).toBe(256)
  })

  it('applies volcengine-style thinking fields', () => {
    const request: Record<string, unknown> = {}

    applyOpenAICompatibleCapabilities({
      request,
      model: baseModel,
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    })

    expect(request.thinking).toEqual({ type: 'enabled' })
  })

  it('keeps default openai-compatible thinking fields', () => {
    const request: Record<string, unknown> = {}

    applyOpenAICompatibleCapabilities({
      request,
      model: baseModel,
      baseUrl: 'https://example-proxy.ai/v1',
    })

    expect(request.thinking_config).toEqual({
      thinking_budget: 256,
      include_thoughts: true,
    })
    expect(request.reasoning_effort).toBe('medium')
  })

  it('disables stream options for mistral host', () => {
    const capabilities = resolveOpenAICompatibleHostCapabilities(
      'https://api.mistral.ai/v1',
    )

    expect(capabilities.disableStreamOptions).toBe(true)
  })
})
