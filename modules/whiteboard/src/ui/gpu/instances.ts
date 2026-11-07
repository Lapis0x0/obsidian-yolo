// A card's content — what the typesetter (../../typeset/layout.ts) laid out
// — as the GPU scene's (./scene.ts) instances: rectangles and glyphs, in the
// card's own coordinates, ready to be copied into a chunk's buffer.
//
// Every instance is a fixed number of 32-bit words, its first the slot of
// the card it belongs to — written when a chunk takes it in, since a card's
// slot is the scene's to give (`setCardSlot`). Coordinates are floats,
// colours RGBA8 packed into one word (`packColor`), glyphs the atlas's ids.

import type { DrawOp } from '../../typeset/layout'

import { placeRun } from './glyphs'

/** A rectangle: [slot, x, y, w, h, radius, border width, fill, border]. */
export const RECT_WORDS = 9
/** A glyph: [slot, origin x, baseline y, glyph id, colour]. */
export const GLYPH_WORDS = 5

export type CardInstances = Readonly<{
  /** RECT_WORDS words each. */
  rects: Uint32Array
  /** GLYPH_WORDS words each. */
  glyphs: Uint32Array
  /** Each glyph id the card uses, once. */
  glyphIds: readonly number[]
}>

export type InstanceDeps = Readonly<{
  /** The atlas's id for a glyph of `font`. */
  glyphId: (text: string, font: string) => number
  /** The atlas's id for an icon `size` world units across. */
  iconId: (name: 'check', size: number) => number
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
    }
  }
  return {
    rects: toWords(rects, RECT_WORDS, [0, 7, 8]),
    glyphs: toWords(glyphs, GLYPH_WORDS, [0, 3, 4]),
    glyphIds: [...ids],
  }
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
