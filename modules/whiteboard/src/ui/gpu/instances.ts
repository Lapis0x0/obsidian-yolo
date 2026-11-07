// A card's content — what the typesetter (../../typeset/layout.ts) laid out
// — as the GPU scene's (./scene.ts) instances: rectangles and glyphs, in the
// card's own coordinates, ready to be copied into a chunk's buffer.
//
// Every instance is a fixed number of 32-bit words, its first the slot of
// the card it belongs to — written when a chunk takes it in, since a card's
// slot is the scene's to give (`setCardSlot`). Coordinates are floats,
// colours RGBA8 packed into one word (`packColor`), glyphs the atlas's ids.

import type { DrawOp } from '../../typeset/layout'
import { mathTextFont } from '../../typeset/math'
import type { PathTransform } from '../typesetting/typesetProtocol'

import { fontSize, placeRun } from './glyphs'

/** A rectangle: [slot, x, y, w, h, radius, border width, fill, border]. */
export const RECT_WORDS = 9
/** A glyph: [slot, origin x, baseline y, glyph id, colour]. */
export const GLYPH_WORDS = 5

export type CardInstances = Readonly<{
  /** RECT_WORDS words each. */
  rects: Uint32Array
  /** GLYPH_WORDS words each. */
  glyphs: Uint32Array
  /** RECT_WORDS words each: a bar for each run of text, drawn in place of
   * its glyphs where the type is too small to read (`greekBar`). */
  greeks: Uint32Array
  /** Each glyph id the card uses, once. */
  glyphIds: readonly number[]
}>

export type InstanceDeps = Readonly<{
  /** The atlas's id for a glyph of `font`. */
  glyphId: (text: string, font: string) => number
  /** The atlas's id for an icon `size` world units across. */
  iconId: (name: 'check', size: number) => number
  /** The atlas's id for an outline (a formula's glyph) drawn with
   * `transform`, its origin where it is placed. */
  pathId: (path: string, transform: PathTransform) => number
  /** A CSS colour as RGBA8 (`packColor`). */
  color: (css: string) => number
  /** A run's width, as the typesetter measured it. */
  measure: (text: string, font: string) => number
  /** One glyph's own advance. */
  advance: (glyph: string, font: string) => number
}>

/** RGBA8 in one word, red in its lowest byte — as a little-endian buffer
 * read as four normalised bytes has it. */
export function packColor(r: number, g: number, b: number, a: number): number {
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
}

