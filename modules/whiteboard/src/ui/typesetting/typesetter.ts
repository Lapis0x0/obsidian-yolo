// Cards typeset into the GPU scene's instances (./instances.ts), measured
// against a 2D context — the typesetting worker's OffscreenCanvas
// (./typesetWorker.ts) — so that nothing of it is on the main thread.

import { embedLinks, imageOf } from '../../typeset/images'
import { type DrawOp, layoutCard } from '../../typeset/layout'
import { paint } from '../../typeset/paint'
import { parseCard } from '../../typeset/parse'
import type { TypesetTokens } from '../../typeset/tokens'
import { cardInstances, packColor } from '../gpu/instances'

import {
  type PlacedImage,
  type TypesetCard,
  type TypesetResult,
  type TypesetResultCard,
  glyphKey,
  iconKey,
} from './typesetProtocol'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Widths a font keeps before they are measured afresh. */
const MEASURES_KEPT = 8192

export class Typesetter {
  private readonly widths = new Map<string, Map<string, number>>()
  private readonly advances = new Map<string, Map<string, number>>()
  private readonly metricsByFont = new Map<
    string,
    Readonly<{ ascent: number; descent: number }>
  >()
  private readonly colors = new Map<string, number>()

  constructor(
    private readonly ctx: Context2D,
    /** Where a colour is read back from: a 1 × 1 context of its own. */
    private readonly pixel: Context2D,
  ) {}

  /** Forgets every measurement: the fonts changed. */
  reset(): void {
    this.widths.clear()
    this.advances.clear()
    this.metricsByFont.clear()
    this.colors.clear()
  }

  typeset(
    tokens: TypesetTokens,
    cards: readonly TypesetCard[],
  ): { result: TypesetResult; transfer: ArrayBuffer[] } {
    const keys: string[] = []
    const keyIndex = new Map<string, number>()
    const keyOf = (key: string): number => {
      let index = keyIndex.get(key)
      if (index === undefined) {
        index = keys.length
        keys.push(key)
        keyIndex.set(key, index)
      }
      return index
    }
    const out: TypesetResultCard[] = []
    const transfer: ArrayBuffer[] = []
    for (const card of cards) {
      const ops = this.layout(tokens, card)
      const content = cardInstances(ops, {
        glyphId: (text, font) => keyOf(glyphKey(text, font)),
        iconId: (name, size) => keyOf(iconKey(name, size)),
        color: (css) => this.color(css),
        measure: (text, font) => this.measure(text, font),
        advance: (glyph, font) => this.advance(glyph, font),
      })
      const rects = content.rects.buffer as ArrayBuffer
      const glyphs = content.glyphs.buffer as ArrayBuffer
      const { shown, runs } = this.runsOf(ops)
      const images: PlacedImage[] = []
      for (const op of ops) {
        if (op.op !== 'image') continue
        images.push({ target: op.target, x: op.x, y: op.y, w: op.w, h: op.h })
      }
      out.push({
        id: card.id,
        rects,
        glyphs,
        images,
        host: needsHost(card.markdown, card.images ?? {}),
        shown,
        runs,
      })
      transfer.push(rects, glyphs, runs)
    }
    return { result: { cards: out, keys }, transfer }
  }

  /** The text a card draws, run by run, and where each run is. */
  private runsOf(ops: readonly DrawOp[]): {
    shown: string
    runs: ArrayBuffer
  } {
    let shown = ''
    const values: number[] = []
    for (const op of ops) {
      if (op.op !== 'text' || op.marker) continue
      const { ascent, descent } = this.metrics(op.font)
      const start = shown.length
      shown += op.text
      values.push(
        start,
        shown.length,
        op.x,
        op.y - Math.round(ascent),
        op.x + this.measure(op.text, op.font),
        op.y + Math.round(descent),
      )
    }
    return { shown, runs: new Float32Array(values).buffer }
  }

