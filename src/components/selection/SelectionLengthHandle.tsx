import {
  type PointerEvent as ReactPointerEvent,
  useId,
  useMemo,
  useRef,
} from 'react'

import { useLanguage } from '../../contexts/language-context'

import type { SelectionInfo } from './SelectionManager'
import {
  getSelectionVisualLineRects,
  trimRangeEndWhitespace,
} from './selectionRangeGeometry'

const DRAG_ACTIVATION_DISTANCE = 6
const HANDLE_SURFACE_OFFSET = 5
const HANDLE_WIDTH = 64

type SelectionLengthHandleProps = {
  selection: SelectionInfo
  containerEl: HTMLElement
  onDragStart: (startClientY: number, currentClientY: number) => boolean
}

export function SelectionLengthHandle({
  selection,
  containerEl,
  onDragStart,
}: SelectionLengthHandleProps) {
  const { t } = useLanguage()
  const labelId = useId()
  const dragRef = useRef<{
    pointerId: number
    startClientY: number
    handedOff: boolean
  } | null>(null)
  const position = useMemo(() => {
    const rects = getSelectionVisualLineRects(
      trimRangeEndWhitespace(selection.range),
    )
    const effectiveRects = rects.length > 0 ? rects : [selection.rect]
    const lastLine = effectiveRects[effectiveRects.length - 1]
    const containerRect = containerEl.getBoundingClientRect()
    const contentRect =
      containerEl
        .querySelector<HTMLElement>('.cm-content')
        ?.getBoundingClientRect() ?? containerRect
    const contentCenter = (contentRect.left + contentRect.right) / 2
    const ownerWindow = containerEl.ownerDocument.defaultView ?? window
    const isRtl = ownerWindow.getComputedStyle(containerEl).direction === 'rtl'
    const selectionEdge = isRtl ? lastLine.left : lastLine.right
    const anchor = isRtl
      ? Math.max(selectionEdge, contentCenter)
      : Math.min(selectionEdge, contentCenter)
    const handleCenter = anchor + (isRtl ? HANDLE_WIDTH / 2 : -HANDLE_WIDTH / 2)
    const left = handleCenter - containerRect.left
    const top = lastLine.bottom - containerRect.top + HANDLE_SURFACE_OFFSET
    return { left, top }
  }, [containerEl, selection])

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      handedOff: false,
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId || drag.handedOff) return
    if (
      Math.abs(event.clientY - drag.startClientY) < DRAG_ACTIVATION_DISTANCE
    ) {
      return
    }
    drag.handedOff = true
    if (!onDragStart(drag.startClientY, event.clientY)) {
      dragRef.current = null
    }
  }

  const resetPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId || drag.handedOff) return
    dragRef.current = null
  }

  return (
    <div
      className="yolo-selection-length-affordance"
      style={{
        left: `${Math.round(position.left)}px`,
        top: `${Math.round(position.top)}px`,
      }}
    >
      <button
        type="button"
        className="yolo-selection-rewrite-length-handle"
        aria-labelledby={labelId}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={resetPointer}
        onPointerCancel={resetPointer}
      />
      <span id={labelId} className="yolo-sr-only">
        {t('selection.length.handle', 'Drag to adjust length')}
      </span>
    </div>
  )
}
