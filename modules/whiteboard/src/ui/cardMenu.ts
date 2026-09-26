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

import {
  CARD_MENU_CREATE_LINGER_MS,
  CARD_MENU_HOVER_LINGER_MS,
} from './constants'
import { findStatusBar, statusBarLift } from './statusBarClearance'

const MENU_CLASS = 'yolo-whiteboard-card-menu'
const MENU_HIDDEN_CLASS = 'yolo-whiteboard-card-menu-hidden'
const MENU_COLLAPSED_CLASS = 'yolo-whiteboard-card-menu-collapsed'
const HANDLE_CLASS = 'yolo-whiteboard-card-menu-handle'
const HANDLE_NEAR_CLASS = 'yolo-whiteboard-card-menu-handle-near'
/** How far the bar and its handle stand off whatever covers the bottom of
 * the board — see `syncPlacement`. */
const LIFT_PROPERTY = '--yolo-card-menu-lift'
/** The handle's grip line as creation-bar.css draws it: 36px by 4px, on
 * 6px of padding at the bottom of the handle. The fold lands on exactly this
 * line. */
const HANDLE_GRIP_HALF_WIDTH_PX = 18
const GRIP_HEIGHT_PX = 4
const GRIP_INSET_PX = 6
/** The bar's bottom edge above the board's — creation-bar.css's `bottom`. */
const MENU_INSET_PX = 16
/** How near a pointer comes to the grip before the grip answers it. */
const GRIP_PROXIMITY_PX = 80
/** How close the status bar may come to either end of the grip before the
 * grip stands up out of its way. */
const HANDLE_CLEARANCE_PX = 8
const BUTTON_CLASS = 'yolo-whiteboard-card-menu-button'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Lucide geometry, matching the icons Canvas puts on the same three actions
 * (`lucide-sticky-note`, `lucide-file-text`, `lucide-file-image`) plus a globe
 * for the web card — the one glyph that reads right now that this button takes
 * an HTML document as well as a URL. Inlined for the same reason
 * ui/selectionToolbar.ts inlines its own: this module has no package
 * dependencies, and four icons are not worth acquiring one. */
