import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Brain, ChevronDown, ChevronUp } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { ChatModel } from '../../../types/chat-model.types'
import {
  REASONING_LEVELS,
  ReasoningLevel,
  getDefaultReasoningLevel,
  modelSupportsReasoning,
} from '../../../types/reasoning'
import {
  getNodeBody,
  getNodeDocument,
  getNodeWindow,
} from '../../../utils/dom/window-context'
import { YoloDropdownContent } from '../../common/popover'

export type { ReasoningLevel } from '../../../types/reasoning'

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

const REASONING_OPTIONS: ReasoningOption[] = REASONING_LEVELS.map((value) => ({
  value,
  ...LEVEL_META[value],
}))

export function supportsReasoning(model: ChatModel | null): boolean {
  return model !== null && modelSupportsReasoning(model)
}

export const ReasoningSelect = forwardRef<
  HTMLButtonElement,
  {
    model: ChatModel | null
    value: ReasoningLevel
    onChange: (level: ReasoningLevel) => void
    onMenuOpenChange?: (isOpen: boolean) => void
    container?: HTMLElement
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    align?: 'start' | 'center' | 'end'
    alignOffset?: number
  }
>(
  (
    {
      model,
      value,
      onChange,
      onMenuOpenChange,
      container,
      side = 'top',
      sideOffset = 4,
      align = 'center',
      alignOffset = 0,
    },
    ref,
  ) => {
    const { t } = useLanguage()
    const [isOpen, setIsOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const resolvedContainer = container ?? getNodeBody(triggerRef.current)
    const segmentRefs = useRef<
      Record<ReasoningLevel, HTMLButtonElement | null>
    >(
      Object.fromEntries(
        REASONING_LEVELS.map((level) => [level, null]),
      ) as Record<ReasoningLevel, HTMLButtonElement | null>,
    )

    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node
        if (typeof ref === 'function') {
          ref(node)
        } else if (ref) {
          ref.current = node
        }
      },
      [ref],
    )

    const fallbackValue = getDefaultReasoningLevel(model)
    const safeValue = REASONING_OPTIONS.some((opt) => opt.value === value)
      ? value
      : fallbackValue
    const currentOption =
      REASONING_OPTIONS.find((opt) => opt.value === safeValue) ??
      REASONING_OPTIONS[0]

    const focusSelectedSegment = useCallback(() => {
      const target = segmentRefs.current[safeValue]
      if (!target) return
      target.focus({ preventScroll: true })
    }, [safeValue])

    const focusByDelta = useCallback(
      (delta: number) => {
        const values = REASONING_OPTIONS.map((option) => option.value)
        const ownerDoc = getNodeDocument(triggerRef.current)
        const focusedValue = values.find(
          (v) =>
            segmentRefs.current[v] !== null &&
            segmentRefs.current[v] === ownerDoc.activeElement,
        )
        const baseIndex =
          focusedValue !== undefined
            ? values.indexOf(focusedValue)
            : values.indexOf(safeValue)
        const nextIndex = (baseIndex + delta + values.length) % values.length
        const nextValue = values[nextIndex]
        const target = segmentRefs.current[nextValue]
        if (target) {
          target.focus({ preventScroll: true })
        }
      },
      [safeValue],
    )

    useEffect(() => {
      if (!isOpen) return
      const ownerWindow = getNodeWindow(triggerRef.current)
      const rafId = ownerWindow.requestAnimationFrame(() => {
        focusSelectedSegment()
      })
      return () => ownerWindow.cancelAnimationFrame(rafId)
    }, [isOpen, focusSelectedSegment])

    const handleOpenChange = (open: boolean) => {
      setIsOpen(open)
      onMenuOpenChange?.(open)
    }

    if (!supportsReasoning(model)) {
      return null
    }

    const handleTriggerKeyDown = (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!isOpen) {
          event.preventDefault()
          setIsOpen(true)
          return
        }
        event.preventDefault()
        focusSelectedSegment()
        return
      }

      if (isOpen && event.key === 'Escape') {
        event.preventDefault()
        handleOpenChange(false)
      }
    }

    const currentLabel = t(currentOption.labelKey, currentOption.labelFallback)
    const currentDesc = t(currentOption.descKey, currentOption.descFallback)

    return (
      <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenu.Trigger
          ref={setTriggerRef}
          className="smtcmp-chat-input-model-select smtcmp-reasoning-select"
          onKeyDown={handleTriggerKeyDown}
        >
          <div className="smtcmp-reasoning-select__icon">
            <Brain size={14} />
          </div>
          <div className="smtcmp-chat-input-model-select__label smtcmp-chat-input-model-select__model-name">
            {currentLabel}
          </div>
          <div className="smtcmp-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <YoloDropdownContent
          container={resolvedContainer}
          variant="default"
          minWidth={360}
          maxWidth={460}
          maxHeight={400}
          className="smtcmp-reasoning-popover"
          side={side}
          sideOffset={sideOffset}
          align={align}
          alignOffset={alignOffset}
          collisionPadding={8}
          loop
          onPointerDownOutside={(e) => {
            e.stopPropagation()
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            triggerRef.current?.focus({ preventScroll: true })
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault()
              focusByDelta(1)
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault()
              focusByDelta(-1)
            }
          }}
        >
          <div className="smtcmp-reasoning-popover__header">
            <Brain
              size={14}
              className="smtcmp-reasoning-popover__header-icon"
            />
            <span className="smtcmp-reasoning-popover__header-title">
              {t('reasoning.selectReasoning', 'Select reasoning')}
            </span>
            <span className="smtcmp-reasoning-popover__header-current">
              · {currentLabel}
            </span>
          </div>

          <div
            className="smtcmp-segmented smtcmp-segmented--pill smtcmp-reasoning-segmented"
            role="radiogroup"
            aria-label={t('reasoning.selectReasoning', 'Select reasoning')}
            style={
              {
                '--smtcmp-segment-count': REASONING_OPTIONS.length,
                '--smtcmp-segment-index': REASONING_OPTIONS.findIndex(
                  (opt) => opt.value === safeValue,
                ),
              } as React.CSSProperties
            }
          >
            <div className="smtcmp-segmented-glider" aria-hidden="true" />
            {REASONING_OPTIONS.map((option) => {
              const selected = option.value === safeValue
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? 'active' : ''}
                  tabIndex={selected ? 0 : -1}
                  ref={(element) => {
                    segmentRefs.current[option.value] = element
                  }}
                  onClick={() => {
                    onChange(option.value)
                  }}
                >
                  {t(option.labelKey, option.labelFallback)}
                </button>
              )
            })}
          </div>

          <div className="smtcmp-reasoning-popover__desc">
            <span className="smtcmp-reasoning-popover__desc-label">
              {currentLabel}
            </span>
            <span className="smtcmp-reasoning-popover__desc-sep"> — </span>
            {currentDesc}
          </div>
        </YoloDropdownContent>
      </DropdownMenu.Root>
    )
  },
)

ReasoningSelect.displayName = 'ReasoningSelect'
