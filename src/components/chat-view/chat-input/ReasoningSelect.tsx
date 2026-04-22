import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Brain, ChevronDown, ChevronUp } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { ChatModel } from '../../../types/chat-model.types'
import {
  REASONING_LEVELS,
  ReasoningLevel,
  getDefaultReasoningLevel,
  isReasoningLevelString,
  modelSupportsReasoning,
} from '../../../types/reasoning'
import { getNodeBody, getNodeWindow } from '../../../utils/dom/window-context'

export type { ReasoningLevel } from '../../../types/reasoning'

type ReasoningOption = {
  value: ReasoningLevel
  labelKey: string
  labelFallback: string
}

const REASONING_OPTIONS: ReasoningOption[] = REASONING_LEVELS.map((value) => {
  const labelKey =
    value === 'extra-high' ? 'reasoning.extraHigh' : `reasoning.${value}`
  const labelFallback =
    value === 'off'
      ? 'Off'
      : value === 'auto'
        ? 'Auto'
        : value === 'low'
          ? 'Low'
          : value === 'medium'
            ? 'Medium'
            : value === 'high'
              ? 'High'
              : 'Extra high'
  return { value, labelKey, labelFallback }
})

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
    contentClassName?: string
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
      align = 'start',
      alignOffset = 0,
      contentClassName,
    },
    ref,
  ) => {
    const { t } = useLanguage()
    const [isOpen, setIsOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const resolvedContainer = container ?? getNodeBody(triggerRef.current)
    const itemRefs = useRef<Record<ReasoningLevel, HTMLDivElement | null>>(
      Object.fromEntries(
        REASONING_LEVELS.map((level) => [level, null]),
      ) as Record<ReasoningLevel, HTMLDivElement | null>,
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

    const focusSelectedItem = useCallback(() => {
      const target = itemRefs.current[safeValue]
      if (!target) return
      target.focus({ preventScroll: true })
      target.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      })
    }, [safeValue])

    const focusByDelta = useCallback(
      (delta: number) => {
        const values = REASONING_OPTIONS.map((option) => option.value)
        const currentIndex = values.indexOf(safeValue)
        const nextIndex = (currentIndex + delta + values.length) % values.length
        const nextValue = values[nextIndex]
        const target = itemRefs.current[nextValue]
        if (target) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      },
      [safeValue],
    )

    useEffect(() => {
      if (!isOpen) return
      const ownerWindow = getNodeWindow(triggerRef.current)
      const rafId = ownerWindow.requestAnimationFrame(() => {
        focusSelectedItem()
      })
      return () => ownerWindow.cancelAnimationFrame(rafId)
    }, [isOpen, focusSelectedItem])

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
        focusSelectedItem()
        return
      }

      if (isOpen && event.key === 'Escape') {
        event.preventDefault()
        handleOpenChange(false)
      }
    }

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
            {t(
              currentOption?.labelKey ?? 'reasoning.medium',
              currentOption?.labelFallback ?? 'Medium',
            )}
          </div>
          <div className="smtcmp-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal container={resolvedContainer}>
          <DropdownMenu.Content
            className={
              contentClassName
                ? `smtcmp-popover ${contentClassName}`
                : 'smtcmp-popover'
            }
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
          >
            <DropdownMenu.Label className="smtcmp-popover-group-label">
              {t('reasoning.selectReasoning', 'Select reasoning')}
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              className="smtcmp-model-select-list smtcmp-reasoning-select-list"
              value={safeValue}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  focusByDelta(1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  focusByDelta(-1)
                }
              }}
              onValueChange={(val) => {
                if (isReasoningLevelString(val)) {
                  onChange(val)
                }
              }}
            >
              {REASONING_OPTIONS.map((option) => (
                <DropdownMenu.RadioItem
                  key={option.value}
                  className="smtcmp-popover-item smtcmp-reasoning-select-item"
                  value={option.value}
                  ref={(element) => {
                    itemRefs.current[option.value] = element
                  }}
                  data-level={option.value}
                >
                  <div className="smtcmp-reasoning-select-item__icon">
                    <Brain size={14} />
                  </div>
                  <div className="smtcmp-reasoning-select-item__label">
                    {t(option.labelKey, option.labelFallback)}
                  </div>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    )
  },
)

ReasoningSelect.displayName = 'ReasoningSelect'
