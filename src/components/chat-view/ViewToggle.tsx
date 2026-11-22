import { SquareTerminal } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import RollerSelect from '../common/RollerSelect'
import { YoloOrbitIcon } from '../common/YoloOrbitIcon'

export type ChatSurfaceKind = 'chat' | 'cli'

type ViewToggleProps = {
  activeChatSurface: ChatSurfaceKind
  onChangeChatSurface: (surface: ChatSurfaceKind) => void
  showCliMode: boolean
  disabled?: boolean
}

const ViewToggle: React.FC<ViewToggleProps> = ({
  activeChatSurface,
  onChangeChatSurface,
  showCliMode,
  disabled = false,
}) => {
  const { t } = useLanguage()
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const [popoverWidth, setPopoverWidth] = useState<number | null>(null)
  const toggleRef = useRef<HTMLDivElement | null>(null)
  const hoverCloseTimeoutRef = useRef<number | null>(null)

  const chatLabel = t('sidebar.runtimeSelector.chatLabel', 'Agent')
  const cliLabel = t('sidebar.runtimeSelector.cliLabel', 'CLI')
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
        'Use a supported CLI agent on this device',
      ),
      icon: <SquareTerminal size={14} strokeWidth={2} />,
    },
  ]

  useEffect(() => {
    return () => {
      if (hoverCloseTimeoutRef.current !== null) {
        window.clearTimeout(hoverCloseTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const element = toggleRef.current
    if (!element || !showCliMode) return

    const updateWidth = () => {
      const toggleWidth = Math.round(element.getBoundingClientRect().width)
      const totalWidth = Number.parseFloat(
        (element.ownerDocument.defaultView ?? window)
          .getComputedStyle(element)
          .getPropertyValue('--yolo-total-width'),
      )
      setPopoverWidth(
        Math.round(
          Number.isFinite(totalWidth) && totalWidth > 0
            ? totalWidth
            : toggleWidth,
        ),
      )
    }

    updateWidth()
    const ResizeObserverCtor =
      element.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver
    const resizeObserver = new ResizeObserverCtor(updateWidth)
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

  const triggerClassName = `yolo-view-toggle-button yolo-view-toggle-button--active yolo-view-toggle-button--expanded${
    showCliMode ? ' yolo-view-toggle-button--roller' : ''
  }`

  return (
    <div ref={toggleRef} className="yolo-view-toggle yolo-view-toggle--single">
      {showCliMode ? (
        <RollerSelect
          value={activeChatSurface}
          options={modeOptions}
          open={isModeMenuOpen}
          onOpenChange={(open) => {
            clearHoverCloseTimeout()
            setIsModeMenuOpen(disabled ? false : open)
          }}
          onChange={(value) => {
            if (value !== 'chat' && value !== 'cli') return
            onChangeChatSurface(value)
            clearHoverCloseTimeout()
            setIsModeMenuOpen(false)
          }}
          onValueClick={() => {
            onChangeChatSurface(activeChatSurface === 'chat' ? 'cli' : 'chat')
            clearHoverCloseTimeout()
            setIsModeMenuOpen(false)
          }}
          disabled={disabled}
          ariaLabel={t(
            'sidebar.runtimeSelector.modeAccessibleLabel',
            'Chat mode',
          )}
          triggerClassName={triggerClassName}
          contentStyle={
            popoverWidth
              ? {
                  width: `${popoverWidth}px`,
                  minWidth: `${popoverWidth}px`,
                  maxWidth: `${popoverWidth}px`,
                  marginLeft: '-4px',
                }
              : undefined
          }
          sideOffset={2}
          onTriggerMouseEnter={() => {
            if (disabled) return
            clearHoverCloseTimeout()
            setIsModeMenuOpen(true)
          }}
          onTriggerMouseLeave={closeModeMenuWithDelay}
          onContentMouseEnter={() => {
            if (disabled) return
            clearHoverCloseTimeout()
          }}
          onContentMouseLeave={closeModeMenuWithDelay}
          popover={{
            variant: 'default',
            maxHeight: 400,
            className: 'yolo-popover-view-toggle-mode',
          }}
        />
      ) : (
        <div className={triggerClassName}>
          <span className="yolo-view-toggle-button-icon" aria-hidden="true">
            <YoloOrbitIcon size={16} />
          </span>
          <span className="yolo-view-toggle-button-label">{chatLabel}</span>
        </div>
      )}
      <div className="yolo-view-toggle-indicator yolo-view-toggle-indicator--single" />
    </div>
  )
}

export default ViewToggle
