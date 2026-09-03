// The floating toolbar that appears over the current selection (P3 batch 3's
// interaction surface ①/②), and the colour popover it opens.
//
// Modelled on Obsidian Canvas's `.canvas-menu`, measured in a running
// Obsidian: a row of `clickable-icon` buttons in a screen-space container that
// is re-positioned as the camera moves, centred on the selection's bounding
// box and sitting just above it. The button set is Canvas's too — delete,
// colour, focus, group, align — as are the placement law and the colour
// picker's anatomy (six preset dots, a "no colour" dot, and a custom swatch
// that is an `<input type="color">` at zero opacity).
//
// What this toolbar does not have is an overflow button. Every command the
// selection can take is a button, and the two that open something open a
// popover of this module's own making rather than a host menu — see
// `ToolbarMenuControl` for why that distinction is the point.
//
// This class is a renderer: it knows how to draw a toolbar and how to raise
// the events its controls produce, and nothing about boards, selections or
// colours. What the buttons *are* is decided by ui/canvas.ts, which hands one
// of these a `ToolbarModel` and a screen position.
//
// Popout safety: every element is created from the `Document` handed in, never
// the global one (Popout / Multi-window, CLAUDE.md).

import type { ScreenPoint } from '../domain/camera'
import {
  COLOR_PRESETS,
  type ColorPreset,
  customColorInputValue,
  normalizeHex,
  resolveColor,
} from '../domain/color'
import type { ToolbarSize } from '../domain/toolbar'

import { TOOLBAR_MARGIN_PX } from './constants'

const OVERLAY_CLASS = 'yolo-whiteboard-overlay'
const TOOLBAR_CLASS = 'yolo-whiteboard-toolbar'
const TOOLBAR_HIDDEN_CLASS = 'yolo-whiteboard-toolbar-hidden'
const TOOLBAR_BUTTON_CLASS = 'yolo-whiteboard-toolbar-button'
/** The popover's chrome (position, panel, shadow); the class beside it says
 * what is inside. */
const POPOVER_CLASS = 'yolo-whiteboard-toolbar-popover'
const COLOR_POPOVER_CLASS = 'yolo-whiteboard-color-popover'
const MENU_POPOVER_CLASS = 'yolo-whiteboard-menu-popover'
const MENU_ITEM_CLASS = 'yolo-whiteboard-menu-popover-item'
const MENU_ITEM_LABEL_CLASS = 'yolo-whiteboard-menu-popover-label'
const SWATCH_CLASS = 'yolo-whiteboard-color-swatch'
const SWATCH_DEFAULT_CLASS = 'yolo-whiteboard-color-swatch-default'
const SWATCH_CUSTOM_CLASS = 'yolo-whiteboard-color-swatch-custom'
const SWATCH_ACTIVE_CLASS = 'yolo-whiteboard-color-swatch-active'

/** Applied to anything that should paint in a node/edge colour; sets
 * `--yolo-whiteboard-color` (style.css). Shared by cards, edge paths and the
 * picker's own swatches, so a swatch cannot drift from what picking it does. */
export function colorPresetClass(preset: ColorPreset): string {
  return `yolo-whiteboard-color-${preset}`
}

export const COLOR_CUSTOM_PROPERTY = '--yolo-whiteboard-color'
/** Marks an element as carrying a colour at all — the switch between the
 * themed and the default look (Obsidian Canvas's `is-themed`). */
export const THEMED_CLASS = 'yolo-whiteboard-themed'

/**
 * Paints `el` in `color`, or returns it to the default look when the colour is
 * absent or unrecognized. The single place the colour rules touch the DOM, so
 * a card, an edge path and a swatch can never disagree about what a value
 * looks like.
 */
