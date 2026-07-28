import {
  Annotation,
  type ChangeDesc,
  EditorSelection,
  type Extension,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  Direction,
  EditorView,
  type LayerMarker,
  RectangleMarker,
  type ViewUpdate,
  WidgetType,
  layer,
} from '@codemirror/view'
import { Notice } from 'obsidian'

import { executeSingleTurn } from '../../../core/ai/single-turn'
import type { BaseLLMProvider } from '../../../core/llm/base'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { ChatModel } from '../../../types/chat-model.types'
import type { LLMProvider } from '../../../types/provider.types'
import { selectionHighlightController } from '../selection-highlight/selectionHighlightController'

type SelectionRewritePhase = 'waiting' | 'streaming' | 'review'

type SelectionRewriteVisual = {
  id: string
  from: number
  to: number
  originalText: string
  candidateText: string
  phase: SelectionRewritePhase
  baselineHeight: number
  startIndent: number
  block: boolean
}

type SelectionRewriteFieldValue = {
  sessions: SelectionRewriteVisual[]
  decorations: DecorationSet
}

type SelectionRewriteRuntime = SelectionRewriteVisual & {
  view: EditorView
  abortController: AbortController
  pendingCandidateText: string
  revealedRawLength: number
  publishFrame: number | null
  publishResolve: (() => void) | null
  autoFollow: boolean
}

export type StartSelectionRewriteOptions = {
  view: EditorView
  from: number
  to: number
  selectedText: string
  instruction: string
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  settings: YoloSettings
}

type SelectionRewriteControllerDeps = {
  t: (key: string, fallback?: string) => string
  addAbortController: (controller: AbortController) => void
  removeAbortController: (controller: AbortController) => void
}

const setSelectionRewriteEffect = StateEffect.define<SelectionRewriteVisual[]>()

const selectionRewriteTransaction = Annotation.define<{
  id: string
  kind: 'commit' | 'reject'
}>()

function stripOuterMarkdownFence(value: string): string {
  const lines = value.split('\n')
  if (lines[0]?.trim().startsWith('```')) lines.shift()
  if (lines.at(-1)?.trim() === '```') lines.pop()
  return lines.join('\n')
}

class SelectionRewriteCandidateWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly text: string,
    readonly baselineHeight: number,
    readonly startIndent: number,
    readonly block: boolean,
  ) {
    super()
  }

  override eq(other: SelectionRewriteCandidateWidget): boolean {
    return (
      other.id === this.id &&
      other.text === this.text &&
      other.baselineHeight === this.baselineHeight &&
      other.startIndent === this.startIndent &&
      other.block === this.block
    )
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (dom.dataset.yoloRewriteId !== this.id) return false
    dom.style.setProperty(
      '--yolo-selection-rewrite-baseline-height',
      `${this.baselineHeight}px`,
    )
    dom.style.setProperty(
      '--yolo-selection-rewrite-start-indent',
      `${this.startIndent}px`,
    )
    const text = dom.querySelector<HTMLElement>(
      '.yolo-selection-rewrite-candidate-text',
    )
    if (!text) return false
    text.textContent = this.text || '\u200b'
    this.updateBlockHeight(dom, text, view)
    return true
  }

  override toDOM(view: EditorView): HTMLElement {
    const root = document.createElement(this.block ? 'div' : 'span')
    root.className = `yolo-selection-rewrite-candidate ${
      this.block ? 'is-block' : 'is-inline'
    }`
    root.dataset.yoloRewriteId = this.id
    root.style.setProperty(
      '--yolo-selection-rewrite-baseline-height',
      `${this.baselineHeight}px`,
    )
    root.style.setProperty(
      '--yolo-selection-rewrite-start-indent',
      `${this.startIndent}px`,
    )
    const text = document.createElement('span')
    text.className = 'yolo-selection-rewrite-candidate-text'
    text.textContent = this.text || '\u200b'
    root.appendChild(text)
    if (this.block) {
      root.style.height = `${this.baselineHeight}px`
      const observer = new ResizeObserver(() => view.requestMeasure())
      observer.observe(root)
      rewriteResizeObservers.set(root, observer)
      this.updateBlockHeight(root, text, view)
    }
    return root
  }

  override get estimatedHeight(): number {
    return this.block ? this.baselineHeight : -1
  }

  override destroy(dom: HTMLElement): void {
    rewriteResizeObservers.get(dom)?.disconnect()
    rewriteResizeObservers.delete(dom)
  }

  private updateBlockHeight(
    root: HTMLElement,
    text: HTMLElement,
    view: EditorView,
  ): void {
    if (!this.block) return
    window.requestAnimationFrame(() => {
      if (!root.isConnected) return
      const target = Math.max(
        this.baselineHeight,
        measureCandidateTextHeight(text, view.defaultLineHeight),
      )
      root.style.height = `${target}px`
      view.requestMeasure()
    })
  }
}

const rewriteResizeObservers = new WeakMap<HTMLElement, ResizeObserver>()

