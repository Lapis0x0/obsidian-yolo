// The bottom-centre creation bar (P3 batch 3, interaction surface ③) —
// Obsidian Canvas's `.canvas-card-menu`.
//
// Every button is both a click and a handle to drag a card off, which is
// Canvas's arrangement (`dragTempNode`) and for its reason: the bar is where
// the eye already is when a card is wanted, so "put one *there*" should not
// have to be asked for somewhere else. A press is raised as one `onPress`
// rather than as a click and a drag, because at pointerdown the two are still
// the same gesture — the canvas decides which it was from how far the pointer
// travelled, the same way a press on a card decides between editing it and
// moving it.
//
// `click` is left for the keyboard alone (`detail === 0`), where there is no
// pointer to follow and a button must still activate.
//
// Our bar carries a fourth button Canvas's does not: the web card. Canvas
// offers "add website" only from its creation menu, but for us this is the one
// card type with no other way to be created at all — batch 2 shipped web cards
// with an import path and no new-card path.
//
// This class is a renderer, like ui/selectionToolbar.ts: it knows how to draw
// a row of buttons and raise their presses, and nothing about boards.
//
// Popout safety: every element is created from the `Document` handed in.

const MENU_CLASS = 'yolo-whiteboard-card-menu'
const MENU_HIDDEN_CLASS = 'yolo-whiteboard-card-menu-hidden'
const BUTTON_CLASS = 'yolo-whiteboard-card-menu-button'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Lucide geometry, matching the icons Canvas puts on the same three actions
 * (`lucide-sticky-note`, `lucide-file-text`, `lucide-file-image`) plus a globe
 * for the web card — the one glyph that reads right now that this button takes
 * an HTML document as well as a URL. Inlined for the same reason
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
  // `lucide-globe` with its single equator replaced by a pair of latitude
  // lines — the one glyph here that is not Lucide verbatim. Lucide's globe
  // draws one horizontal line; the two-line reading is what Material's
  // `language` and Font Awesome's `globe` established, and it is the one
  // people recognise as "a web page". Deliberate deviation, chosen on looks.
  //
  // The circle is spelled as two semicircular arcs because this map holds path
  // data and nothing else (verified identical to `<circle cx=12 cy=12 r=10>`:
  // same bounding box, same 62.83 length). The chords sit at y=8.5 and y=15.5,
  // inset ~0.5 from where they would truly meet the circle so the round stroke
  // caps do not collide with its outline.
  globe: [
    'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20',
    'M3.1 8.5h17.8',
    'M3.1 15.5h17.8',
    'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20',
  ],
}

export type CardMenuIconName =
  | 'sticky-note'
  | 'file-text'
  | 'file-image'
  | 'globe'

export type CardMenuAction = Readonly<{
  label: string
  icon: CardMenuIconName
  /** Activated from the keyboard, which names no place: create wherever this
   * action's default is. */
  onSelect: () => void
  /** Pressed with a pointer, which does: raised at pointerdown, before a
   * click and a drag have become different things. */
  onPress: (event: PointerEvent) => void
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
   * Takes the bar off screen while the board cannot accept a new card: zoomed
   * out past the point where a card's content is built at all (D8 — a card
   * created there would be an empty rectangle with no editor, which is why
   * `createTextCardAt` already declines).
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
      // A pointer press was already handled at pointerdown; `detail === 0` is
      // the click the keyboard synthesises, which is the only one left to act
      // on.
      if (event.detail !== 0) return
      event.preventDefault()
      action.onSelect()
    })
    button.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return
      // Nothing this press does is the default one: no text selection, and no
      // focus ring landing on a button whose card is about to be dragged
      // somewhere else. Canvas's `dragTempNode` opens the same way.
      event.preventDefault()
      action.onPress(event)
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
