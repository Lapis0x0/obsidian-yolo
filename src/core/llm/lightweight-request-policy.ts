import { ChatModel } from '../../types/chat-model.types'
import { LLMOptions } from '../../types/llm/request'

/**
 * Custom-parameter keys that are safe to keep on lightweight single-turn calls
 * (conversation title generation, tab completion, compaction summary). These
 * are generic sampling / output-shape knobs that cannot re-inject hosted tools,
 * reasoning, or search behavior.
 *
 * We use an allowlist because some providers merge customParameters directly
 * into the request payload, which means container fields like `config`,
 * `generationConfig`, or `thinkingConfig` could smuggle hosted features in.
 */
const LIGHTWEIGHT_ALLOWED_CUSTOM_PARAM_KEYS = new Set([
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'stop',
  'stop_sequences',
  'seed',
  'response_format',
  'n',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'user',
])

/**
 * Returns a ChatModel clone with heavyweight provider features stripped:
 * hosted/built-in tools, provider web-search options, and any custom-parameter
 * entries that fall outside the lightweight allowlist.
 *
 * Deliberately keeps `reasoningType` intact. Lightweight callers can still pass
 * `reasoningLevel: 'off'`, which provider adapters need to translate into the
 * correct vendor-specific "disable thinking" field.
 */
export function stripHeavyProviderFeatures(model: ChatModel): ChatModel {
  return {
    ...model,
    builtinToolProvider: 'none',
    builtinTools: undefined,
    web_search_options: undefined,
    customParameters: (model.customParameters ?? []).filter((entry) => {
      const key = (entry?.key ?? '').trim().toLowerCase()
      return key.length > 0 && LIGHTWEIGHT_ALLOWED_CUSTOM_PARAM_KEYS.has(key)
    }),
  }
}

export function stripHostedToolOptions(options: LLMOptions): LLMOptions {
  return {
    ...options,
    geminiTools: undefined,
  }
}

export function applyLightweightRequestPolicy({
  model,
  options,
}: {
  model: ChatModel
  options: LLMOptions
}): {
  model: ChatModel
  options: LLMOptions
} {
  return {
    model: stripHeavyProviderFeatures(model),
    options: stripHostedToolOptions(options),
  }
}