const ICONS: Readonly<Record<CardMenuIconName, readonly string[]>> = {
  // `lucide-type`: bare text, the one thing on the bar that is not a card.
  type: ['M4 7V4h16v3', 'M9 20h6', 'M12 4v16'],
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
  | 'type'
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
   * on the handle opens the bar and holds it as a hover leaving would. */
  private hovered = false
  /**
   * The earliest the bar may tuck itself away (`performance.now()` time). Every
   * time the bar is reached for, this moves later — never earlier: reaching
   * for it says it is about to be wanted again, and a card made from it says
   * so more strongly than a hover (`hold`). Until then, working on the board
   * does not tuck it away either.
   */
  private holdUntil = 0
  private collapseTimer: number | null = null
  private readonly resizeObserver: ResizeObserver | null

  constructor(
    private readonly doc: Document,
    private readonly parent: HTMLElement,
    actions: readonly CardMenuAction[],
  ) {
    const el = doc.createElement('div')
    el.className = MENU_CLASS
    // Each button's distance from the nearer end, which orders the icons'
    // part of the fold (creation-bar.css).
    actions.forEach((action, index) => {
      const rank = Math.min(index, actions.length - 1 - index)
      this.appendButton(el, action).style.setProperty(
        '--yolo-card-menu-rank',
        String(rank),
      )
    })
    el.style.setProperty(
      '--yolo-card-menu-ranks',
      String(Math.floor((actions.length - 1) / 2)),
    )
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
    this.resizeObserver = win
      ? new win.ResizeObserver(this.syncPlacement)
      : null
    this.resizeObserver?.observe(parent)
    const statusBar = findStatusBar(this.doc)
    if (statusBar) {
      this.resizeObserver?.observe(statusBar, { box: 'border-box' })
    }
    this.syncPlacement()
  }

  contains(node: Node): boolean {
    return this.el.contains(node) || this.handleEl.contains(node)
  }

  /**
   * Whether the bar gets out of the way when it is not being reached for.
   * Turned on once the board is being worked on, and off while there is
   * nothing on it — an empty board's hint points at this bar. Turning it on
   * (every press on the board does) tucks the bar away at once, unless it
   * was reached for recently enough to still be held out (`holdUntil`).
   */
  setAutoCollapse(enabled: boolean): void {
    this.autoCollapse = enabled
    if (!enabled) this.setCollapsed(false)
    else if (!this.hovered && this.now() >= this.holdUntil) {
      this.setCollapsed(true)
    }
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
    if (available) this.syncPlacement()
  }

  destroy(): void {
    this.clearCollapseTimer()
    this.setCollapsed(false)
    this.resizeObserver?.disconnect()
    this.el.remove()
    this.handleEl.remove()
  }

  private readonly onPointerEnter = (event: PointerEvent): void => {
    this.setCollapsed(false)
    if (event.pointerType === 'touch') this.hold(CARD_MENU_HOVER_LINGER_MS)
    else this.hovered = true
  }

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    this.hovered = false
    this.hold(CARD_MENU_HOVER_LINGER_MS)
  }

  /** Keeps the bar out for at least `ms` from now, then lets it tuck itself
   * away if nothing else is holding it by then. */
  private hold(ms: number): void {
    const win = this.doc.defaultView
    if (!win) return
    this.holdUntil = Math.max(this.holdUntil, this.now() + ms)
    this.clearCollapseTimer()
    this.collapseTimer = win.setTimeout(() => {
      this.collapseTimer = null
      if (this.autoCollapse && !this.hovered) this.setCollapsed(true)
    }, this.holdUntil - this.now())
  }

  private now(): number {
    return this.doc.defaultView?.performance.now() ?? 0
  }

  private setCollapsed(collapsed: boolean): void {
    if (this.el.classList.contains(MENU_COLLAPSED_CLASS) === collapsed) return
    this.el.classList.toggle(MENU_COLLAPSED_CLASS, collapsed)
    this.handleEl.classList.toggle(MENU_COLLAPSED_CLASS, collapsed)
    // The grip answers an approaching pointer only while it is all there is
    // of the bar; the listener is not left running over an open one.
    if (collapsed) {
      this.doc.addEventListener('pointermove', this.onProximityMove, {
        passive: true,
      })
    } else {
      this.doc.removeEventListener('pointermove', this.onProximityMove)
      this.handleEl.classList.remove(HANDLE_NEAR_CLASS)
    }
  }

  /** Marks the grip as approached while a mouse or pen is within
   * `GRIP_PROXIMITY_PX` of its line — a hint that there is something to
   * reach for, not an opening. */
  private readonly onProximityMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    const box = this.handleEl.getBoundingClientRect()
    const gripY = box.bottom - GRIP_INSET_PX - GRIP_HEIGHT_PX / 2
    const dx = Math.max(
      0,
      Math.abs(event.clientX - (box.left + box.width / 2)) -
        HANDLE_GRIP_HALF_WIDTH_PX,
    )
    const near = Math.hypot(dx, event.clientY - gripY) <= GRIP_PROXIMITY_PX
    this.handleEl.classList.toggle(HANDLE_NEAR_CLASS, near)
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer === null) return
    this.doc.defaultView?.clearTimeout(this.collapseTimer)
    this.collapseTimer = null
  }

  /**
   * Stands the bar and its handle clear of the status bar, when it floats
   * over the bottom of the board where they sit. The status bar grows
   * leftward from the window's right edge, so in a narrow pane it reaches
   * under the middle of the board.
   *
   * Asked of each on its own width. The handle's grip is far narrower than the
   * bar it stands in for, and a status bar that only reaches the bar's end
   * leaves room under the grip — lifting the grip with the bar would leave it
   * hanging above an empty strip. Its wider hit area may then run under the
   * status bar's edge; the grip itself never does.
   */
  private readonly syncPlacement = (): void => {
    const area = this.parent.getBoundingClientRect()
    const bar = findStatusBar(this.doc)?.getBoundingClientRect()
    const centre = area.left + area.width / 2
    const liftFor = (halfWidth: number): number =>
      statusBarLift(area, bar, centre - halfWidth, centre + halfWidth)
    const width = this.el.offsetWidth
    const height = this.el.offsetHeight
    const menuLift = liftFor(width / 2)
    const handleLift = liftFor(HANDLE_GRIP_HALF_WIDTH_PX + HANDLE_CLEARANCE_PX)
    this.el.style.setProperty(LIFT_PROPERTY, `${menuLift}px`)
    this.handleEl.style.setProperty(LIFT_PROPERTY, `${handleLift}px`)
    // What folds the bar onto the grip: its bottom edge dropped onto the
    // grip's, and its box scaled to the grip's line. Unmeasurable while the
    // bar is not displayed — `setAvailable` asks again when it is.
    if (width === 0 || height === 0) return
    this.el.style.setProperty(
      '--yolo-card-menu-drop',
      `${MENU_INSET_PX + menuLift - (GRIP_INSET_PX + handleLift)}px`,
    )
    this.el.style.setProperty(
      '--yolo-card-menu-fold-x',
      String((HANDLE_GRIP_HALF_WIDTH_PX * 2) / width),
    )
    this.el.style.setProperty(
      '--yolo-card-menu-fold-y',
      String(GRIP_HEIGHT_PX / height),
    )
  }

  private appendButton(
    parent: HTMLElement,
    action: CardMenuAction,
  ): HTMLButtonElement {
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
      this.hold(CARD_MENU_CREATE_LINGER_MS)
      action.onSelect()
    })
    button.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return
      // Nothing this press does is the default one: no text selection, and no
      // focus ring landing on a button whose card is about to be dragged
      // somewhere else. Canvas's `dragTempNode` opens the same way.
      event.preventDefault()
      this.hold(CARD_MENU_CREATE_LINGER_MS)
      action.onPress(event)
    })
    parent.appendChild(button)
    return button
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
