import { Infinity as InfinityIcon, MessageCircle, PenLine } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import RollerSelect from '../common/RollerSelect'

import { ChatMode } from './chat-input/ChatModeSelect'

type ViewToggleProps = {
  activeView: 'chat' | 'composer'
  onChangeView: (view: 'chat' | 'composer') => void
  chatMode: ChatMode
  onChangeChatMode: (mode: ChatMode) => void
  showComposer?: boolean
  disabled?: boolean
}

const ViewToggle: React.FC<ViewToggleProps> = ({
  activeView,
  onChangeView,
  chatMode,
  onChangeChatMode,
  showComposer = true,
  disabled = false,
}) => {
  const { t } = useLanguage()
  const [hoveredView, setHoveredView] = useState<'chat' | 'composer' | null>(
    null,
  )
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const [isModeClickOpenBlocked, setIsModeClickOpenBlocked] = useState(false)
  const [toggleWidth, setToggleWidth] = useState<number | null>(null)
  const [popoverWidth, setPopoverWidth] = useState<number | null>(null)
  const toggleRef = useRef<HTMLDivElement | null>(null)
  const clickOpenBlockTimeoutRef = useRef<number | null>(null)
  const hoverCloseTimeoutRef = useRef<number | null>(null)

  const chatLabel = t('sidebar.tabs.chat', 'Chat')
  const agentLabel = t('chatMode.agent', 'Agent')
  const composerLabel = t('sidebar.tabs.composer', 'Composer')
  const chatModeDesc = t('chatMode.chatDesc', 'Ask, refine, create')
  const agentModeDesc = t('chatMode.agentDesc', 'Tools for complex tasks')

  const modeOptions = [
    {
      value: 'chat',
      label: chatLabel,
      description: chatModeDesc,
      icon: <MessageCircle size={14} strokeWidth={2} />,
    },
    {
      value: 'agent',
      label: agentLabel,
      description: agentModeDesc,
      icon: <InfinityIcon size={14} strokeWidth={2} />,
    },
  ]

  const expandedView = showComposer ? hoveredView || activeView : 'chat'
  const isActiveExpanded = expandedView === activeView

  useEffect(() => {
    if (activeView !== 'chat') {
      if (hoverCloseTimeoutRef.current !== null) {
        window.clearTimeout(hoverCloseTimeoutRef.current)
        hoverCloseTimeoutRef.current = null
      }
      setIsModeMenuOpen(false)
    }
  }, [activeView])

  useEffect(() => {
    return () => {
      if (hoverCloseTimeoutRef.current !== null) {
        window.clearTimeout(hoverCloseTimeoutRef.current)
        hoverCloseTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!isModeClickOpenBlocked) {
      if (clickOpenBlockTimeoutRef.current !== null) {
        window.clearTimeout(clickOpenBlockTimeoutRef.current)
        clickOpenBlockTimeoutRef.current = null
      }
      return
    }

    clickOpenBlockTimeoutRef.current = window.setTimeout(() => {
      setIsModeClickOpenBlocked(false)
      clickOpenBlockTimeoutRef.current = null
    }, 220)

    return () => {
      if (clickOpenBlockTimeoutRef.current !== null) {
        window.clearTimeout(clickOpenBlockTimeoutRef.current)
        clickOpenBlockTimeoutRef.current = null
      }
    }
  }, [isModeClickOpenBlocked])

  useEffect(() => {
    const element = toggleRef.current
    if (!element) return

    const updateWidth = () => {
      const nextToggleWidth = Math.round(element.getBoundingClientRect().width)
      const totalWidth = Number.parseFloat(
        window
          .getComputedStyle(element)
          .getPropertyValue('--smtcmp-total-width'),
      )

      setToggleWidth(nextToggleWidth)
      setPopoverWidth(
        Math.round(
          Number.isFinite(totalWidth) && totalWidth > 0
            ? totalWidth
            : nextToggleWidth,
        ),
      )
    }

    updateWidth()

    const resizeObserver = new ResizeObserver(() => {
      updateWidth()
    })
    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  const clearHoverCloseTimeout = () => {
    if (hoverCloseTimeoutRef.current !== null) {
      window.clearTimeout(hoverCloseTimeoutRef.current)
      hoverCloseTimeoutRef.current = null
    }
  }

  const openModeMenuOnHover = () => {
    if (disabled || activeView !== 'chat') return
    clearHoverCloseTimeout()
    setIsModeMenuOpen(true)
  }

  const closeModeMenuWithDelay = () => {
    clearHoverCloseTimeout()
    hoverCloseTimeoutRef.current = window.setTimeout(() => {
      setIsModeMenuOpen(false)
      hoverCloseTimeoutRef.current = null
    }, 150)
  }

  return (
    <div
      ref={toggleRef}
      className={`smtcmp-view-toggle${showComposer ? '' : ' smtcmp-view-toggle--single'}`}
      data-expanded-view={expandedView}
      data-active-expanded={isActiveExpanded ? 'true' : 'false'}
    >
      <RollerSelect
        value={chatMode}
        options={modeOptions}
        onActivate={() => {
          if (activeView !== 'chat') {
            setIsModeClickOpenBlocked(true)
          }
          onChangeView('chat')
        }}
        open={isModeMenuOpen}
        onOpenChange={(open) => {
          clearHoverCloseTimeout()
          if (disabled || activeView !== 'chat') {
            setIsModeMenuOpen(false)
            return
          }

          if (open && isModeClickOpenBlocked) {
            setIsModeMenuOpen(false)
            return
          }

          setIsModeMenuOpen(open)
          if (open) {
            setHoveredView('chat')
          }
        }}
        onChange={(value) => {
          if (value !== 'chat' && value !== 'agent') return
          onChangeChatMode(value)
          onChangeView('chat')
          clearHoverCloseTimeout()
          setIsModeMenuOpen(false)
        }}
        disabled={disabled}
        triggerClassName={`smtcmp-view-toggle-button smtcmp-view-toggle-button--roller ${
          activeView === 'chat' ? 'smtcmp-view-toggle-button--active' : ''
        } ${
          expandedView === 'chat' ? 'smtcmp-view-toggle-button--expanded' : ''
        }`}
        contentStyle={
          (showComposer ? toggleWidth : popoverWidth)
            ? {
                width: `${showComposer ? toggleWidth : popoverWidth}px`,
                minWidth: `${showComposer ? toggleWidth : popoverWidth}px`,
                maxWidth: `${showComposer ? toggleWidth : popoverWidth}px`,
                marginLeft: '-4px',
              }
            : undefined
        }
        sideOffset={2}
        onTriggerMouseEnter={() => {
          if (disabled) return
          setHoveredView('chat')
          openModeMenuOnHover()
        }}
        onTriggerMouseLeave={() => {
          setHoveredView(null)
          closeModeMenuWithDelay()
        }}
        onContentMouseEnter={() => {
          if (disabled) return
          setHoveredView('chat')
          clearHoverCloseTimeout()
        }}
        onContentMouseLeave={() => {
          setHoveredView(null)
          closeModeMenuWithDelay()
        }}
        popover={{
          variant: 'default',
          maxHeight: 400,
          className: 'yolo-popover-view-toggle-mode',
        }}
      />
      {showComposer ? (
        <button
          type="button"
          className={`smtcmp-view-toggle-button ${
            activeView === 'composer' ? 'smtcmp-view-toggle-button--active' : ''
          } ${
            expandedView === 'composer'
              ? 'smtcmp-view-toggle-button--expanded'
              : ''
          }`}
          onClick={() => onChangeView('composer')}
          onMouseEnter={() => !disabled && setHoveredView('composer')}
          onMouseLeave={() => setHoveredView(null)}
          disabled={disabled}
          aria-pressed={activeView === 'composer'}
        >
          <span className="smtcmp-view-toggle-button-icon" aria-hidden="true">
            <PenLine size={16} strokeWidth={2} />
          </span>
          <span className="smtcmp-view-toggle-button-label">
            {composerLabel}
          </span>
        </button>
      ) : null}
      <div
        className={`smtcmp-view-toggle-indicator${showComposer ? '' : ' smtcmp-view-toggle-indicator--single'}`}
        data-active-view={activeView}
      />
    </div>
  )
}

export default ViewToggle
