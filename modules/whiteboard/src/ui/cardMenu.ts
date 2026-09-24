// The bottom-centre creation bar — Obsidian Canvas's `.canvas-card-menu`.
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
// card type with no other way to be created at all — web cards shipped with
// an import path and no new-card path.
//
// This class is a renderer, like ui/selectionToolbar.ts: it knows how to draw
// a row of buttons and raise their presses, and nothing about boards.
//
// Popout safety: every element is created from the `Document` handed in.

import { CARD_MENU_COLLAPSE_DELAY_MS } from './constants'

const MENU_CLASS = 'yolo-whiteboard-card-menu'
const MENU_HIDDEN_CLASS = 'yolo-whiteboard-card-menu-hidden'
const MENU_COLLAPSED_CLASS = 'yolo-whiteboard-card-menu-collapsed'
const HANDLE_CLASS = 'yolo-whiteboard-card-menu-handle'
/** How far the bar and its handle stand off whatever covers the bottom of
 * the board — see `syncLift`. */
const LIFT_PROPERTY = '--yolo-card-menu-lift'
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
  /** What is left of the bar while it is tucked away: a short grip line where
   * its bottom edge was, and the place a pointer brings it back from. */
  private readonly handleEl: HTMLElement
  /** Whether the bar tucks itself away when no pointer is over it — decided
   * by the owner (`setAutoCollapse`), not by this renderer. */
  private autoCollapse = false
  /** A mouse or pen over the bar or its handle. A touch never hovers: a tap
   * on the handle opens the bar, and it stays open until the owner says the
   * board is being worked on again. */
  private hovered = false
  private collapseTimer: number | null = null
  private readonly resizeObserver: ResizeObserver | null

  constructor(
    private readonly doc: Document,
    private readonly parent: HTMLElement,
    actions: readonly CardMenuAction[],
  ) {
    const el = doc.createElement('div')
    el.className = MENU_CLASS
    for (const action of actions) this.appendButton(el, action)
    const handle = doc.createElement('div')
    handle.className = HANDLE_CLASS
    handle.setAttribute('aria-hidden', 'true')
    parent.append(el, handle)
    this.el = el
    this.handleEl = handle
    for (const target of [el, handle]) {
      target.addEventListener('pointerenter', this.onPointerEnter)
      target.addEventListener('pointerleave', this.onPointerLeave)
    }
    const win = doc.defaultView
    this.resizeObserver = win ? new win.ResizeObserver(this.syncLift) : null
    this.resizeObserver?.observe(parent)
    const statusBar = this.statusBar()
    if (statusBar) {
      this.resizeObserver?.observe(statusBar, { box: 'border-box' })
    }
    this.syncLift()
  }

  contains(node: Node): boolean {
    return this.el.contains(node) || this.handleEl.contains(node)
  }

  /**
   * Whether the bar gets out of the way when it is not being reached for.
   * Turned on once the board is being worked on, and off while there is
   * nothing on it — an empty board's hint points at this bar. Turning it on
   * again (every press on the board does) tucks away a bar a tap opened.
   */
  setAutoCollapse(enabled: boolean): void {
    this.autoCollapse = enabled
    this.clearCollapseTimer()
    this.setCollapsed(enabled && !this.hovered)
  }

  /**
   * Takes the bar off screen while the board cannot accept a new card: zoomed
   * out past the point where a card's content is built at all (a card created
   * there would be an empty rectangle with no editor, which is why
   * `createTextCardAt` already declines).
   */
  setAvailable(available: boolean): void {
    this.el.classList.toggle(MENU_HIDDEN_CLASS, !available)
    this.handleEl.classList.toggle(MENU_HIDDEN_CLASS, !available)
    if (available) this.syncLift()
  }

  destroy(): void {
    this.clearCollapseTimer()
    this.resizeObserver?.disconnect()
    this.el.remove()
    this.handleEl.remove()
  }

  private readonly onPointerEnter = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') this.hovered = true
    this.clearCollapseTimer()
    this.setCollapsed(false)
  }

  /** Leaving tucks the bar away after a beat, not at once: a pointer that
   * grazes past, or crosses from the handle onto the bar it just opened,
   * must not set it flapping. */
  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    this.hovered = false
    if (!this.autoCollapse) return
    this.clearCollapseTimer()
    this.collapseTimer =
      this.doc.defaultView?.setTimeout(() => {
        this.collapseTimer = null
        if (this.autoCollapse && !this.hovered) this.setCollapsed(true)
      }, CARD_MENU_COLLAPSE_DELAY_MS) ?? null
  }

  private setCollapsed(collapsed: boolean): void {
    this.el.classList.toggle(MENU_COLLAPSED_CLASS, collapsed)
    this.handleEl.classList.toggle(MENU_COLLAPSED_CLASS, collapsed)
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer === null) return
    this.doc.defaultView?.clearTimeout(this.collapseTimer)
    this.collapseTimer = null
  }

  /** Obsidian's status bar, which on desktop floats over the bottom right of
   * the workspace; absent in a popout and on mobile. */
  private statusBar(): HTMLElement | null {
    return this.doc.querySelector<HTMLElement>('.status-bar')
  }

  /**
   * Stands the bar and its handle clear of the status bar, when the two share
   * the bottom of the board. The status bar grows leftward from the window's
   * right edge, so in a narrow pane it reaches under the middle of the board,
   * where this bar sits — and a handle a few pixels off the bottom would be
   * underneath it outright.
   */
  private readonly syncLift = (): void => {
    const area = this.parent.getBoundingClientRect()
    const bar = this.statusBar()?.getBoundingClientRect()
    let lift = 0
    if (bar && bar.height > 0 && area.height > 0) {
      const centre = area.left + area.width / 2
      const half = this.el.offsetWidth / 2
      const sharesX = bar.left < centre + half && bar.right > centre - half
      if (sharesX) lift = Math.max(0, area.bottom - bar.top)
    }
    for (const target of [this.el, this.handleEl]) {
      target.style.setProperty(LIFT_PROPERTY, `${lift}px`)
    }
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
