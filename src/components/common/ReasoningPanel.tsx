import { useEffect, useRef, useState } from 'react'

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
 * Self-contained reasoning picker: compact title row + effort slider. Used
 * inline in the Sparkle sidebar and wrapped inside `ReasoningSelect`'s popover.
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

  const fallbackValue = getDefaultReasoningLevel(model)
  const safeValue = REASONING_OPTIONS.some((opt) => opt.value === value)
    ? value
    : fallbackValue
  const [draftValue, setDraftValue] = useState<ReasoningLevel>(safeValue)
  const previousDraftValueRef = useRef<ReasoningLevel>(safeValue)

  useEffect(() => {
    setDraftValue(safeValue)
  }, [safeValue])

  const safeDraftValue = REASONING_OPTIONS.some(
    (opt) => opt.value === draftValue,
  )
    ? draftValue
    : safeValue
  const currentIndex = REASONING_OPTIONS.findIndex(
    (opt) => opt.value === safeDraftValue,
  )
  const previousIndex = REASONING_OPTIONS.findIndex(
    (opt) => opt.value === previousDraftValueRef.current,
  )
  const currentMotionClass =
    currentIndex >= previousIndex
      ? 'yolo-reasoning-popover__header-current--up'
      : 'yolo-reasoning-popover__header-current--down'
  const currentOption =
    REASONING_OPTIONS.find((opt) => opt.value === safeDraftValue) ??
    REASONING_OPTIONS[0]
  const currentLabel = t(currentOption.labelKey, currentOption.labelFallback)

  useEffect(() => {
    previousDraftValueRef.current = safeDraftValue
  }, [safeDraftValue])

  if (!model || !modelSupportsReasoning(model)) return null

  return (
    <div className="yolo-reasoning-panel">
      <div className="yolo-reasoning-popover__header">
        <span className="yolo-reasoning-popover__header-title">
          {t('reasoning.effort', 'Effort')}
        </span>
        <span
          key={safeDraftValue}
          className={`yolo-reasoning-popover__header-current ${currentMotionClass}`}
        >
          {currentLabel}
        </span>
      </div>

      <div className="yolo-reasoning-popover__scale-labels">
        <span>{t('reasoning.faster', 'Faster')}</span>
        <span>{t('reasoning.smarter', 'Smarter')}</span>
      </div>

      <ReasoningSegmented
        value={safeDraftValue}
        onPreviewChange={setDraftValue}
        onPreviewCancel={() => setDraftValue(safeValue)}
        onChange={(level) => {
          setDraftValue(level)
          onChange(level)
        }}
        segmentRefs={segmentRefs}
      />
    </div>
  )
}
