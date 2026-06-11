import { useCallback, useId, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { REASONING_LEVELS, ReasoningLevel } from '../../types/reasoning'
import { getNodeDocument } from '../../utils/dom/window-context'

type ReasoningOption = {
  value: ReasoningLevel
  labelKey: string
  labelFallback: string
  descKey: string
  descFallback: string
}

const LEVEL_META: Record<
  ReasoningLevel,
  {
    labelKey: string
    labelFallback: string
    descKey: string
    descFallback: string
  }
> = {
  off: {
    labelKey: 'reasoning.off',
    labelFallback: 'Off',
    descKey: 'reasoning.offDesc',
    descFallback: 'No thinking, answer directly',
  },
  auto: {
    labelKey: 'reasoning.auto',
    labelFallback: 'Auto',
    descKey: 'reasoning.autoDesc',
    descFallback: 'Let the model decide thinking depth based on the prompt',
  },
  low: {
    labelKey: 'reasoning.low',
    labelFallback: 'Low',
    descKey: 'reasoning.lowDesc',
    descFallback: 'Lightweight thinking, faster response',
  },
  medium: {
    labelKey: 'reasoning.medium',
    labelFallback: 'Medium',
    descKey: 'reasoning.mediumDesc',
    descFallback: 'Balanced thinking depth',
  },
  high: {
    labelKey: 'reasoning.high',
    labelFallback: 'High',
    descKey: 'reasoning.highDesc',
    descFallback: 'Deep thinking, suited for complex problems',
  },
  'extra-high': {
    labelKey: 'reasoning.extraHigh',
    labelFallback: 'Extra high',
    descKey: 'reasoning.extraHighDesc',
    descFallback: 'Maximum thinking, for the toughest reasoning',
  },
}

export const REASONING_OPTIONS: ReasoningOption[] = REASONING_LEVELS.map(
  (value) => ({
    value,
    ...LEVEL_META[value],
  }),
)

type ReasoningSegmentedProps = {
  value: ReasoningLevel
  onChange: (level: ReasoningLevel) => void
  onPreviewChange?: (level: ReasoningLevel) => void
  onPreviewCancel?: () => void
  ariaLabel?: string
  /**
   * Optional refs map populated with each segment button. Lets parent (e.g.
   * `ReasoningSelect`'s popover) drive focus management when used inside a
   * dropdown. Standalone callers can ignore it.
   */
  segmentRefs?: React.MutableRefObject<
    Record<ReasoningLevel, HTMLButtonElement | null>
  >
}

/**
 * Inline effort slider for picking a reasoning level. Used standalone in the
 * settings panel and wrapped by `ReasoningSelect` inside its popover.
 */
export function ReasoningSegmented({
  value,
  onChange,
  onPreviewChange,
  onPreviewCancel,
  ariaLabel,
  segmentRefs,
}: ReasoningSegmentedProps) {
  const { t } = useLanguage()
  const labelId = useId()
  const [isDragging, setIsDragging] = useState(false)
  const fallbackRefs = useRef<Record<ReasoningLevel, HTMLButtonElement | null>>(
    Object.fromEntries(
      REASONING_LEVELS.map((level) => [level, null]),
    ) as Record<ReasoningLevel, HTMLButtonElement | null>,
  )
  const refs = segmentRefs ?? fallbackRefs
  const sliderRef = useRef<HTMLDivElement | null>(null)
  const dragPointerIdRef = useRef<number | null>(null)

  const focusByDelta = useCallback(
    (currentValue: ReasoningLevel, delta: number) => {
      const values = REASONING_OPTIONS.map((option) => option.value)
      const ownerDoc = getNodeDocument(refs.current[currentValue])
      const focusedValue = values.find(
        (v) =>
          refs.current[v] !== null &&
          refs.current[v] === ownerDoc.activeElement,
      )
      const baseIndex =
        focusedValue !== undefined
          ? values.indexOf(focusedValue)
          : values.indexOf(currentValue)
      const nextIndex = (baseIndex + delta + values.length) % values.length
      const target = refs.current[values[nextIndex]]
      if (target) target.focus({ preventScroll: true })
    },
    [refs],
  )

  const resolveLevelFromClientX = useCallback((clientX: number) => {
    const rect = sliderRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const maxIndex = REASONING_OPTIONS.length - 1
    const index = Math.min(maxIndex, Math.max(0, Math.round(ratio * maxIndex)))
    return REASONING_OPTIONS[index].value
  }, [])

  const previewFromPointer = useCallback(
    (clientX: number) => {
      const nextLevel = resolveLevelFromClientX(clientX)
      if (!nextLevel || nextLevel === value) return
      if (onPreviewChange) {
        onPreviewChange(nextLevel)
        return
      }
      onChange(nextLevel)
    },
    [onChange, onPreviewChange, resolveLevelFromClientX, value],
  )

  const safeValue = REASONING_OPTIONS.some((opt) => opt.value === value)
    ? value
    : 'auto'
  const selectedIndex = REASONING_OPTIONS.findIndex(
    (opt) => opt.value === safeValue,
  )
  const getSliderPosition = (index: number) =>
    (index / (REASONING_OPTIONS.length - 1)) * 100
  const selectedPosition = `${getSliderPosition(selectedIndex)}`

  return (
    <div
      ref={sliderRef}
      className={`yolo-reasoning-slider${isDragging ? ' is-dragging' : ''}`}
      role="radiogroup"
      aria-labelledby={labelId}
      style={
        {
          '--yolo-segment-count': REASONING_OPTIONS.length,
        } as React.CSSProperties
      }
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          onChange(
            REASONING_OPTIONS[(selectedIndex + 1) % REASONING_OPTIONS.length]
              .value,
          )
          focusByDelta(safeValue, 1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          onChange(
            REASONING_OPTIONS[
              (selectedIndex - 1 + REASONING_OPTIONS.length) %
                REASONING_OPTIONS.length
            ].value,
          )
          focusByDelta(safeValue, -1)
        }
      }}
      onPointerDown={(event) => {
        dragPointerIdRef.current = event.pointerId
        setIsDragging(true)
        event.currentTarget.setPointerCapture(event.pointerId)
        previewFromPointer(event.clientX)
      }}
      onPointerMove={(event) => {
        if (dragPointerIdRef.current !== event.pointerId) return
        previewFromPointer(event.clientX)
      }}
      onPointerUp={(event) => {
        if (dragPointerIdRef.current !== event.pointerId) return
        dragPointerIdRef.current = null
        setIsDragging(false)
        event.currentTarget.releasePointerCapture(event.pointerId)
        onChange(resolveLevelFromClientX(event.clientX) ?? value)
      }}
      onPointerCancel={(event) => {
        if (dragPointerIdRef.current !== event.pointerId) return
        dragPointerIdRef.current = null
        setIsDragging(false)
        event.currentTarget.releasePointerCapture(event.pointerId)
        onPreviewCancel?.()
      }}
    >
      <span id={labelId} className="yolo-sr-only">
        {ariaLabel ?? t('reasoning.selectReasoning', 'Select reasoning')}
      </span>
      <div className="yolo-reasoning-slider__track" aria-hidden="true">
        <div
          className="yolo-reasoning-slider__fill"
          style={
            {
              '--yolo-reasoning-slider-position': selectedPosition,
            } as React.CSSProperties
          }
        />
        <div
          className="yolo-reasoning-slider__thumb"
          style={
            {
              '--yolo-reasoning-slider-position': selectedPosition,
            } as React.CSSProperties
          }
        />
        {REASONING_OPTIONS.map((option, index) => (
          <div
            key={option.value}
            className={`yolo-reasoning-slider__dot${
              option.value === safeValue ? ' active' : ''
            }`}
            style={
              {
                '--yolo-reasoning-slider-position': `${getSliderPosition(
                  index,
                )}`,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
      {REASONING_OPTIONS.map((option) => {
        const selected = option.value === safeValue
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`yolo-reasoning-slider__option${
              selected ? ' active' : ''
            }`}
            tabIndex={selected ? 0 : -1}
            ref={(element) => {
              refs.current[option.value] = element
            }}
            onClick={(event) => {
              if (event.detail !== 0) return
              onChange(option.value)
            }}
          >
            <span className="yolo-sr-only">
              {t(option.labelKey, option.labelFallback)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
