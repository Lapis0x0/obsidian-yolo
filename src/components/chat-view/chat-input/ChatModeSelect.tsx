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

/**
 * Capability modes. These are mutually exclusive and describe what the chat is
 * allowed to do. "Auto-approve tool calls" (YOLO) is NOT a mode — it is an
 * orthogonal boolean (`yoloEnabled`) that only takes effect while in Agent
 * mode. See `chat-runtime-profiles.ts`.
 */
export type ChatMode = 'ask' | 'agent'

export const CHAT_MODES: readonly ChatMode[] = ['ask', 'agent']

export const isChatMode = (value: string): value is ChatMode =>
  value === 'ask' || value === 'agent'

export const normalizeChatMode = (
  raw: string | null | undefined,
  fallback: ChatMode = 'agent',
): ChatMode => {
  if (raw === 'chat') {
    return 'ask'
  }
  // Legacy value: `agent-full` used to encode "agent + auto-approval". The
  // capability is just Agent now; the YOLO bit is recovered via
  // `normalizeYoloEnabled`.
  if (raw === 'agent-full') {
    return 'agent'
  }
  if (raw && isChatMode(raw)) {
    return raw
  }
  return fallback
}

/**
 * Recover the orthogonal YOLO flag, including from the legacy `agent-full`
 * value that conflated mode and auto-approval.
 */
export const normalizeYoloEnabled = (
  rawMode: string | null | undefined,
  rawYolo: boolean | null | undefined,
  fallback = false,
): boolean => {
  if (rawMode === 'agent-full') {
    return true
  }
  if (typeof rawYolo === 'boolean') {
    return rawYolo
  }
  return fallback
}

export const isAgentChatMode = (mode: ChatMode): boolean => mode === 'agent'

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
]

// Keyboard navigation order across the focusable controls in the dropdown.
type NavKey = 'ask' | 'agent' | 'yolo'
const NAV_ORDER: readonly NavKey[] = ['ask', 'agent', 'yolo']

