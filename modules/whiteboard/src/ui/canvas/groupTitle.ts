// A group's title bar (styles/cards/group.css): a strip outside the frame,
// over its top-left corner, that names the group, says how much it holds,
// and carries what is done to the group as a whole — fitting the frame back
// to its contents. It is the group's handle: a press on it selects the group,
// a drag moves the group with everything in it, a double-click renames it.
//
// Its size is domain/groups.ts's GROUP_TITLE — the domain fits frames around
// nested groups' title bars, so the two must agree — and it reads the way an
// open PDF spread's title does (title-line.css): one kind of heading.

import { GROUP_TITLE } from '../../domain/groups'
import type { WhiteboardTranslation } from '../../i18n'
import { GROUP_LABEL_CLASS } from '../constants'

export const GROUP_TITLE_CLASS = 'yolo-whiteboard-group-title'
const ICON_CLASS = 'yolo-whiteboard-group-title-icon'
const COUNT_CLASS = 'yolo-whiteboard-group-count'
const SPACER_CLASS = 'yolo-whiteboard-group-title-spacer'
const ACTION_CLASS = 'yolo-whiteboard-group-action'

/** What a button on the title bar does to its group. */
export type GroupTitleAction = 'fit'

export type GroupTitleState = Readonly<{
  label: string
  /** How many things the group directly holds. */
  count: number
  /** The frame has a size set by hand, which "fit to content" lets go of. */
  sized: boolean
}>

/**
 * The bar, built once per mount: a group's element is rebuilt whenever the
 * group changes, so there is nothing here to keep in step. `onAction` runs
 * when one of its buttons is clicked; a press on a button is the button's,
 * and does not reach the board as a press on the group.
 */
export function createGroupTitle(
  doc: Document,
  state: GroupTitleState,
  t: WhiteboardTranslation,
  onAction: (action: GroupTitleAction) => void,
): HTMLElement {
  const bar = doc.createElement('div')
  bar.className = GROUP_TITLE_CLASS
  bar.style.width = `${GROUP_TITLE.width}px`
  bar.style.height = `${GROUP_TITLE.height}px`
  bar.style.bottom = `calc(100% + ${GROUP_TITLE.gap}px)`

  bar.appendChild(groupIcon(doc))

  const label = doc.createElement('span')
  label.className = GROUP_LABEL_CLASS
  label.textContent = state.label
  label.spellcheck = false
  bar.appendChild(label)

  const count = doc.createElement('span')
  count.className = COUNT_CLASS
  count.textContent =
    state.count === 1
      ? t('group.countOne')
      : t('group.count').replace('{count}', String(state.count))
  bar.appendChild(count)

  const spacer = doc.createElement('span')
  spacer.className = SPACER_CLASS
  bar.appendChild(spacer)

  if (state.sized) {
    bar.appendChild(
      actionButton(doc, t('group.fitToContent'), () => onAction('fit')),
    )
  }
  return bar
}

/** The name, where the rename edits it (editingController.ts). */
export function groupTitleLabel(bar: Element): HTMLElement | null {
  return bar.querySelector<HTMLElement>(`.${GROUP_LABEL_CLASS}`)
}

/** Whether an event landed on one of a title bar's buttons. */
export function isGroupTitleAction(target: Element | null): boolean {
  return target?.closest(`.${ACTION_CLASS}`) != null
}

function actionButton(
  doc: Document,
  text: string,
  run: () => void,
): HTMLButtonElement {
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = ACTION_CLASS
  button.textContent = text
  // The board takes every press it hears as the start of a gesture on the
  // group (interactionController.ts); this one is the button's.
  button.addEventListener('pointerdown', (event) => event.stopPropagation())
  button.addEventListener('dblclick', (event) => event.stopPropagation())
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    run()
  })
  return button
}

/** A frame with a heading: what a group is. */
function groupIcon(doc: Document): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = doc.createElementNS(ns, 'svg')
  svg.setAttribute('class', ICON_CLASS)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const rect = doc.createElementNS(ns, 'rect')
  for (const [key, value] of Object.entries({
    x: '3',
    y: '3',
    width: '18',
    height: '18',
    rx: '4',
  })) {
    rect.setAttribute(key, value)
  }
  const line = doc.createElementNS(ns, 'path')
  line.setAttribute('d', 'M3 9h18')
  svg.append(rect, line)
  return svg
}
