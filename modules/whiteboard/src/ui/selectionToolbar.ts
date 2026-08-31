// The floating toolbar that appears over the current selection (P3 batch 3's
// interaction surface ①/②), and the colour popover it opens.
//
// Modelled on Obsidian Canvas's `.canvas-menu`, measured in a running
// Obsidian: a row of `clickable-icon` buttons in a screen-space container that
// is re-positioned as the camera moves, centred on the selection's bounding
// box and sitting just above it. The button set is ours — Canvas's own row
// carries actions (create group, align) that belong to a later wave — but the
// shape, the placement law and the colour picker's anatomy (six preset dots, a
// "no colour" dot, and a custom swatch that is an `<input type="color">` at
// zero opacity) are Canvas's.
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

const OVERLAY_CLASS = 'yolo-whiteboard-overlay'
const TOOLBAR_CLASS = 'yolo-whiteboard-toolbar'
const TOOLBAR_HIDDEN_CLASS = 'yolo-whiteboard-toolbar-hidden'
const TOOLBAR_BUTTON_CLASS = 'yolo-whiteboard-toolbar-button'
const POPOVER_CLASS = 'yolo-whiteboard-color-popover'
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
  | 'ellipsis'
  | 'arrow-right'
  | 'tag'
  | 'trash'
  | 'scan-search'

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

/** One button in the row. The colour control is an item like any other so its
 * place in the row is the caller's decision, not this class's — the delete
 * button has to be able to sit before it. */
export type ToolbarItem = ToolbarAction | ToolbarColorControl

export type ToolbarModel = Readonly<{
  /** Drawn left to right. A control the selection cannot use — recolouring a
   * locked board — is simply absent, rather than drawn and inert. */
  items: readonly ToolbarItem[]
}>

/**
 * Lucide icon geometry, the same drawings Obsidian's own `setIcon` produces
 * (lucide 0.447, the version this repository already vendors for the Learning
 * module's React UI). Inlined rather than imported: this module is imperative
 * DOM with no package dependencies, and six icons are not worth one.
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
  ellipsis: [
    { kind: 'dot', cx: 12, cy: 12, r: 1 },
    { kind: 'dot', cx: 19, cy: 12, r: 1 },
    { kind: 'dot', cx: 5, cy: 12, r: 1 },
  ],
  'arrow-right': [
    { kind: 'path', d: 'M5 12h14' },
    { kind: 'path', d: 'm12 5 7 7-7 7' },
  ],
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

/** `dot` is filled (the palette's paint blobs, the ellipsis); `ring` is
 * stroked like a path, which is what lucide's `<circle>` elements are. */
type IconShape =
  | Readonly<{ kind: 'path'; d: string }>
  | Readonly<{ kind: 'dot'; cx: number; cy: number; r?: number }>
  | Readonly<{ kind: 'ring'; cx: number; cy: number; r: number }>

const SVG_NS = 'http://www.w3.org/2000/svg'

export class SelectionToolbar {
  /** Screen-space layer holding the toolbar (and, while it is open, the
   * colour popover). Transparent to the pointer itself so it cannot steal the
   * canvas gestures underneath; its children take pointer events back. */
  private readonly overlayEl: HTMLElement
  private readonly el: HTMLElement
  private popoverEl: HTMLElement | null = null
  private paletteButtonEl: HTMLElement | null = null
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

  /** Rebuilds the toolbar's contents. `null` empties and hides it. Closes the
   * colour popover: what the popover acts on is exactly what just changed. */
  setModel(model: ToolbarModel | null): void {
    this.closePopover()
    this.model = model
    this.el.replaceChildren()
    this.paletteButtonEl = null
    this.color = null
    if (!model || model.items.length === 0) {
      this.el.classList.add(TOOLBAR_HIDDEN_CLASS)
      return
    }
    for (const item of model.items) {
      if (item.kind !== 'color') {
        this.appendButton(item)
        continue
      }
      this.color = item
      this.paletteButtonEl = this.appendButton({
        label: item.label,
        icon: 'palette',
        onSelect: () => this.togglePopover(),
      })
    }
    this.el.classList.remove(TOOLBAR_HIDDEN_CLASS)
  }

  /** Reflects a colour the caller just applied, without rebuilding the
   * toolbar — picking a second colour from an open popover has to be possible. */
  setCurrentColor(color: string | undefined): void {
    if (!this.color) return
    this.color = { ...this.color, current: color }
    if (this.popoverEl) this.markActiveSwatch()
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
    this.popoverEl?.remove()
    this.popoverEl = null
    this.paletteButtonEl?.classList.remove('is-active')
  }

  get popoverOpen(): boolean {
    return this.popoverEl !== null
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
      const circle = this.doc.createElementNS(SVG_NS, 'circle')
      circle.setAttribute('cx', String(shape.cx))
      circle.setAttribute('cy', String(shape.cy))
      circle.setAttribute('r', String(shape.r ?? 0.5))
      if (shape.kind === 'dot') circle.setAttribute('fill', 'currentColor')
      svg.appendChild(circle)
    }
    return svg
  }

  private togglePopover(): void {
    if (this.popoverEl) {
      this.closePopover()
      return
    }
    this.openPopover()
  }

  private openPopover(): void {
    const color = this.color
    if (!color) return
    const popover = this.doc.createElement('div')
    popover.className = POPOVER_CLASS

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

    this.el.appendChild(popover)
    this.popoverEl = popover
    this.paletteButtonEl?.classList.add('is-active')
    this.markActiveSwatch()
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
    const popover = this.popoverEl
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
