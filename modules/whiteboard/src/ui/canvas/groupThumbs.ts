// A collapsed group's box (styles/cards/group.css): where what the group
// holds is shown, each thing in its cell, under its title (./nodeTitle.ts).

import { collapsedGroupCells, collapsedGroupSize } from '../../domain/groups'

export const GROUP_THUMBS_CLASS = 'yolo-whiteboard-group-thumbs'
export const GROUP_COLLAPSED_CLASS = 'yolo-whiteboard-group-collapsed'
const MORE_CLASS = 'yolo-whiteboard-group-more'
/** The count coming in as the group folds (`showGroupMore`). */
const MORE_ENTERING_CLASS = 'yolo-whiteboard-group-more-entering'
/** The count going as the group opens (`hideGroupMore`). */
const MORE_LEAVING_CLASS = 'yolo-whiteboard-group-more-leaving'

type Cell = Readonly<{ x: number; y: number; w: number; h: number }>

/** What the last cell of a collapsed group's box says when it holds more
 * things than the box has cells: how many more. */
export type GroupMore = Readonly<{ text: string; cell: Cell }>

/** The last cell's count for a group holding `count` things, in the
 * group's own units; null when every thing has a cell. */
export function groupMore(count: number): GroupMore | null {
  const size = collapsedGroupSize(count)
  const cells = collapsedGroupCells({ x: 0, y: 0, ...size }, count)
  const last = cells[cells.length - 1]
  if (count <= cells.length || !last) return null
  return { text: `+${count - (cells.length - 1)}`, cell: last }
}

/**
 * A collapsed group's box. What it holds is shown in it by the board itself,
 * each thing in its cell (canvas.ts's `folded`) — drawn as the board draws
 * any card, under the world layer this is in. What is here is what takes the
 * click that opens the group: each thing in it is a way back to what it
 * stands for, the count over the last cell (`showGroupMore`) included.
 */
export function createGroupThumbs(
  doc: Document,
  onOpen: () => void,
): HTMLElement {
  const box = doc.createElement('div')
  box.className = GROUP_THUMBS_CLASS
  box.addEventListener('pointerdown', (event) => event.stopPropagation())
  box.addEventListener('dblclick', (event) => event.stopPropagation())
  box.addEventListener('click', (event) => {
    event.stopPropagation()
    onOpen()
  })
  return box
}

/**
 * Shows `more` over the last cell of group element `el`'s box, or nothing
 * there when it is null. The count is the element's own rather than its
 * box's, under the box and taking no clicks itself: so it can come before
 * the box does, fading in (`entering`) as the things it counts go into its
 * cell while the group folds, and stay after it, fading out as they come
 * back out (`hideGroupMore`). The box's top-left is the frame's, so its
 * cell is where it is either way.
 */
export function showGroupMore(
  doc: Document,
  el: HTMLElement,
  more: GroupMore | null,
  entering = false,
): void {
  let label = el.querySelector<HTMLElement>(`:scope > .${MORE_CLASS}`)
  if (!more) {
    label?.remove()
    return
  }
  if (!label) {
    label = doc.createElement('div')
    label.className = MORE_CLASS
    if (entering) label.classList.add(MORE_ENTERING_CLASS)
    el.prepend(label)
  }
  // Folded again while it was going: it stays.
  label.classList.remove(MORE_LEAVING_CLASS)
  label.textContent = more.text
  label.style.left = `${more.cell.x}px`
  label.style.top = `${more.cell.y}px`
  label.style.width = `${more.cell.w}px`
  label.style.height = `${more.cell.h}px`
}

/** Fades out group element `el`'s count, if it shows one, and takes it
 * away once it has gone: what it counted is coming back out of its cell. */
export function hideGroupMore(el: HTMLElement): void {
  const label = el.querySelector<HTMLElement>(`:scope > .${MORE_CLASS}`)
  if (!label || label.classList.contains(MORE_LEAVING_CLASS)) return
  label.classList.remove(MORE_ENTERING_CLASS)
  label.classList.add(MORE_LEAVING_CLASS)
  label.addEventListener(
    'animationend',
    () => {
      if (label.classList.contains(MORE_LEAVING_CLASS)) label.remove()
    },
    { once: true },
  )
}
