// Cards typeset into the GPU scene's instances (./instances.ts), measured
// against a 2D context — the typesetting worker's OffscreenCanvas
// (./typesetWorker.ts) — so that nothing of it is on the main thread.

import { embedLinks, imageOf } from '../../typeset/images'
import { type DrawOp, layoutCard } from '../../typeset/layout'
import { formulasIn, mathKey } from '../../typeset/math'
import type { Section } from '../../typeset/model'
import { paint } from '../../typeset/paint'
import { hasStrayEmphasis, parseCard } from '../../typeset/parse'
import { type TypesetTokens, contentClip } from '../../typeset/tokens'
import { fontSize } from '../gpu/glyphs'
import { cardInstances, packColor } from '../gpu/instances'

import {
  type PlacedImage,
  type TypesetCard,
  type TypesetResult,
  type TypesetResultCard,
  glyphKey,
  iconKey,
  pathKey,
} from './typesetProtocol'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Widths a font keeps before they are measured afresh. */
const MEASURES_KEPT = 8192
/** An emoji, with what it is joined with or modified by. */
const EMOJI =
  /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)(?:\p{Emoji_Modifier}|\uFE0F|\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?))*/gu

/** The fonts an emoji falls back to, wherever the board runs. */
const EMOJI_FONTS = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'