export function applyColorToElement(
  el: Element & ElementCSSInlineStyle,
  color: string | undefined,
): void {
  for (const preset of COLOR_PRESETS) {
    el.classList.remove(colorPresetClass(preset))
  }
  el.style.removeProperty(COLOR_CUSTOM_PROPERTY)
  const resolved = resolveColor(color)
  switch (resolved.kind) {
    case 'preset':
      el.classList.add(colorPresetClass(resolved.preset), THEMED_CLASS)
      return
    case 'custom':
      el.style.setProperty(COLOR_CUSTOM_PROPERTY, resolved.hex)
      el.classList.add(THEMED_CLASS)
      return
    case 'none':
      el.classList.remove(THEMED_CLASS)
  }
}

export type ToolbarIconName =
  | 'palette'
  | 'pencil'
  | 'arrow-right'
  | 'arrow-left'
  | 'move-horizontal'
  | 'minus'
  | 'check'
  | 'tag'
  | 'trash'
  | 'scan-search'
  | 'group'
  | 'layout-grid'
  | 'align-start-vertical'
  | 'align-center-vertical'
  | 'align-end-vertical'
  | 'align-start-horizontal'
  | 'align-center-horizontal'
  | 'align-end-horizontal'
  | 'align-horizontal-distribute-center'
  | 'align-vertical-distribute-center'

export type ToolbarAction = Readonly<{
  kind?: 'action'
  label: string
  icon: ToolbarIconName
  onSelect: (event: MouseEvent) => void
}>

export type ToolbarColorControl = Readonly<{
  kind: 'color'
  /** Tooltip for the palette button. */
  label: string
  /** Tooltip for the "no colour" swatch. */
  defaultLabel: string
  /** Tooltip per preset, in `COLOR_PRESETS` order. */
  presetLabels: Readonly<Record<ColorPreset, string>>
  /** Tooltip for the custom-colour swatch. */
  customLabel: string
  /** The selection's current colour, or undefined when it has none/disagrees. */
  current: string | undefined
  onPick: (color: string | undefined) => void
}>

export type ToolbarMenuEntry = Readonly<{
  label: string
  icon: ToolbarIconName
  /** Drawn with a check mark, for the state the selection is already in.
   * Only a `list` menu shows it — a row of icons has nowhere to put it. */
  checked?: boolean
  onSelect: () => void
}>

/**
 * A button whose commands are too many for the row but too alike to separate:
 * it opens a popover of its own, anchored under the button.
 *
 * Deliberately not the host's `showMenu`. That is Obsidian's `Menu`, which on
 * desktop is by default the *operating system's* menu — correct where a menu
 * belongs to a right-click, and wrong hanging off a button inside a canvas,
 * where it arrives as a piece of the OS pasted over the board. Obsidian Canvas
 * draws the same line: its own align button forces `setUseNativeMenu(false)`
 * and anchors the result to the button, while its context menu stays native.
 * Drawing it ourselves is also the only way the popover can show which entry
 * is currently in force — which is what a set of named states needs, and a
 * set of named states is all that is left behind a toolbar button now that
 * the one-shot commands are either a single click (tidy) or right-click menu
 * items (align, distribute).
 */
export type ToolbarMenuControl = Readonly<{
  kind: 'menu'
  label: string
  icon: ToolbarIconName
  /** One block per group: a labelled row per entry, with a check on the one
   * in force — what Obsidian's own menus look like. Empty groups are dropped,
   * so a caller can pass a group its current selection does not qualify
   * for. */
  groups: readonly (readonly ToolbarMenuEntry[])[]
}>

/** One button in the row. The controls that open something are items like any
 * other so their place in the row is the caller's decision, not this class's —
 * the delete button has to be able to sit before them. */
export type ToolbarItem =
  | ToolbarAction
  | ToolbarColorControl
  | ToolbarMenuControl

export type ToolbarModel = Readonly<{
  /** Drawn left to right. A control the selection cannot use is simply
   * absent, rather than drawn and inert. */
  items: readonly ToolbarItem[]
}>

