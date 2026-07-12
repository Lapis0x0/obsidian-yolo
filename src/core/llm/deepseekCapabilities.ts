import { ChatModel } from '../../types/chat-model.types'
import {
  REASONING_META,
  type ReasoningLevel,
  modelSupportsReasoning,
} from '../../types/reasoning'

type DeepSeekRequestRecord = Record<string, unknown>

/**
 * DeepSeek V4 thinking-mode mapping (docs: api-docs.deepseek.com/zh-cn/guides/thinking_mode).
 *
 * V4 only accepts `reasoning_effort` of `high` / `max` and toggles thinking via a
 * top-level `thinking: { type }` field; unsupported levels are passed through so
 * the API reports the mismatch instead of silently changing the user's choice.
 *
 * Legacy `deepseek-reasoner` encodes thinking in the model alias itself and is
 * scheduled for retirement on 2026-07-24; skip it to preserve alias semantics.
 */
export function applyDeepSeekCapabilities(params: {
  request: DeepSeekRequestRecord
  model: Pick<ChatModel, 'model' | 'reasoningType'>
  reasoningLevel?: ReasoningLevel
}): void {
  const { request, model, reasoningLevel } = params

  if (isDeepSeekReasonerModel(model.model)) return
  if (!modelSupportsReasoning(model) || !reasoningLevel) return

  if (reasoningLevel === 'auto') {
    return
  }

  if (reasoningLevel === 'off') {
    request.thinking = { type: 'disabled' }
    return
  }

  request.thinking = { type: 'enabled' }
  request.reasoning_effort = REASONING_META[reasoningLevel].effort
}

function isDeepSeekReasonerModel(modelId: string): boolean {
  return /reasoner/i.test(modelId)
}
