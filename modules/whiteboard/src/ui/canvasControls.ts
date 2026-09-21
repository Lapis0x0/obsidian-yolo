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

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Lucide geometry, the same icons Canvas's column draws. Inlined like
 * ui/cardMenu.ts's, for the same reason: no package dependencies. */
const ICONS: Readonly<Record<CanvasControlIconName, readonly string[]>> = {
  plus: ['M5 12h14', 'M12 5v14'],
  'rotate-cw': [
    'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8',
    'M21 3v5h-5',
  ],
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
}

export type CanvasControlIconName =
  | 'plus'
  | 'rotate-cw'
  | 'maximize'
  | 'minus'
  | 'undo-2'
  | 'redo-2'

export type CanvasControl = Readonly<{
  label: string
  icon: CanvasControlIconName
  onSelect: () => void
  /** Asked again on every `refresh`; a control without it is always on. */
  isEnabled?: () => boolean
}>

export class CanvasControls {
  private readonly el: HTMLElement
  private readonly stateful: {
    button: HTMLButtonElement
    isEnabled: () => boolean
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
   * undo is shown, and greyed, like Canvas's). */
  refresh(): void {
    for (const { button, isEnabled } of this.stateful) {
      const enabled = isEnabled()
      button.classList.toggle(ITEM_DISABLED_CLASS, !enabled)
      button.setAttribute('aria-disabled', String(!enabled))
    }
  }

  destroy(): void {
    this.el.remove()
  }

  private appendItem(parent: HTMLElement, control: CanvasControl): void {
    const button = this.doc.createElement('button')
    button.className = ITEM_CLASS
    button.type = 'button'
    button.setAttribute('aria-label', control.label)
    button.appendChild(this.createIcon(control.icon))
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
    if (control.isEnabled) {
      this.stateful.push({ button, isEnabled: control.isEnabled })
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
