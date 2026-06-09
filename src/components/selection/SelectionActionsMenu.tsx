import { Platform } from 'obsidian'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { useSettings } from '../../contexts/settings-context'
import { resolveSelectionChatActions } from '../../features/editor/selection-chat/resolveSelectionChatActions'
import type { SelectionInfo } from './SelectionManager'

export type SelectionActionMode = 'ask' | 'rewrite' | 'chat-input' | 'chat-send'
export type SelectionActionRewriteBehavior = 'custom' | 'preset'

export type SelectionAction = {
  id: string
  label: string
  instruction: string
  mode: SelectionActionMode
  rewriteBehavior?: SelectionActionRewriteBehavior
  assistantId?: string
  handler: () => void | Promise<void>
}

type SelectionActionsMenuProps = {
  selection: SelectionInfo
  containerEl: HTMLElement
  indicatorPosition: { left: number; top: number }
  visible: boolean
  onAction: (
    actionId: string,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
    assistantId?: string,
  ) => void | Promise<void>
  onHoverChange: (isHovering: boolean) => void
  /** PDF selections cannot be rewritten — pass 'pdf' to hide rewrite actions. */
  source?: 'markdown' | 'pdf'
}

export function SelectionActionsMenu({
  selection,
  containerEl,
  indicatorPosition,
  visible,
  onAction,
  onHoverChange,
  source = 'markdown',
}: SelectionActionsMenuProps) {
  const isMobile = !Platform.isDesktop
  const { t } = useLanguage()
  const { settings } = useSettings()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [isVisible, setIsVisible] = useState(false)
  const showTimerRef = useRef<number | null>(null)

  const actions: SelectionAction[] = useMemo(() => {
    if (!settings) return []
    const resolved = resolveSelectionChatActions(settings, t)
    // PDF selections have no writable target: filter out all rewrite-mode actions.
    const displayActions =
      source === 'pdf'
        ? resolved.filter((action) => action.mode !== 'rewrite')
        : resolved

    return displayActions.map((action) => ({
      id: action.id,
      label: action.label,
      instruction: action.instruction,
      mode: action.mode,
      rewriteBehavior: action.rewriteBehavior,
      assistantId: action.assistantId,
      handler: () =>
        onAction(
          action.id,
          action.instruction,
          action.mode,
          action.rewriteBehavior,
          action.assistantId,
        ),
    }))
  }, [settings, t, source, onAction])

  const getMenuSize = useCallback(() => {
    const measuredWidth = menuRef.current?.offsetWidth ?? 0
    const measuredHeight = menuRef.current?.offsetHeight ?? 0

    return {
      width: measuredWidth > 0 ? measuredWidth : 180,
      height: measuredHeight > 0 ? measuredHeight : 44 * actions.length + 16,
    }
  }, [actions.length])

  const updatePosition = useCallback(() => {
    const containerRect = containerEl.getBoundingClientRect()
    const offset = 8
    const viewportWidth = containerRect.width
    const viewportHeight = containerRect.height
    const indicatorWidth = 28
    const indicatorHeight = 28
    let left = indicatorPosition.left + indicatorWidth + offset
    let top = indicatorPosition.top

    if (!isMobile) {
      const menuWidth = 200
      const menuHeight = 44 * actions.length + 16

      if (left + menuWidth > viewportWidth - 8) {
        left = indicatorPosition.left - menuWidth - offset
      }
      if (left < 8) {
        left = 8
      }

      if (top + menuHeight > viewportHeight - 8) {
        top = viewportHeight - menuHeight - 8
      }
      if (top < 8) {
        top = 8
      }

      setPosition({ left, top })
      return
    }

    const { width: menuWidth, height: menuHeight } = getMenuSize()
    const minLeft = 8
    const maxLeft = Math.max(minLeft, containerRect.width - menuWidth - 8)
    const preferredRightLeft = indicatorPosition.left + indicatorWidth + offset
    const preferredLeftLeft = indicatorPosition.left - menuWidth - offset
    const fallbackAlignedLeft =
      indicatorPosition.left + indicatorWidth - menuWidth

    if (preferredRightLeft + menuWidth <= viewportWidth - 8) {
      left = preferredRightLeft
    } else if (preferredLeftLeft >= minLeft) {
      left = preferredLeftLeft
    } else {
      left = Math.min(maxLeft, Math.max(minLeft, fallbackAlignedLeft))
    }

    if (top + menuHeight > viewportHeight - 8) {
      top = Math.max(8, indicatorPosition.top + indicatorHeight - menuHeight)
    }
    if (top < 8) {
      top = 8
    }

    setPosition({ left, top })
  }, [
    actions.length,
    containerEl,
    getMenuSize,
    indicatorPosition.left,
    indicatorPosition.top,
    isMobile,
  ])

  useEffect(() => {
    updatePosition()
  }, [selection, updatePosition, visible])

  useEffect(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }

    if (visible) {
      updatePosition()
      // small delay to allow position styles to apply before transition
      showTimerRef.current = window.setTimeout(() => {
        setIsVisible(true)
        showTimerRef.current = null
      }, 10)
    } else {
      setIsVisible(false)
    }

    return () => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current)
        showTimerRef.current = null
      }
    }
  }, [updatePosition, visible])

  const handleMouseEnter = () => {
    onHoverChange(true)
  }

  const handleMouseLeave = () => {
    onHoverChange(false)
  }

  const handleActionClick = async (action: SelectionAction) => {
    await action.handler()
  }

  const positionStyles = useMemo(
    () => ({
      left: `${Math.round(position.left)}px`,
      top: `${Math.round(position.top)}px`,
      ...(isMobile
        ? {
            minWidth: '160px',
            maxWidth: 'min(280px, calc(100vw - 24px))',
          }
        : {}),
    }),
    [isMobile, position.left, position.top],
  )

  const menuClasses = `yolo-selection-menu ${isVisible ? 'visible' : ''}`.trim()

  return (
    <div
      ref={menuRef}
      className={menuClasses}
      style={positionStyles}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="yolo-selection-menu-content">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="yolo-selection-menu-item"
            onClick={() => void handleActionClick(action)}
          >
            <span className="yolo-selection-menu-item-label">
              {action.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
