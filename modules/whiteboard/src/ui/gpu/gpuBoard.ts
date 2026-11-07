// The content of the board's text and note cards, drawn by the GPU scene
// (./scene.ts) wherever the overview canvas (../canvas/overviewLayer.ts)
// draws those cards — in its tier, and under the world for cards not mounted
// yet — in place of their pictures: typeset (../../typeset/) in the look read
// off the host's own card (../pictures/typesetStyle.ts), sharp at the size
// the card shows at rather than a picture made at one size.
//
// The overview layer decides which cards show, as it always has; this layer
// only answers, card by card, whether it can draw one (`claim`): it cannot
// while the card is not typeset yet, or where its type would be too small to
// read, and there the card's picture stands in as before.
//
// Its canvas lies between the overview's and the world layer, so the content
// is over the surfaces the overview draws and under everything the world
// holds.
//
// Behind a development switch while the scene grows into the board's
// renderer (docs/plans/…-whiteboard-gpu-renderer/p4-gpu.md): set
// `localStorage['yolo-whiteboard-gpu'] = '1'` and reopen a board.

import { resolveColor } from '../../domain/color'
import { type BoardNode, isPlainText } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import type { CardRect } from '../../domain/resize'
import type { CanvasView } from '../../domain/virtualization'
import { layoutCard } from '../../typeset/layout'
import { parseCard } from '../../typeset/parse'
import { clippedCardMarkdown } from '../canvas/cardContent'
import type { ContentLayer } from '../canvas/overviewLayer'
import type { TypesetStyle } from '../pictures/typesetStyle'

import { cardInstances, packColor } from './instances'
import { GpuScene } from './scene'

export const GPU_SWITCH_KEY = 'yolo-whiteboard-gpu'

/** Whether the development switch is on in this window. */
export function gpuSwitchedOn(win: Window): boolean {
  try {
    return win.localStorage.getItem(GPU_SWITCH_KEY) === '1'
  } catch {
    return false
  }
}

/** How far above a framed card's bottom edge its content fades out
 * (styles/cards/content.css's mask). */
const FADE = 24
/** How long the camera must have been still to count as at rest, ms. */
const SETTLE_MS = 120
/** How long a frame may spend typesetting cards, ms. */
const TYPESET_BUDGET_MS = 4
const MEASURES_KEPT = 8192
/** The smallest a card's body type is drawn, in device pixels: below it a
 * card's picture says as much, for far less. */
const MIN_BODY_DEVICE_PX = 5

export type GpuBoardDeps = Readonly<{
  /** Where the scene's canvas goes: appended after the overview's, before
   * the world layer is. */
  parent: HTMLElement
  /** Where the board's palette is read (root.css). */
  root: HTMLElement
  style: TypesetStyle
  view: () => CanvasView
  /** Whether a card has its DOM now. The overview leaves a card it drew
   * under the world for its DOM to cover when it mounts, and does not draw
   * again for that; bare text's DOM is transparent and would not cover this
   * layer's drawing, so a mounted card is dropped here. */
  isMounted: (id: string) => boolean
  /** Has the overview draw again: it asks anew which cards this layer
   * draws. */
  redrawOverview: () => void
  readNote: (path: string) => Promise<string | null>
}>

type Pending = { node: BoardNode; text: string | null }

export class GpuBoard implements ContentLayer {
  readonly canvas: HTMLCanvasElement
  private readonly scene: GpuScene
  private readonly nodes = new Map<string, BoardNode>()
  /** Cards whose content is owed, in the order they are typeset. */
  private readonly pending = new Map<string, Pending>()
  private readonly colors = new Map<string, number>()
  private readonly widths = new Map<string, Map<string, number>>()
  private readonly metricsByFont = new Map<
    string,
    Readonly<{ ascent: number; descent: number }>
  >()
  private readonly parseCtx: CanvasRenderingContext2D
  private lastView: CanvasView | null = null
  private movedAt = 0
  private dirty = true
  private styleHash: string | null = null
  /** What the overview's last frame had this layer draw, and where. */
  private claimed = new Map<string, CardRect>()
  /** What the scene shows now. */
  private shown = new Set<string>()
  /** Cards asked for that are not typeset yet: typeset first. */
  private readonly wanted = new Set<string>()

