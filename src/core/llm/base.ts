import { ChatModel } from '../../types/chat-model.types'
import {
  LLMOptions,
  LLMRequestNonStreaming,
  LLMRequestStreaming,
} from '../../types/llm/request'
import {
  LLMResponseNonStreaming,
  LLMResponseStreaming,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'

// TODO: do these really have to be class? why not just function?
export abstract class BaseLLMProvider<P extends LLMProvider> {
  protected readonly provider: P
  constructor(provider: P) {
    this.provider = provider
  }

  abstract generateResponse(
    model: ChatModel,
    request: LLMRequestNonStreaming,
    options?: LLMOptions,
  ): Promise<LLMResponseNonStreaming>

  abstract streamResponse(
    model: ChatModel,
    request: LLMRequestStreaming,
    options?: LLMOptions,
  ): Promise<AsyncIterable<LLMResponseStreaming>>

  abstract getEmbedding(model: string, text: string): Promise<number[]>

  protected applyCustomModelParameters<T extends Record<string, unknown>>(
    model: ChatModel,
    request: T,
  ): T {
    const entries = Array.isArray(model.customParameters)
      ? model.customParameters
      : []

    if (entries.length === 0) {
      return request
    }

    const next: Record<string, unknown> = { ...request }
    for (const entry of entries) {
      const key = typeof entry?.key === 'string' ? entry.key.trim() : ''
      if (!key) continue
      const rawValue = typeof entry?.value === 'string' ? entry.value : ''
      if (rawValue.trim().length === 0) {
        continue
      }
      next[key] = parseCustomParameterValue(rawValue)
    }
    return next as T
  }
}

function parseCustomParameterValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return raw
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}
