import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Infinity as InfinityIcon,
  MessageSquare,
} from 'lucide-react'
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { getNodeWindow } from '../../../utils/dom/window-context'
import { YoloDropdownContent } from '../../common/popover'

export type ChatMode = 'ask' | 'agent' | 'agent-full'

export const CHAT_MODES: readonly ChatMode[] = ['ask', 'agent', 'agent-full']

export const isChatMode = (value: string): value is ChatMode =>
  value === 'ask' || value === 'agent' || value === 'agent-full'

export const normalizeChatMode = (
  raw: string | null | undefined,
  fallback: ChatMode = 'agent',
): ChatMode => {
  if (raw === 'chat') {
    return 'ask'
  }
  if (raw && isChatMode(raw)) {
    return raw
  }
  return fallback
}

export const isAgentChatMode = (mode: ChatMode): boolean =>
  mode === 'agent' || mode === 'agent-full'

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
    value: 'ask',
    labelKey: 'chatMode.ask',
    labelFallback: 'Ask',
    descKey: 'chatMode.askDesc',
    descFallback: 'Ask, refine, create',
    icon: <MessageSquare size={16} />,
  },
  {
    value: 'agent',
    labelKey: 'chatMode.agent',
    labelFallback: 'Agent',
    descKey: 'chatMode.agentDesc',
    descFallback: 'Tools for complex tasks',
    icon: <Bot size={16} />,
  },
  {
    value: 'agent-full',
    labelKey: 'chatMode.agentFull',
    labelFallback: 'Agent (Full Access)',
    descKey: 'chatMode.agentFullDesc',
    descFallback: 'Auto-approve all tool calls',
    icon: <InfinityIcon size={16} />,
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
      alignOffset = -12,
    },
    ref,
  ) => {
    const { t } = useLanguage()
    const [isOpen, setIsOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const itemRefs = useRef<Record<ChatMode, HTMLDivElement | null>>({
      ask: null,
      agent: null,
      'agent-full': null,
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
        const values = [...CHAT_MODES]
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
      const ownerWindow = getNodeWindow(triggerRef.current)
      const rafId = ownerWindow.requestAnimationFrame(() => {
        focusSelectedItem()
      })
      return () => ownerWindow.cancelAnimationFrame(rafId)
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
          className="yolo-chat-input-model-select yolo-chat-mode-select"
          data-mode={mode}
          onKeyDown={handleTriggerKeyDown}
        >
          <div className="yolo-chat-input-model-select__model-name">
            {t(
              currentOption?.labelKey ?? 'chatMode.ask',
              currentOption?.labelFallback ?? 'Ask',
            )}
          </div>
          <div className="yolo-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <YoloDropdownContent
          container={container}
          anchorRef={triggerRef}
          variant="default"
          minWidth={220}
          maxHeight={400}
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
            className="yolo-model-select-list yolo-chat-mode-select-list"
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
                className="yolo-popover-item yolo-chat-mode-select-item"
                value={option.value}
                ref={(element) => {
                  itemRefs.current[option.value] = element
                }}
                data-mode={option.value}
              >
                <div className="yolo-chat-mode-select-item__icon">
                  {option.icon}
                </div>
                <div className="yolo-chat-mode-select-item__content">
                  <div className="yolo-chat-mode-select-item__label">
                    {t(option.labelKey, option.labelFallback)}
                  </div>
                  <div className="yolo-chat-mode-select-item__desc">
                    {t(option.descKey, option.descFallback)}
                  </div>
                </div>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </YoloDropdownContent>
      </DropdownMenu.Root>
    )
  },
)

ChatModeSelect.displayName = 'ChatModeSelect'
