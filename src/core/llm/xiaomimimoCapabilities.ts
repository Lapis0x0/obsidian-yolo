import { ChatModel } from '../../types/chat-model.types'
import {
  type ReasoningLevel,
  modelSupportsReasoning,
} from '../../types/reasoning'

type XiaomimimoRequestRecord = Record<string, unknown>

/**
 * Xiaomi MiMo thinking-mode mapping. Mirrors DeepSeek V4 — thinking is
 * opt-in via a top-level `thinking: { type }` field (which the platform
 * forwards from OpenAI SDK's `extra_body`). `reasoning_effort` is not
 * documented for MiMo and is therefore omitted.
 */
export function applyXiaomimimoCapabilities(params: {
  request: XiaomimimoRequestRecord
  model: Pick<ChatModel, 'model' | 'reasoningType'>
  reasoningLevel?: ReasoningLevel
}): void {
  const { request, model, reasoningLevel } = params

  if (!reasoningLevel) return

  if (reasoningLevel === 'off') {
    request.thinking = { type: 'disabled' }
    return
  }

  if (!modelSupportsReasoning(model)) return

  if (reasoningLevel === 'auto') {
    return
  }

  request.thinking = { type: 'enabled' }
}
