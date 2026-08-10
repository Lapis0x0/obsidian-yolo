import { type RefObject, useCallback, useEffect, useRef } from 'react'

type UseHistoricalUserMessageDismissInput = {
  activeMessageId: string | null
  containerRef: RefObject<HTMLElement | null>
  onDismiss: (messageId: string) => void
}

export const shouldDismissHistoricalUserMessage = (
  target: Element,
  activeMessageId: string,
): boolean => {
  if (target.closest('.yolo-popover-surface')) return false
  const messageElement = target.closest<HTMLElement>('[data-user-message-id]')
  return messageElement?.dataset.userMessageId !== activeMessageId
}

/**
 * Owns the shared interaction boundary for an expanded historical user
 * message. Callers decide whether dismissing commits or discards the draft.
 */
export const useHistoricalUserMessageDismiss = ({
  activeMessageId,
  containerRef,
  onDismiss,
}: UseHistoricalUserMessageDismissInput): {
  onControlPopoverOpenChange: (isOpen: boolean) => void
} => {
  const controlPopoverOpenRef = useRef(false)

  const onControlPopoverOpenChange = useCallback((isOpen: boolean) => {
    controlPopoverOpenRef.current = isOpen
  }, [])

  useEffect(() => {
    if (!activeMessageId) {
      controlPopoverOpenRef.current = false
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (controlPopoverOpenRef.current) return
      if (!shouldDismissHistoricalUserMessage(target, activeMessageId)) return

      onDismiss(activeMessageId)
    }

    const doc = containerRef.current?.ownerDocument ?? document
    doc.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      doc.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [activeMessageId, containerRef, onDismiss])

  return { onControlPopoverOpenChange }
}
