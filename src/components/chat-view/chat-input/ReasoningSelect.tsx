import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Brain, ChevronDown, ChevronUp } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { ChatModel } from '../../../types/chat-model.types'
import { detectReasoningTypeFromModelId } from '../../../utils/model-id-utils'

export type ReasoningLevel =
  | 'off'
  | 'on'
  | 'auto'
  | 'low'
  | 'medium'
  | 'high'
  | 'extra-high'

type ReasoningModelType = 'openai' | 'gemini' | 'anthropic' | 'generic'

const REASONING_LEVELS: ReasoningLevel[] = [
  'off',
  'on',
  'auto',
  'low',
  'medium',
  'high',
  'extra-high',
]

const isReasoningLevel = (value: string): value is ReasoningLevel =>
  REASONING_LEVELS.includes(value as ReasoningLevel)

type ReasoningOption = {
  value: ReasoningLevel
  labelKey: string
  labelFallback: string
  reasoningEffort?: string
  thinkingBudget?: number
  budgetTokens?: number
}

const DEFAULT_ANTHROPIC_BUDGET_TOKENS = 8192

const REASONING_OPTIONS_MAP: Record<ReasoningModelType, ReasoningOption[]> = {
  openai: [
    {
      value: 'off',
      labelKey: 'reasoning.off',
      labelFallback: 'Off',
    },
    {
      value: 'low',
      labelKey: 'reasoning.low',
      labelFallback: 'Low',
      reasoningEffort: 'low',
    },
    {
      value: 'medium',
      labelKey: 'reasoning.medium',
      labelFallback: 'Medium',
      reasoningEffort: 'medium',
    },
    {
      value: 'high',
      labelKey: 'reasoning.high',
      labelFallback: 'High',
      reasoningEffort: 'high',
    },
  ],
  gemini: [
    {
      value: 'off',
      labelKey: 'reasoning.off',
      labelFallback: 'Off',
      thinkingBudget: 0,
    },
    {
      value: 'auto',
      labelKey: 'reasoning.auto',
      labelFallback: 'Auto',
      thinkingBudget: -1,
    },
    {
      value: 'low',
      labelKey: 'reasoning.low',
      labelFallback: 'Low',
      thinkingBudget: 4096,
    },
    {
      value: 'medium',
      labelKey: 'reasoning.medium',
      labelFallback: 'Medium',
      thinkingBudget: 8192,
    },
    {
      value: 'high',
      labelKey: 'reasoning.high',
      labelFallback: 'High',
      thinkingBudget: 16384,
    },
  ],
  anthropic: [
    {
      value: 'off',
      labelKey: 'reasoning.off',
      labelFallback: 'Off',
    },
    {
      value: 'on',
      labelKey: 'reasoning.on',
      labelFallback: 'On',
      budgetTokens: DEFAULT_ANTHROPIC_BUDGET_TOKENS,
    },
  ],
  generic: [
    {
      value: 'off',
      labelKey: 'reasoning.off',
      labelFallback: 'Off',
    },
    {
      value: 'low',
      labelKey: 'reasoning.low',
      labelFallback: 'Low',
      reasoningEffort: 'low',
      thinkingBudget: 4096,
      budgetTokens: 4096,
    },
    {
      value: 'medium',
      labelKey: 'reasoning.medium',
      labelFallback: 'Medium',
      reasoningEffort: 'medium',
      thinkingBudget: 8192,
      budgetTokens: 8192,
    },
    {
      value: 'high',
      labelKey: 'reasoning.high',
      labelFallback: 'High',
      reasoningEffort: 'high',
      thinkingBudget: 16384,
      budgetTokens: 16384,
    },
  ],
}

const resolveReasoningModelType = (
  model: ChatModel | null,
): ReasoningModelType | null => {
  if (!model) return null
  if (model.reasoningType) {
    return model.reasoningType === 'none' ? null : model.reasoningType
  }
  const detected = detectReasoningTypeFromModelId(model.model)
  if (detected === 'openai') return 'openai'
  if (detected === 'gemini') return 'gemini'
  if (detected === 'anthropic') return 'anthropic'
  if (detected === 'generic') return 'generic'
  if ('reasoning' in model && model.reasoning?.enabled) {
    return 'openai'
  }
  if ('thinking' in model && model.thinking?.enabled) {
    if (model.providerType === 'anthropic') return 'anthropic'
    if (model.providerType === 'gemini') return 'gemini'
    return 'generic'
  }
  return null
}

export function supportsReasoning(model: ChatModel | null): boolean {
  return resolveReasoningModelType(model) !== null
}

