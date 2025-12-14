import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Pencil,
  Zap,
} from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'

export type QuickAskMode = 'ask' | 'edit' | 'edit-direct'

type ModeOption = {
  value: QuickAskMode
  labelKey: string
  labelFallback: string
  descKey: string
  descFallback: string
  icon: React.ReactNode
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'ask',
    labelKey: 'quickAsk.modeAsk',
    labelFallback: 'Ask',
    descKey: 'quickAsk.modeAskDesc',
    descFallback: 'Ask questions and get answers',
    icon: <MessageSquare size={14} />,
  },
  {
    value: 'edit',
    labelKey: 'quickAsk.modeEdit',
    labelFallback: 'Edit',
    descKey: 'quickAsk.modeEditDesc',
    descFallback: 'Edit the current document',
    icon: <Pencil size={14} />,
  },
  {
    value: 'edit-direct',
    labelKey: 'quickAsk.modeEditDirect',
    labelFallback: 'Edit (Full Access)',
    descKey: 'quickAsk.modeEditDirectDesc',
    descFallback: 'Edit document directly without confirmation',
    icon: <Zap size={14} />,
  },
]

export const ModeSelect = forwardRef<
  HTMLButtonElement,
  {
    mode: QuickAskMode
    onChange: (mode: QuickAskMode) => void
    onMenuOpenChange?: (isOpen: boolean) => void
    onKeyDown?: (
      event: React.KeyboardEvent<HTMLButtonElement>,
      isMenuOpen: boolean,
    ) => void
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
      mode,
      onChange,
      onMenuOpenChange,
      onKeyDown,
      container,
      side = 'bottom',
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
    const itemRefs = useRef<Record<QuickAskMode, HTMLDivElement | null>>({
      ask: null,
      edit: null,
      'edit-direct': null,
    })
    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node
        if (typeof ref === 'function') {
          ref(node)
        } else if (ref) {
          // eslint-disable-next-line no-param-reassign -- React ref object assignment
          ref.current = node
        }
      },
      [ref],
    )

    const currentOption = MODE_OPTIONS.find((opt) => opt.value === mode)

    const focusSelectedItem = useCallback(() => {
      const target = itemRefs.current[mode]
      if (!target) return
      target.focus({ preventScroll: true })
      target.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      })
    }, [mode])

    const focusByDelta = useCallback(
      (delta: number) => {
        const values: QuickAskMode[] = ['ask', 'edit', 'edit-direct']
        const currentIndex = values.indexOf(mode)
        const nextIndex = (currentIndex + delta + values.length) % values.length
        const nextValue = values[nextIndex]
        const target = itemRefs.current[nextValue]
        if (target) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      },
      [mode],
    )

    useEffect(() => {
      if (!isOpen) return
      const rafId = window.requestAnimationFrame(() => {
        focusSelectedItem()
      })
      return () => window.cancelAnimationFrame(rafId)
    }, [isOpen, focusSelectedItem])

    const handleTriggerKeyDown = (
      event: React.KeyboardEvent<HTMLButtonElement>,
    ) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (onKeyDown) {
          onKeyDown(event, isOpen)
        }
        if (event.defaultPrevented) {
          return
        }

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
        return
      }

      if (onKeyDown) {
        onKeyDown(event, isOpen)
      }
    }

    const handleOpenChange = (open: boolean) => {
      setIsOpen(open)
      onMenuOpenChange?.(open)
    }

    return (
      <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenu.Trigger
          ref={setTriggerRef}
          className="smtcmp-chat-input-model-select smtcmp-mode-select"
          onKeyDown={handleTriggerKeyDown}
        >
          <div className="smtcmp-mode-select__icon">{currentOption?.icon}</div>
          <div className="smtcmp-chat-input-model-select__model-name">
            {t(
              currentOption?.labelKey ?? 'quickAsk.modeAsk',
              currentOption?.labelFallback ?? 'Ask',
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
            <DropdownMenu.RadioGroup
              className="smtcmp-model-select-list smtcmp-mode-select-list"
              value={mode}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  focusByDelta(1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  focusByDelta(-1)
                }
              }}
              onValueChange={(value: string) => {
                onChange(value as QuickAskMode)
              }}
            >
              {MODE_OPTIONS.map((option) => (
                <DropdownMenu.RadioItem
                  key={option.value}
                  className="smtcmp-popover-item smtcmp-mode-select-item"
                  value={option.value}
                  ref={(element) => {
                    itemRefs.current[option.value] = element
                  }}
                  data-mode={option.value}
                >
                  <div className="smtcmp-mode-select-item__icon">
                    {option.icon}
                  </div>
                  <div className="smtcmp-mode-select-item__content">
                    <div className="smtcmp-mode-select-item__label">
                      {t(option.labelKey, option.labelFallback)}
                    </div>
                    <div className="smtcmp-mode-select-item__desc">
                      {t(option.descKey, option.descFallback)}
                    </div>
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

ModeSelect.displayName = 'ModeSelect'
