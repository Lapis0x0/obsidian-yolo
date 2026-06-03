import { ChatModel } from '../../types/chat-model.types'
import {
  type ReasoningLevel,
  modelSupportsReasoning,
} from '../../types/reasoning'

type DeepSeekRequestRecord = Record<string, unknown>

/**
 * DeepSeek V4 thinking-mode mapping (docs: api-docs.deepseek.com/zh-cn/guides/thinking_mode).
 *
 * V4 only accepts `reasoning_effort` of `high` / `max` and toggles thinking via a
 * top-level `thinking: { type }` field; thinking is enabled by default.
 *
 * V3.2 `deepseek-reasoner` predates these parameters and is being deprecated in
 * July; we skip it entirely to preserve current behavior.
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
  request.reasoning_effort = reasoningLevel === 'extra-high' ? 'max' : 'high'
}

function isDeepSeekReasonerModel(modelId: string): boolean {
  return /reasoner/i.test(modelId)
}
