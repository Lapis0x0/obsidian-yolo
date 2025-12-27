import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ChevronDown,
  ChevronUp,
  Infinity as InfinityIcon,
  MessageSquare,
} from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'

export type ChatMode = 'chat' | 'agent'

const isChatMode = (value: string): value is ChatMode =>
  value === 'chat' || value === 'agent'

type ModeOption = {
  value: ChatMode
  labelKey: string
  labelFallback: string
  descKey: string
  descFallback: string
  icon: React.ReactNode
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'chat',
    labelKey: 'chatMode.chat',
    labelFallback: 'Chat',
    descKey: 'chatMode.chatDesc',
    descFallback: 'Normal conversation mode',
    icon: <MessageSquare size={14} />,
  },
  {
    value: 'agent',
    labelKey: 'chatMode.agent',
    labelFallback: 'Agent',
    descKey: 'chatMode.agentDesc',
    descFallback: 'Enable tool calling capabilities',
    icon: <InfinityIcon size={14} />,
  },
]

export const ChatModeSelect = forwardRef<
  HTMLButtonElement,
  {
    mode: ChatMode
    onChange: (mode: ChatMode) => void
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
    const itemRefs = useRef<Record<ChatMode, HTMLDivElement | null>>({
      chat: null,
      agent: null,
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
        const values: ChatMode[] = ['chat', 'agent']
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
          className="smtcmp-chat-input-model-select smtcmp-chat-mode-select"
          onKeyDown={handleTriggerKeyDown}
        >
          <div className="smtcmp-chat-mode-select__icon">
            {currentOption?.icon}
          </div>
          <div className="smtcmp-chat-input-model-select__model-name">
            {t(
              currentOption?.labelKey ?? 'chatMode.chat',
              currentOption?.labelFallback ?? 'Chat',
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
              className="smtcmp-model-select-list smtcmp-chat-mode-select-list"
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
              onValueChange={(value) => {
                if (isChatMode(value)) {
                  onChange(value)
                }
              }}
            >
              {MODE_OPTIONS.map((option) => (
                <DropdownMenu.RadioItem
                  key={option.value}
                  className="smtcmp-popover-item smtcmp-chat-mode-select-item"
                  value={option.value}
                  ref={(element) => {
                    itemRefs.current[option.value] = element
                  }}
                  data-mode={option.value}
                >
                  <div className="smtcmp-chat-mode-select-item__icon">
                    {option.icon}
                  </div>
                  <div className="smtcmp-chat-mode-select-item__content">
                    <div className="smtcmp-chat-mode-select-item__label">
                      {t(option.labelKey, option.labelFallback)}
                    </div>
                    <div className="smtcmp-chat-mode-select-item__desc">
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

ChatModeSelect.displayName = 'ChatModeSelect'
