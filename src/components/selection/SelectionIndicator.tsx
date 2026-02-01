import { Sparkles } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SelectionInfo } from './SelectionManager'

const getIndicatorPosition = (
  selection: SelectionInfo,
  containerEl: HTMLElement,
  offset: number,
): { left: number; top: number } => {
  const { rect } = selection
  const containerRect = containerEl.getBoundingClientRect()
  const isRTL = document.dir === 'rtl'

  let left: number
  let top: number

  if (isRTL) {
    // For RTL, position to the left of the selection
    left = rect.left - containerRect.left - 28 - offset // 28px is approximate indicator width
  } else {
    // For LTR, position to the right of the selection
    left = rect.right - containerRect.left + offset
  }

  top = rect.bottom - containerRect.top + offset

  // Ensure the indicator stays within container bounds
  const viewportWidth = containerRect.width
  const viewportHeight = containerRect.height
  const indicatorWidth = 28
  const indicatorHeight = 28

  if (left + indicatorWidth > viewportWidth - 8) {
    left = viewportWidth - indicatorWidth - 8
  }
  if (left < 8) {
    left = 8
  }
  if (top + indicatorHeight > viewportHeight - 8) {
    top = rect.top - containerRect.top - indicatorHeight - offset
  }
  if (top < 8) {
    top = 8
  }

  return { left, top }
}

type SelectionIndicatorProps = {
  selection: SelectionInfo
  onHoverChange: (isHovering: boolean) => void
  containerEl: HTMLElement
  offset?: number
}

export function SelectionIndicator({
  selection,
  onHoverChange,
  containerEl,
  offset = 8,
}: SelectionIndicatorProps) {
  const indicatorRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(() =>
    getIndicatorPosition(selection, containerEl, offset),
  )
  const [isVisible, setIsVisible] = useState(false)

  const updatePosition = useCallback(() => {
    setPosition(getIndicatorPosition(selection, containerEl, offset))
  }, [containerEl, offset, selection])

  useEffect(() => {
    updatePosition()
    // Fade in after positioning
    const timer = window.setTimeout(() => setIsVisible(true), 0)

    return () => window.clearTimeout(timer)
  }, [selection, updatePosition])

  const handleMouseEnter = () => {
    onHoverChange(true)
  }

  const handleMouseLeave = () => {
    onHoverChange(false)
  }

  const positionStyles = useMemo(
    () => ({
      left: `${Math.round(position.left)}px`,
      top: `${Math.round(position.top)}px`,
    }),
    [position.left, position.top],
  )

  const classes =
    `smtcmp-selection-indicator ${isVisible ? 'visible' : ''}`.trim()

  return (
    <div
      ref={indicatorRef}
      className={classes}
      style={positionStyles}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Sparkles size={14} />
    </div>
  )
}