function measureCandidateTextHeight(
  text: HTMLElement,
  fallbackHeight: number,
): number {
  const rects = Array.from(text.getClientRects()).filter(
    (rect) => rect.height > 0,
  )
  if (rects.length === 0) return fallbackHeight
  const top = Math.min(...rects.map((rect) => rect.top))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return Math.max(fallbackHeight, bottom - top)
}

function buildRewriteDecorations(
  sessions: SelectionRewriteVisual[],
): DecorationSet {
  const ranges = sessions
    .filter(
      (session) => session.phase === 'streaming' && session.from <= session.to,
    )
    .map((session) =>
      Decoration.replace({
        widget: new SelectionRewriteCandidateWidget(
          session.id,
          session.candidateText,
          session.baselineHeight,
          session.startIndent,
          session.block,
        ),
        inclusive: true,
        block: session.block,
      }).range(session.from, session.to),
    )

  return Decoration.set(ranges, true)
}

function createFieldValue(
  sessions: SelectionRewriteVisual[],
): SelectionRewriteFieldValue {
  return {
    sessions,
    decorations: buildRewriteDecorations(sessions),
  }
}

const selectionRewriteField = StateField.define<SelectionRewriteFieldValue>({
  create: () => createFieldValue([]),
  update(value, transaction) {
    const replacement = transaction.effects.find((effect) =>
      effect.is(setSelectionRewriteEffect),
    )
    if (replacement?.is(setSelectionRewriteEffect)) {
      return createFieldValue(replacement.value)
    }

    if (!transaction.docChanged || value.sessions.length === 0) return value

    return createFieldValue(
      value.sessions.map((session) => ({
        ...session,
        from: transaction.changes.mapPos(session.from, -1),
        to: transaction.changes.mapPos(session.to, 1),
      })),
    )
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
})

function getLayerBase(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect()
  const left =
    view.textDirection === Direction.LTR
      ? rect.left
      : rect.right - view.scrollDOM.clientWidth * view.scaleX
  return {
    left: left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  }
}

function getContentHorizontalBounds(view: EditorView): {
  left: number
  right: number
} {
  const contentRect = view.contentDOM.getBoundingClientRect()
  const line = view.contentDOM.querySelector<HTMLElement>('.cm-line')
  const style = line ? window.getComputedStyle(line) : null
  const paddingLeft = style ? Number.parseFloat(style.paddingLeft) || 0 : 0
  const paddingRight = style ? Number.parseFloat(style.paddingRight) || 0 : 0
  const textIndent = style ? Number.parseFloat(style.textIndent) || 0 : 0

  return {
    left: contentRect.left + paddingLeft + Math.min(0, textIndent),
    right: contentRect.right - paddingRight,
  }
}

function mergeVisualLineRects(rects: DOMRect[]): DOMRect[] {
  const merged: DOMRect[] = []
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue
    const previous = merged.at(-1)
    if (
      previous &&
      Math.abs(previous.top - rect.top) < 1 &&
      Math.abs(previous.bottom - rect.bottom) < 1
    ) {
      merged[merged.length - 1] = DOMRect.fromRect({
        x: Math.min(previous.left, rect.left),
        y: Math.min(previous.top, rect.top),
        width:
          Math.max(previous.right, rect.right) -
          Math.min(previous.left, rect.left),
        height:
          Math.max(previous.bottom, rect.bottom) -
          Math.min(previous.top, rect.top),
      })
      continue
    }
    merged.push(rect)
  }
  return merged
}

type RewriteSurfaceRect = {
  left: number
  top: number
  width: number
  height: number
}

type RewriteSurfaceBand = {
  left: number
  right: number
  top: number
  bottom: number
  visualHeight: number
}