  constructor(private readonly deps: GpuBoardDeps) {
    const doc = deps.parent.ownerDocument
    this.canvas = doc.createElement('canvas')
    this.canvas.className = 'yolo-whiteboard-gpu-scene'
    deps.parent.appendChild(this.canvas)
    // DEBUG(p4): reachable from the console while the scene is developed.
    Object.assign(this.canvas, { gpuBoard: this })
    this.scene = new GpuScene(this.canvas)
    const ctx = doc.createElement('canvas').getContext('2d', {
      willReadFrequently: true,
    })
    if (!ctx) throw new Error('no 2D canvas')
    this.parseCtx = ctx
  }

  /** The board's cards, bottom to top. */
  setNodes(nodes: readonly BoardNode[]): void {
    const seen = new Set<string>()
    const cards: string[] = []
    for (const node of nodes) {
      if (!drawsContent(node)) continue
      seen.add(node.id)
      cards.push(node.id)
      const before = this.nodes.get(node.id)
      if (before === node) continue
      this.nodes.set(node.id, node)
      this.pending.set(node.id, { node, text: null })
    }
    for (const id of [...this.nodes.keys()]) {
      if (seen.has(id)) continue
      this.nodes.delete(id)
      this.pending.delete(id)
      this.scene.removeCard(id)
    }
    this.scene.setOrder(cards)
    this.dirty = true
  }

  begin(): void {
    this.claimed = new Map()
    this.dirty = true
  }

  claim(node: BoardNode, rect: CardRect, scale: number): boolean {
    const tokens = this.deps.style.tokens
    if (!tokens || !this.scene.usable) return false
    const dpr = this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1
    if (tokens.body.size * scale * dpr < MIN_BODY_DEVICE_PX) return false
    if (!this.nodes.has(node.id)) return false
    if (this.pending.has(node.id) || !this.scene.cardOf(node.id)) {
      this.wanted.add(node.id)
      return false
    }
    this.claimed.set(node.id, rect)
    return true
  }

  /** Called every frame, after the overview's: typesets what is owed, and
   * draws when anything changed. */
  render(now: number): void {
    const hash = this.deps.style.hash
    if (hash !== this.styleHash && this.deps.style.tokens) {
      // A new look: every card is typeset again.
      this.styleHash = hash
      this.colors.clear()
      for (const node of this.nodes.values()) {
        this.pending.set(node.id, { node, text: null })
      }
    }
    if (this.pending.size > 0 && this.deps.style.tokens) this.typeset(now)
    this.syncShown()
    const view = this.deps.view()
    const last = this.lastView
    if (
      !last ||
      last.tx !== view.tx ||
      last.ty !== view.ty ||
      last.scale !== view.scale
    ) {
      this.lastView = view
      this.movedAt = now
      this.dirty = true
    }
    const settled = now - this.movedAt >= SETTLE_MS
    // The frame the camera comes to rest on is drawn once more, sharp.
    if (settled && this.movedAt > 0) {
      this.movedAt = -1
      this.dirty = true
    }
    if (!this.dirty) return
    const result = this.scene.render(view, settled || this.movedAt === -1)
    this.dirty = result.more
  }

  /** Shows what the overview claimed, where it claimed it — a card a
   * gesture is moving at its live rectangle — and nothing else. */
  private syncShown(): void {
    const view = this.deps.view()
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    for (const id of this.claimed.keys()) {
      if (this.deps.isMounted(id)) this.claimed.delete(id)
    }
    for (const id of this.shown) {
      if (this.claimed.has(id)) continue
      // One gone off screen is out of sight anyway: left as it is, so that
      // panning changes nothing in the card table.
      const card = this.scene.cardOf(id)
      if (card && !onScreen(card, view, width, height)) continue
      this.scene.setShown(id, false)
      this.shown.delete(id)
      this.dirty = true
    }
    for (const [id, rect] of this.claimed) {
      const card = this.scene.cardOf(id)
      if (!card) continue
      if (
        card.x !== rect.x ||
        card.y !== rect.y ||
        card.w !== rect.w ||
        card.h !== rect.h
      ) {
        this.scene.setCard(id, {
          ...card,
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
        })
        this.dirty = true
      }
      if (this.shown.has(id)) continue
      this.scene.setShown(id, true)
      this.shown.add(id)
      this.dirty = true
    }
  }

  destroy(): void {
    this.scene.dispose()
    this.canvas.remove()
  }

