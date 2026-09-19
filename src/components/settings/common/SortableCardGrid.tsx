import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  closestCenter,
  defaultDropAnimationSideEffects,
  getClientRect,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import { useReducedMotion } from 'framer-motion'
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  forwardRef,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import {
  MOTION_DURATION_ENTER_S,
  MOTION_EASE_OUT_CSS,
} from '../../../styles/tokens/motion'

import { useOptimisticOrder } from './useOptimisticOrder'
import { useSortableDragSensors } from './useSortableDragSensors'

/**
 * Card grid whose cards reorder by dragging the card itself — no handle.
 * A press opens the card; moving the pointer past a few pixels (or a long
 * press on touch) lifts it instead.
 */
type SortableCardGridProps<T> = {
  items: readonly T[]
  getId: (item: T) => string
  renderCard: (item: T) => ReactNode
  onOpen: (item: T) => void
  onReorder: (items: T[]) => Promise<unknown>
  getCardClassName?: (item: T) => string | undefined
  className: string
  /** Rendered after the cards, outside the sortable set (e.g. a create tile). */
  trailing?: ReactNode
}

const SORT_TRANSITION = {
  duration: MOTION_DURATION_ENTER_S * 1000,
  easing: MOTION_EASE_OUT_CSS,
}
// The lifted card is scaled up; measure it unscaled so the drop animation
// lands exactly on the slot instead of offset by half the scale growth.
const MEASURING = {
  dragOverlay: {
    measure: (node: HTMLElement) =>
      getClientRect(node, { ignoreTransform: true }),
  },
}

export function SortableCardGrid<T>({
  items,
  getId,
  renderCard,
  onOpen,
  onReorder,
  getCardClassName,
  className,
  trailing,
}: SortableCardGridProps<T>) {
  const reducedMotion = useReducedMotion()
  const [portalBody, setPortalBody] = useState<HTMLElement | null>(null)
  const gridRef = useCallback((node: HTMLDivElement | null) => {
    setPortalBody(node?.ownerDocument.body ?? null)
  }, [])
  const [activeId, setActiveId] = useState<string | null>(null)
  const {
    ordered: orderedItems,
    applyOrder,
    revertOrder,
  } = useOptimisticOrder(items, getId)
  const suppressOpenUntilRef = useRef(0)

  const sensors = useSortableDragSensors()

  const ids = useMemo(() => orderedItems.map(getId), [orderedItems, getId])
  const activeItem =
    activeId === null
      ? undefined
      : orderedItems.find((item) => getId(item) === activeId)

  const handleOpen = (item: T) => {
    if (Date.now() < suppressOpenUntilRef.current) return
    onOpen(item)
  }

  const finishDrag = () => {
    setActiveId(null)
    suppressOpenUntilRef.current = Date.now() + 250
  }

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id))
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    finishDrag()
    if (!over || active.id === over.id) return
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove([...orderedItems], oldIndex, newIndex)
    applyOrder(next)
    void onReorder(next).catch((error: unknown) => {
      console.error('[YOLO] Failed to save card order', error)
      revertOrder()
    })
  }

  const dropAnimation: DropAnimation | null = reducedMotion
    ? null
    : {
        duration: SORT_TRANSITION.duration,
        easing: SORT_TRANSITION.easing,
        sideEffects: defaultDropAnimationSideEffects({
          className: { dragOverlay: 'is-dropping' },
          // Keep the real card hidden until the overlay has landed on it;
          // otherwise both are visible and the card seems to settle twice.
          styles: { active: { opacity: '0' } },
        }),
      }

  return (
    <DndContext
      sensors={sensors}
      measuring={MEASURING}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={finishDrag}
    >
      <div ref={gridRef} className={className}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          {orderedItems.map((item) => (
            <SortableCard
              key={getId(item)}
              id={getId(item)}
              className={getCardClassName?.(item)}
              onOpen={() => handleOpen(item)}
            >
              {renderCard(item)}
            </SortableCard>
          ))}
        </SortableContext>
        {trailing}
      </div>
      {portalBody &&
        createPortal(
          <DragOverlay dropAnimation={dropAnimation}>
            {activeItem !== undefined && (
              <CardShell
                className={clsx(getCardClassName?.(activeItem), 'is-lifted')}
              >
                {renderCard(activeItem)}
              </CardShell>
            )}
          </DragOverlay>,
          portalBody,
        )}
    </DndContext>
  )
}

function SortableCard({
  id,
  className,
  onOpen,
  children,
}: {
  id: string
  className?: string
  onOpen: () => void
  children: ReactNode
}) {
  // `attributes` is left out: it re-declares role/tabIndex/aria for keyboard
  // sorting, which this grid doesn't offer; the card stays a plain button.
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, transition: SORT_TRANSITION })

  return (
    <CardShell
      ref={setNodeRef}
      className={clsx(className, 'yolo-sortable-card', {
        'is-placeholder': isDragging,
      })}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onOpen={onOpen}
      {...listeners}
    >
      {children}
    </CardShell>
  )
}

type CardShellProps = {
  className?: string
  style?: CSSProperties
  onOpen?: () => void
  children: ReactNode
  onMouseDown?: (event: ReactMouseEvent) => void
  onTouchStart?: (event: ReactTouchEvent) => void
}

const CardShell = forwardRef<HTMLElement, CardShellProps>(function CardShell(
  { className, onOpen, children, ...rest },
  ref,
) {
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Keys pressed on a nested control (the "…" menu) are that control's.
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen?.()
    }
  }

  return (
    <article
      ref={ref}
      className={clsx('yolo-agent-card yolo-agent-card--clickable', className)}
      role="button"
      tabIndex={onOpen ? 0 : -1}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
    </article>
  )
})
