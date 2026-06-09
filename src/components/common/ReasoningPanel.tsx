import { Brain } from 'lucide-react'

import { useLanguage } from '../../contexts/language-context'
import { ChatModel } from '../../types/chat-model.types'
import {
  ReasoningLevel,
  getDefaultReasoningLevel,
  modelSupportsReasoning,
} from '../../types/reasoning'
import { REASONING_OPTIONS, ReasoningSegmented } from './ReasoningSegmented'

type ReasoningPanelProps = {
  model: ChatModel | null
  value: ReasoningLevel
  onChange: (level: ReasoningLevel) => void
  /**
   * Optional refs map for the segmented buttons. Used by `ReasoningSelect`'s
   * popover to drive focus on open. Inline callers can omit it.
   */
  segmentRefs?: React.MutableRefObject<
    Record<ReasoningLevel, HTMLButtonElement | null>
  >
}

/**
 * Self-contained reasoning picker: title row + segmented pill + live
 * description of the current level. Used inline in the Sparkle sidebar and
 * wrapped inside `ReasoningSelect`'s popover.
 *
 * Returns `null` when the model does not support reasoning, so callers can
 * unconditionally render it.
 */
export function ReasoningPanel({
  model,
  value,
  onChange,
  segmentRefs,
}: ReasoningPanelProps) {
  const { t } = useLanguage()

  if (!model || !modelSupportsReasoning(model)) return null

  const fallbackValue = getDefaultReasoningLevel(model)
  const safeValue = REASONING_OPTIONS.some((opt) => opt.value === value)
    ? value
    : fallbackValue
  const currentOption =
    REASONING_OPTIONS.find((opt) => opt.value === safeValue) ??
    REASONING_OPTIONS[0]
  const currentLabel = t(currentOption.labelKey, currentOption.labelFallback)
  const currentDesc = t(currentOption.descKey, currentOption.descFallback)

  return (
    <div className="yolo-reasoning-panel">
      <div className="yolo-reasoning-popover__header">
        <Brain size={14} className="yolo-reasoning-popover__header-icon" />
        <span className="yolo-reasoning-popover__header-title">
          {t('reasoning.selectReasoning', 'Select reasoning')}
        </span>
        <span className="yolo-reasoning-popover__header-current">
          · {currentLabel}
        </span>
      </div>

      <ReasoningSegmented
        value={safeValue}
        onChange={onChange}
        segmentRefs={segmentRefs}
      />

      <div className="yolo-reasoning-popover__desc">
        <span className="yolo-reasoning-popover__desc-label">
          {currentLabel}
        </span>
        <span className="yolo-reasoning-popover__desc-sep"> — </span>
        {currentDesc}
      </div>
    </div>
  )
}
