import { Sparkles, SquareTerminal } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import RollerSelect from '../common/RollerSelect'
import { YoloOrbitIcon } from '../common/YoloOrbitIcon'

export type ChatSurfaceKind = 'chat' | 'cli'

type ViewToggleProps = {
  activeView: 'chat' | 'composer'
  onChangeView: (view: 'chat' | 'composer') => void
  activeChatSurface: ChatSurfaceKind
  onChangeChatSurface: (surface: ChatSurfaceKind) => void
  showCliMode: boolean
  showComposer?: boolean
  disabled?: boolean
}

const ViewToggle: React.FC<ViewToggleProps> = ({
  activeView,
  onChangeView,
  activeChatSurface,
  onChangeChatSurface,
  showCliMode,
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

  const chatLabel = t('sidebar.runtimeSelector.chatLabel', 'Agent')
  const cliLabel = t('sidebar.runtimeSelector.cliLabel', 'CLI')
  const composerLabel = t('sidebar.tabs.composer', 'Sparkle')
  const modeOptions = [
    {
      value: 'chat',
      label: chatLabel,
      description: t(
        'sidebar.runtimeSelector.chatDescription',
        'Built-in YOLO chat',
      ),
      icon: <YoloOrbitIcon size={14} />,
    },
    {
      value: 'cli',
      label: cliLabel,
      description: t(
        'sidebar.runtimeSelector.cliDescription',
        'Claude Code or Codex on this device',
      ),
      icon: <SquareTerminal size={14} strokeWidth={2} />,
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
      }
    }
  }, [isModeClickOpenBlocked])

  useEffect(() => {
    const element = toggleRef.current
    if (!element || !showCliMode) return

    const updateWidth = () => {
      const nextToggleWidth = Math.round(element.getBoundingClientRect().width)
      const totalWidth = Number.parseFloat(
        (element.ownerDocument.defaultView ?? window)
          .getComputedStyle(element)
          .getPropertyValue('--yolo-total-width'),
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
    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(element)
    return () => resizeObserver.disconnect()
  }, [showCliMode])

  const clearHoverCloseTimeout = () => {
    if (hoverCloseTimeoutRef.current !== null) {
      window.clearTimeout(hoverCloseTimeoutRef.current)
      hoverCloseTimeoutRef.current = null
    }
  }

  const closeModeMenuWithDelay = () => {
    clearHoverCloseTimeout()
    hoverCloseTimeoutRef.current = window.setTimeout(() => {
      setIsModeMenuOpen(false)
      hoverCloseTimeoutRef.current = null
    }, 150)
  }

  const chatTriggerClassName = `yolo-view-toggle-button ${
    showCliMode ? 'yolo-view-toggle-button--roller ' : ''
  }${activeView === 'chat' ? 'yolo-view-toggle-button--active' : ''} ${
    expandedView === 'chat' ? 'yolo-view-toggle-button--expanded' : ''
  }`
  return (
    <div
      ref={toggleRef}
      className={`yolo-view-toggle${showComposer ? '' : ' yolo-view-toggle--single'}`}
      data-expanded-view={expandedView}
      data-active-expanded={isActiveExpanded ? 'true' : 'false'}
    >
      {showCliMode ? (
        <RollerSelect
          value={activeChatSurface}
          options={modeOptions}
          onActivate={() => {
            if (activeView !== 'chat') setIsModeClickOpenBlocked(true)
            onChangeView('chat')
          }}
          open={isModeMenuOpen}
          onOpenChange={(open) => {
            clearHoverCloseTimeout()
            if (
              disabled ||
              activeView !== 'chat' ||
              (open && isModeClickOpenBlocked)
            ) {
              setIsModeMenuOpen(false)
              return
            }
            setIsModeMenuOpen(open)
            if (open) setHoveredView('chat')
          }}
          onChange={(value) => {
            if (value !== 'chat' && value !== 'cli') return
            onChangeChatSurface(value)
            onChangeView('chat')
            clearHoverCloseTimeout()
            setIsModeMenuOpen(false)
          }}
          onValueClick={() => {
            if (activeView !== 'chat') {
              onChangeView('chat')
              clearHoverCloseTimeout()
              setIsModeMenuOpen(false)
              return
            }
            const nextSurface = activeChatSurface === 'chat' ? 'cli' : 'chat'
            onChangeChatSurface(nextSurface)
            onChangeView('chat')
            clearHoverCloseTimeout()
            setIsModeMenuOpen(false)
          }}
          disabled={disabled}
          ariaLabel={t(
            'sidebar.runtimeSelector.modeAccessibleLabel',
            'Chat mode',
          )}
          triggerClassName={chatTriggerClassName}
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
            clearHoverCloseTimeout()
            if (activeView === 'chat') setIsModeMenuOpen(true)
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
      ) : (
        <button
          type="button"
          className={chatTriggerClassName}
          onClick={() => onChangeView('chat')}
          onMouseEnter={() => !disabled && setHoveredView('chat')}
          onMouseLeave={() => setHoveredView(null)}
          disabled={disabled}
          aria-pressed={activeView === 'chat'}
        >
          <span className="yolo-view-toggle-button-icon" aria-hidden="true">
            <YoloOrbitIcon size={16} />
          </span>
          <span className="yolo-view-toggle-button-label">{chatLabel}</span>
        </button>
      )}
      {showComposer ? (
        <button
          type="button"
          className={`yolo-view-toggle-button ${
            activeView === 'composer' ? 'yolo-view-toggle-button--active' : ''
          } ${
            expandedView === 'composer'
              ? 'yolo-view-toggle-button--expanded'
              : ''
          }`}
          onClick={() => onChangeView('composer')}
          onMouseEnter={() => !disabled && setHoveredView('composer')}
          onMouseLeave={() => setHoveredView(null)}
          disabled={disabled}
          aria-pressed={activeView === 'composer'}
        >
          <span className="yolo-view-toggle-button-icon" aria-hidden="true">
            <Sparkles size={16} strokeWidth={2} />
          </span>
          <span className="yolo-view-toggle-button-label">{composerLabel}</span>
        </button>
      ) : null}
      <div
        className={`yolo-view-toggle-indicator${showComposer ? '' : ' yolo-view-toggle-indicator--single'}`}
        data-active-view={activeView}
      />
    </div>
  )
}

export default ViewToggle
