import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { useSettings } from '../../contexts/settings-context'

import type { SelectionInfo } from './SelectionManager'

export type SelectionAction = {
  id: string
  label: string
  instruction: string
  handler: () => void | Promise<void>
}

type SelectionActionsMenuProps = {
  selection: SelectionInfo
  containerEl: HTMLElement
  indicatorPosition: { left: number; top: number }
  visible: boolean
  onAction: (actionId: string, instruction: string) => void | Promise<void>
  onHoverChange: (isHovering: boolean) => void
}

export function SelectionActionsMenu({
  selection,
  containerEl,
  indicatorPosition,
  visible,
  onAction,
  onHoverChange,
}: SelectionActionsMenuProps) {
  const { t } = useLanguage()
  const { settings } = useSettings()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [isVisible, setIsVisible] = useState(false)
  const showTimerRef = useRef<number | null>(null)

  const defaultActions = useMemo(
    () => [
      {
        id: 'explain',
        label: t('selection.actions.explain', '深入解释'),
        instruction: t('selection.actions.explain', '深入解释'),
      },
      {
        id: 'suggest',
        label: t('selection.actions.suggest', '提供建议'),
        instruction: t('selection.actions.suggest', '提供建议'),
      },
      {
        id: 'translate-to-chinese',
        label: t('selection.actions.translateToChinese', '翻译成中文'),
        instruction: t('selection.actions.translateToChinese', '翻译成中文'),
      },
    ],
    [t],
  )

  const actions: SelectionAction[] = useMemo(() => {
    const customActions = settings?.continuationOptions?.selectionChatActions
    const resolvedActions =
      customActions && customActions.length > 0
        ? customActions.filter((action) => action.enabled)
        : defaultActions

    return resolvedActions.map((action) => {
      const label = action.label?.trim() || ''
      const instruction = action.instruction?.trim() || label
      return {
        id: action.id,
        label: label || action.id,
        instruction: instruction || label || action.id,
        handler: () => onAction(action.id, instruction || label || action.id),
      }
    })
  }, [
    defaultActions,
    onAction,
    settings?.continuationOptions?.selectionChatActions,
  ])

  const updatePosition = useCallback(() => {
    const containerRect = containerEl.getBoundingClientRect()
    // Position menu relative to indicator
    const menuWidth = 200 // Approximate menu width
    const menuHeight = 44 * actions.length + 16 // Approximate height
    const offset = 8

    let left = indicatorPosition.left + 28 + offset // 28px is indicator width
    let top = indicatorPosition.top

    // Ensure menu stays within container bounds
    const viewportWidth = containerRect.width
    const viewportHeight = containerRect.height

    if (left + menuWidth > viewportWidth - 8) {
      // Position to the left of indicator
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
  }, [
    actions.length,
    containerEl,
    indicatorPosition.left,
    indicatorPosition.top,
  ])

  useEffect(() => {
    updatePosition()
  }, [selection, updatePosition])

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
    }),
    [position.left, position.top],
  )

  const menuClasses =
    `smtcmp-selection-menu ${isVisible ? 'visible' : ''}`.trim()

  return (
    <div
      ref={menuRef}
      className={menuClasses}
      style={positionStyles}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="smtcmp-selection-menu-content">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="smtcmp-selection-menu-item"
            onClick={() => void handleActionClick(action)}
          >
            <span className="smtcmp-selection-menu-item-label">
              {action.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