  private typeset(now: number): void {
    const win = this.canvas.ownerDocument.defaultView
    const clock = () => win?.performance.now() ?? now
    const start = clock()
    // What the overview asked for first, then the rest in board order.
    const order = [
      ...[...this.wanted].filter((id) => this.pending.has(id)),
      ...this.pending.keys(),
    ]
    this.wanted.clear()
    let placed = false
    for (const id of order) {
      const pending = this.pending.get(id)
      if (!pending) continue
      if (clock() - start > TYPESET_BUDGET_MS) break
      const { node } = pending
      if (node.type === 'file' && pending.text === null) {
        // Read once, then typeset on a later frame.
        pending.text = ''
        void this.deps.readNote(node.file).then((text) => {
          const still = this.pending.get(id)
          if (still === pending) still.text = text ?? ''
          this.dirty = true
        })
        continue
      }
      if (node.type === 'file' && pending.text === '') continue
      this.pending.delete(id)
      const markdown = node.type === 'text' ? node.text : (pending.text ?? '')
      this.place(node, markdown)
      placed = true
    }
    // The overview draws their pictures until it asks again.
    if (placed) this.deps.redrawOverview()
  }

  private place(node: BoardNode, markdown: string): void {
    const tokens = this.deps.style.tokens
    if (!tokens) return
    const plain = isPlainText(node)
    const inset = plain ? tokens.plainInset : tokens.inset
    const color =
      plain && node.color !== undefined ? this.nodeColor(node.color) : null
    const ops = layoutCard({
      sections: parseCard(clippedCardMarkdown(node, markdown)),
      width: node.w,
      height: node.h - inset.bottom,
      tokens,
      plain,
      color,
      measure: (text, font) => this.measure(text, font),
      metrics: (font) => this.metrics(font),
    })
    const atlas = this.scene.glyphs
    const content = cardInstances(ops, {
      glyphId: (text, font) => atlas.glyphId(text, font),
      iconId: (name, size) => atlas.iconId(name, size),
      color: (css) => this.pack(css),
      measure: (text, font) => this.measure(text, font),
      advance: (glyph, font) => atlas.advance(glyph, font),
    })
    // Not shown until the overview claims it: it draws the card's surface.
    const before = this.scene.cardOf(node.id)
    this.scene.setCard(node.id, {
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      frame: null,
      fade: plain ? 0 : FADE,
      content,
    })
    if (!before) this.scene.setShown(node.id, false)
  }

  private nodeColor(color: string): string | null {
    const resolved = resolveColor(color)
    if (resolved.kind === 'none') return null
    if (resolved.kind === 'custom') return resolved.hex
    const value = this.canvas.ownerDocument.defaultView
      ?.getComputedStyle(this.deps.root)
      .getPropertyValue(`--yolo-whiteboard-color-${resolved.preset}`)
      .trim()
    return value ? value : null
  }

  /** A CSS colour as RGBA8, as the canvas parses it. */
  private pack(css: string): number {
    let word = this.colors.get(css)
    if (word === undefined) {
      const ctx = this.parseCtx
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      word = packColor(r, g, b, a)
      this.colors.set(css, word)
    }
    return word
  }

  private measure(text: string, font: string): number {
    let known = this.widths.get(font)
    if (!known) {
      known = new Map()
      this.widths.set(font, known)
    }
    let width = known.get(text)
    if (width === undefined) {
      const ctx = this.parseCtx
      if (ctx.font !== font) ctx.font = font
      width = ctx.measureText(text).width
      if (known.size >= MEASURES_KEPT) known.clear()
      known.set(text, width)
    }
    return width
  }

  private metrics(font: string): Readonly<{ ascent: number; descent: number }> {
    let known = this.metricsByFont.get(font)
    if (!known) {
      const ctx = this.parseCtx
      ctx.font = font
      const m = ctx.measureText('Hg国')
      known = {
        ascent: m.fontBoundingBoxAscent,
        descent: m.fontBoundingBoxDescent,
      }
      this.metricsByFont.set(font, known)
    }
    return known
  }
}

/** Whether a node is a card the typesetter lays out: text, or a note. */
function drawsContent(node: BoardNode): boolean {
  if (node.type === 'text') return true
  return node.type === 'file' && fileNodeKind(node.file) === 'markdown'
}

function onScreen(
  card: Readonly<{ x: number; y: number; w: number; h: number }>,
  view: CanvasView,
  width: number,
  height: number,
): boolean {
  const x = card.x * view.scale + view.tx
  const y = card.y * view.scale + view.ty
  return (
    x < width &&
    y < height &&
    x + card.w * view.scale > 0 &&
    y + card.h * view.scale > 0
  )
}