type RewriteOutline = {
  left: number
  top: number
  width: number
  height: number
  path: string
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const REWRITE_OUTER_RADIUS = 8
const REWRITE_INNER_RADIUS = 4
const REWRITE_START_PADDING = 4
const REWRITE_SURFACE_EDGE_EPSILON = 1

function padRewriteStart(
  rects: RewriteSurfaceRect[],
  direction: Direction,
  bounds: { left: number; right: number },
): RewriteSurfaceRect[] {
  if (rects.length === 0) return rects

  const padded = [...rects]
  const first = { ...padded[0] }
  if (direction === Direction.LTR) {
    const nextLeft = Math.max(bounds.left, first.left - REWRITE_START_PADDING)
    first.width += first.left - nextLeft
    first.left = nextLeft
  } else {
    const nextRight = Math.min(
      bounds.right,
      first.left + first.width + REWRITE_START_PADDING,
    )
    first.width = nextRight - first.left
  }
  padded[0] = first
  return padded
}
function toSurfaceBand(rect: RewriteSurfaceRect): RewriteSurfaceBand {
  return {
    left: rect.left,
    right: rect.left + rect.width,
    top: rect.top,
    bottom: rect.top + rect.height,
    visualHeight: rect.height,
  }
}

function splitBand(
  band: RewriteSurfaceBand,
  from: number,
  to: number,
): RewriteSurfaceBand {
  return { ...band, top: from, bottom: to }
}

function normalizeSurfaceBands(
  rects: RewriteSurfaceRect[],
): [RewriteSurfaceBand, RewriteSurfaceBand, RewriteSurfaceBand] | null {
  if (rects.length === 0) return null

  const ordered = rects
    .map(toSurfaceBand)
    .sort((a, b) => a.top - b.top || a.left - b.left)

  if (ordered.length === 1) {
    const band = ordered[0]
    const firstBreak = band.top + (band.bottom - band.top) / 3
    const secondBreak = band.top + ((band.bottom - band.top) * 2) / 3
    return [
      splitBand(band, band.top, firstBreak),
      splitBand(band, firstBreak, secondBreak),
      splitBand(band, secondBreak, band.bottom),
    ]
  }

  if (ordered.length === 2) {
    const [first, last] = ordered
    const lastMiddle = last.top + (last.bottom - last.top) / 2
    return [
      first,
      splitBand(last, last.top, lastMiddle),
      splitBand(last, lastMiddle, last.bottom),
    ]
  }

  const first = ordered[0]
  const last = ordered.at(-1)!
  const middleRects = ordered.slice(1, -1)
  const middle: RewriteSurfaceBand = {
    left: Math.min(...middleRects.map((rect) => rect.left)),
    right: Math.max(...middleRects.map((rect) => rect.right)),
    top: first.bottom,
    bottom: last.top,
    visualHeight: Math.max(
      ...middleRects.map((rect) => rect.visualHeight),
    ),
  }
  return [first, middle, last]
}

function transitionRadii(
  edgeDelta: number,
  upper: RewriteSurfaceBand,
  lower: RewriteSurfaceBand,
): { outer: number; inner: number } {
  const heightLimit = Math.min(
    upper.visualHeight / 2,
    lower.visualHeight / 2,
  )
  const desiredOuter = Math.min(REWRITE_OUTER_RADIUS, heightLimit)
  const desiredInner = Math.min(REWRITE_INNER_RADIUS, heightLimit)
  const scale = Math.min(1, edgeDelta / (desiredOuter + desiredInner))
  return {
    outer: desiredOuter * scale,
    inner: desiredInner * scale,
  }
}

function pathNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

function createRewriteOutline(rects: RewriteSurfaceRect[]): RewriteOutline | null {
  const bands = normalizeSurfaceBands(rects)
  if (!bands) return null

  const [first, middle, last] = bands
  const left = Math.min(...bands.map((band) => band.left))
  const right = Math.max(...bands.map((band) => band.right))
  const top = first.top
  const bottom = last.bottom
  const x = (value: number) => pathNumber(value - left)
  const y = (value: number) => pathNumber(value - top)
  const commands: string[] = []
  const topRadius = Math.min(
    REWRITE_OUTER_RADIUS,
    first.visualHeight / 2,
    (first.right - first.left) / 2,
  )
  const bottomRadius = Math.min(
    REWRITE_OUTER_RADIUS,
    last.visualHeight / 2,
    (last.right - last.left) / 2,
  )

  const line = (toX: number, toY: number) =>
    commands.push(`L ${x(toX)} ${y(toY)}`)
  const curve = (
    controlX: number,
    controlY: number,
    toX: number,
    toY: number,
  ) =>
    commands.push(
      `Q ${x(controlX)} ${y(controlY)} ${x(toX)} ${y(toY)}`,
    )

  const rightTransition = (
    upper: RewriteSurfaceBand,
    lower: RewriteSurfaceBand,
  ) => {
    const boundary = lower.top
    const delta = lower.right - upper.right
    if (Math.abs(delta) < REWRITE_SURFACE_EDGE_EPSILON) {
      line(upper.right, boundary)
      return
    }
    const { outer, inner } = transitionRadii(
      Math.abs(delta),
      upper,
      lower,
    )
    if (delta > 0) {
      line(upper.right, boundary - inner)
      curve(upper.right, boundary, upper.right + inner, boundary)
      line(lower.right - outer, boundary)
      curve(lower.right, boundary, lower.right, boundary + outer)
    } else {
      line(upper.right, boundary - outer)
      curve(upper.right, boundary, upper.right - outer, boundary)
      line(lower.right + inner, boundary)
      curve(lower.right, boundary, lower.right, boundary + inner)
    }
  }

  const leftTransition = (
    upper: RewriteSurfaceBand,
    lower: RewriteSurfaceBand,
  ) => {
    const boundary = lower.top
    const delta = lower.left - upper.left
    if (Math.abs(delta) < REWRITE_SURFACE_EDGE_EPSILON) {
      line(lower.left, boundary)
      return
    }
    const { outer, inner } = transitionRadii(
      Math.abs(delta),
      upper,
      lower,
    )
    if (delta < 0) {
      line(lower.left, boundary + outer)
      curve(lower.left, boundary, lower.left + outer, boundary)
      line(upper.left - inner, boundary)
      curve(upper.left, boundary, upper.left, boundary - inner)
    } else {
      line(lower.left, boundary + inner)
      curve(lower.left, boundary, lower.left - inner, boundary)
      line(upper.left + outer, boundary)
      curve(upper.left, boundary, upper.left, boundary - outer)
    }
  }

  commands.push(`M ${x(first.left + topRadius)} ${y(first.top)}`)
  line(first.right - topRadius, first.top)
  curve(first.right, first.top, first.right, first.top + topRadius)
  rightTransition(first, middle)
  rightTransition(middle, last)
  line(last.right, last.bottom - bottomRadius)
  curve(last.right, last.bottom, last.right - bottomRadius, last.bottom)
  line(last.left + bottomRadius, last.bottom)
  curve(last.left, last.bottom, last.left, last.bottom - bottomRadius)
  leftTransition(middle, last)
  leftTransition(first, middle)
  line(first.left, first.top + topRadius)
  curve(first.left, first.top, first.left + topRadius, first.top)
  commands.push('Z')

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    path: commands.join(' '),
  }
}

