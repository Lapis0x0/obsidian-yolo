// A collapsed group's box (styles/cards/group.css): where what the group
// holds is shown, each thing in its cell, under its title (./nodeTitle.ts).

export const GROUP_THUMBS_CLASS = 'yolo-whiteboard-group-thumbs'
export const GROUP_COLLAPSED_CLASS = 'yolo-whiteboard-group-collapsed'
const MORE_CLASS = 'yolo-whiteboard-group-more'

/**
 * A collapsed group's box. What it holds is shown in it by the board itself,
 * each thing in its cell (canvas.ts's `folded`) — drawn as the board draws
 * any card, under the world layer this is in. What is here is what takes the
 * click that opens the group — each thing in it is a way back to what it
 * stands for — and, when there are more than the cells, the last cell saying
 * how many more.
 */
export function createGroupThumbs(
  doc: Document,
  more: Readonly<{
    text: string
    cell: Readonly<{ x: number; y: number; w: number; h: number }>
  }> | null,
  onOpen: () => void,
): HTMLElement {
  const box = doc.createElement('div')
  box.className = GROUP_THUMBS_CLASS
  if (more) {
    const label = doc.createElement('div')
    label.className = MORE_CLASS
    label.textContent = more.text
    label.style.left = `${more.cell.x}px`
    label.style.top = `${more.cell.y}px`
    label.style.width = `${more.cell.w}px`
    label.style.height = `${more.cell.h}px`
    box.appendChild(label)
  }
  box.addEventListener('pointerdown', (event) => event.stopPropagation())
  box.addEventListener('dblclick', (event) => event.stopPropagation())
  box.addEventListener('click', (event) => {
    event.stopPropagation()
    onOpen()
  })
  return box
}
