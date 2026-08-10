import {
  Annotation,
  type ChangeDesc,
  EditorSelection,
  type EditorState,
  type Extension,
  type Range,
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

type SelectionRewritePhase = 'resizing' | 'waiting' | 'streaming' | 'review'
type SelectionRewriteKind = 'instruction' | 'length'

type SelectionRewriteVisual = {
  id: string
  from: number
  to: number
  candidateText: string
  kind: SelectionRewriteKind
  phase: SelectionRewritePhase
  baselineHeight: number
  startIndent: number
  block: boolean
  targetHeight: number
  targetRatio: number
  reserveHeight: number
  frozenSurfaceRects: RewriteSurfaceRect[] | null
  overflowHeight: number
  settlingSurface: boolean
}

type SelectionRewriteFieldValue = {
  sessions: SelectionRewriteVisual[]
  decorations: DecorationSet
}

type SelectionRewriteRuntime = SelectionRewriteVisual & {
  view: EditorView
  originalText: string
  baselineCapacity: number
  targetCapacity: number
  targetReserveHeight: number
  abortController: AbortController
  pendingCandidateText: string
  revealedRawLength: number
  publishFrame: number | null
  publishResolve: (() => void) | null
  layoutFrame: number | null
  dragFrame: number | null
  pendingDragClientY: number
  autoFollow: boolean
  drag: {
    pointerY: number
    startTargetHeight: number
    startTargetCapacity: number
    returnPhase: 'resizing' | 'review'
  } | null
  fallbackReviewText: string | null
  request: SelectionRewriteRequest
}

type SelectionRewriteModelOptions = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  settings: YoloSettings
}

type SelectionRewriteRequest = SelectionRewriteModelOptions &
  (
    | {
        kind: 'instruction'
        instruction: string
      }
    | {
        kind: 'length'
        contextBefore: string
        contextAfter: string
        fileTitle: string
      }
  )

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

export type StartSelectionLengthAdjustmentOptions = {
  view: EditorView
  from: number
  to: number
  selectedText: string
  contextBefore: string
  contextAfter: string
  fileTitle: string
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  settings: YoloSettings
  initialDrag?: {
    startClientY: number
    currentClientY: number
  }
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

class SelectionRewriteFlowSpacerWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly height: number,
    readonly phase: SelectionRewritePhase,
    readonly settling: boolean,
  ) {
    super()
  }

  override eq(other: SelectionRewriteFlowSpacerWidget): boolean {
    return (
      other.id === this.id &&
      other.height === this.height &&
      other.phase === this.phase &&
      other.settling === this.settling
    )
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (dom.dataset.yoloRewriteSpacerId !== this.id) return false
    this.adjust(dom)
    view.requestMeasure()
    return true
  }

  override toDOM(view: EditorView): HTMLElement {
    const spacer = document.createElement('div')
    spacer.dataset.yoloRewriteSpacerId = this.id
    this.adjust(spacer)
    const observer = new ResizeObserver(() => view.requestMeasure())
    observer.observe(spacer)
    rewriteResizeObservers.set(spacer, observer)
    return spacer
  }

  override get estimatedHeight(): number {
    return this.height
  }

  override destroy(dom: HTMLElement): void {
    rewriteResizeObservers.get(dom)?.disconnect()
    rewriteResizeObservers.delete(dom)
  }

  override ignoreEvent(): boolean {
    return true
  }

  private adjust(spacer: HTMLElement): void {
    spacer.className = `yolo-selection-rewrite-flow-spacer is-${this.phase}${this.settling ? ' is-settling' : ''}`
    spacer.style.height = `${this.height}px`
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
  viewState?: EditorState,
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const session of sessions) {
    if (session.phase === 'streaming' && session.from <= session.to) {
      ranges.push(
        Decoration.mark({
          class: 'yolo-selection-rewrite-source-placeholder',
        }).range(session.from, session.to),
      )
    }

    if (session.reserveHeight <= 0.5 || !viewState) {
      continue
    }
    const doc = viewState.doc
    const endPos = Math.max(session.from, Math.min(doc.length, session.to - 1))
    const endLine = doc.lineAt(endPos)
    ranges.push(
      Decoration.widget({
        widget: new SelectionRewriteFlowSpacerWidget(
          session.id,
          session.reserveHeight,
          session.phase,
          session.settlingSurface,
        ),
        block: true,
        side: 1,
      }).range(endLine.to),
    )
    const suffixFrom = Math.max(endLine.from, Math.min(endLine.to, session.to))
    if (suffixFrom < endLine.to) {
      ranges.push(
        Decoration.mark({
          class: 'yolo-selection-rewrite-stretch-suffix',
          attributes: {
            style: `--yolo-selection-rewrite-stretch-height: ${session.reserveHeight}px`,
          },
        }).range(suffixFrom, endLine.to),
      )
    }
  }

  return Decoration.set(ranges, true)
}

function createFieldValue(
  sessions: SelectionRewriteVisual[],
  viewState?: EditorState,
): SelectionRewriteFieldValue {
  return {
    sessions,
    decorations: buildRewriteDecorations(sessions, viewState),
  }
}