class SelectionRewriteOutlineMarker implements LayerMarker {
  constructor(
    readonly id: string,
    readonly phase: SelectionRewritePhase,
    readonly outline: RewriteOutline,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof SelectionRewriteOutlineMarker &&
      other.id === this.id &&
      other.phase === this.phase &&
      other.outline.left === this.outline.left &&
      other.outline.top === this.outline.top &&
      other.outline.width === this.outline.width &&
      other.outline.height === this.outline.height &&
      other.outline.path === this.outline.path
    )
  }

  draw(): HTMLDivElement {
    const element = document.createElement('div')
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg')
    svg.classList.add('yolo-selection-rewrite-outline-svg')

    const gradientId = `yolo-selection-rewrite-sheen-${this.id}`
    const defs = document.createElementNS(SVG_NAMESPACE, 'defs')
    const gradient = document.createElementNS(SVG_NAMESPACE, 'linearGradient')
    gradient.id = gradientId
    gradient.setAttribute('x1', '-0.45')
    gradient.setAttribute('y1', '0')
    gradient.setAttribute('x2', '-0.05')
    gradient.setAttribute('y2', '0')
    const animateGradientEdge = (
      attributeName: 'x1' | 'x2',
      values: string,
    ) => {
      const animate = document.createElementNS(SVG_NAMESPACE, 'animate')
      animate.setAttribute('attributeName', attributeName)
      animate.setAttribute('values', values)
      animate.setAttribute('dur', '1.6s')
      animate.setAttribute('begin', '250ms')
      animate.setAttribute('repeatCount', 'indefinite')
      gradient.appendChild(animate)
    }
    animateGradientEdge('x1', '-0.45;1.15')
    animateGradientEdge('x2', '-0.05;1.55')
    const sheenStops = [
      { offset: '0%', className: 'is-edge' },
      { offset: '50%', className: 'is-center' },
      { offset: '100%', className: 'is-edge' },
    ]
    for (const { offset, className } of sheenStops) {
      const stop = document.createElementNS(SVG_NAMESPACE, 'stop')
      stop.setAttribute('offset', offset)
      stop.classList.add('yolo-selection-rewrite-sheen-stop', className)
      gradient.appendChild(stop)
    }
    defs.appendChild(gradient)

    const path = document.createElementNS(SVG_NAMESPACE, 'path')
    path.classList.add('yolo-selection-rewrite-outline-path')
    const sheen = document.createElementNS(SVG_NAMESPACE, 'path')
    sheen.classList.add('yolo-selection-rewrite-sheen-path')
    sheen.setAttribute('fill', `url(#${gradientId})`)

    svg.append(defs, path, sheen)
    element.appendChild(svg)
    this.adjust(element)
    return element
  }

  update(element: HTMLElement, previous: LayerMarker): boolean {
    if (
      !(previous instanceof SelectionRewriteOutlineMarker) ||
      previous.id !== this.id
    ) {
      return false
    }
    this.adjust(element)
    return true
  }

  private adjust(element: HTMLElement): void {
    const { left, top, width, height, path: pathData } = this.outline
    element.className = `yolo-selection-rewrite-outline is-${this.phase}`
    element.dataset.yoloRewriteOutlineId = this.id
    element.style.left = `${left}px`
    element.style.top = `${top}px`
    element.style.width = `${width}px`
    element.style.height = `${height}px`
    const svg = element.querySelector<SVGSVGElement>(
      '.yolo-selection-rewrite-outline-svg',
    )
    const path = svg?.querySelector<SVGPathElement>(
      '.yolo-selection-rewrite-outline-path',
    )
    const sheenPath = svg?.querySelector<SVGPathElement>(
      '.yolo-selection-rewrite-sheen-path',
    )
    if (!path || !sheenPath) return
    path.setAttribute('d', pathData)
    path.style.setProperty('d', `path("${pathData}")`)
    sheenPath.setAttribute('d', pathData)
  }
}

function createRewriteSurfaceMarkers(
  session: SelectionRewriteVisual,
  rects: RewriteSurfaceRect[],
): LayerMarker[] {
  const outline = createRewriteOutline(rects)
  return outline
    ? [new SelectionRewriteOutlineMarker(session.id, session.phase, outline)]
    : []
}

