import { ChatModel } from '../../types/chat-model.types'

/**
 * Custom-parameter keys that are safe to keep on auxiliary single-turn calls
 * (conversation title generation, compaction summary). These are the generic
 * sampling / output-shape knobs that every LLM endpoint understands and that
 * cannot re-inject hosted tools, reasoning, or search behavior.
 *
 * We use an allowlist (not a blacklist) because some providers — notably
 * Gemini native — merge customParameters directly into the request payload,
 * which means container fields like `config`, `generationConfig`, or
 * `thinkingConfig` could smuggle hosted features in. Listing every possible
 * carrier per provider is brittle; explicitly enumerating what's safe is not.
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
 * Returns a ChatModel clone with all "heavy" provider features stripped:
 * hosted/built-in tools, reasoning configuration unless explicitly preserved,
 * and any custom-parameter entries that fall outside the lightweight allowlist.
 *
 * Use for auxiliary single-turn LLM calls (title generation, compaction
 * summary) where the only desired behavior is "send messages, get one short
 * reply". The user-configured chat behavior is intentionally bypassed.
 */
export function stripProviderFeatures(
  model: ChatModel,
  options: { preserveReasoning?: boolean } = {},
): ChatModel {
  return {
    ...model,
    reasoningType: options.preserveReasoning ? model.reasoningType : 'none',
    builtinToolProvider: 'none',
    builtinTools: undefined,
    web_search_options: undefined,
    customParameters: (model.customParameters ?? []).filter((entry) => {
      const key = (entry?.key ?? '').trim().toLowerCase()
      return key.length > 0 && LIGHTWEIGHT_ALLOWED_CUSTOM_PARAM_KEYS.has(key)
    }),
  }
}
