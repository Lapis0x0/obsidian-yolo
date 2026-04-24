import {
  CHAT_MODEL_MODALITIES,
  ChatModel,
  ChatModelModality,
} from '../../types/chat-model.types'
import { LLMProvider } from '../../types/provider.types'

export { CHAT_MODEL_MODALITIES }
export type { ChatModelModality }

/**
 * Default modalities inferred from provider apiType, used when a new chat model
 * is first created via the settings modal. For unknown / openai-compatible
 * providers we stay conservative (text only) — the user can toggle vision on
 * for their specific model.
 */
export function resolveDefaultChatModelModalities(
  provider: LLMProvider | undefined,
): ChatModelModality[] {
  if (!provider) return ['text']
  switch (provider.apiType) {
    case 'anthropic':
    case 'amazon-bedrock':
    case 'gemini':
    case 'openai-responses':
      return ['text', 'vision']
    case 'openai-compatible':
    default:
      return ['text']
  }
}

/**
 * Settings migration (see `migrations/48_to_49.ts`) backfills this field for
 * every ChatModel using `resolveDefaultChatModelModalities`, so by the time
 * this gate runs the array is always populated. The `?? ['text']` branch is
 * the ultra-defensive fallback for a model that somehow bypassed migration.
 */
export function chatModelSupportsVision(
  model: ChatModel | null | undefined,
): boolean {
  const modalities =
    model?.modalities && model.modalities.length > 0
      ? model.modalities
      : (['text'] as ChatModelModality[])
  return modalities.includes('vision')
}
