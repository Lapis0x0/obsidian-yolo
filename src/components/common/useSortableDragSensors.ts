import { MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import type {
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from 'react'

/**
 * Sensors for lists where the item itself is the drag source rather than a
 * dedicated handle — the agent and knowledge base cards and the provider rows
 * in settings, and the conversations in the chat sidebar.
 *
 * Mouse and touch are deliberately separate. A pointer only has to travel a
 * few pixels to be reading as a drag, but on a touch screen that is the same
 * gesture as scrolling the page, so touch instead asks for a long press and
 * abandons it the moment the finger travels: a swipe still scrolls, holding
 * still picks the item up.
 */
const DRAG_DISTANCE_PX = 5
const TOUCH_LONG_PRESS_MS = 250
const TOUCH_TOLERANCE_PX = 5

// A drag starting on a control nested in the item (a menu trigger, a link)
// belongs to that control, not to the item. The item itself may be a control
// (a sidebar conversation is a button), which doesn't count.
const startsOnNestedControl = (event: ReactMouseEvent | ReactTouchEvent) => {
  const target = event.target as Element | null
  if (typeof target?.closest !== 'function') return false
  const control = target.closest('button, a, input, textarea, select')
  return control !== null && control !== event.currentTarget
}

class ItemMouseSensor extends MouseSensor {
  static activators = [
    {
      eventName: 'onMouseDown' as const,
      handler: (
        event: ReactMouseEvent,
        options: Parameters<(typeof MouseSensor.activators)[0]['handler']>[1],
      ) =>
        !startsOnNestedControl(event) &&
        MouseSensor.activators[0].handler(event, options),
    },
  ]
}

class ItemTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: (
        event: ReactTouchEvent,
        options: Parameters<(typeof TouchSensor.activators)[0]['handler']>[1],
      ) =>
        !startsOnNestedControl(event) &&
        TouchSensor.activators[0].handler(event, options),
    },
  ]
}

export function useSortableDragSensors() {
  return useSensors(
    useSensor(ItemMouseSensor, {
      activationConstraint: { distance: DRAG_DISTANCE_PX },
    }),
    useSensor(ItemTouchSensor, {
      activationConstraint: {
        delay: TOUCH_LONG_PRESS_MS,
        tolerance: TOUCH_TOLERANCE_PX,
      },
    }),
  )
}
