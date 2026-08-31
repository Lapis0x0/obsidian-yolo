// The bottom-centre creation bar (P3 batch 3, interaction surface ③) —
// Obsidian Canvas's `.canvas-card-menu`.
//
// Canvas's own bar carries three buttons (card, note, media), each wired to
// *two* gestures: `click` creates at `posCenter()` — the viewport's centre —
// and `pointerdown` starts a ghost node that is dropped wherever the pointer
// lets go. Both verified against a running 1.13.7 build.
//
// We ship the click. Placing a card exactly where you want it is covered
// instead by the canvas context menu, which creates at the point that was
// right-clicked (Canvas's `showCreationMenu(menu, pos, size)` does the same) —
// so the drag is a second route to a destination already reachable, and the
// three of our four entries that need a file or a URL would have to open their
// picker *after* the drop, which is a good deal more machinery than a ghost
// rectangle. The button labels promise only what they do.
//
// Our bar carries a fourth button Canvas's does not: the web card. Canvas
// offers "add website" only from its creation menu, but for us this is the one
// card type with no other way to be created at all — batch 2 shipped web cards
// with an import path and no new-card path.
//
// This class is a renderer, like ui/selectionToolbar.ts: it knows how to draw
// a row of buttons and raise their clicks, and nothing about boards.
//
// Popout safety: every element is created from the `Document` handed in.

const MENU_CLASS = 'yolo-whiteboard-card-menu'
const MENU_HIDDEN_CLASS = 'yolo-whiteboard-card-menu-hidden'
const BUTTON_CLASS = 'yolo-whiteboard-card-menu-button'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Lucide geometry, matching the icons Canvas puts on the same three actions
 * (`lucide-sticky-note`, `lucide-file-text`, `lucide-file-image`) plus
 * `lucide-external-link` for the web card. Inlined for the same reason
 * ui/selectionToolbar.ts inlines its own: this module has no package
 * dependencies, and four icons are not worth acquiring one. */
const ICONS: Readonly<Record<CardMenuIconName, readonly string[]>> = {
  'sticky-note': [
    'M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11l5-5V5a2 2 0 0 0-2-2z',
    'M15 21v-4a2 2 0 0 1 2-2h4',
  ],
  'file-text': [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ],
  'file-image': [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
    'm20 17-1.3-1.3a2 2 0 0 0-3 0L9 22',
  ],
  'external-link': [
    'M15 3h6v6',
    'M10 14 21 3',
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  ],
}

export type CardMenuIconName =
  | 'sticky-note'
  | 'file-text'
  | 'file-image'
  | 'external-link'

export type CardMenuAction = Readonly<{
  label: string
  icon: CardMenuIconName
  onSelect: () => void
}>

export class CardMenu {
  private readonly el: HTMLElement

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
    actions: readonly CardMenuAction[],
  ) {
    const el = doc.createElement('div')
    el.className = MENU_CLASS
    for (const action of actions) this.appendButton(el, action)
    parent.appendChild(el)
    this.el = el
  }

  contains(node: Node): boolean {
    return this.el === node || this.el.contains(node)
  }

  /**
   * Takes the bar off screen while the board cannot accept a new card: locked
   * (feature 6), or zoomed out past the point where a card's content is built
   * at all (D8 — a card created there would be an empty rectangle with no
   * editor, which is why `createTextCardAt` already declines).
   */
  setAvailable(available: boolean): void {
    this.el.classList.toggle(MENU_HIDDEN_CLASS, !available)
  }

  destroy(): void {
    this.el.remove()
  }

  private appendButton(parent: HTMLElement, action: CardMenuAction): void {
    const button = this.doc.createElement('button')
    // `clickable-icon` is Obsidian's own icon-button treatment, the same class
    // Canvas's card menu buttons carry.
    button.className = `clickable-icon ${BUTTON_CLASS}`
    button.type = 'button'
    button.setAttribute('aria-label', action.label)
    button.appendChild(this.createIcon(action.icon))
    button.addEventListener('click', (event) => {
      event.preventDefault()
      action.onSelect()
    })
    parent.appendChild(button)
  }

  private createIcon(name: CardMenuIconName): SVGElement {
    const svg = this.doc.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'svg-icon')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    for (const d of ICONS[name]) {
      const path = this.doc.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    }
    return svg
  }
}
