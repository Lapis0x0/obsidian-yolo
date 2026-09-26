// The top-right control column — Obsidian Canvas's `.canvas-controls`, the
// visible way back for someone who has panned or zoomed themselves lost and
// knows none of the keys.
//
// Canvas's column has four groups: settings, zoom, history, help. This one has
// the two that have something behind them here — zoom and history. A settings
// button with no settings, or a help button with no help, would be copying the
// look without the reason; they go where Canvas puts them when there is
// something to put there.
//
// A renderer like ui/cardMenu.ts: it draws buttons and raises their clicks,
// and knows nothing about boards. Every element is created from the
// `Document` handed in (popout safety).

const CONTROLS_CLASS = 'yolo-whiteboard-controls'
const GROUP_CLASS = 'yolo-whiteboard-control-group'
const ITEM_CLASS = 'yolo-whiteboard-control-item'
const ITEM_DISABLED_CLASS = 'is-disabled'
const ITEM_READOUT_CLASS = 'yolo-whiteboard-control-readout'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Lucide geometry, the same icons Canvas's column draws. Inlined like
 * ui/cardMenu.ts's, for the same reason: no package dependencies. */
const ICONS: Readonly<Record<CanvasControlIconName, readonly string[]>> = {
  plus: ['M5 12h14', 'M12 5v14'],
  maximize: [
    'M8 3H5a2 2 0 0 0-2 2v3',
    'M21 8V5a2 2 0 0 0-2-2h-3',
    'M3 16v3a2 2 0 0 0 2 2h3',
    'M16 21h3a2 2 0 0 0 2-2v-3',
  ],
  minus: ['M5 12h14'],
  'undo-2': [
    'M9 14 4 9l5-5',
    'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11',
  ],
  'redo-2': [
    'm15 14 5-5-5-5',
    'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13',
  ],
  map: [
    'M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z',
    'M15 5.764v15',
    'M9 3.236v15',
  ],
  // `map` struck through, the way Lucide's `-off` icons are drawn: the
  // switch that is off shows its icon crossed out, as a muted microphone
  // does.
  'map-off': [
    'M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z',
    'M15 5.764v15',
    'M9 3.236v15',
    'm2 2 20 20',
  ],
}

export type CanvasControlIconName =
  | 'plus'
  | 'maximize'
  | 'minus'
  | 'undo-2'
  | 'redo-2'
  | 'map'
  | 'map-off'

export type CanvasControl = Readonly<
  {
    /** The tooltip. A function for a switch, whose tooltip names what a
     * click does next — asked again on every `refresh`. */
    label: string | (() => string)
    onSelect: () => void
    /** Asked again on every `refresh`; a control without it is always on. */
    isEnabled?: () => boolean
  } & (
    | {
        /** A function for a switch, which shows its state by its icon alone
         * (`map` / `map-off`) — asked again on every `refresh`. */
        icon: CanvasControlIconName | (() => CanvasControlIconName)
        readout?: never
      }
    | {
        icon?: never
        /** A control that shows a value instead of an icon — the zoom
         * percentage. Asked again on every `refreshReadouts`. */
        readout: () => string
      }
  )
>

export class CanvasControls {
  private readonly el: HTMLElement
  private readonly stateful: {
    button: HTMLButtonElement
    isEnabled?: () => boolean
    label?: () => string
    icon?: () => CanvasControlIconName
    /** The icon the button is drawn with now, so `refresh` redraws it only
     * when it changes. */
    shownIcon?: CanvasControlIconName
  }[] = []
  private readonly readouts: {
    el: HTMLElement
    read: () => string
  }[] = []

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
    groups: readonly (readonly CanvasControl[])[],
  ) {
    const el = doc.createElement('div')
    el.className = CONTROLS_CLASS
    for (const controls of groups) {
      const group = doc.createElement('div')
      group.className = GROUP_CLASS
      for (const control of controls) this.appendItem(group, control)
      el.appendChild(group)
    }
    parent.appendChild(el)
    this.el = el
    this.refresh()
  }

  contains(node: Node): boolean {
    return this.el === node || this.el.contains(node)
  }

  /** Re-asks every control whether it can act now (undo with nothing to
   * undo is shown, and greyed, like Canvas's), and every switch which way
   * it is set. */
  refresh(): void {
    for (const item of this.stateful) {
      const { button, isEnabled, label, icon } = item
      if (isEnabled) {
        const enabled = isEnabled()
        button.classList.toggle(ITEM_DISABLED_CLASS, !enabled)
        button.setAttribute('aria-disabled', String(!enabled))
      }
      if (label) button.setAttribute('aria-label', label())
      if (icon) {
        const name = icon()
        if (name !== item.shownIcon) {
          item.shownIcon = name
          button.replaceChildren(this.createIcon(name))
        }
      }
    }
  }

  /** Re-reads every value-showing control. Called on every camera frame, so
   * the text is only written when it actually changed. */
  refreshReadouts(): void {
    for (const { el, read } of this.readouts) {
      const text = read()
      if (el.textContent !== text) el.textContent = text
    }
  }

  destroy(): void {
    this.el.remove()
  }

  private appendItem(parent: HTMLElement, control: CanvasControl): void {
    const button = this.doc.createElement('button')
    button.className = ITEM_CLASS
    button.type = 'button'
    // A switch's label and icon are drawn by `refresh`, which the
    // constructor runs once every item is in.
    let label: (() => string) | null = null
    if (typeof control.label === 'function') label = control.label
    else button.setAttribute('aria-label', control.label)
    let icon: (() => CanvasControlIconName) | null = null
    if (control.readout) {
      button.classList.add(ITEM_READOUT_CLASS)
      const text = this.doc.createElement('span')
      text.textContent = control.readout()
      button.appendChild(text)
      this.readouts.push({ el: text, read: control.readout })
    } else if (typeof control.icon === 'function') {
      icon = control.icon
    } else {
      button.appendChild(this.createIcon(control.icon))
    }
    // A click here is about the board, not the button: keeping focus where it
    // was keeps the board's keys (Space, Mod+Z) working after it.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      if (control.isEnabled && !control.isEnabled()) return
      control.onSelect()
    })
    if (control.isEnabled || label || icon) {
      this.stateful.push({
        button,
        isEnabled: control.isEnabled,
        label: label ?? undefined,
        icon: icon ?? undefined,
      })
    }
    parent.appendChild(button)
  }

  private createIcon(name: CanvasControlIconName): SVGElement {
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