function rewriteMarkersFromWidget(
  view: EditorView,
  session: SelectionRewriteVisual,
  widget: HTMLElement,
): LayerMarker[] {
  const text = widget.querySelector<HTMLElement>(
    '.yolo-selection-rewrite-candidate-text',
  )
  const rects = mergeVisualLineRects(Array.from(text?.getClientRects() ?? []))
  if (rects.length === 0) return []

  const base = getLayerBase(view)
  const bounds = getContentHorizontalBounds(view)
  const layerBounds = {
    left: bounds.left - base.left,
    right: bounds.right - base.left,
  }
  const create = (
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): RewriteSurfaceRect => ({
    left: left - base.left,
    top: top - base.top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  })

  if (rects.length === 1) {
    const rect = rects[0]
    return createRewriteSurfaceMarkers(
      session,
      padRewriteStart(
        [create(rect.left, rect.top, rect.right, rect.bottom)],
        view.textDirection,
        layerBounds,
      ),
    )
  }

  const first = rects[0]
  const last = rects[rects.length - 1]
  const markers = [create(first.left, first.top, bounds.right, first.bottom)]
  if (last.top > first.bottom) {
    markers.push(create(bounds.left, first.bottom, bounds.right, last.top))
  }
  markers.push(create(bounds.left, last.top, last.right, last.bottom))
  return createRewriteSurfaceMarkers(
    session,
    padRewriteStart(markers, view.textDirection, layerBounds),
  )
}

function rewriteMarkersFromDocumentRange(
  view: EditorView,
  session: SelectionRewriteVisual,
): LayerMarker[] {
  if (session.from >= session.to) return []
  const markers = RectangleMarker.forRange(
    view,
    'yolo-selection-rewrite-surface',
    EditorSelection.range(session.from, session.to),
  )
  const base = getLayerBase(view)
  const bounds = getContentHorizontalBounds(view)
  return createRewriteSurfaceMarkers(
    session,
    padRewriteStart(
      markers.map((marker) => ({
        left: marker.left,
        top: marker.top,
        width: marker.width ?? 1,
        height: marker.height,
      })),
      view.textDirection,
      {
        left: bounds.left - base.left,
        right: bounds.right - base.left,
      },
    ),
  )
}

function createActionButton(
  className: string,
  label: string,
  text: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `yolo-selection-rewrite-action ${className}`
  button.setAttribute('aria-label', label)
  button.textContent = text
  button.addEventListener('click', onClick)
  return button
}

class SelectionRewriteControlsMarker implements LayerMarker {
  constructor(
    readonly id: string,
    readonly phase: SelectionRewritePhase,
    readonly left: number,
    readonly top: number,
    readonly railTop: number,
    readonly railHeight: number,
    private readonly labels: {
      stop: string
      accept: string
      reject: string
    },
    private readonly actions: {
      stop: () => void
      accept: () => void
      reject: () => void
    },
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof SelectionRewriteControlsMarker &&
      other.id === this.id &&
      other.phase === this.phase &&
      other.left === this.left &&
      other.top === this.top &&
      other.railTop === this.railTop &&
      other.railHeight === this.railHeight
    )
  }

  draw(): HTMLElement {
    const control = document.createElement('div')
    control.className = 'yolo-selection-rewrite-controls'
    control.dataset.yoloRewriteControlsId = this.id
    this.position(control)

    if (this.phase === 'review') {
      control.appendChild(
        createActionButton('is-reject', this.labels.reject, '×', () =>
          this.actions.reject(),
        ),
      )
      control.appendChild(
        createActionButton('is-accept', this.labels.accept, '✓', () =>
          this.actions.accept(),
        ),
      )
    } else {
      control.appendChild(
        createActionButton('is-stop', this.labels.stop, '■', () =>
          this.actions.stop(),
        ),
      )
    }
    return control
  }

  update(dom: HTMLElement, previous: LayerMarker): boolean {
    if (
      !(previous instanceof SelectionRewriteControlsMarker) ||
      previous.id !== this.id ||
      previous.phase !== this.phase
    ) {
      return false
    }
    this.position(dom)
    return true
  }

  private position(dom: HTMLElement): void {
    dom.style.left = `${this.left}px`
    dom.style.top = `${this.top}px`
    dom.style.setProperty(
      '--yolo-selection-rewrite-rail-top',
      `${this.railTop}px`,
    )
    dom.style.setProperty(
      '--yolo-selection-rewrite-rail-height',
      `${this.railHeight}px`,
    )
  }
}

export class SelectionRewriteController {
  private readonly sessions = new Map<string, SelectionRewriteRuntime>()

  constructor(private readonly deps: SelectionRewriteControllerDeps) {}