export const ChatModeSelect = forwardRef<
  HTMLButtonElement,
  {
    mode: ChatMode
    onChange: (mode: ChatMode) => void
    yoloEnabled: boolean
    onYoloChange: (enabled: boolean) => void
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
      yoloEnabled,
      onYoloChange,
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
    const itemRefs = useRef<Record<NavKey, HTMLElement | null>>({
      ask: null,
      agent: null,
      yolo: null,
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
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }, [mode])

    const focusByDelta = useCallback(
      (delta: number) => {
        const ownerWindow = getNodeWindow(triggerRef.current)
        const activeEl = ownerWindow.document.activeElement
        let currentIndex = NAV_ORDER.findIndex(
          (key) => itemRefs.current[key] === activeEl,
        )
        if (currentIndex < 0) {
          currentIndex = NAV_ORDER.indexOf(mode)
        }
        const nextIndex =
          (currentIndex + delta + NAV_ORDER.length) % NAV_ORDER.length
        const target = itemRefs.current[NAV_ORDER[nextIndex]]
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

    const handleOpenChange = (open: boolean) => {
      setIsOpen(open)
      onMenuOpenChange?.(open)
    }

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

    const selectMode = (next: ChatMode) => {
      onChange(next)
      handleOpenChange(false)
    }

    const handleYoloToggle = () => {
      // Behavior A: YOLO is orthogonal. Toggling it never changes the
      // capability mode and keeps the menu open so the switch state is visible.
      onYoloChange(!yoloEnabled)
    }

    // We render the list as plain buttons (not Radix RadioItem/Item) so the
    // Agent card can host an independent YOLO toggle without fighting Radix's
    // "the whole item is one selectable unit" model. Radix still owns the
    // popover surface (portal, positioning, dismiss, focus trap); we own the
    // arrow-key navigation across the three buttons.
    const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        focusByDelta(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        focusByDelta(-1)
      }
    }
    const isYoloActive = isAgentChatMode(mode) && yoloEnabled

    return (
      <DropdownMenu.Root open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenu.Trigger
          ref={setTriggerRef}
          className="yolo-chat-input-model-select yolo-chat-mode-select"
          data-mode={mode}
          data-yolo={isYoloActive ? 'on' : 'off'}
          onKeyDown={handleTriggerKeyDown}
        >
          <div className="yolo-chat-input-model-select__model-name">
            {t(
              currentOption?.labelKey ?? 'chatMode.ask',
              currentOption?.labelFallback ?? 'Ask',
            )}
          </div>
          {isYoloActive ? (
            <div
              className="yolo-chat-mode-select__yolo-badge"
              title={t('chatMode.yolo', 'YOLO')}
            >
              <InfinityIcon size={11} />
            </div>
          ) : null}
          <div className="yolo-chat-input-model-select__icon">
            {isOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </DropdownMenu.Trigger>

        <YoloDropdownContent
          container={container}
          anchorRef={triggerRef}
          variant="default"
          minWidth={220}
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
          <div
            className="yolo-model-select-list yolo-chat-mode-select-list"
            role="menu"
            onKeyDown={handleListKeyDown}
          >
            {MODE_OPTIONS.map((option) => {
              const isSelected = option.value === mode
              if (option.value === 'agent') {
                return (
                  <div
                    key={option.value}
                    role="menuitemradio"
                    tabIndex={0}
                    aria-checked={isSelected}
                    className="yolo-popover-item yolo-chat-mode-agent-card"
                    data-mode="agent"
                    data-state={isSelected ? 'checked' : 'unchecked'}
                    ref={(element) => {
                      itemRefs.current.agent = element
                    }}
                    onClick={() => selectMode('agent')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        selectMode('agent')
                      }
                    }}
                  >
                    <span className="yolo-chat-mode-select-item__icon">
                      {option.icon}
                    </span>
                    <span className="yolo-chat-mode-select-item__content">
                      <span className="yolo-chat-mode-agent-card__title-row">
                        <span className="yolo-chat-mode-select-item__label">
                          {t(option.labelKey, option.labelFallback)}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={yoloEnabled}
                          data-active={yoloEnabled}
                          ref={(element) => {
                            itemRefs.current.yolo = element
                          }}
                          className="yolo-chat-mode-yolo-toggle"
                          title={t(
                            'chatMode.yoloDesc',
                            'Auto-approve tool calls for complex tasks',
                          )}
                          onClick={(event) => {
                            event.stopPropagation()
                            handleYoloToggle()
                          }}
                        >
                          <span className="yolo-chat-mode-yolo-toggle__label">
                            {t('chatMode.yolo', 'YOLO')}
                          </span>
                          <span
                            className="yolo-chat-mode-yolo-toggle__switch"
                            aria-hidden="true"
                          >
                            <span className="yolo-chat-mode-yolo-toggle__thumb" />
                          </span>
                        </button>
                      </span>
                      <span className="yolo-chat-mode-select-item__desc">
                        {t(option.descKey, option.descFallback)}
                      </span>
                    </span>
                  </div>
                )
              }

              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  data-mode={option.value}
                  data-state={isSelected ? 'checked' : 'unchecked'}
                  ref={(element) => {
                    itemRefs.current[option.value as NavKey] = element
                  }}
                  className="yolo-popover-item yolo-chat-mode-select-item"
                  onClick={() => selectMode(option.value)}
                >
                  <span className="yolo-chat-mode-select-item__icon">
                    {option.icon}
                  </span>
                  <span className="yolo-chat-mode-select-item__content">
                    <span className="yolo-chat-mode-select-item__label">
                      {t(option.labelKey, option.labelFallback)}
                    </span>
                    <span className="yolo-chat-mode-select-item__desc">
                      {t(option.descKey, option.descFallback)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </YoloDropdownContent>
      </DropdownMenu.Root>
    )
  },
)

ChatModeSelect.displayName = 'ChatModeSelect'