export function cardInstances(
  ops: readonly DrawOp[],
  deps: InstanceDeps,
): CardInstances {
  const rects: number[] = []
  const glyphs: number[] = []
  const greeks: number[] = []
  const ids = new Set<number>()
  const rect = (
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    border: number,
    fill: number,
    stroke: number,
  ) => {
    rects.push(0, x, y, w, h, radius, border, fill, stroke)
  }
  const glyph = (x: number, y: number, id: number, color: number) => {
    glyphs.push(0, x, y, id, color)
    ids.add(id)
  }
  for (const op of ops) {
    switch (op.op) {
      case 'text': {
        const color = deps.color(op.color)
        const width = deps.measure(op.text, op.font)
        for (const placed of placeRun(op.text, width, (g) =>
          deps.advance(g, op.font),
        )) {
          glyph(
            op.x + placed.x,
            op.y,
            deps.glyphId(placed.text, op.font),
            color,
          )
        }
        const bar = greekBar(op.text, op.x, op.y, width, fontSize(op.font))
        if (bar) {
          greeks.push(
            0,
            bar.x,
            bar.y,
            bar.w,
            bar.h,
            bar.h / 2,
            0,
            faded(color),
            0,
          )
        }
        break
      }
      case 'rect':
        rect(op.x, op.y, op.w, op.h, op.radius, 0, deps.color(op.color), 0)
        break
      case 'frame':
        rect(
          op.x,
          op.y,
          op.w,
          op.h,
          op.radius,
          op.width,
          0,
          deps.color(op.color),
        )
        break
      case 'line': {
        // The typesetter's lines are rules, strikes and table borders: level
        // or upright, so a rectangle along the line.
        const half = op.width / 2
        const x = Math.min(op.x1, op.x2)
        const y = Math.min(op.y1, op.y2)
        const level = Math.abs(op.y2 - op.y1) <= Math.abs(op.x2 - op.x1)
        rect(
          level ? x : x - half,
          level ? y - half : y,
          level ? Math.abs(op.x2 - op.x1) : op.width,
          level ? op.width : Math.abs(op.y2 - op.y1),
          0,
          0,
          deps.color(op.color),
          0,
        )
        break
      }
      case 'dot':
        rect(
          op.x - op.r,
          op.y - op.r,
          op.r * 2,
          op.r * 2,
          op.r,
          0,
          deps.color(op.color),
          0,
        )
        break
      case 'check':
        glyph(op.x, op.y, deps.iconId('check', op.size), deps.color(op.color))
        break
      case 'math': {
        const { piece, size } = op
        const own = deps.color(op.color)
        for (const shape of piece.shapes) {
          const color = shape.color === null ? own : deps.color(shape.color)
          if (shape.kind === 'path') {
            const [a, b, c, d, e, f] = shape.transform
            glyph(
              op.x + e * size,
              op.y + f * size,
              deps.pathId(op.paths[shape.path], [
                a * size,
                b * size,
                c * size,
                d * size,
              ]),
              color,
            )
          } else if (shape.kind === 'rect') {
            rect(
              op.x + shape.x * size,
              op.y + shape.y * size,
              shape.width * size,
              shape.height * size,
              0,
              0,
              color,
              0,
            )
          } else {
            const font = mathTextFont(shape, size)
            const x = op.x + shape.x * size
            const y = op.y + shape.y * size
            const width = deps.measure(shape.text, font)
            for (const placed of placeRun(shape.text, width, (g) =>
              deps.advance(g, font),
            )) {
              glyph(x + placed.x, y, deps.glyphId(placed.text, font), color)
            }
          }
        }
        // Far off, a bar over the middle of it, as a run of text is.
        const h = size * 0.5
        greeks.push(
          0,
          op.x,
          op.y - size * 0.62,
          piece.width * size,
          h,
          h / 2,
          0,
          faded(own),
          0,
        )
        break
      }
    }
  }
  return {
    rects: toWords(rects, RECT_WORDS, [0, 7, 8]),
    glyphs: toWords(glyphs, GLYPH_WORDS, [0, 3, 4]),
    greeks: toWords(greeks, RECT_WORDS, [0, 7, 8]),
    glyphIds: [...ids],
  }
}

/** How much of its colour a run's bar keeps: a line of small type reads as
 * a grey of its colour, not as a solid stroke. */
const GREEK_ALPHA = 0.4

/**
 * The bar a run of text is drawn as where its type is too small to read —
 * over the run's ink, its spaces at either end left out, as tall as a
 * lowercase letter about the middle of one. Null for a run of spaces.
 */
export function greekBar(
  text: string,
  x: number,
  baseline: number,
  width: number,
  size: number,
): Readonly<{ x: number; y: number; w: number; h: number }> | null {
  const lead = text.length - text.trimStart().length
  const tail = text.length - text.trimEnd().length
  if (lead === text.length) return null
  // Spaces are a third of an em, near enough at this size.
  const left = x + lead * size * 0.3
  const w = width - (lead + tail) * size * 0.3
  if (w <= 0) return null
  const h = size * 0.5
  return { x: left, y: baseline - size * 0.62, w, h }
}

function faded(color: number): number {
  const alpha = Math.round(((color >>> 24) & 255) * GREEK_ALPHA)
  return ((color & 0xffffff) | (alpha << 24)) >>> 0
}

/** Instances as words: the fields at `integers` as they are, the rest as
 * the bits of a float. */
function toWords(
  values: readonly number[],
  stride: number,
  integers: readonly number[],
): Uint32Array {
  const words = new Uint32Array(values.length)
  const floats = new Float32Array(words.buffer)
  for (let i = 0; i < values.length; i++) {
    if (integers.includes(i % stride)) words[i] = values[i]
    else floats[i] = values[i]
  }
  return words
}
