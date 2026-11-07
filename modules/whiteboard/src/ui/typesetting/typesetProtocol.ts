// What the board (./typesetClient.ts) and its typesetting worker
// (./typesetWorker.ts) say to each other, through the host's worker calls:
// `{ id, method, payload }` in, `{ id, result }` or `{ id, error }` out.

import type { MathLayout, MathSource } from '../../typeset/math'
import type { TypesetTokens } from '../../typeset/tokens'

/** The worker's name in the module's package.json `yoloModule.workers`. */
export const TYPESET_WORKER = 'typeset'

/** An `@font-face` of the document, for the worker to load: its own
 * `FontFaceSet` starts empty, and a theme's web fonts are only the
 * document's. */
export type FontSource = Readonly<{
  family: string
  /** The rule's `src`, its URLs made absolute. */
  src: string
  descriptors: Readonly<{
    style?: string
    weight?: string
    stretch?: string
    unicodeRange?: string
  }>
}>

/** `fonts`: the faces to load before anything is typeset again. */
export type FontsPayload = Readonly<{ faces: readonly FontSource[] }>

export type TypesetCard = Readonly<{
  id: string
  markdown: string
  w: number
  h: number
  /** Bare text (fileFormat.ts's `isPlainText`). */
  plain: boolean
  /** A bare text's colour, as a colour the canvas paints with. */
  color: string | null
  /** The own size of each image it embeds, by what the source names it;
   * one left out is not known (../../domain/imageSize.ts). */
  images?: Readonly<Record<string, Readonly<{ w: number; h: number }>>>
  /** Its formulas as the host's math engine laid them out, by
   * ../../typeset/math.ts's `mathKey`: null for one it could not, left out
   * for one not asked for yet. */
  math?: Readonly<Record<string, MathLayout | null>>
}>

/** An image as a card lays it out: where, and which. */
export type PlacedImage = Readonly<{
  target: string
  x: number
  y: number
  w: number
  h: number
  /** Its corners' radius. */
  radius: number
}>

/** `typeset`: cards to lay out in `tokens`' look. */
export type TypesetPayload = Readonly<{
  tokens: TypesetTokens
  cards: readonly TypesetCard[]
}>

/** `picture`: one card's picture, an ImageBitmap. */
export type PicturePayload = Readonly<{
  tokens: TypesetTokens
  card: TypesetCard
  /** Device pixels per world unit. */
  scale: number
  /** How far above its bottom edge it fades out; 0 for not at all. */
  fade: number
  /** The images it draws, decoded at about the size they show at, by what
   * the source names each. */
  images: Readonly<Record<string, ImageBitmap>>
}>

/**
 * A card's content as ../gpu/instances.ts's instances, except that a glyph's
 * id word is an index into the result's `keys` — the worker has no atlas;
 * the board turns each key into the atlas's id.
 */
export type TypesetResultCard = Readonly<{
  id: string
  rects: ArrayBuffer
  glyphs: ArrayBuffer
  /** Its runs' bars, as rectangles (../gpu/instances.ts's `greeks`). */
  greeks: ArrayBuffer
  /** It holds what only the host's renderer shows as it should
   * (../typesetting/typesetter.ts's `needsHost`), or a formula not laid
   * out: kept in the DOM near to. */
  host: boolean
  /** Formulas it holds that were not asked for: once they are laid out,
   * it is typeset again with them (../gpu/gpuBoard.ts). */
  math?: readonly MathSource[]
  /** Its images, where they are in it. */
  images: readonly PlacedImage[]
  /** Its text as drawn, run after run in reading order — what a passage
   * in it is found in (../gpu/passages.ts). */
  shown: string
  /** Per run, RUN_FIELDS floats: where its text is in `shown` (start,
   * end), its box in the card (left, top, right, bottom), its baseline,
   * and its font, as an index into `fonts`. */
  runs: ArrayBuffer
  /** The fonts its runs are set in, each once. */
  fonts: readonly string[]
}>

export const RUN_FIELDS = 8

export type TypesetResult = Readonly<{
  cards: readonly TypesetResultCard[]
  /** A glyph's key: `font + '\0' + text`, an icon's: `'\u0001' + name
   * + '\0' + size`, or an outline's: `'\u0002' + its linear transform
   * + '\0' + its path` (`glyphKey`, `iconKey`, `pathKey`). */
  keys: readonly string[]
}>

export const glyphKey = (text: string, font: string): string =>
  `${font}\u0000${text}`

export const iconKey = (name: string, size: number): string =>
  `\u0001${name}\u0000${size}`

/** The linear part of an outline's transform, from its path's units to
 * world units: `[a, b, c, d]` of SVG's `matrix(a b c d e f)`. */
export type PathTransform = readonly [number, number, number, number]

/** An outline (a formula's glyph) drawn with `transform`: rounded, so that
 * the same glyph at the same size is one key. */
export const pathKey = (path: string, transform: PathTransform): string =>
  `\u0002${transform.map((n) => Math.round(n * 1e6) / 1e6).join(',')}\u0000${path}`

/** A key as what it names. */
export function parseKey(
  key: string,
):
  | Readonly<{ kind: 'glyph'; font: string; text: string }>
  | Readonly<{ kind: 'icon'; name: 'check'; size: number }>
  | Readonly<{ kind: 'path'; path: string; transform: PathTransform }> {
  const split = key.indexOf('\u0000')
  if (key.startsWith('\u0001')) {
    return { kind: 'icon', name: 'check', size: Number(key.slice(split + 1)) }
  }
  if (key.startsWith('\u0002')) {
    const [a, b, c, d] = key.slice(1, split).split(',').map(Number)
    return { kind: 'path', path: key.slice(split + 1), transform: [a, b, c, d] }
  }
  return {
    kind: 'glyph',
    font: key.slice(0, split),
    text: key.slice(split + 1),
  }
}
