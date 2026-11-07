// A run of text as the GPU scene (./scene.ts) draws it: one glyph at a time,
// each from the atlas (./atlas.ts), placed where the run's own shaping would
// put it.
//
// A canvas sets a run with the font's kerning, which the sum of its glyphs'
// own advances does not have; the run's measured width does. So the glyphs
// are spread to that width — the difference shared out evenly between them —
// and a run ends exactly where the typesetter (../../typeset/) measured it
// to, whatever the kerning did inside it.

/** A glyph of a run: what it is and where its origin is, from the run's. */
export type PlacedGlyph = Readonly<{ text: string; x: number }>

// Not in the TypeScript lib the project targets; in every Obsidian runtime.
type Segmenter = Readonly<{
  segment: (text: string) => Iterable<Readonly<{ segment: string }>>
}>
const SegmenterClass = (
  Intl as unknown as {
    Segmenter?: new (
      locale: undefined,
      options: Readonly<{ granularity: 'grapheme' }>,
    ) => Segmenter
  }
).Segmenter
const segmenter = SegmenterClass
  ? new SegmenterClass(undefined, { granularity: 'grapheme' })
  : null

/** Text whose every character is a grapheme of its own: Latin, general
 * punctuation and CJK, without a joiner, a combining mark or a kana sound
 * mark among them — most of what a card holds, split without segmenting. */
const SIMPLE =
  /^[\u0020-\u02ff\u2010-\u2027\u2030-\u205e\u3000-\u3098\u309b-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uff01-\uff9d]*$/

/** The graphemes of `text`: what a reader takes for one character each. */
export function graphemes(text: string): string[] {
  if (SIMPLE.test(text)) return text.split('')
  if (!segmenter) return Array.from(text)
  const out: string[] = []
  for (const { segment } of segmenter.segment(text)) out.push(segment)
  return out
}

const BLANK = /^\s+$/u

/**
 * The glyphs of a run `width` wide, each with its own `advance`. Blanks take
 * their room and are not drawn.
 */
export function placeRun(
  text: string,
  width: number,
  advance: (glyph: string) => number,
): PlacedGlyph[] {
  const parts = graphemes(text)
  if (parts.length === 0) return []
  const advances = parts.map(advance)
  const natural = advances.reduce((sum, a) => sum + a, 0)
  // Shared between the gaps, so the first glyph stays at the run's start and
  // the last ends at its end.
  const gaps = parts.length - 1
  const extra = gaps > 0 ? (width - natural) / gaps : 0
  const out: PlacedGlyph[] = []
  let x = 0
  for (let i = 0; i < parts.length; i++) {
    if (!BLANK.test(parts[i])) out.push({ text: parts[i], x })
    x += advances[i] + extra
  }
  return out
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

/** Whether a glyph is drawn in its own colours (an emoji) rather than in the
 * run's. */
export function isColorGlyph(glyph: string): boolean {
  return PICTOGRAPHIC.test(glyph)
}

/** A font string's size, in its own units (../../typeset/layout.ts's
 * `fontString`). */
export function fontSize(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font)
  return match ? Number(match[1]) : 16
}

/** `font` at `size` px instead. */
export function resizeFont(font: string, size: number): string {
  return font.replace(/\d+(?:\.\d+)?px/, `${size}px`)
}
