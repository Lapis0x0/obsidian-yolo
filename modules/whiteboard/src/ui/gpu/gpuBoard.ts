// The board's cards handed to the GPU scene (./scene.ts): which cards there
// are, what each one says — typeset (../../typeset/) in the look read off the
// host's own card (../pictures/typesetStyle.ts) — and when to draw.
//
// Behind a development switch while the scene grows into the board's
// renderer (docs/plans/…-whiteboard-gpu-renderer/p4-gpu.md): set
// `localStorage['yolo-whiteboard-gpu'] = '1'` and reopen a board to have it
// drawn over the DOM.

import { resolveColor } from '../../domain/color'
import { type BoardNode, isPlainText } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import type { CanvasView } from '../../domain/virtualization'
import { layoutCard } from '../../typeset/layout'
import { parseCard } from '../../typeset/parse'
import { clippedCardMarkdown } from '../canvas/cardContent'
import { OVERVIEW_THEMED_CARD_WASH_ALPHA } from '../constants'
import type { TypesetStyle } from '../pictures/typesetStyle'

import { cardInstances, packColor } from './instances'
import { GpuScene, type SceneFrame } from './scene'

export const GPU_SWITCH_KEY = 'yolo-whiteboard-gpu'

/** Whether the development switch is on in this window. */
export function gpuSwitchedOn(win: Window): boolean {
  try {
    return win.localStorage.getItem(GPU_SWITCH_KEY) === '1'
  } catch {
    return false
  }
}

/** The card's radius and border (styles/cards/card.css). */
const CARD_RADIUS = 10
const CARD_BORDER = 1
/** How far above a framed card's bottom edge its content fades out
 * (styles/cards/content.css's mask). */
const FADE = 24
/** How long the camera must have been still to count as at rest, ms. */
const SETTLE_MS = 120
/** How long a frame may spend typesetting cards, ms. */
const TYPESET_BUDGET_MS = 4
const MEASURES_KEPT = 8192

export type GpuBoardDeps = Readonly<{
  /** Where the scene's canvas goes: over everything the board draws. */
  parent: HTMLElement
  /** Where the board's palette is read (root.css). */
  root: HTMLElement
  style: TypesetStyle
  view: () => CanvasView
  readNote: (path: string) => Promise<string | null>
}>

type Pending = { node: BoardNode; text: string | null }

export class GpuBoard {
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

  /** Called every frame: typesets what is owed, and draws when anything
   * changed. */
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
    this.dirty = result.more || this.pending.size > 0
  }

  destroy(): void {
    this.scene.dispose()
    this.canvas.remove()
  }

  private typeset(now: number): void {
    const win = this.canvas.ownerDocument.defaultView
    const clock = () => win?.performance.now() ?? now
    const start = clock()
    for (const [id, pending] of this.pending) {
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
    }
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
    this.scene.setCard(node.id, {
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      frame: plain ? null : this.frameOf(node),
      fade: plain ? 0 : FADE,
      content,
    })
  }

  private frameOf(node: BoardNode): SceneFrame {
    const style = this.canvas.ownerDocument.defaultView?.getComputedStyle(
      this.deps.root,
    )
    const read = (name: string, fallback: string) =>
      style?.getPropertyValue(name).trim() || fallback
    const background = read('--yolo-whiteboard-card-background', '#ffffff')
    let fill = this.pack(background)
    if (node.color !== undefined) {
      const tint = this.nodeColor(node.color)
      if (tint) {
        const dark = this.deps.root.closest('.theme-dark') !== null
        const alpha = dark
          ? OVERVIEW_THEMED_CARD_WASH_ALPHA.dark
          : OVERVIEW_THEMED_CARD_WASH_ALPHA.light
        fill = mix(fill, this.pack(tint), alpha)
      }
    }
    return {
      fill,
      border: this.pack(read('--yolo-whiteboard-card-border', '#e8e8e8')),
      borderWidth: CARD_BORDER,
      radius: CARD_RADIUS,
    }
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

/** `over` laid over `under` at `alpha`, both RGBA8 words. */
function mix(under: number, over: number, alpha: number): number {
  const channel = (shift: number) => {
    const a = (under >>> shift) & 255
    const b = (over >>> shift) & 255
    return Math.round(a + (b - a) * alpha)
  }
  return packColor(channel(0), channel(8), channel(16), (under >>> 24) & 255)
}