  /** A card laid out, as ../../typeset/layout.ts's draw ops. */
  layout(tokens: TypesetTokens, card: TypesetCard): DrawOp[] {
    const inset = card.plain ? tokens.plainInset : tokens.inset
    return layoutCard({
      sections: parseCard(card.markdown),
      width: card.w,
      height: card.h - inset.bottom,
      tokens,
      plain: card.plain,
      color: card.color,
      measure: (text, font) => this.measure(text, font),
      metrics: (font) => this.metrics(font),
      images: (target) => card.images?.[target] ?? null,
    })
  }

  /** A card's picture (../pictures/typesetCards.ts): its content drawn
   * over its whole box at `scale` device pixels per world unit, fading out
   * `fade` above its bottom edge. */
  picture(
    tokens: TypesetTokens,
    card: TypesetCard,
    scale: number,
    fade: number,
  ): ImageBitmap {
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(card.w * scale)),
      Math.max(1, Math.round(card.h * scale)),
    )
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no OffscreenCanvas 2D context')
    paint(ctx, this.layout(tokens, card), {
      scale,
      width: card.w,
      height: card.h,
      fade,
    })
    return canvas.transferToImageBitmap()
  }

  private measure(text: string, font: string): number {
    return this.cached(this.widths, text, font)
  }

  private advance(glyph: string, font: string): number {
    return this.cached(this.advances, glyph, font)
  }

  private cached(
    cache: Map<string, Map<string, number>>,
    text: string,
    font: string,
  ): number {
    let known = cache.get(font)
    if (!known) {
      known = new Map()
      cache.set(font, known)
    }
    let width = known.get(text)
    if (width === undefined) {
      if (this.ctx.font !== font) this.ctx.font = font
      width = this.ctx.measureText(text).width
      if (known.size >= MEASURES_KEPT) known.clear()
      known.set(text, width)
    }
    return width
  }

  private metrics(font: string): Readonly<{ ascent: number; descent: number }> {
    let known = this.metricsByFont.get(font)
    if (!known) {
      this.ctx.font = font
      const m = this.ctx.measureText('Hg国')
      known = {
        ascent: m.fontBoundingBoxAscent,
        descent: m.fontBoundingBoxDescent,
      }
      this.metricsByFont.set(font, known)
    }
    return known
  }

  /** A CSS colour as RGBA8, as the canvas parses it. */
  private color(css: string): number {
    let word = this.colors.get(css)
    if (word === undefined) {
      const ctx = this.pixel
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
}

/** Code blocks a plugin, or Obsidian itself, draws as something else. */
const DRAWN_FENCES =
  /^\s*(?:```|~~~)\s*(?:mermaid|dataview|dataviewjs|tasks|query|chart|excalidraw|math|latex|ad-[\w-]+)\b/im
/** `$$…$$`, or `$…$` hugging what it encloses, as Obsidian reads math. */
const MATH = /\$\$|(?:^|[^\\$\w])\$(?=\S)[^$\n]*?\S\$(?!\d)/m
const HTML = /<\/?[a-z][\w-]*(?:\s[^>]*)?>/i

/**
 * Whether a card's markdown holds what only the host's renderer shows as it
 * should — an embed that is not an image, an image whose size is not known
 * (`images`), math, HTML, a block a plugin draws — or nothing at all, which
 * the card shows its empty state's chips for. Such a card keeps its DOM
 * where it can be read; the typesetter only stands in for it far away,
 * where its picture is enough.
 */
export function needsHost(
  markdown: string,
  images: Readonly<Record<string, unknown>> = {},
): boolean {
  if (markdown.trim() === '') return true
  for (const link of embedLinks(markdown)) {
    const image = imageOf(link)
    if (!image || !(image.target in images)) return true
  }
  return (
    DRAWN_FENCES.test(markdown) || MATH.test(markdown) || HTML.test(markdown)
  )
}
