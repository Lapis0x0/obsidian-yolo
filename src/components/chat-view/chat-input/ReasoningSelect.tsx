import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Brain, ChevronDown, ChevronUp } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { ChatModel } from '../../../types/chat-model.types'

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'extra-high'

const isReasoningLevel = (value: string): value is ReasoningLevel =>
  ['off', 'low', 'medium', 'high', 'extra-high'].includes(value)

type ReasoningOption = {
  value: ReasoningLevel
  labelKey: string
  labelFallback: string
  // For OpenAI reasoning_effort
  reasoningEffort?: string
  // For Anthropic/Gemini thinking budget
  budgetTokens?: number
}

const REASONING_OPTIONS: ReasoningOption[] = [
  {
    value: 'off',
    labelKey: 'reasoning.off',
    labelFallback: 'Off',
    reasoningEffort: undefined,
    budgetTokens: 0,
  },
  {
    value: 'low',
    labelKey: 'reasoning.low',
    labelFallback: 'Low',
    reasoningEffort: 'low',
    budgetTokens: 4096,
  },
  {
    value: 'medium',
    labelKey: 'reasoning.medium',
    labelFallback: 'Medium',
    reasoningEffort: 'medium',
    budgetTokens: 8192,
  },
  {
    value: 'high',
    labelKey: 'reasoning.high',
    labelFallback: 'High',
    reasoningEffort: 'high',
    budgetTokens: 16384,
  },
  {
    value: 'extra-high',
    labelKey: 'reasoning.extraHigh',
    labelFallback: 'Extra high',
    reasoningEffort: 'high',
    budgetTokens: 32768,
  },
]

// Provider types that support reasoning configuration
const REASONING_PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'openai-compatible',
] as const

export function supportsReasoning(model: ChatModel | null): boolean {
  if (!model) return false
  return (REASONING_PROVIDER_TYPES as readonly string[]).includes(
    model.providerType,
  )
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
    const itemRefs = useRef<Record<ReasoningLevel, HTMLDivElement | null>>({
      off: null,
      low: null,
      medium: null,
      high: null,
      'extra-high': null,
    })

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

    const currentOption = REASONING_OPTIONS.find((opt) => opt.value === value)

    const focusSelectedItem = useCallback(() => {
      const target = itemRefs.current[value]
      if (!target) return
      target.focus({ preventScroll: true })
      target.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      })
    }, [value])

    const focusByDelta = useCallback(
      (delta: number) => {
        const values: ReasoningLevel[] = [
          'off',
          'low',
          'medium',
          'high',
          'extra-high',
        ]
        const currentIndex = values.indexOf(value)
        const nextIndex = (currentIndex + delta + values.length) % values.length
        const nextValue = values[nextIndex]
        const target = itemRefs.current[nextValue]
        if (target) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      },
      [value],
    )

    useEffect(() => {
      if (!isOpen) return
      const rafId = window.requestAnimationFrame(() => {
        focusSelectedItem()
      })
      return () => window.cancelAnimationFrame(rafId)
    }, [isOpen, focusSelectedItem])

    const handleOpenChange = (open: boolean) => {
      setIsOpen(open)
      onMenuOpenChange?.(open)
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

    // Don't render if model doesn't support reasoning
    if (!supportsReasoning(model)) {
      return null
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
          <div className="smtcmp-chat-input-model-select__model-name">
            {t(
              currentOption?.labelKey ?? 'reasoning.medium',
              currentOption?.labelFallback ?? 'Medium',
            )}
          </div>
          <div className="smtcmp-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal container={container}>
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
              value={value}
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
                if (isReasoningLevel(val)) {
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

// Helper to convert ReasoningLevel to model config
export function reasoningLevelToConfig(
  level: ReasoningLevel,
  providerType: string,
): {
  reasoning?: { enabled: boolean; reasoning_effort?: string }
  thinking?: {
    enabled: boolean
    budget_tokens?: number
    thinking_budget?: number
  }
} {
  const option = REASONING_OPTIONS.find((o) => o.value === level)
  if (!option || level === 'off') {
    return {}
  }

  if (providerType === 'openai') {
    return {
      reasoning: {
        enabled: true,
        reasoning_effort: option.reasoningEffort,
      },
    }
  }

  if (providerType === 'anthropic') {
    return {
      thinking: {
        enabled: true,
        budget_tokens: option.budgetTokens,
      },
    }
  }

  if (providerType === 'gemini') {
    return {
      thinking: {
        enabled: true,
        thinking_budget: option.budgetTokens,
      },
    }
  }

  // For openrouter and openai-compatible, return both
  return {
    reasoning: {
      enabled: true,
      reasoning_effort: option.reasoningEffort,
    },
    thinking: {
      enabled: true,
      budget_tokens: option.budgetTokens,
      thinking_budget: option.budgetTokens,
    },
  }
}
