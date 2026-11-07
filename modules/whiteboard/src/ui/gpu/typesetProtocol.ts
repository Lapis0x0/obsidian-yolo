// What the board (./gpuBoard.ts) and its typesetting worker
// (./typesetWorker.ts) say to each other, through the host's worker calls:
// `{ id, method, payload }` in, `{ id, result }` or `{ id, error }` out.

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
}>

/** `typeset`: cards to lay out in `tokens`' look. */
export type TypesetPayload = Readonly<{
  tokens: TypesetTokens
  cards: readonly TypesetCard[]
}>

/**
 * A card's content as ./instances.ts's instances, except that a glyph's
 * id word is an index into the result's `keys` — the worker has no atlas;
 * the board turns each key into the atlas's id.
 */
export type TypesetResultCard = Readonly<{
  id: string
  rects: ArrayBuffer
  glyphs: ArrayBuffer
}>

export type TypesetResult = Readonly<{
  cards: readonly TypesetResultCard[]
  /** A glyph's key: `font + '\0' + text`, or an icon's: `'\u0001' + name
   * + '\0' + size` (`glyphKey`, `iconKey`). */
  keys: readonly string[]
}>

export const glyphKey = (text: string, font: string): string =>
  `${font}\u0000${text}`

export const iconKey = (name: string, size: number): string =>
  `\u0001${name}\u0000${size}`

/** A key as what it names. */
export function parseKey(
  key: string,
):
  | Readonly<{ kind: 'glyph'; font: string; text: string }>
  | Readonly<{ kind: 'icon'; name: 'check'; size: number }> {
  const split = key.indexOf('\u0000')
  if (key.startsWith('\u0001')) {
    return { kind: 'icon', name: 'check', size: Number(key.slice(split + 1)) }
  }
  return {
    kind: 'glyph',
    font: key.slice(0, split),
    text: key.slice(split + 1),
  }
}