/**
 * Lucide icon geometry, the same drawings Obsidian's own `setIcon` produces
 * (lucide 0.447, the version this repository already vendors for the Learning
 * module's React UI). Inlined rather than imported: this module is imperative
 * DOM with no package dependencies, and a handful of path strings is not worth
 * one. The names are lucide's own, so a command can hand the same name to this
 * table or to a host menu item and get the same drawing either way.
 */
const ICONS: Readonly<Record<ToolbarIconName, readonly IconShape[]>> = {
  palette: [
    { kind: 'dot', cx: 13.5, cy: 6.5 },
    { kind: 'dot', cx: 17.5, cy: 10.5 },
    { kind: 'dot', cx: 8.5, cy: 7.5 },
    { kind: 'dot', cx: 6.5, cy: 12.5 },
    {
      kind: 'path',
      d: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z',
    },
  ],
  pencil: [
    {
      kind: 'path',
      d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    },
    { kind: 'path', d: 'm15 5 4 4' },
  ],
  'layout-grid': [
    { kind: 'rect', x: 3, y: 3, w: 7, h: 7, r: 1 },
    { kind: 'rect', x: 14, y: 3, w: 7, h: 7, r: 1 },
    { kind: 'rect', x: 14, y: 14, w: 7, h: 7, r: 1 },
    { kind: 'rect', x: 3, y: 14, w: 7, h: 7, r: 1 },
  ],
  group: [
    { kind: 'path', d: 'M3 7V5c0-1.1.9-2 2-2h2' },
    { kind: 'path', d: 'M17 3h2c1.1 0 2 .9 2 2v2' },
    { kind: 'path', d: 'M21 17v2c0 1.1-.9 2-2 2h-2' },
    { kind: 'path', d: 'M7 21H5c-1.1 0-2-.9-2-2v-2' },
    { kind: 'rect', x: 7, y: 7, w: 7, h: 5, r: 1 },
    { kind: 'rect', x: 10, y: 12, w: 7, h: 5, r: 1 },
  ],
  'align-start-vertical': [
    { kind: 'rect', x: 6, y: 14, w: 9, h: 6, r: 2 },
    { kind: 'rect', x: 6, y: 4, w: 16, h: 6, r: 2 },
    { kind: 'path', d: 'M2 2v20' },
  ],
  'align-center-vertical': [
    { kind: 'path', d: 'M12 2v20' },
    { kind: 'path', d: 'M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4' },
    { kind: 'path', d: 'M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4' },
    { kind: 'path', d: 'M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1' },
    { kind: 'path', d: 'M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1' },
  ],
  'align-end-vertical': [
    { kind: 'rect', x: 2, y: 4, w: 16, h: 6, r: 2 },
    { kind: 'rect', x: 9, y: 14, w: 9, h: 6, r: 2 },
    { kind: 'path', d: 'M22 22V2' },
  ],
  'align-start-horizontal': [
    { kind: 'rect', x: 4, y: 6, w: 6, h: 16, r: 2 },
    { kind: 'rect', x: 14, y: 6, w: 6, h: 9, r: 2 },
    { kind: 'path', d: 'M22 2H2' },
  ],
  'align-center-horizontal': [
    { kind: 'path', d: 'M2 12h20' },
    { kind: 'path', d: 'M10 16v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4' },
    { kind: 'path', d: 'M10 8V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v4' },
    { kind: 'path', d: 'M20 16v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1' },
    { kind: 'path', d: 'M14 8V7c0-1.1.9-2 2-2h2a2 2 0 0 1 2 2v1' },
  ],
  'align-end-horizontal': [
    { kind: 'rect', x: 4, y: 2, w: 6, h: 16, r: 2 },
    { kind: 'rect', x: 14, y: 9, w: 6, h: 9, r: 2 },
    { kind: 'path', d: 'M22 22H2' },
  ],
  'align-horizontal-distribute-center': [
    { kind: 'rect', x: 4, y: 5, w: 6, h: 14, r: 2 },
    { kind: 'rect', x: 14, y: 7, w: 6, h: 10, r: 2 },
    { kind: 'path', d: 'M17 22v-5' },
    { kind: 'path', d: 'M17 7V2' },
    { kind: 'path', d: 'M7 22v-3' },
    { kind: 'path', d: 'M7 5V2' },
  ],
  'align-vertical-distribute-center': [
    { kind: 'path', d: 'M22 17h-3' },
    { kind: 'path', d: 'M22 7h-5' },
    { kind: 'path', d: 'M5 17H2' },
    { kind: 'path', d: 'M7 7H2' },
    { kind: 'rect', x: 5, y: 14, w: 14, h: 6, r: 2 },
    { kind: 'rect', x: 7, y: 4, w: 10, h: 6, r: 2 },
  ],
  'arrow-right': [
    { kind: 'path', d: 'M5 12h14' },
    { kind: 'path', d: 'm12 5 7 7-7 7' },
  ],
  'arrow-left': [
    { kind: 'path', d: 'm12 19-7-7 7-7' },
    { kind: 'path', d: 'M19 12H5' },
  ],
  'move-horizontal': [
    { kind: 'path', d: 'm18 8 4 4-4 4' },
    { kind: 'path', d: 'M2 12h20' },
    { kind: 'path', d: 'm6 16-4-4 4-4' },
  ],
  minus: [{ kind: 'path', d: 'M5 12h14' }],
  check: [{ kind: 'path', d: 'M20 6 9 17l-5-5' }],
  tag: [
    {
      kind: 'path',
      d: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z',
    },
    { kind: 'dot', cx: 7.5, cy: 7.5 },
  ],
  'scan-search': [
    { kind: 'path', d: 'M3 7V5a2 2 0 0 1 2-2h2' },
    { kind: 'path', d: 'M17 3h2a2 2 0 0 1 2 2v2' },
    { kind: 'path', d: 'M21 17v2a2 2 0 0 1-2 2h-2' },
    { kind: 'path', d: 'M7 21H5a2 2 0 0 1-2-2v-2' },
    { kind: 'ring', cx: 12, cy: 12, r: 3 },
    { kind: 'path', d: 'm16 16-1.9-1.9' },
  ],
  trash: [
    { kind: 'path', d: 'M3 6h18' },
    { kind: 'path', d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' },
    { kind: 'path', d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' },
    { kind: 'path', d: 'M10 11v6' },
    { kind: 'path', d: 'M14 11v6' },
  ],
}

/** `dot` is filled (the palette's paint blobs); `ring` and `rect` are stroked
 * like a path, which is what lucide's `<circle>` and `<rect>` elements are. */
type IconShape =
  | Readonly<{ kind: 'path'; d: string }>
  | Readonly<{ kind: 'dot'; cx: number; cy: number; r?: number }>
  | Readonly<{ kind: 'ring'; cx: number; cy: number; r: number }>
  | Readonly<{
      kind: 'rect'
      x: number
      y: number
      w: number
      h: number
      r: number
    }>

const SVG_NS = 'http://www.w3.org/2000/svg'

export class SelectionToolbar {
  /** Screen-space layer holding the toolbar (and, while it is open, the
   * colour popover). Transparent to the pointer itself so it cannot steal the
   * canvas gestures underneath; its children take pointer events back. */
  private readonly overlayEl: HTMLElement
  private readonly el: HTMLElement
  /** The one popover a toolbar may have open, with the button that owns it —
   * both the colour picker and a menu button hang off this, so opening either
   * closes the other without any of them knowing about the rest. */
  private popover: Readonly<{ el: HTMLElement; button: HTMLElement }> | null =
    null
  private model: ToolbarModel | null = null
  /** The colour item out of `model.items`, kept aside because the popover and
   * `setCurrentColor` reach for it on every interaction. */
  private color: ToolbarColorControl | null = null

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
  ) {
    this.overlayEl = doc.createElement('div')
    this.overlayEl.className = OVERLAY_CLASS
    this.el = doc.createElement('div')
    this.el.className = `${TOOLBAR_CLASS} ${TOOLBAR_HIDDEN_CLASS}`
    this.overlayEl.appendChild(this.el)
    parent.appendChild(this.overlayEl)
  }

  /** The layer the caller can hang other screen-space editing chrome in (the
   * edge-label input), so one `contains` check covers all of it. */
  get overlay(): HTMLElement {
    return this.overlayEl
  }

  /** Whether a pointer event landed on the toolbar or anything else in the
   * overlay — the test ui/canvas.ts uses to keep a click on a button from
   * also being a click on the canvas behind it. */
  contains(node: Node): boolean {
    return this.overlayEl.contains(node)
  }

  /** Rebuilds the toolbar's contents. `null` empties and hides it. Closes any
   * popover: what it acts on is exactly what just changed. */
  setModel(model: ToolbarModel | null): void {
    this.closePopover()
    this.model = model
    this.el.replaceChildren()
    this.color = null
    if (!model || model.items.length === 0) {
      this.el.classList.add(TOOLBAR_HIDDEN_CLASS)
      return
    }
    for (const item of model.items) {
      switch (item.kind) {
        case 'color': {
          this.color = item
          const button = this.appendButton({
            label: item.label,
            icon: 'palette',
            onSelect: () => this.togglePopover(button),
          })
          break
        }
        case 'menu': {
          const button = this.appendButton({
            label: item.label,
            icon: item.icon,
            onSelect: () => this.togglePopover(button, item),
          })
          break
        }
        default:
          this.appendButton(item)
      }
    }
    this.el.classList.remove(TOOLBAR_HIDDEN_CLASS)
  }

  /** Reflects a colour the caller just applied, without rebuilding the
   * toolbar — picking a second colour from an open popover has to be possible. */
  setCurrentColor(color: string | undefined): void {
    if (!this.color) return
    this.color = { ...this.color, current: color }
    if (this.popover) this.markActiveSwatch()
  }

  /** Measured only while shown — a hidden toolbar has no size, and the caller
   * needs the real one to centre it. */
  size(): ToolbarSize {
    const rect = this.el.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }

  place(point: ScreenPoint): void {
    this.el.style.transform = `translate(${point.x}px, ${point.y}px)`
  }

  /** Hides the toolbar without forgetting what is in it — what a drag or a
   * camera gesture does, exactly as Obsidian Canvas hides its own menu for the
   * duration. */
  setSuppressed(suppressed: boolean): void {
    if (!this.model) return
    if (suppressed) this.closePopover()
    this.el.classList.toggle(TOOLBAR_HIDDEN_CLASS, suppressed)
  }

  closePopover(): void {
    if (!this.popover) return
    this.popover.el.remove()
    this.popover.button.classList.remove('is-active')
    this.popover = null
  }

  get popoverOpen(): boolean {
    return this.popover !== null
  }

  destroy(): void {
    this.closePopover()
    this.overlayEl.remove()
  }

  // -- internals ----------------------------------------------------------

  private appendButton(action: ToolbarAction): HTMLElement {
    const button = this.doc.createElement('button')
    // `clickable-icon` is Obsidian's own icon-button treatment (hover, active
    // and focus states, icon sizing) — the same class its Canvas menu uses.
    // The yolo- class beside it is what this stylesheet is allowed to target.
    button.className = `clickable-icon ${TOOLBAR_BUTTON_CLASS}`
    button.type = 'button'
    button.setAttribute('aria-label', action.label)
    button.appendChild(this.createIcon(action.icon))
    button.addEventListener('click', (event) => {
      event.preventDefault()
      action.onSelect(event)
    })
    this.el.appendChild(button)
    return button
  }

  private createIcon(name: ToolbarIconName): SVGElement {
    const svg = this.doc.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'svg-icon')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    for (const shape of ICONS[name]) {
      if (shape.kind === 'path') {
        const path = this.doc.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', shape.d)
        svg.appendChild(path)
        continue
      }
      if (shape.kind === 'rect') {
        const rect = this.doc.createElementNS(SVG_NS, 'rect')
        rect.setAttribute('x', String(shape.x))
        rect.setAttribute('y', String(shape.y))
        rect.setAttribute('width', String(shape.w))
        rect.setAttribute('height', String(shape.h))
        rect.setAttribute('rx', String(shape.r))
        svg.appendChild(rect)
        continue
      }
      const circle = this.doc.createElementNS(SVG_NS, 'circle')
      circle.setAttribute('cx', String(shape.cx))
      circle.setAttribute('cy', String(shape.cy))
      circle.setAttribute('r', String(shape.r ?? 0.5))
      if (shape.kind === 'dot') circle.setAttribute('fill', 'currentColor')
      svg.appendChild(circle)
    }
    return svg
  }

  /**
   * Opens `button`'s popover, or closes whatever is open. One popover at a
   * time is the whole rule: a second click on the same button closes it, and a
   * click on a different one replaces it.
   */
  private togglePopover(button: HTMLElement, menu?: ToolbarMenuControl): void {
    const wasOpen = this.popover?.button === button
    this.closePopover()
    if (wasOpen) return

    const popover = this.doc.createElement('div')
    popover.className = `${POPOVER_CLASS} ${menu ? MENU_POPOVER_CLASS : COLOR_POPOVER_CLASS}`
    if (menu) this.fillMenuPopover(popover, menu)
    else if (!this.fillColorPopover(popover)) return

    this.el.appendChild(popover)
    this.positionPopover(popover, button)
    this.popover = { el: popover, button }
    button.classList.add('is-active')
    if (!menu) this.markActiveSwatch()
  }

  /**
   * Hangs the popover under the button that owns it — with several buttons
   * able to open one, where it hangs from is the only thing saying which
   * button it belongs to — then pulls it back inside the board if that would
   * leave it hanging off the edge.
   */
  private positionPopover(popover: HTMLElement, button: HTMLElement): void {
    const anchor = button.offsetLeft
    popover.style.left = `${anchor}px`
    const bounds = this.overlayEl.getBoundingClientRect()
    const rect = popover.getBoundingClientRect()
    const min = bounds.left + TOOLBAR_MARGIN_PX
    const max = bounds.right - TOOLBAR_MARGIN_PX - rect.width
    // `max` is below `min` only on a board narrower than the popover, where
    // the left edge is the better of the two failures.
    const clamped = Math.max(min, Math.min(rect.left, Math.max(min, max)))
    if (clamped !== rect.left) {
      popover.style.left = `${anchor + (clamped - rect.left)}px`
    }
  }

  private fillColorPopover(popover: HTMLElement): boolean {
    const color = this.color
    if (!color) return false
    this.appendSwatch(popover, {
      label: color.defaultLabel,
      extraClass: SWATCH_DEFAULT_CLASS,
      value: undefined,
    })
    for (const preset of COLOR_PRESETS) {
      this.appendSwatch(popover, {
        label: color.presetLabels[preset],
        extraClass: colorPresetClass(preset),
        value: preset,
      })
    }
    this.appendCustomSwatch(popover, color)
    return true
  }

  /** One labelled item per entry. Selecting closes the popover: these
   * commands change
   * what is selected or how it is drawn, so leaving it open would leave it
   * describing a board that has moved on. */
  private fillMenuPopover(
    popover: HTMLElement,
    menu: ToolbarMenuControl,
  ): void {
    for (const group of menu.groups) {
      for (const entry of group) {
        popover.appendChild(this.createMenuItem(entry))
      }
    }
  }

  /** Icon, label, and a check on the state that is already in force —
   * Obsidian's own menu item, drawn in this popover so it can hang off the
   * button rather than off the pointer. */
  private createMenuItem(entry: ToolbarMenuEntry): HTMLElement {
    const button = this.doc.createElement('button')
    button.className = MENU_ITEM_CLASS
    button.type = 'button'
    // The states are mutually exclusive, and the one in force reads as the
    // pressed one — the check mark beside it, said out loud.
    button.setAttribute('aria-pressed', String(Boolean(entry.checked)))
    button.appendChild(this.createIcon(entry.icon))
    const label = this.doc.createElement('span')
    label.className = MENU_ITEM_LABEL_CLASS
    label.textContent = entry.label
    button.appendChild(label)
    if (entry.checked) button.appendChild(this.createIcon('check'))
    this.bindMenuEntry(button, entry)
    return button
  }

  private bindMenuEntry(button: HTMLElement, entry: ToolbarMenuEntry): void {
    button.addEventListener('click', (event) => {
      event.preventDefault()
      this.closePopover()
      entry.onSelect()
    })
  }

  private appendSwatch(
    popover: HTMLElement,
    options: Readonly<{
      label: string
      extraClass: string
      value: string | undefined
    }>,
  ): HTMLElement {
    const swatch = this.doc.createElement('button')
    swatch.className = `${SWATCH_CLASS} ${options.extraClass}`
    swatch.type = 'button'
    swatch.setAttribute('aria-label', options.label)
    swatch.dataset.color = options.value ?? ''
    swatch.addEventListener('click', (event) => {
      event.preventDefault()
      this.color?.onPick(options.value)
    })
    popover.appendChild(swatch)
    return swatch
  }

  /**
   * The custom swatch is a transparent `<input type="color">` sitting on a
   * rainbow dot — Obsidian Canvas's own construction, and the least machinery
   * that gets a real colour picker: the platform's own, with no popover of our
   * making to position, dismiss or make keyboard-reachable.
   *
   * `change` rather than `input`: a native picker streams `input` as the user
   * drags through the spectrum, and every one of those would be a board write
   * and an undo step. `change` fires once, on commit.
   */
  private appendCustomSwatch(
    popover: HTMLElement,
    control: ToolbarColorControl,
  ): void {
    const swatch = this.doc.createElement('label')
    swatch.className = `${SWATCH_CLASS} ${SWATCH_CUSTOM_CLASS}`
    swatch.setAttribute('aria-label', control.customLabel)
    const input = this.doc.createElement('input')
    input.type = 'color'
    input.value = customColorInputValue(control.current)
    input.addEventListener('change', () => {
      const hex = normalizeHex(input.value)
      if (hex) this.color?.onPick(hex)
    })
    swatch.appendChild(input)
    popover.appendChild(swatch)
  }

  private markActiveSwatch(): void {
    const popover = this.popover?.el
    const current = this.color?.current
    if (!popover) return
    const resolved = resolveColor(current)
    // `null` = no plain swatch can match, which is the custom case: the empty
    // string belongs to the "no colour" swatch alone.
    const activeValue =
      resolved.kind === 'preset'
        ? resolved.preset
        : resolved.kind === 'none'
          ? ''
          : null
    for (const swatch of Array.from(popover.children)) {
      const isCustom = swatch.classList.contains(SWATCH_CUSTOM_CLASS)
      const matches = isCustom
        ? resolved.kind === 'custom'
        : activeValue !== null &&
          (swatch as HTMLElement).dataset.color === activeValue
      swatch.classList.toggle(SWATCH_ACTIVE_CLASS, matches)
      if (isCustom && resolved.kind === 'custom') {
        ;(swatch as HTMLElement).style.setProperty(
          COLOR_CUSTOM_PROPERTY,
          resolved.hex,
        )
      } else if (isCustom) {
        ;(swatch as HTMLElement).style.removeProperty(COLOR_CUSTOM_PROPERTY)
      }
    }
  }
}
