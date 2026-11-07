// Cards typeset into the GPU scene's instances (./instances.ts), measured
// against a 2D context — the typesetting worker's OffscreenCanvas
// (./typesetWorker.ts) — so that nothing of it is on the main thread.

import { layoutCard } from '../../typeset/layout'
import { parseCard } from '../../typeset/parse'
import type { TypesetTokens } from '../../typeset/tokens'

import { cardInstances, packColor } from './instances'
import {
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
      const inset = card.plain ? tokens.plainInset : tokens.inset
      const ops = layoutCard({
        sections: parseCard(card.markdown),
        width: card.w,
        height: card.h - inset.bottom,
        tokens,
        plain: card.plain,
        color: card.color,
        measure: (text, font) => this.measure(text, font),
        metrics: (font) => this.metrics(font),
      })
      const content = cardInstances(ops, {
        glyphId: (text, font) => keyOf(glyphKey(text, font)),
        iconId: (name, size) => keyOf(iconKey(name, size)),
        color: (css) => this.color(css),
        measure: (text, font) => this.measure(text, font),
        advance: (glyph, font) => this.advance(glyph, font),
      })
      const rects = content.rects.buffer as ArrayBuffer
      const glyphs = content.glyphs.buffer as ArrayBuffer
      out.push({ id: card.id, rects, glyphs })
      transfer.push(rects, glyphs)
    }
    return { result: { cards: out, keys }, transfer }
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