const selectionRewriteField = StateField.define<SelectionRewriteFieldValue>({
  create: (state) => createFieldValue([], state),
  update(value, transaction) {
    const replacement = transaction.effects.find((effect) =>
      effect.is(setSelectionRewriteEffect),
    )
    if (replacement?.is(setSelectionRewriteEffect)) {
      return createFieldValue(replacement.value, transaction.state)
    }

    if (!transaction.docChanged || value.sessions.length === 0) return value

    return createFieldValue(
      value.sessions.map((session) => ({
        ...session,
        from: transaction.changes.mapPos(session.from, -1),
        to: transaction.changes.mapPos(session.to, 1),
      })),
      transaction.state,
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

type RewriteCandidateProjection = {
  text: string
  startIndent: number
  font: string
  letterSpacing: string
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const REWRITE_OUTER_RADIUS = 8
const REWRITE_INNER_RADIUS = 4
const REWRITE_SURFACE_EDGE_EPSILON = 1
const LENGTH_HANDLE_SURFACE_EXTENSION = 5
const LENGTH_HANDLE_WIDTH = 64

function getOutlineReserveHeight(session: SelectionRewriteVisual): number {
  return (
    session.reserveHeight +
    (session.kind === 'length' ? LENGTH_HANDLE_SURFACE_EXTENSION : 0)
  )
}

function getLengthHandleHorizontalAnchor(
  rects: RewriteSurfaceRect[],
  contentCenter: number,
  direction: Direction,
): number | undefined {
  if (rects.length === 0) return undefined
  const lastTop = Math.max(...rects.map((rect) => rect.top))
  const lastLine = rects.filter((rect) => Math.abs(rect.top - lastTop) < 1)
  const selectionEdge =
    direction === Direction.RTL
      ? Math.min(...lastLine.map((rect) => rect.left))
      : Math.max(...lastLine.map((rect) => rect.left + rect.width))
  const edgeAnchor =
    direction === Direction.RTL
      ? Math.max(selectionEdge, contentCenter)
      : Math.min(selectionEdge, contentCenter)
  return (
    edgeAnchor +
    (direction === Direction.RTL
      ? LENGTH_HANDLE_WIDTH / 2
      : -LENGTH_HANDLE_WIDTH / 2)
  )
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
    visualHeight: Math.max(...middleRects.map((rect) => rect.visualHeight)),
  }
  return [first, middle, last]
}

function transitionRadii(
  edgeDelta: number,
  upper: RewriteSurfaceBand,
  lower: RewriteSurfaceBand,
): { outer: number; inner: number } {
  const heightLimit = Math.min(upper.visualHeight / 2, lower.visualHeight / 2)
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

function createRewriteOutline(
  rects: RewriteSurfaceRect[],
): RewriteOutline | null {
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
  ) => commands.push(`Q ${x(controlX)} ${y(controlY)} ${x(toX)} ${y(toY)}`)

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
    const { outer, inner } = transitionRadii(Math.abs(delta), upper, lower)
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
    const { outer, inner } = transitionRadii(Math.abs(delta), upper, lower)
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
    readonly settling: boolean,
    readonly outline: RewriteOutline,
    readonly candidate: RewriteCandidateProjection | null = null,
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof SelectionRewriteOutlineMarker &&
      other.id === this.id &&
      other.phase === this.phase &&
      other.settling === this.settling &&
      other.outline.left === this.outline.left &&
      other.outline.top === this.outline.top &&
      other.outline.width === this.outline.width &&
      other.outline.height === this.outline.height &&
      other.outline.path === this.outline.path &&
      other.candidate?.text === this.candidate?.text &&
      other.candidate?.startIndent === this.candidate?.startIndent &&
      other.candidate?.font === this.candidate?.font &&
      other.candidate?.letterSpacing === this.candidate?.letterSpacing
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
    if (this.candidate) {
      const candidate = document.createElement('div')
      const text = document.createElement('span')
      candidate.className = 'yolo-selection-rewrite-candidate-overlay'
      text.className = 'yolo-selection-rewrite-candidate-text'
      candidate.appendChild(text)
      element.appendChild(candidate)
    }
    this.adjust(element)
    return element
  }

  update(element: HTMLElement, previous: LayerMarker): boolean {
    if (
      !(previous instanceof SelectionRewriteOutlineMarker) ||
      previous.id !== this.id ||
      Boolean(previous.candidate) !== Boolean(this.candidate)
    ) {
      return false
    }
    this.adjust(element)
    return true
  }

  private adjust(element: HTMLElement): void {
    const { left, top, width, height, path: pathData } = this.outline
    element.className = `yolo-selection-rewrite-outline is-${this.phase}${this.settling ? ' is-settling-surface' : ''}${this.candidate ? ' has-candidate' : ''}`
    element.dataset.yoloRewriteOutlineId = this.id
    if (this.candidate) {
      element.dataset.yoloRewriteId = this.id
    } else {
      delete element.dataset.yoloRewriteId
    }
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
    const candidate = element.querySelector<HTMLElement>(
      '.yolo-selection-rewrite-candidate-overlay',
    )
    if (!candidate || !this.candidate) return
    candidate.style.font = this.candidate.font
    candidate.style.letterSpacing = this.candidate.letterSpacing
    candidate.style.clipPath = `path("${pathData}")`
    candidate.style.setProperty(
      '--yolo-selection-rewrite-start-indent',
      `${this.candidate.startIndent}px`,
    )
    this.updateCandidateText(candidate, this.candidate.text)
  }

  private updateCandidateText(candidate: HTMLElement, nextText: string): void {
    const text = candidate.querySelector<HTMLElement>(
      '.yolo-selection-rewrite-candidate-text',
    )
    if (!text) return
    const previousText = text.dataset.yoloCandidateText ?? ''
    if (!nextText.startsWith(previousText)) {
      text.textContent = nextText || '\u200b'
      text.dataset.yoloCandidateText = nextText
      return
    }
    const delta = nextText.slice(previousText.length)
    if (!delta) return
    if (!previousText && text.textContent === '\u200b') text.textContent = ''
    const reveal = document.createElement('span')
    reveal.className = 'yolo-selection-rewrite-candidate-reveal'
    reveal.textContent = delta
    text.appendChild(reveal)
    text.dataset.yoloCandidateText = nextText
    const settle = (node: HTMLElement) => {
      if (!node.isConnected) return
      node.replaceWith(document.createTextNode(node.textContent ?? ''))
      text.normalize()
    }
    reveal.addEventListener('animationend', () => settle(reveal), {
      once: true,
    })
    const active = text.querySelectorAll<HTMLElement>(
      '.yolo-selection-rewrite-candidate-reveal',
    )
    if (active.length > 4) settle(active[0])
  }
}

function getRewriteContentRects(
  view: EditorView,
  session: SelectionRewriteVisual,
): RewriteSurfaceRect[] {
  if (session.phase === 'streaming') {
    const widget = view.dom.querySelector<HTMLElement>(
      `[data-yolo-rewrite-id="${session.id}"]`,
    )
    const text = widget?.querySelector<HTMLElement>(
      '.yolo-selection-rewrite-candidate-text',
    )
    const rects = mergeVisualLineRects(Array.from(text?.getClientRects() ?? []))
    if (rects.length > 0) {
      const base = getLayerBase(view)
      return rects.map((rect) => ({
        left: rect.left - base.left,
        top: rect.top - base.top,
        width: rect.width,
        height: rect.height,
      }))
    }
  }

  return RectangleMarker.forRange(
    view,
    'yolo-selection-rewrite-surface',
    EditorSelection.range(session.from, session.to),
  ).map((marker) => ({
    left: marker.left,
    top: marker.top,
    width: marker.width ?? 1,
    height: marker.height,
  }))
}

function buildRewriteSurfaceRects(
  view: EditorView,
  session: SelectionRewriteVisual,
  rects: RewriteSurfaceRect[],
  reserveHeight: number,
): RewriteSurfaceRect[] {
  if (rects.length === 0) return []
  if (reserveHeight <= REWRITE_SURFACE_EDGE_EPSILON) return rects

  const ordered = rects
    .map((rect) => ({
      left: rect.left,
      right: rect.left + rect.width,
      top: rect.top,
      bottom: rect.top + rect.height,
    }))
    .sort((a, b) => a.top - b.top || a.left - b.left)
  const first = ordered[0]
  const last = ordered.at(-1)!
  const base = getLayerBase(view)
  const bounds = getContentHorizontalBounds(view)
  const contentLeft = bounds.left - base.left
  const contentRight = bounds.right - base.left
  const endPos = Math.max(
    session.from,
    Math.min(view.state.doc.length, session.to) - 1,
  )
  const endLine = view.state.doc.lineAt(endPos)
  const hasTrailingText =
    session.to <= endLine.to &&
    view.state.doc.sliceString(session.to, endLine.to).trim().length > 0
  const footHeight = Math.min(
    reserveHeight,
    Math.max(view.defaultLineHeight, last.bottom - last.top),
  )
  const bodyHeight = Math.max(0, reserveHeight - footHeight)
  const synthetic: RewriteSurfaceRect[] = [
    {
      left: view.textDirection === Direction.LTR ? first.left : contentLeft,
      top: first.top,
      width:
        view.textDirection === Direction.LTR
          ? Math.max(1, contentRight - first.left)
          : Math.max(1, first.right - contentLeft),
      height: Math.max(1, first.bottom - first.top),
    },
  ]
  const middleTop = first.bottom
  const middleBottom = last.bottom + bodyHeight
  if (middleBottom > middleTop + REWRITE_SURFACE_EDGE_EPSILON) {
    synthetic.push({
      left: contentLeft,
      top: middleTop,
      width: Math.max(1, contentRight - contentLeft),
      height: middleBottom - middleTop,
    })
  }
  synthetic.push({
    left:
      view.textDirection === Direction.LTR || !hasTrailingText
        ? contentLeft
        : last.left,
    top: middleBottom,
    width: !hasTrailingText
      ? Math.max(1, contentRight - contentLeft)
      : view.textDirection === Direction.LTR
        ? Math.max(1, last.right - contentLeft)
        : Math.max(1, contentRight - last.left),
    height: Math.max(1, footHeight),
  })
  return synthetic
}

function extendFrozenSurface(
  rects: RewriteSurfaceRect[],
  overflowHeight: number,
): RewriteSurfaceRect[] {
  if (rects.length === 0 || overflowHeight <= REWRITE_SURFACE_EDGE_EPSILON) {
    return rects
  }
  const ordered = [...rects].sort((a, b) => a.top - b.top || a.left - b.left)
  const first = { ...ordered[0] }
  const last = { ...ordered.at(-1)!, top: ordered.at(-1)!.top + overflowHeight }
  const fullLeft = Math.min(...ordered.map((rect) => rect.left))
  const fullRight = Math.max(...ordered.map((rect) => rect.left + rect.width))
  const middleTop = first.top + first.height
  const middleBottom = last.top
  return [
    first,
    ...(middleBottom > middleTop + REWRITE_SURFACE_EDGE_EPSILON
      ? [
          {
            left: fullLeft,
            top: middleTop,
            width: Math.max(1, fullRight - fullLeft),
            height: middleBottom - middleTop,
          },
        ]
      : []),
    last,
  ]
}

function createAdaptiveRewriteOutline(
  view: EditorView,
  session: SelectionRewriteVisual,
): RewriteOutline | null {
  const holdTargetSurface =
    session.frozenSurfaceRects &&
    !session.settlingSurface &&
    (session.phase === 'waiting' || session.phase === 'streaming')
  const rects = holdTargetSurface
    ? extendFrozenSurface(session.frozenSurfaceRects!, session.overflowHeight)
    : buildRewriteSurfaceRects(
        view,
        session,
        getRewriteContentRects(view, session),
        getOutlineReserveHeight(session),
      )
  return createRewriteOutline(rects)
}

function createAdaptiveRewriteMarkers(
  view: EditorView,
  session: SelectionRewriteVisual,
): LayerMarker[] {
  const outline = createAdaptiveRewriteOutline(view, session)
  const base = getLayerBase(view)
  const bounds = getContentHorizontalBounds(view)
  const contentLeft = bounds.left - base.left
  const contentStyle = window.getComputedStyle(view.contentDOM)
  const candidate =
    outline && session.phase === 'streaming' && session.candidateText
      ? {
          text: session.candidateText,
          startIndent: Math.max(
            0,
            contentLeft + session.startIndent - outline.left,
          ),
          font: contentStyle.font,
          letterSpacing: contentStyle.letterSpacing,
        }
      : null
  return outline
    ? [
        new SelectionRewriteOutlineMarker(
          session.id,
          session.phase,
          session.settlingSurface,
          outline,
          candidate,
        ),
      ]
    : []
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

class SelectionRewriteLengthHandleMarker implements LayerMarker {
  constructor(
    readonly id: string,
    readonly phase: SelectionRewritePhase,
    readonly left: number,
    readonly top: number,
    readonly label: string,
    readonly ariaLabel: string,
    readonly condensing: boolean,
    readonly guideWidth: number,
    readonly actions: {
      start: (clientY: number) => void
      move: (clientY: number) => void
      finish: (clientY: number) => void
      cancel: () => void
    },
  ) {}

  eq(other: LayerMarker): boolean {
    return (
      other instanceof SelectionRewriteLengthHandleMarker &&
      other.id === this.id &&
      other.phase === this.phase &&
      other.left === this.left &&
      other.top === this.top &&
      other.label === this.label &&
      other.ariaLabel === this.ariaLabel &&
      other.condensing === this.condensing &&
      other.guideWidth === this.guideWidth
    )
  }

  draw(): HTMLDivElement {
    const root = document.createElement('div')
    root.dataset.yoloRewriteLengthHandleId = this.id
    const readout = document.createElement('div')
    readout.className = 'yolo-selection-rewrite-length-readout'
    const accessibleLabel = document.createElement('span')
    accessibleLabel.id = `yolo-selection-rewrite-length-handle-label-${this.id}`
    accessibleLabel.className = 'yolo-sr-only'
    accessibleLabel.textContent = this.ariaLabel
    const handle = document.createElement('button')
    handle.type = 'button'
    handle.className = 'yolo-selection-rewrite-length-handle'
    handle.setAttribute('aria-labelledby', accessibleLabel.id)
    handle.addEventListener('pointerdown', (event) => {
      if (handle.disabled) return
      event.preventDefault()
      event.stopPropagation()
      handle.setPointerCapture(event.pointerId)
      this.actions.start(event.clientY)
      const move = (moveEvent: PointerEvent) => {
        this.actions.move(moveEvent.clientY)
      }
      const finish = (finishEvent: PointerEvent) => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', finish)
        handle.removeEventListener('pointercancel', cancel)
        this.actions.finish(finishEvent.clientY)
      }
      const cancel = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', finish)
        handle.removeEventListener('pointercancel', cancel)
        this.actions.cancel()
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', finish)
      handle.addEventListener('pointercancel', cancel)
    })
    root.append(readout, handle, accessibleLabel)
    this.adjust(root)
    return root
  }

  update(element: HTMLElement, previous: LayerMarker): boolean {
    if (
      !(previous instanceof SelectionRewriteLengthHandleMarker) ||
      previous.id !== this.id
    ) {
      return false
    }
    this.adjust(element)
    return true
  }

  private adjust(element: HTMLElement): void {
    const locked = this.phase === 'waiting' || this.phase === 'streaming'
    element.className = `yolo-selection-rewrite-length-control is-${this.phase}${locked ? ' is-locked' : ''}${this.condensing ? ' is-condensing' : ''}`
    element.style.left = `${this.left}px`
    element.style.top = `${this.top}px`
    element.style.setProperty(
      '--yolo-selection-rewrite-length-guide-width',
      `${this.guideWidth}px`,
    )
    element.style.setProperty(
      '--yolo-selection-rewrite-handle-surface-extension',
      `${LENGTH_HANDLE_SURFACE_EXTENSION}px`,
    )
    const readout = element.querySelector<HTMLElement>(
      '.yolo-selection-rewrite-length-readout',
    )
    if (readout) readout.textContent = this.label
    const handle = element.querySelector<HTMLButtonElement>(
      '.yolo-selection-rewrite-length-handle',
    )
    const accessibleLabel = element.querySelector<HTMLElement>('.yolo-sr-only')
    if (accessibleLabel) accessibleLabel.textContent = this.ariaLabel
    if (handle) {
      handle.disabled = locked
    }
  }
}

export class SelectionRewriteController {
  private readonly sessions = new Map<string, SelectionRewriteRuntime>()
  private readonly externalLengthDragCleanups = new Map<string, () => void>()
  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    const runtime = Array.from(this.sessions.values())
      .reverse()
      .find(
        (candidate) =>
          candidate.kind === 'length' && candidate.phase === 'resizing',
      )
    if (!runtime) return
    this.dismissLengthRuntime(runtime)
    event.preventDefault()
    event.stopPropagation()
  }
  private readonly handleDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    const activeHandleId = target
      ?.closest<HTMLElement>('[data-yolo-rewrite-length-handle-id]')
      ?.getAttribute('data-yolo-rewrite-length-handle-id')
    for (const runtime of Array.from(this.sessions.values())) {
      if (
        runtime.kind !== 'length' ||
        runtime.phase !== 'resizing' ||
        runtime.id === activeHandleId
      ) {
        continue
      }
      this.dismissLengthRuntime(runtime)
    }
  }

  constructor(private readonly deps: SelectionRewriteControllerDeps) {
    document.addEventListener('keydown', this.handleDocumentKeyDown, true)
    document.addEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      true,
    )
  }

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
          return sessions.flatMap((session) =>
            createAdaptiveRewriteMarkers(view, session),
          )
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
          return sessions.flatMap((session) => {
            const markers: LayerMarker[] = []
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
            if (session.kind === 'length') {
              const lengthOutline = createAdaptiveRewriteOutline(view, session)
              const contentRects = getRewriteContentRects(view, session)
              const contentTop =
                contentRects.length > 0
                  ? Math.min(...contentRects.map((rect) => rect.top))
                  : lengthOutline?.top
              const contentBottom =
                contentRects.length > 0
                  ? Math.max(
                      ...contentRects.map((rect) => rect.top + rect.height),
                    )
                  : lengthOutline
                    ? lengthOutline.top + lengthOutline.height
                    : undefined
              const contentHeight =
                contentTop !== undefined && contentBottom !== undefined
                  ? contentBottom - contentTop
                  : session.targetHeight
              const contentBounds = getContentHorizontalBounds(view)
              const contentCenter =
                (contentBounds.left + contentBounds.right) / 2 - base.left
              const handleAnchor = getLengthHandleHorizontalAnchor(
                contentRects,
                contentCenter,
                view.textDirection,
              )
              const condensing =
                session.reserveHeight <= REWRITE_SURFACE_EDGE_EPSILON &&
                session.targetHeight < contentHeight - 1
              markers.push(
                new SelectionRewriteLengthHandleMarker(
                  session.id,
                  session.phase,
                  handleAnchor ??
                    (lengthOutline
                      ? lengthOutline.left + lengthOutline.width / 2
                      : Math.max(
                          6,
                          (contentRect.left + contentRect.right) / 2 -
                            base.left,
                        )),
                  lengthOutline
                    ? condensing && contentTop !== undefined
                      ? contentTop +
                        session.targetHeight +
                        LENGTH_HANDLE_SURFACE_EXTENSION
                      : lengthOutline.top + lengthOutline.height
                    : bottom - base.top,
                  controller.formatLengthLabel(session.targetRatio),
                  controller.deps.t(
                    'selection.length.handle',
                    'Drag to adjust length',
                  ),
                  condensing,
                  lengthOutline?.width ?? Math.max(1, contentRect.width),
                  {
                    start: (clientY) =>
                      controller.startLengthDrag(session.id, clientY),
                    move: (clientY) =>
                      controller.scheduleLengthDrag(session.id, clientY),
                    finish: (clientY) =>
                      controller.finishLengthDrag(session.id, clientY),
                    cancel: () => controller.cancelLengthDrag(session.id),
                  },
                ),
              )
            }
            if (session.phase === 'resizing') return markers
            const controlHeight = session.phase === 'review' ? 62 : 26
            const left = Math.min(contentRect.right + 12, scrollRect.right - 32)
            const controlTop = Math.max(
              6,
              top + (bottom - top - controlHeight) / 2 - base.top,
            )
            markers.push(
              new SelectionRewriteControlsMarker(
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
              ),
            )
            return markers
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
        keydown: (event, view) => {
          if (event.key !== 'Escape') return false
          return controller.cancelLengthSessionForView(view)
        },
      }),
    ]
  }

  start(options: StartSelectionRewriteOptions): void {
    selectionHighlightController.clearMatchingRange(options.view, {
      from: options.from,
      to: options.to,
    })
    const runtime = this.createRuntime({
      view: options.view,
      from: options.from,
      to: options.to,
      selectedText: options.selectedText,
      phase: 'waiting',
      request: {
        kind: 'instruction',
        instruction: options.instruction,
        providerClient: options.providerClient,
        model: options.model,
        settings: options.settings,
      },
    })
    runtime.frozenSurfaceRects = buildRewriteSurfaceRects(
      runtime.view,
      runtime,
      getRewriteContentRects(runtime.view, runtime),
      0,
    )
    this.sessions.set(runtime.id, runtime)
    this.deps.addAbortController(runtime.abortController)
    this.dispatchView(options.view, {
      selection: { anchor: options.from },
    })

    void this.run(runtime)
  }

  startLengthAdjustment(options: StartSelectionLengthAdjustmentOptions): void {
    selectionHighlightController.clearMatchingRange(options.view, {
      from: options.from,
      to: options.to,
    })
    const runtime = this.createRuntime({
      view: options.view,
      from: options.from,
      to: options.to,
      selectedText: options.selectedText,
      phase: 'resizing',
      request: {
        kind: 'length',
        contextBefore: options.contextBefore,
        contextAfter: options.contextAfter,
        fileTitle: options.fileTitle,
        providerClient: options.providerClient,
        model: options.model,
        settings: options.settings,
      },
    })
    this.sessions.set(runtime.id, runtime)
    this.deps.addAbortController(runtime.abortController)
    if (options.initialDrag) {
      this.startLengthDrag(runtime.id, options.initialDrag.startClientY)
      this.applyLengthDrag(runtime, options.initialDrag.currentClientY)
      this.continueLengthDragFromDocument(runtime.id)
    }
    this.dispatchView(options.view, {
      selection: { anchor: options.from },
    })
    // This action starts from a menu click, so the editor is no longer focused.
    // Focusing after collapsing the CodeMirror selection synchronizes the
    // browser DOM Range as well; otherwise native ::selection remains painted
    // above the rewrite surface even though the editor state is already empty.
    options.view.focus()
  }

  private createRuntime(options: {
    view: EditorView
    from: number
    to: number
    selectedText: string
    phase: 'resizing' | 'waiting'
    request: SelectionRewriteRequest
  }): SelectionRewriteRuntime {
    const baselineHeight = this.measureBaselineHeight(
      options.view,
      options.from,
      options.to,
    )
    const baselineCapacity = this.measureRangeCapacity(
      options.view,
      options.from,
      options.to,
    )
    return {
      id: crypto.randomUUID(),
      view: options.view,
      from: options.from,
      to: options.to,
      originalText: options.selectedText,
      candidateText: '',
      kind: options.request.kind,
      pendingCandidateText: '',
      revealedRawLength: 0,
      phase: options.phase,
      baselineHeight,
      baselineCapacity,
      targetCapacity: baselineCapacity,
      startIndent: this.measureStartIndent(options.view, options.from),
      block: this.shouldUseBlockCandidate(
        options.view,
        options.from,
        options.to,
      ),
      abortController: new AbortController(),
      publishFrame: null,
      publishResolve: null,
      layoutFrame: null,
      dragFrame: null,
      pendingDragClientY: 0,
      autoFollow: true,
      targetHeight: baselineHeight,
      targetRatio: 1,
      reserveHeight: 0,
      targetReserveHeight: 0,
      frozenSurfaceRects: null,
      overflowHeight: 0,
      settlingSurface: false,
      drag: null,
      fallbackReviewText: null,
      request: options.request,
    }
  }

  private formatLengthLabel(ratio: number): string {
    const rounded = (Math.round(ratio * 10) / 10).toFixed(1)
    const semantic =
      ratio < 0.95
        ? this.deps.t('selection.length.condense', 'Condense')
        : ratio <= 1.05
          ? this.deps.t('selection.length.adjust', 'Adjust length')
          : ratio <= 2.5
            ? this.deps.t('selection.length.expand', 'Expand')
            : this.deps.t('selection.length.freeExpand', 'Free expand')
    return `${semantic} · ×${rounded}`
  }

  private startLengthDrag(id: string, clientY: number): void {
    const runtime = this.sessions.get(id)
    if (
      !runtime ||
      runtime.kind !== 'length' ||
      (runtime.phase !== 'resizing' && runtime.phase !== 'review')
    ) {
      return
    }
    const returnPhase = runtime.phase
    if (returnPhase === 'review') {
      const actualHeight = this.measureDisplayedContentHeight(runtime)
      const actualCapacity = this.measureRangeCapacity(
        runtime.view,
        runtime.from,
        runtime.to,
      )
      runtime.targetHeight = actualHeight
      runtime.targetCapacity = actualCapacity
      runtime.targetRatio = actualCapacity / runtime.baselineCapacity
      runtime.reserveHeight = 0
    }
    runtime.drag = {
      pointerY: clientY,
      startTargetHeight: runtime.targetHeight,
      startTargetCapacity: runtime.targetCapacity,
      returnPhase,
    }
    runtime.pendingDragClientY = clientY
    runtime.phase = 'resizing'
    this.dispatchView(runtime.view)
  }

  private scheduleLengthDrag(id: string, clientY: number): void {
    const runtime = this.sessions.get(id)
    if (!runtime || runtime.kind !== 'length' || !runtime.drag) return
    runtime.pendingDragClientY = clientY
    if (runtime.dragFrame !== null) return
    runtime.dragFrame = window.requestAnimationFrame(() => {
      runtime.dragFrame = null
      this.applyLengthDrag(runtime, runtime.pendingDragClientY)
    })
  }

  private continueLengthDragFromDocument(id: string): void {
    this.externalLengthDragCleanups.get(id)?.()
    const move = (event: PointerEvent) => {
      this.scheduleLengthDrag(id, event.clientY)
    }
    const finish = (event: PointerEvent) => {
      cleanup()
      this.finishLengthDrag(id, event.clientY)
    }
    const cancel = () => {
      cleanup()
      this.cancelLengthDrag(id)
    }
    const cleanup = () => {
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', finish, true)
      document.removeEventListener('pointercancel', cancel, true)
      this.externalLengthDragCleanups.delete(id)
    }
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerup', finish, true)
    document.addEventListener('pointercancel', cancel, true)
    this.externalLengthDragCleanups.set(id, cleanup)
  }

  private applyLengthDrag(
    runtime: SelectionRewriteRuntime,
    clientY: number,
  ): void {
    if (!runtime.drag) return
    const targetHeight = Math.max(
      runtime.view.defaultLineHeight,
      runtime.drag.startTargetHeight + clientY - runtime.drag.pointerY,
    )
    const contentHeight = this.measureDisplayedContentHeight(runtime)
    const capacityDelta =
      (targetHeight - runtime.drag.startTargetHeight) /
      runtime.view.defaultLineHeight
    const minimumCapacity = Math.min(runtime.baselineCapacity, 0.1)
    runtime.targetHeight = targetHeight
    runtime.targetCapacity = Math.max(
      minimumCapacity,
      runtime.drag.startTargetCapacity + capacityDelta,
    )
    runtime.targetRatio = runtime.targetCapacity / runtime.baselineCapacity
    runtime.reserveHeight = Math.max(0, targetHeight - contentHeight)
    this.dispatchView(runtime.view)
  }

  private finishLengthDrag(id: string, clientY: number): void {
    const runtime = this.sessions.get(id)
    if (!runtime || runtime.kind !== 'length' || !runtime.drag) return
    this.cancelDragFrame(runtime)
    this.applyLengthDrag(runtime, clientY)
    const drag = runtime.drag
    if (
      Math.abs(runtime.targetHeight - drag.startTargetHeight) <
      runtime.view.defaultLineHeight * 0.15
    ) {
      this.cancelLengthDrag(id)
      return
    }

    runtime.drag = null
    runtime.frozenSurfaceRects = buildRewriteSurfaceRects(
      runtime.view,
      runtime,
      getRewriteContentRects(runtime.view, runtime),
      getOutlineReserveHeight(runtime),
    )
    runtime.targetReserveHeight = runtime.reserveHeight
    runtime.overflowHeight = 0
    runtime.settlingSurface = false
    runtime.fallbackReviewText =
      drag.returnPhase === 'review'
        ? runtime.view.state.sliceDoc(runtime.from, runtime.to)
        : null
    runtime.phase = 'waiting'
    runtime.candidateText = ''
    runtime.pendingCandidateText = ''
    runtime.revealedRawLength = 0
    this.cleanupRuntimeRequest(runtime)
    runtime.abortController.abort()
    runtime.abortController = new AbortController()
    this.deps.addAbortController(runtime.abortController)
    this.dispatchView(runtime.view)
    void this.run(runtime)
  }

  private cancelLengthDrag(id: string): void {
    const runtime = this.sessions.get(id)
    if (!runtime || runtime.kind !== 'length' || !runtime.drag) return
    this.cancelDragFrame(runtime)
    const drag = runtime.drag
    runtime.drag = null
    runtime.phase = drag.returnPhase
    runtime.targetHeight = drag.startTargetHeight
    runtime.targetCapacity = drag.startTargetCapacity
    runtime.targetRatio = runtime.targetCapacity / runtime.baselineCapacity
    runtime.reserveHeight = Math.max(
      0,
      runtime.targetHeight - this.measureDisplayedContentHeight(runtime),
    )
    this.dispatchView(runtime.view)
  }

  private cancelLengthSessionForView(view: EditorView): boolean {
    const runtime = Array.from(this.sessions.values()).find(
      (candidate) =>
        candidate.view === view &&
        candidate.kind === 'length' &&
        candidate.phase === 'resizing',
    )
    if (!runtime || runtime.kind !== 'length') return false
    this.dismissLengthRuntime(runtime)
    return true
  }

  private dismissLengthRuntime(runtime: SelectionRewriteRuntime): void {
    if (runtime.drag) {
      this.cancelLengthDrag(runtime.id)
      return
    }
    this.removeRuntime(runtime)
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
    document.removeEventListener('keydown', this.handleDocumentKeyDown, true)
    document.removeEventListener(
      'pointerdown',
      this.handleDocumentPointerDown,
      true,
    )
    for (const runtime of Array.from(this.sessions.values())) {
      runtime.abortController.abort()
      if (runtime.phase === 'review') {
        this.reject(runtime.id)
      } else {
        this.removeRuntime(runtime)
      }
    }
  }

  private async run(runtime: SelectionRewriteRuntime): Promise<void> {
    const request = runtime.request
    try {
      const result = await executeSingleTurn({
        providerClient: request.providerClient,
        model: request.model,
        request: {
          model: request.model.model,
          messages: this.buildRequestMessages(runtime),
          reasoningLevel:
            request.kind === 'length'
              ? request.settings.continuationOptions.tabCompletionOptions
                  ?.reasoningLevel
              : undefined,
        },
        signal: runtime.abortController.signal,
        deliveryMode: 'incremental',
        primaryRequestTimeoutMs:
          request.settings.continuationOptions.primaryRequestTimeoutMs,
        streamFallbackRecoveryEnabled:
          request.settings.continuationOptions.streamFallbackRecoveryEnabled,
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
        if (!this.restoreLengthReviewFallback(runtime)) {
          this.removeRuntime(runtime)
        }
        return
      }
      runtime.candidateText = finalText
      await this.commitCandidate(runtime)
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
        await this.commitCandidate(runtime)
      } else {
        if (!this.restoreLengthReviewFallback(runtime)) {
          this.removeRuntime(runtime)
        }
      }
    }
  }

  private buildRequestMessages(runtime: SelectionRewriteRuntime) {
    if (runtime.request.kind === 'instruction') {
      return [
        {
          role: 'system' as const,
          content:
            'Rewrite only the selected markdown according to the instruction. Preserve markdown structure unless the instruction requires changing it. Output only the complete replacement text, with no explanation and no code fence wrapping the response.',
        },
        {
          role: 'user' as const,
          content: `Instruction:\n${runtime.request.instruction.trim()}\n\nSelected markdown:\n${runtime.originalText}`,
        },
      ]
    }

    return [
      {
        role: 'system' as const,
        content:
          'Rewrite only the selected passage according to the requested output length. Use the provided context to infer an appropriate direction and style. Return valid Markdown that can replace the selection at its current location. Output only the complete replacement text, without explanations, labels, or code fences.',
      },
      {
        role: 'user' as const,
        content: `<document_title>\n${runtime.request.fileTitle}\n</document_title>\n\n<context_before>\n${runtime.request.contextBefore}\n</context_before>\n\n<selection>\n${runtime.originalText}\n</selection>\n\n<context_after>\n${runtime.request.contextAfter}\n</context_after>\n\n<target_length>\nRewrite the selection to approximately ${runtime.targetRatio.toFixed(2)} times its original length.\n</target_length>`,
      },
    ]
  }

  private restoreLengthReviewFallback(
    runtime: SelectionRewriteRuntime,
  ): boolean {
    if (runtime.kind !== 'length' || runtime.fallbackReviewText === null) {
      return false
    }
    runtime.candidateText = runtime.fallbackReviewText
    runtime.pendingCandidateText = ''
    runtime.revealedRawLength = 0
    this.enterReview(runtime)
    return true
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
      this.scheduleSurfaceMeasure(runtime)
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

  private async commitCandidate(
    runtime: SelectionRewriteRuntime,
  ): Promise<void> {
    if (!this.sessions.has(runtime.id)) return
    this.cancelLayoutFrame(runtime)
    const finalText = runtime.candidateText
    runtime.settlingSurface = true
    runtime.drag = null
    const from = runtime.from
    const to = runtime.to
    runtime.to = from + finalText.length
    runtime.view.dispatch({
      changes: { from, to, insert: finalText },
      effects: setSelectionRewriteEffect.of(this.visualsForView(runtime.view)),
      annotations: selectionRewriteTransaction.of({
        id: runtime.id,
        kind: 'commit',
      }),
    })

    // The streaming overlay and CodeMirror can wrap the same text differently.
    // Calibrate the remaining spacer against the committed document range in
    // the same task, before the browser paints, so their heights are never
    // briefly added together.
    const committedHeight = this.measureBaselineHeight(
      runtime.view,
      runtime.from,
      runtime.to,
    )
    runtime.reserveHeight = Math.max(0, runtime.targetHeight - committedHeight)
    runtime.targetReserveHeight = runtime.reserveHeight
    runtime.overflowHeight = 0
    this.dispatchView(runtime.view)

    await this.settleSurface(runtime)
    if (!this.sessions.has(runtime.id)) return
    this.enterReview(runtime)
    this.scheduleAutoFollow(runtime)
  }

  private enterReview(runtime: SelectionRewriteRuntime): void {
    runtime.phase = 'review'
    runtime.reserveHeight = 0
    runtime.targetReserveHeight = 0
    runtime.frozenSurfaceRects = null
    runtime.overflowHeight = 0
    runtime.settlingSurface = false
    runtime.fallbackReviewText = null
    this.cleanupRuntimeRequest(runtime)
    this.dispatchView(runtime.view)
    if (runtime.kind !== 'length') return
    window.requestAnimationFrame(() => {
      if (!this.sessions.has(runtime.id) || runtime.phase !== 'review') return
      const actualHeight = this.measureDisplayedContentHeight(runtime)
      const actualCapacity = this.measureRangeCapacity(
        runtime.view,
        runtime.from,
        runtime.to,
      )
      runtime.targetHeight = actualHeight
      runtime.targetCapacity = actualCapacity
      runtime.targetRatio = actualCapacity / runtime.baselineCapacity
      this.dispatchView(runtime.view)
    })
  }

  private measureDisplayedContentHeight(
    runtime: SelectionRewriteRuntime,
  ): number {
    if (runtime.phase === 'streaming') {
      const root = runtime.view.dom.querySelector<HTMLElement>(
        `[data-yolo-rewrite-id="${runtime.id}"]`,
      )
      const text = root?.querySelector<HTMLElement>(
        '.yolo-selection-rewrite-candidate-text',
      )
      if (text) {
        return measureCandidateTextHeight(text, runtime.view.defaultLineHeight)
      }
    }
    return this.measureBaselineHeight(runtime.view, runtime.from, runtime.to)
  }

  private scheduleSurfaceMeasure(runtime: SelectionRewriteRuntime): void {
    if (runtime.layoutFrame !== null) return
    runtime.layoutFrame = window.requestAnimationFrame(() => {
      runtime.layoutFrame = null
      if (runtime.phase !== 'streaming' || !this.sessions.has(runtime.id)) {
        return
      }
      const contentHeight = this.measureDisplayedContentHeight(runtime)
      const overflowHeight = Math.max(
        runtime.overflowHeight,
        contentHeight - runtime.targetHeight,
      )
      const reserveHeight = runtime.targetReserveHeight + overflowHeight
      if (
        Math.abs(runtime.reserveHeight - reserveHeight) < 0.5 &&
        Math.abs(runtime.overflowHeight - overflowHeight) < 0.5
      ) {
        return
      }
      runtime.reserveHeight = reserveHeight
      runtime.overflowHeight = overflowHeight
      this.dispatchView(runtime.view)
    })
  }

  private async settleSurface(runtime: SelectionRewriteRuntime): Promise<void> {
    if (!this.sessions.has(runtime.id)) return
    this.cancelLayoutFrame(runtime)
    runtime.phase = 'streaming'
    runtime.settlingSurface = true
    const startHeight = runtime.reserveHeight
    if (
      startHeight <= 0.5 ||
      !document.hasFocus() ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      runtime.reserveHeight = 0
      this.dispatchView(runtime.view)
      return
    }

    const duration = 240
    const startedAt = performance.now()
    await new Promise<void>((resolve) => {
      const frame = (now: number) => {
        if (!this.sessions.has(runtime.id)) {
          resolve()
          return
        }
        const progress = Math.min(1, (now - startedAt) / duration)
        const eased = 1 - Math.pow(1 - progress, 3)
        runtime.reserveHeight = startHeight * (1 - eased)
        this.dispatchView(runtime.view)
        if (progress < 1) {
          runtime.layoutFrame = window.requestAnimationFrame(frame)
        } else {
          runtime.layoutFrame = null
          resolve()
        }
      }
      runtime.layoutFrame = window.requestAnimationFrame(frame)
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
    const markers = RectangleMarker.forRange(
      view,
      'yolo-selection-rewrite-height-measure',
      EditorSelection.range(from, to),
    )
    if (markers.length > 0) {
      const top = Math.min(...markers.map((marker) => marker.top))
      const bottom = Math.max(
        ...markers.map((marker) => marker.top + marker.height),
      )
      return Math.max(view.defaultLineHeight, bottom - top)
    }

    const start = view.coordsAtPos(from)
    const end = view.coordsAtPos(Math.max(from, to - 1))
    if (!start || !end) return view.defaultLineHeight
    return Math.max(view.defaultLineHeight, end.bottom - start.top)
  }

  private measureRangeCapacity(
    view: EditorView,
    from: number,
    to: number,
  ): number {
    const bounds = getContentHorizontalBounds(view)
    const contentWidth = Math.max(1, bounds.right - bounds.left)
    const markers = RectangleMarker.forRange(
      view,
      'yolo-selection-rewrite-capacity',
      EditorSelection.range(from, to),
    )
    const capacity = markers.reduce((total, marker) => {
      const width = Math.min(contentWidth, Math.max(1, marker.width ?? 1))
      const heightInLines = Math.max(1, marker.height / view.defaultLineHeight)
      return total + (width / contentWidth) * heightInLines
    }, 0)
    return Math.max(0.01, capacity)
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
      .map((runtime) => this.toVisual(runtime))
  }

  private toVisual(runtime: SelectionRewriteRuntime): SelectionRewriteVisual {
    return {
      id: runtime.id,
      from: runtime.from,
      to: runtime.to,
      candidateText: runtime.candidateText,
      kind: runtime.kind,
      phase: runtime.phase,
      baselineHeight: runtime.baselineHeight,
      startIndent: runtime.startIndent,
      block: runtime.block,
      targetHeight: runtime.targetHeight,
      targetRatio: runtime.targetRatio,
      reserveHeight: runtime.reserveHeight,
      frozenSurfaceRects: runtime.frozenSurfaceRects,
      overflowHeight: runtime.overflowHeight,
      settlingSurface: runtime.settlingSurface,
    }
  }

  private removeRuntime(runtime: SelectionRewriteRuntime): void {
    if (!this.sessions.delete(runtime.id)) return
    this.dispatchView(runtime.view)
    this.cleanupRuntime(runtime)
  }

  private cleanupRuntime(runtime: SelectionRewriteRuntime): void {
    this.externalLengthDragCleanups.get(runtime.id)?.()
    this.cancelPublishFrame(runtime)
    this.cancelLayoutFrame(runtime)
    this.cancelDragFrame(runtime)
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

  private cancelLayoutFrame(runtime: SelectionRewriteRuntime): void {
    if (runtime.layoutFrame === null) return
    window.cancelAnimationFrame(runtime.layoutFrame)
    runtime.layoutFrame = null
  }

  private cancelDragFrame(runtime: SelectionRewriteRuntime): void {
    if (runtime.dragFrame === null) return
    window.cancelAnimationFrame(runtime.dragFrame)
    runtime.dragFrame = null
  }
}