export class Typesetter {
  private readonly widths = new Map<string, Map<string, number>>()
  private readonly advances = new Map<string, Map<string, number>>()
  private readonly metricsByFont = new Map<
    string,
    Readonly<{ ascent: number; descent: number }>
  >()
  private readonly colors = new Map<string, number>()
  /** The look's emoji advance, in em (../../typeset/tokens.ts). */
  private emojiEm = 1

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
    this.useLook(tokens)
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
    // A glyph's index by font, then text: found without its key being put
    // together, which is every glyph but a font's first of each.
    const glyphIndex = new Map<string, Map<string, number>>()
    const glyphOf = (text: string, font: string): number => {
      let known = glyphIndex.get(font)
      if (!known) {
        known = new Map()
        glyphIndex.set(font, known)
      }
      let index = known.get(text)
      if (index === undefined) {
        index = keyOf(glyphKey(text, font))
        known.set(text, index)
      }
      return index
    }
    const out: TypesetResultCard[] = []
    const transfer: ArrayBuffer[] = []
    for (const card of cards) {
      const sections = parseCard(card.markdown)
      const ops = this.layout(tokens, card, sections)
      const content = cardInstances(ops, {
        glyphId: glyphOf,
        iconId: (name, size) => keyOf(iconKey(name, size)),
        pathId: (path, transform) => keyOf(pathKey(path, transform)),
        color: (css) => this.color(css),
        measure: (text, font) => this.measure(text, font),
        advance: (glyph, font) => this.advance(glyph, font),
      })
      const rects = content.rects.buffer as ArrayBuffer
      const glyphs = content.glyphs.buffer as ArrayBuffer
      const greeks = content.greeks.buffer as ArrayBuffer
      const { shown, runs, fonts } = this.runsOf(ops)
      const images: PlacedImage[] = []
      for (const op of ops) {
        if (op.op !== 'image') continue
        images.push({
          target: op.target,
          x: op.x,
          y: op.y,
          w: op.w,
          h: op.h,
          radius: op.radius,
        })
      }
      // Its formulas are drawn when each is laid out; one that is not yet
      // is asked for, and the card is the host's until it is.
      const math = formulasIn(sections)
      const missing = math.looseDisplay
        ? []
        : math.formulas.filter((f) => card.math?.[mathKey(f)] === undefined)
      const unlaid = math.formulas.some((f) => !card.math?.[mathKey(f)])
      out.push({
        id: card.id,
        rects,
        glyphs,
        greeks,
        images,
        host:
          needsHost(card.markdown, card.images ?? {}) ||
          hasStrayEmphasis(sections) ||
          math.looseDisplay ||
          unlaid,
        ...(missing.length > 0 ? { math: missing } : {}),
        shown,
        runs,
        fonts,
      })
      transfer.push(rects, glyphs, greeks, runs)
    }
    return { result: { cards: out, keys }, transfer }
  }

  /** The text a card draws, run by run, and where each run is. */
  private runsOf(ops: readonly DrawOp[]): {
    shown: string
    runs: ArrayBuffer
    fonts: string[]
  } {
    let shown = ''
    const values: number[] = []
    const fonts: string[] = []
    const fontIndex = new Map<string, number>()
    for (const op of ops) {
      if (op.op !== 'text' || op.marker) continue
      const { ascent, descent } = this.metrics(op.font)
      let font = fontIndex.get(op.font)
      if (font === undefined) {
        font = fonts.length
        fontIndex.set(op.font, font)
        fonts.push(op.font)
      }
      const start = shown.length
      shown += op.text
      values.push(
        start,
        shown.length,
        op.x,
        op.y - Math.round(ascent),
        op.x + this.measure(op.text, op.font),
        op.y + Math.round(descent),
        op.y,
        font,
      )
    }
    return { shown, runs: new Float32Array(values).buffer, fonts }
  }

  /** A card laid out, as ../../typeset/layout.ts's draw ops. */
  layout(
    tokens: TypesetTokens,
    card: TypesetCard,
    sections: readonly Section[] = parseCard(card.markdown),
  ): DrawOp[] {
    this.useLook(tokens)
    return layoutCard({
      sections,
      width: card.w,
      // What overflows the content shows over the bottom padding too, to
      // the card's edge.
      height: card.h,
      tokens,
      plain: card.plain,
      color: card.color,
      measure: (text, font) => this.measure(text, font),
      metrics: (font) => this.metrics(font),
      images: (target) => card.images?.[target] ?? null,
      math: (formula) => card.math?.[mathKey(formula)] ?? null,
    })
  }

  /** A card's picture (../pictures/typesetCards.ts): its content drawn
   * over its whole box at `scale` device pixels per world unit, fading out
   * `fade` above its bottom edge, with `images` where they are laid out. */
  picture(
    tokens: TypesetTokens,
    card: TypesetCard,
    scale: number,
    fade: number,
    images: Readonly<Record<string, ImageBitmap>> = {},
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
      clip: contentClip(tokens, card.plain),
      images,
    })
    return canvas.transferToImageBitmap()
  }

  /** Widths measured in another look's emoji advance are measured again. */
  private useLook(tokens: TypesetTokens): void {
    if (tokens.emoji === this.emojiEm) return
    this.emojiEm = tokens.emoji
    this.widths.clear()
    this.advances.clear()
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
      // An emoji drawn from the emoji font takes the browser's advance, not
      // the canvas's; one the font has a glyph of itself is its own.
      let emoji = 0
      const rest = text.replace(EMOJI, (match) => {
        emoji += this.emojiAdvance(match, font)
        return ''
      })
      width =
        emoji === 0 && rest === text
          ? this.ctx.measureText(text).width
          : this.ctx.measureText(rest).width + emoji
      if (known.size >= MEASURES_KEPT) known.clear()
      known.set(text, width)
    }
    return width
  }

  /** An emoji's advance in `font`: the browser's, an em's worth of it
   * (`emojiEm`), where the font has no glyph of it and it falls back to the
   * emoji font — as the canvas measures it the same in both — and the
   * canvas's own where the font has one. */
  private emojiAdvance(emoji: string, font: string): number {
    const size = fontSize(font)
    this.ctx.font = font
    const own = this.ctx.measureText(emoji).width
    this.ctx.font = `${size}px ${EMOJI_FONTS}`
    const fallback = this.ctx.measureText(emoji).width
    this.ctx.font = font
    return Math.abs(own - fallback) < 0.01 ? this.emojiEm * size : own
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
/** A tag, but a line break, which the typesetter breaks the line at. */
const HTML = /<\/?(?!br\b)[a-z][\w-]*(?:\s[^>]*)?>/i

/**
 * Whether a card's markdown holds what only the host's renderer shows as it
 * should — an embed that is not an image, an image whose size is not known
 * (`images`), HTML, a block a plugin draws. (Math is the typesetter's once
 * each formula is laid out: `typeset`.) Such a card keeps its DOM
 * where it can be read; the typesetter only stands in for it far away,
 * where its picture is enough. An empty card is the typesetter's: it shows
 * nothing until it is the one selected or being edited, which have their
 * DOM anyway (canvas.ts's `gpuDraws`) and the chips with it.
 */
export function needsHost(
  markdown: string,
  images: Readonly<Record<string, unknown>> = {},
): boolean {
  for (const link of embedLinks(markdown)) {
    const image = imageOf(link)
    // Only an image that can be drawn is in `images` — one on the web once
    // its bytes are kept (../../host/remoteImages.ts).
    if (!image || !(image.target in images)) return true
  }
  return DRAWN_FENCES.test(markdown) || HTML.test(markdown)
}
