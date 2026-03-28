import { Quote } from 'lucide-react'
import type { ReactNode, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'

type AssistantSelectionQuoteButtonProps = {
  messageId: string
  conversationId: string
  disabled?: boolean
  onQuote: (payload: {
    messageId: string
    conversationId: string
    content: string
  }) => void
  children: ReactNode
}

type OverlayState = {
  content: string
  left: number
  top: number
}

const SELECTION_STABILIZE_DELAY = 300
const selectionListeners = new Set<() => void>()
const viewportListeners = new Set<() => void>()

let removeGlobalListeners: (() => void) | null = null

function emitSelectionChange() {
  selectionListeners.forEach((listener) => {
    listener()
  })
}

function emitViewportChange() {
  viewportListeners.forEach((listener) => {
    listener()
  })
}

function ensureGlobalListeners() {
  if (removeGlobalListeners) {
    return
  }

  document.addEventListener('selectionchange', emitSelectionChange)
  window.addEventListener('resize', emitViewportChange)
  document.addEventListener('scroll', emitViewportChange, true)

  removeGlobalListeners = () => {
    document.removeEventListener('selectionchange', emitSelectionChange)
    window.removeEventListener('resize', emitViewportChange)
    document.removeEventListener('scroll', emitViewportChange, true)
    removeGlobalListeners = null
  }
}

function cleanupGlobalListenersIfIdle() {
  if (
    selectionListeners.size === 0 &&
    viewportListeners.size === 0 &&
    removeGlobalListeners
  ) {
    removeGlobalListeners()
  }
}

export default function AssistantSelectionQuoteButton({
  messageId,
  conversationId,
  disabled = false,
  onQuote,
  children,
}: AssistantSelectionQuoteButtonProps) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const debounceTimerRef = useRef<number | null>(null)
  const overlayRef = useRef<OverlayState | null>(null)
  const processSelectionRef = useRef<() => void>(() => {})
  const [overlay, setOverlay] = useState<OverlayState | null>(null)
  const [isVisible, setIsVisible] = useState(false)

  const hideOverlay = useCallback(() => {
    setIsVisible(false)
    setOverlay(null)
  }, [])

  const processSelection = useCallback(() => {
    if (disabled) {
      hideOverlay()
      return
    }

    const container = containerRef.current
    const selection = window.getSelection()
    if (
      !container ||
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      hideOverlay()
      return
    }

    const anchorNode = selection.anchorNode
    const focusNode = selection.focusNode
    if (
      !anchorNode ||
      !focusNode ||
      !container.contains(anchorNode) ||
      !container.contains(focusNode)
    ) {
      hideOverlay()
      return
    }

    const selectedContent = selection.toString().trim()
    if (!selectedContent) {
      hideOverlay()
      return
    }

    const range = selection.getRangeAt(0)
    const rects = Array.from(range.getClientRects()).filter(
      (item) => item.width > 0 || item.height > 0,
    )
    const rect = rects.at(-1) ?? range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      hideOverlay()
      return
    }

    const containerRect = container.getBoundingClientRect()
    const buttonRect = buttonRef.current?.getBoundingClientRect()
    const buttonWidth = Math.max(buttonRect?.width ?? 92, 92)
    const buttonHeight = Math.max(buttonRect?.height ?? 36, 36)
    const left = Math.min(
      Math.max(rect.right - containerRect.left + 8, 8),
      Math.max(containerRect.width - buttonWidth - 8, 8),
    )
    const top = Math.min(
      Math.max(rect.bottom - containerRect.top + 8, 8),
      Math.max(containerRect.height - buttonHeight - 8, 8),
    )

    setOverlay({
      content: selectedContent,
      left,
      top,
    })
  }, [disabled, hideOverlay])

  useEffect(() => {
    overlayRef.current = overlay
  }, [overlay])

  useEffect(() => {
    processSelectionRef.current = processSelection
  }, [processSelection])

  useEffect(() => {
    const handleSelectionChange = () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current)
      }

      setIsVisible(false)
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null
        processSelectionRef.current()
      }, SELECTION_STABILIZE_DELAY)
    }

    const handleViewportChange = () => {
      if (!overlayRef.current) {
        return
      }
      processSelectionRef.current()
    }

    selectionListeners.add(handleSelectionChange)
    viewportListeners.add(handleViewportChange)
    ensureGlobalListeners()

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
      selectionListeners.delete(handleSelectionChange)
      viewportListeners.delete(handleViewportChange)
      cleanupGlobalListenersIfIdle()
    }
  }, [])

  useEffect(() => {
    if (disabled) {
      hideOverlay()
    }
  }, [disabled, hideOverlay])

  useEffect(() => {
    if (!overlay) {
      return
    }

    let firstFrameId = 0
    let secondFrameId = 0

    firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        setIsVisible(true)
      })
    })

    return () => {
      if (firstFrameId) {
        window.cancelAnimationFrame(firstFrameId)
      }
      if (secondFrameId) {
        window.cancelAnimationFrame(secondFrameId)
      }
    }
  }, [overlay])

  const handleMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
  }, [])

  const handleClick = useCallback(() => {
    if (!overlay) {
      return
    }

    onQuote({
      messageId,
      conversationId,
      content: overlay.content,
    })
    window.getSelection()?.removeAllRanges()
    hideOverlay()
  }, [conversationId, hideOverlay, messageId, onQuote, overlay])

  const buttonLabel = useMemo(() => t('chat.assistantQuote.add', '引用'), [t])

  return (
    <div
      ref={containerRef}
      className="smtcmp-assistant-message-selectable"
      data-assistant-message-id={messageId}
    >
      {children}
      {overlay && (
        <button
          ref={buttonRef}
          type="button"
          className={`smtcmp-assistant-selection-quote-button ${
            isVisible ? 'visible' : ''
          }`.trim()}
          style={{
            left: `${Math.round(overlay.left)}px`,
            top: `${Math.round(overlay.top)}px`,
          }}
          onMouseDown={handleMouseDown}
          onClick={handleClick}
        >
          <Quote size={12} />
          <span>{buttonLabel}</span>
        </button>
      )}
    </div>
  )
}