  createExtension(): Extension {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- CodeMirror constructs the view plugin class
    const controller = this
    return [
      selectionRewriteField,
      layer({
        above: false,
        class: 'yolo-selection-rewrite-layer',
        update(update: ViewUpdate): boolean {
          return (
            update.geometryChanged ||
            update.viewportChanged ||
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) =>
                effect.is(setSelectionRewriteEffect),
              ),
            )
          )
        },
        markers(view: EditorView): readonly LayerMarker[] {
          const sessions = view.state.field(selectionRewriteField).sessions
          return sessions.flatMap((session) => {
            if (session.phase === 'streaming') {
              const widget = view.dom.querySelector<HTMLElement>(
                `[data-yolo-rewrite-id="${session.id}"]`,
              )
              if (widget) {
                return rewriteMarkersFromWidget(view, session, widget)
              }
            }
            return rewriteMarkersFromDocumentRange(view, session)
          })
        },
      }),
      layer({
        above: true,
        class: 'yolo-selection-rewrite-controls-layer',
        update(update: ViewUpdate): boolean {
          return (
            update.geometryChanged ||
            update.viewportChanged ||
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) =>
                effect.is(setSelectionRewriteEffect),
              ),
            )
          )
        },
        markers(view: EditorView): readonly LayerMarker[] {
          const sessions = view.state.field(selectionRewriteField).sessions
          const base = getLayerBase(view)
          const contentRect = view.contentDOM.getBoundingClientRect()
          const scrollRect = view.scrollDOM.getBoundingClientRect()
          return sessions.map((session) => {
            const widget = view.dom.querySelector<HTMLElement>(
              `[data-yolo-rewrite-id="${session.id}"]`,
            )
            const outline = view.dom.querySelector<HTMLElement>(
              `[data-yolo-rewrite-outline-id="${session.id}"]`,
            )
            const fromRect = view.coordsAtPos(session.from)
            const toRect = view.coordsAtPos(
              Math.max(session.from, session.to - 1),
            )
            const widgetRect = widget?.getBoundingClientRect()
            const outlineRect = outline?.getBoundingClientRect()
            const top =
              outlineRect?.top ??
              widgetRect?.top ??
              fromRect?.top ??
              scrollRect.top
            const bottom =
              outlineRect?.bottom ??
              widgetRect?.bottom ??
              toRect?.bottom ??
              fromRect?.bottom ??
              top + view.defaultLineHeight
            const controlHeight = session.phase === 'review' ? 62 : 26
            const left = Math.min(contentRect.right + 12, scrollRect.right - 32)
            const controlTop = Math.max(
              6,
              top + (bottom - top - controlHeight) / 2 - base.top,
            )
            return new SelectionRewriteControlsMarker(
              session.id,
              session.phase,
              Math.max(6, left - base.left),
              controlTop,
              top - base.top - controlTop,
              Math.max(20, bottom - top),
              {
                stop: controller.deps.t(
                  'chat.stopGeneration',
                  'Stop generation',
                ),
                accept: controller.deps.t(
                  'applyView.acceptChange',
                  'Accept change',
                ),
                reject: controller.deps.t(
                  'applyView.rejectChange',
                  'Reject change',
                ),
              },
              {
                stop: () => controller.stop(session.id),
                accept: () => controller.accept(session.id),
                reject: () => controller.reject(session.id),
              },
            )
          })
        },
      }),
      EditorView.updateListener.of((update) =>
        controller.handleViewUpdate(update),
      ),
      EditorView.domEventHandlers({
        wheel: (_event, view) => {
          controller.disableAutoFollow(view)
          return false
        },
        touchstart: (_event, view) => {
          controller.disableAutoFollow(view)
          return false
        },
        pointerdown: (_event, view) => {
          controller.disableAutoFollow(view)
          return false
        },
        beforeinput: (_event, view) => {
          controller.disableAutoFollow(view)
          return false
        },
      }),
    ]
  }

  start(options: StartSelectionRewriteOptions): void {
    selectionHighlightController.clearMatchingRange(options.view, {
      from: options.from,
      to: options.to,
    })
    const id = crypto.randomUUID()
    const abortController = new AbortController()
    const runtime: SelectionRewriteRuntime = {
      id,
      view: options.view,
      from: options.from,
      to: options.to,
      originalText: options.selectedText,
      candidateText: '',
      pendingCandidateText: '',
      revealedRawLength: 0,
      phase: 'waiting',
      baselineHeight: this.measureBaselineHeight(
        options.view,
        options.from,
        options.to,
      ),
      startIndent: this.measureStartIndent(options.view, options.from),
      block: this.shouldUseBlockCandidate(
        options.view,
        options.from,
        options.to,
      ),
      abortController,
      publishFrame: null,
      publishResolve: null,
      autoFollow: true,
    }
    this.sessions.set(id, runtime)
    this.deps.addAbortController(abortController)
    this.dispatchView(options.view, {
      selection: { anchor: options.from },
    })

    void this.run(runtime, options)
  }

  stop(id: string): void {
    this.sessions.get(id)?.abortController.abort()
  }

  accept(id: string): void {
    const runtime = this.sessions.get(id)
    if (!runtime || runtime.phase !== 'review') return
    this.removeRuntime(runtime)
  }

  reject(id: string): void {
    const runtime = this.sessions.get(id)
    if (!runtime) return
    runtime.abortController.abort()
    if (runtime.phase !== 'review') {
      this.removeRuntime(runtime)
      return
    }
    this.sessions.delete(id)
    runtime.view.dispatch({
      changes: {
        from: runtime.from,
        to: runtime.to,
        insert: runtime.originalText,
      },
      effects: setSelectionRewriteEffect.of(this.visualsForView(runtime.view)),
      annotations: selectionRewriteTransaction.of({ id, kind: 'reject' }),
    })
    this.cleanupRuntime(runtime)
  }

  destroy(): void {
    for (const runtime of Array.from(this.sessions.values())) {
      runtime.abortController.abort()
      if (runtime.phase === 'review') {
        this.reject(runtime.id)
      } else {
        this.removeRuntime(runtime)
      }
    }
  }

  private async run(
    runtime: SelectionRewriteRuntime,
    options: StartSelectionRewriteOptions,
  ): Promise<void> {
    try {
      const result = await executeSingleTurn({
        providerClient: options.providerClient,
        model: options.model,
        request: {
          model: options.model.model,
          messages: [
            {
              role: 'system',
              content:
                'Rewrite only the selected markdown according to the instruction. Preserve markdown structure unless the instruction requires changing it. Output only the complete replacement text, with no explanation and no code fence wrapping the response.',
            },
            {
              role: 'user',
              content: `Instruction:\n${options.instruction.trim()}\n\nSelected markdown:\n${options.selectedText}`,
            },
          ],
        },
        signal: runtime.abortController.signal,
        deliveryMode: 'incremental',
        primaryRequestTimeoutMs:
          options.settings.continuationOptions.primaryRequestTimeoutMs,
        streamFallbackRecoveryEnabled:
          options.settings.continuationOptions.streamFallbackRecoveryEnabled,
        onStreamDelta: async ({ contentDelta }) => {
          if (!contentDelta || runtime.abortController.signal.aborted) return
          runtime.pendingCandidateText += contentDelta
          if (!document.hasFocus()) {
            runtime.revealedRawLength = runtime.pendingCandidateText.length
            runtime.candidateText = stripOuterMarkdownFence(
              runtime.pendingCandidateText,
            )
            return
          }
          await this.revealPendingCandidate(runtime, contentDelta.length)
        },
      })

      this.cancelPublishFrame(runtime)
      const finalText = stripOuterMarkdownFence(result.content)
      if (!finalText.trim()) {
        this.removeRuntime(runtime)
        return
      }
      runtime.candidateText = finalText
      await this.settleCandidateHeight(runtime)
      this.commitCandidate(runtime)
    } catch (error) {
      this.cancelPublishFrame(runtime)
      if (
        error instanceof Error &&
        error.name !== 'AbortError' &&
        !runtime.abortController.signal.aborted
      ) {
        console.error('[YOLO] Selection rewrite failed:', error)
        new Notice(this.deps.t('quickAsk.error', 'Failed to generate response'))
      }

      const partial = stripOuterMarkdownFence(
        runtime.pendingCandidateText || runtime.candidateText,
      )
      if (partial.trim()) {
        runtime.candidateText = partial
        await this.settleCandidateHeight(runtime)
        this.commitCandidate(runtime)
      } else {
        this.removeRuntime(runtime)
      }
    }
  }

  private async revealPendingCandidate(
    runtime: SelectionRewriteRuntime,
    deltaLength: number,
  ): Promise<void> {
    const targetLength = runtime.pendingCandidateText.length
    const step =
      deltaLength <= 24 ? deltaLength : Math.max(2, Math.ceil(deltaLength / 60))

    while (
      runtime.revealedRawLength < targetLength &&
      !runtime.abortController.signal.aborted &&
      this.sessions.has(runtime.id)
    ) {
      if (!document.hasFocus()) {
        runtime.revealedRawLength = targetLength
        runtime.candidateText = stripOuterMarkdownFence(
          runtime.pendingCandidateText.slice(0, targetLength),
        )
        break
      }
      await this.waitForNextFrame(runtime)
      runtime.revealedRawLength = Math.min(
        targetLength,
        runtime.revealedRawLength + step,
      )
      runtime.candidateText = stripOuterMarkdownFence(
        runtime.pendingCandidateText.slice(0, runtime.revealedRawLength),
      )
      if (!runtime.candidateText) continue
      runtime.phase = 'streaming'
      this.dispatchView(runtime.view)
      this.scheduleAutoFollow(runtime)
    }
  }

  private waitForNextFrame(runtime: SelectionRewriteRuntime): Promise<void> {
    if (runtime.publishFrame !== null) return Promise.resolve()
    return new Promise((resolve) => {
      runtime.publishResolve = resolve
      runtime.publishFrame = window.requestAnimationFrame(() => {
        runtime.publishFrame = null
        runtime.publishResolve = null
        resolve()
      })
    })
  }

  private commitCandidate(runtime: SelectionRewriteRuntime): void {
    if (!this.sessions.has(runtime.id)) return
    const finalText = runtime.candidateText
    runtime.phase = 'review'
    const from = runtime.from
    const to = runtime.to
    runtime.to = from + finalText.length
    runtime.view.dispatch({
      changes: {
        from,
        to,
        insert: finalText,
      },
      effects: setSelectionRewriteEffect.of(this.visualsForView(runtime.view)),
      annotations: selectionRewriteTransaction.of({
        id: runtime.id,
        kind: 'commit',
      }),
    })
    this.cleanupRuntimeRequest(runtime)
    this.scheduleAutoFollow(runtime)
  }

  private async settleCandidateHeight(
    runtime: SelectionRewriteRuntime,
  ): Promise<void> {
    if (!runtime.block || !document.hasFocus()) return
    const root = runtime.view.dom.querySelector<HTMLElement>(
      `[data-yolo-rewrite-id="${runtime.id}"]`,
    )
    const text = root?.querySelector<HTMLElement>(
      '.yolo-selection-rewrite-candidate-text',
    )
    if (!root || !text) return

    const target = measureCandidateTextHeight(
      text,
      runtime.view.defaultLineHeight,
    )
    if (Math.abs(root.getBoundingClientRect().height - target) < 1) return

    root.classList.add('is-settling')
    root.style.height = `${target}px`
    runtime.view.requestMeasure()
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        root.removeEventListener('transitionend', finish)
        window.clearTimeout(timeout)
        resolve()
      }
      const timeout = window.setTimeout(finish, 280)
      root.addEventListener('transitionend', finish, { once: true })
    })
  }

  private scheduleAutoFollow(runtime: SelectionRewriteRuntime): void {
    if (!runtime.autoFollow) return
    window.requestAnimationFrame(() => {
      if (!runtime.autoFollow || !this.sessions.has(runtime.id)) return
      const widget = runtime.view.dom.querySelector<HTMLElement>(
        `[data-yolo-rewrite-id="${runtime.id}"]`,
      )
      const tail =
        widget?.getBoundingClientRect().bottom ??
        runtime.view.coordsAtPos(Math.max(runtime.from, runtime.to - 1))?.bottom
      const viewport = runtime.view.scrollDOM.getBoundingClientRect()
      if (!tail || tail <= viewport.bottom - 48) return
      runtime.view.scrollDOM.scrollBy({
        top: Math.min(tail - viewport.bottom + 64, 120),
        behavior: 'smooth',
      })
    })
  }

  private disableAutoFollow(view: EditorView): void {
    for (const runtime of this.sessions.values()) {
      if (runtime.view === view) runtime.autoFollow = false
    }
  }

  private measureBaselineHeight(
    view: EditorView,
    from: number,
    to: number,
  ): number {
    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(Math.max(from, to - 1))
    if (!start || !end) return view.defaultLineHeight
    return Math.max(view.defaultLineHeight, end.bottom - start.top)
  }

  private measureStartIndent(view: EditorView, from: number): number {
    const start = view.coordsAtPos(from)
    if (!start) return 0
    return Math.max(0, start.left - getContentHorizontalBounds(view).left)
  }

  private shouldUseBlockCandidate(
    view: EditorView,
    from: number,
    to: number,
  ): boolean {
    const startLine = view.state.doc.lineAt(from)
    const endLine = view.state.doc.lineAt(Math.max(from, to - 1))
    const includesWholeStartLine = from === startLine.from
    const includesWholeEndLine =
      to === endLine.to ||
      to === Math.min(view.state.doc.length, endLine.to + 1)

    return includesWholeStartLine && includesWholeEndLine
  }

  private handleViewUpdate(update: ViewUpdate): void {
    if (!update.docChanged) return
    const internal = update.transactions
      .map((transaction) => transaction.annotation(selectionRewriteTransaction))
      .find((value) => value !== undefined)
    for (const runtime of this.sessions.values()) {
      if (runtime.view !== update.view || internal?.id === runtime.id) continue
      this.mapRuntime(runtime, update.changes)
    }
  }

  private mapRuntime(runtime: SelectionRewriteRuntime, changes: ChangeDesc) {
    runtime.from = changes.mapPos(runtime.from, -1)
    runtime.to = changes.mapPos(runtime.to, 1)
  }

  private dispatchView(
    view: EditorView,
    extra?: { selection: { anchor: number } },
  ): void {
    view.dispatch({
      ...extra,
      effects: setSelectionRewriteEffect.of(this.visualsForView(view)),
    })
  }

  private visualsForView(view: EditorView): SelectionRewriteVisual[] {
    return Array.from(this.sessions.values())
      .filter((runtime) => runtime.view === view)
      .map(
        ({
          id,
          from,
          to,
          originalText,
          candidateText,
          phase,
          baselineHeight,
          startIndent,
          block,
        }) => ({
          id,
          from,
          to,
          originalText,
          candidateText,
          phase,
          baselineHeight,
          startIndent,
          block,
        }),
      )
  }

  private removeRuntime(runtime: SelectionRewriteRuntime): void {
    if (!this.sessions.delete(runtime.id)) return
    this.dispatchView(runtime.view)
    this.cleanupRuntime(runtime)
  }

  private cleanupRuntime(runtime: SelectionRewriteRuntime): void {
    this.cancelPublishFrame(runtime)
    this.cleanupRuntimeRequest(runtime)
  }

  private cleanupRuntimeRequest(runtime: SelectionRewriteRuntime): void {
    this.deps.removeAbortController(runtime.abortController)
  }

  private cancelPublishFrame(runtime: SelectionRewriteRuntime): void {
    if (runtime.publishFrame === null) return
    window.cancelAnimationFrame(runtime.publishFrame)
    runtime.publishFrame = null
    runtime.publishResolve?.()
    runtime.publishResolve = null
  }
}