export function getDefaultReasoningLevel(
  model: ChatModel | null,
): ReasoningLevel {
  if (!model) return 'off'
  const modelType = resolveReasoningModelType(model)
  if (!modelType) return 'off'

  if (modelType === 'openai') {
    const effort =
      'reasoning' in model ? model.reasoning?.reasoning_effort : undefined
    if (effort === 'low') return 'low'
    if (effort === 'high') return 'high'
    return 'medium'
  }

  if (modelType === 'gemini') {
    const typedModel = model as Extract<
      ChatModel,
      { providerType: 'gemini' | 'openrouter' | 'openai-compatible' }
    >
    const budget = typedModel.thinking?.thinking_budget
    if (budget === -1) return 'auto'
    if (budget === 0) return 'off'
    if (typeof budget === 'number') {
      if (budget <= 4096) return 'low'
      if (budget <= 8192) return 'medium'
      return 'high'
    }
    return 'medium'
  }

  if (modelType === 'anthropic') {
    return 'on'
  }

  return 'medium'
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
      on: null,
      auto: null,
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

    const modelType = resolveReasoningModelType(model)
    if (!modelType) {
      return null
    }
    const availableOptions = REASONING_OPTIONS_MAP[modelType]
    const fallbackValue = getDefaultReasoningLevel(model)
    const safeValue = availableOptions.some((opt) => opt.value === value)
      ? value
      : fallbackValue
    const currentOption =
      availableOptions.find((opt) => opt.value === safeValue) ??
      availableOptions[0]

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
        const values = availableOptions.map((option) => option.value)
        const currentIndex = values.indexOf(safeValue)
        const nextIndex = (currentIndex + delta + values.length) % values.length
        const nextValue = values[nextIndex]
        const target = itemRefs.current[nextValue]
        if (target) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      },
      [availableOptions, safeValue],
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
                if (isReasoningLevel(val)) {
                  onChange(val)
                }
              }}
            >
              {availableOptions.map((option) => (
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
  model: ChatModel,
): {
  reasoning?: { enabled: boolean; reasoning_effort?: string }
  thinking?: {
    enabled: boolean
    budget_tokens?: number
    thinking_budget?: number
  }
} {
  const modelType = resolveReasoningModelType(model)
  if (!modelType) {
    return {}
  }
  if (level === 'off') {
    if (modelType === 'openai') {
      return { reasoning: { enabled: false } }
    }
    if (modelType === 'gemini') {
      return { thinking: { enabled: false, thinking_budget: 0 } }
    }
    if (modelType === 'anthropic') {
      return { thinking: { enabled: false, budget_tokens: 0 } }
    }
    return {
      reasoning: { enabled: false },
      thinking: { enabled: false },
    }
  }
  const option = REASONING_OPTIONS_MAP[modelType].find(
    (opt) => opt.value === level,
  )
  if (!option) {
    return {}
  }

  if (modelType === 'openai') {
    return {
      reasoning: {
        enabled: true,
        reasoning_effort: option.reasoningEffort,
      },
    }
  }

  if (modelType === 'gemini') {
    return {
      thinking: {
        enabled: true,
        thinking_budget: option.thinkingBudget,
      },
    }
  }

  if (modelType === 'anthropic') {
    if (level !== 'on') {
      return {}
    }
    const typedModel = model as Extract<
      ChatModel,
      { providerType: 'anthropic' }
    >
    return {
      thinking: {
        enabled: true,
        budget_tokens:
          typedModel.thinking?.budget_tokens ??
          option.budgetTokens ??
          DEFAULT_ANTHROPIC_BUDGET_TOKENS,
      },
    }
  }

  const reasoningEffort =
    option.reasoningEffort ?? (level === 'high' ? 'high' : 'medium')
  const thinkingBudget = option.thinkingBudget ?? option.budgetTokens
  const budgetTokens = option.budgetTokens ?? thinkingBudget

  if (model.providerType === 'openai') {
    return {
      reasoning: {
        enabled: true,
        reasoning_effort: reasoningEffort,
      },
    }
  }

  if (model.providerType === 'anthropic') {
    return {
      thinking: {
        enabled: true,
        budget_tokens: budgetTokens ?? DEFAULT_ANTHROPIC_BUDGET_TOKENS,
      },
    }
  }

  if (model.providerType === 'gemini') {
    return {
      thinking: {
        enabled: true,
        thinking_budget: thinkingBudget,
      },
    }
  }

  return {
    reasoning: {
      enabled: true,
      reasoning_effort: reasoningEffort,
    },
    thinking: {
      enabled: true,
      budget_tokens: budgetTokens,
      thinking_budget: thinkingBudget,
    },
  }
}
