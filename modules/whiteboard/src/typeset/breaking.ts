// Lines out of a paragraph's runs (./model.ts's Inline), the way a browser
// breaks a card's text: where the Unicode line breaking algorithm (UAX #14,
// which the browser's ICU follows) allows a break, and inside a word only
// when the word alone is wider than the line (`overflow-wrap: break-word`).
//
// Widths come from `measure`, so the same breaker runs against a canvas, in
// a Worker, or in a test against made-up widths.

import LineBreaker from 'linebreak'

import type { MathLayout, MathSource } from './math'
import { CODE, HIGHLIGHT, type Inline, type InlineImage, TAG } from './model'

export type Measure = (text: string, font: string) => number

/** An image's size in a line at most `maxWidth` wide; null for one whose
 * size is not known, which is left out. */
export type ImageSize = (
  image: InlineImage,
  maxWidth: number,
) => Readonly<{ w: number; h: number }> | null

/** What a line holds that is not text: images, by their size, and
 * formulas, as MathJax lays them out; one with no size or layout is left
 * out. */
export type InlineObjects = Readonly<{
  imageSize?: ImageSize
  math?: (formula: MathSource) => MathLayout | null
}>

/** How a run is set: its font, and the room a pill (inline code, a tag)
 * takes on either side of its text. */
export type RunStyle = Readonly<{
  font: string
  padX: number
  /** How wide an external link's icon is (./model.ts's `linkIcon`). */
  linkIcon: number
}>

export type Piece = Readonly<{
  text: string
  flags: number
  font: string
  /** From the line's start to the piece's left edge (its pill's, where it
   * has one). */
  x: number
  /** Its whole width, pill padding included. */
  width: number
  padLeft: number
  /** An external link's icon: room, drawn as nothing. */
  icon?: true
  /** An image's: what it is, and how tall it stands on the baseline. */
  image?: InlineImage
  height?: number
  /** A formula's piece: which formula, and which of its pieces. */
  math?: Readonly<{ formula: MathSource; piece: number }>
  /** How far it reaches below the baseline: a formula's piece's. */
  depth?: number
}>

export type Line = Readonly<{ pieces: readonly Piece[]; width: number }>

/** Full-width marks whose ink sits in one half of their em, the other half
 * blank: closing ones on the left, opening ones on the right. */
const HALF_CLOSING = new Set(Array.from('，。、；：）」』】》〉〕〗｝'))
const HALF_OPENING = new Set(Array.from('（「『【《〈〔〖｛'))
/** The closing ones that are brackets (Unicode's Pe), not stops. */
const CLOSING_BRACKETS = new Set(Array.from('）」』】》〉〕〗｝'))
/** Marks that are not full-width but take a full-width one's blank half
 * from it: after a closing mark, closing quotes and middle dots; before an
 * opening one, opening quotes and middle dots (measured in Chrome). */
const AFTER_CLOSING = new Set(Array.from('”’·・'))
const BEFORE_OPENING = new Set(Array.from('“‘·・'))
/** Marks the breaker keeps as atoms of their own, as it does CJK. */
const QUOTES_AND_DOTS = new Set(Array.from('“”‘’·・'))

/**
 * Which of two marks side by side gives up its blank half — the browser's
 * `text-spacing-trim: normal`, which sets "，「" or "」。" in an em and a
 * half rather than two: a closing mark before another mark, or an opening
 * one after an opening mark, a quote or a middle dot (measured in Chrome).
 * Where the room goes is the same either way; which mark gives it is what
 * says how much.
 */
function trimBetween(mark: string, next: string): 'first' | 'second' | null {
  if (HALF_CLOSING.has(mark)) {
    return HALF_CLOSING.has(next) ||
      HALF_OPENING.has(next) ||
      AFTER_CLOSING.has(next)
      ? 'first'
      : null
  }
  if (!HALF_OPENING.has(next)) return null
  return HALF_OPENING.has(mark) || BEFORE_OPENING.has(mark) ? 'second' : null
}

/**
 * Where Chrome lets a line break between two printable ASCII characters:
 * after the first, before any of the second (measured in Chrome, every
 * pair). It uses a table of its own for these rather than the Unicode
 * algorithm; a pair not here does not break.
 */
const ASCII_BREAKS: ReadonlyArray<readonly [string, string]> = [
  ['!"#%&)*+,.:;=>\\]|}~', '(<[{'],
  [
    '-',
    `"#%&'(*+-<=>@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\^_\`abcdefghijklmnopqrstuvwxyz{|~`,
  ],
  [
    '?',
    '#$%&(*+-0123456789<=>@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\^_`abcdefghijklmnopqrstuvwxyz{|~',
  ],
]
const ASCII_BREAK_TABLE: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  ASCII_BREAKS.flatMap(([firsts, seconds]) =>
    Array.from(firsts, (first) => [first, new Set(seconds)] as const),
  ),
)

const isPrintableAscii = (ch: string): boolean => ch > ' ' && ch <= '~'
const isAsciiAlnum = (ch: string | undefined): boolean =>
  ch !== undefined && /^[0-9A-Za-z]$/.test(ch)
const isEastAsian = (ch: string | undefined): boolean =>
  ch !== undefined && isCjk(ch.codePointAt(0) ?? 0)
const FULL_WIDTH_OPENING = new Set(Array.from('（「『【《〈〔〖｛［'))
/** Unicode's conditional Japanese starters (CJ): small kana and the
 * prolonged sound mark. */
const CONDITIONAL_STARTERS =
  /[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰ-ㇿーｧ-ｯｰ]/g

/**
 * Where a line may break in `text`, as Chrome breaks it: before each
 * position in the set. The Unicode algorithm's answer (UAX #14, the version
 * the linebreak package implements), with what Chrome does otherwise —
 * measured against it over real notes:
 * - after a run of spaces, always;
 * - between two printable ASCII characters, by its own table
 *   (`ASCII_BREAKS`), and after a hyphen before a digit only where the
 *   hyphen follows a letter or digit — "2026-07", not "-1";
 * - curly double quotes break as the brackets they are in Chinese text:
 *   the opening one as an opening bracket, the closing one as a closing
 *   bracket (single ones break as quotes, an apostrophe among them);
 * - small kana and the prolonged sound mark break as any other kana do
 *   (`line-break: normal`);
 * - and before a full-width opening bracket after anything not East Asian,
 *   as Unicode 15.1 has it.
 */
export function breakOpportunities(text: string): Set<number> {
  const out = new Set<number>()
  const breaker = new LineBreaker(
    text
      .replace(/“/g, '（')
      .replace(/”/g, '）')
      .replace(CONDITIONAL_STARTERS, '字'),
  )
  for (let next = breaker.nextBreak(); next; next = breaker.nextBreak()) {
    out.add(next.position)
  }
  for (let i = 1; i < text.length; i += 1) {
    const before = text[i - 1]
    const after = text[i]
    let allow: boolean | null = null
    if (isSpace(before)) {
      allow = !isSpace(after)
    } else if (isPrintableAscii(before) && isPrintableAscii(after)) {
      allow =
        before === '-' && after >= '0' && after <= '9'
          ? isAsciiAlnum(text[i - 2])
          : (ASCII_BREAK_TABLE.get(before)?.has(after) ?? false)
    } else if (
      FULL_WIDTH_OPENING.has(after) &&
      !isEastAsian(before) &&
      !'"“‘([{'.includes(before)
    ) {
      allow = true
    }
    if (allow === true) out.add(i)
    else if (allow === false) out.delete(i)
  }
  return out
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3134f)
  )
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t'

/** A CJK letter — not a mark — which no font kerns against another. */
const CJK_LETTER = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]$/u

type AtomKind = 'space' | 'cjk' | 'word' | 'image'

type Atom = {
  text: string
  kind: AtomKind
  run: number
  width: number
  /** Whether the line may break before this atom. */
  breakBefore: boolean
  /** The room its pill takes before it: only the first atom of a run has
   * any. */
  padLeft: number
  /** A mark that gave up its blank half (`trimsBefore`): what follows it is
   * set closer than the mark's own advance, so it ends its piece. */
  trimmed: boolean
  height?: number
  depth?: number
  /** Which of its formula's pieces it is. */
  mathPiece?: number
}

/** A run's text in atoms — spaces, single CJK characters and marks, and
 * words cut wherever a line may break (`breaks`, positions from `offset`) —
 * each knowing whether a line may break before it. */
function atomize(
  text: string,
  offset: number,
  breaks: ReadonlySet<number>,
): { text: string; kind: AtomKind; breakBefore: boolean }[] {
  const out: { text: string; kind: AtomKind; breakBefore: boolean }[] = []
  let word = ''
  let wordAt = 0
  let space = ''
  const flushWord = () => {
    if (word !== '') {
      out.push({ text: word, kind: 'word', breakBefore: breaks.has(wordAt) })
    }
    word = ''
  }
  const flushSpace = () => {
    if (space !== '')
      out.push({ text: space, kind: 'space', breakBefore: true })
    space = ''
  }
  let at = offset
  for (const ch of text) {
    const here = at
    at += ch.length
    if (isSpace(ch)) {
      flushWord()
      space += ch
      continue
    }
    flushSpace()
    if (isCjk(ch.codePointAt(0) ?? 0) || QUOTES_AND_DOTS.has(ch)) {
      flushWord()
      out.push({ text: ch, kind: 'cjk', breakBefore: breaks.has(here) })
      continue
    }
    if (word !== '' && breaks.has(here)) flushWord()
    if (word === '') wordAt = here
    word += ch
  }
  flushWord()
  flushSpace()
  return out
}

/**
 * Atoms as `white-space: break-spaces` breaks them (a table cell's): a line
 * breaks after a space, never before one, so a space keeps to the word it
 * follows and takes its room at the end of a line rather than hanging; and
 * spaces are not run together, each one a place to break after.
 */
function spacesKept(
  atoms: readonly { text: string; kind: AtomKind; breakBefore: boolean }[],
): { text: string; kind: AtomKind; breakBefore: boolean }[] {
  const out: { text: string; kind: AtomKind; breakBefore: boolean }[] = []
  for (const atom of atoms) {
    if (atom.kind !== 'space') {
      out.push(atom)
      continue
    }
    Array.from(atom.text).forEach((ch, i) => {
      out.push({ text: ch, kind: 'space', breakBefore: i > 0 })
    })
  }
  return out
}

/** The paragraph's atoms in order, each knowing whether a line may break
 * before it; null for a hard break. */
function atomsOf(
  inlines: readonly Inline[],
  maxWidth: number,
  styleOf: (flags: number) => RunStyle,
  measure: Measure,
  objects: InlineObjects = {},
  keepSpaces = false,
): (Atom | null)[] {
  // Where a line may break, over the paragraph's text as a whole: a break
  // depends on what is either side of it, whichever run each is in.
  const offsets: number[] = []
  let text = ''
  for (const inline of inlines) {
    offsets.push(text.length)
    text += inline.text
  }
  const breaks = breakOpportunities(text)
  // Atoms, run by run, each knowing whether a line may break before it.
  const atoms: (Atom | null)[] = [] // null: a hard break
  let previous: Atom | null = null
  inlines.forEach((inline, run) => {
    if (inline.text === '\n') {
      atoms.push(null)
      previous = null
      return
    }
    if (inline.linkIcon) {
      const width = styleOf(inline.flags).linkIcon
      if (width <= 0) return
      const atom: Atom = {
        text: inline.text,
        kind: 'image',
        run,
        width,
        height: 0,
        breakBefore: true,
        padLeft: 0,
        trimmed: false,
      }
      atoms.push(atom)
      previous = atom
      return
    }
    if (inline.math) {
      const layout = objects.math?.(inline.math)
      if (!layout) return
      const em = fontPx(styleOf(inline.flags).font)
      const last = layout.pieces.length - 1
      layout.pieces.forEach((piece, k) => {
        const atom: Atom = {
          text: inline.text,
          kind: 'image',
          run,
          width: piece.width * em,
          height: piece.height * em,
          depth: piece.depth * em,
          mathPiece: k,
          // Between its pieces a line may break, where MathJax would.
          breakBefore: k > 0 || previous === null || breaks.has(offsets[run]),
          padLeft: 0,
          trimmed: false,
        }
        atoms.push(atom)
        previous = atom
        if (k === last) return
        if (piece.after === 'newline') {
          atoms.push(null)
          previous = null
        } else if (piece.after > 0) {
          atoms.push({
            text: ' ',
            kind: 'space',
            run,
            width: piece.after * em,
            breakBefore: true,
            padLeft: 0,
            trimmed: false,
          })
        }
      })
      return
    }
    if (inline.image) {
      const size = objects.imageSize?.(inline.image, maxWidth)
      if (!size) return
      const atom: Atom = {
        text: inline.text,
        kind: 'image',
        run,
        width: size.w,
        height: size.h,
        breakBefore: true,
        padLeft: 0,
        trimmed: false,
      }
      atoms.push(atom)
      previous = atom
      return
    }
    const style = styleOf(inline.flags)
    // A pill (code, a tag) is padded at both ends; a highlight at the ends
    // of all of it, which may run over several runs (`==a **b** c==`).
    const pill = (inline.flags & (CODE | TAG)) !== 0
    const marked = !pill && (inline.flags & HIGHLIGHT) !== 0
    const startPad =
      pill || (marked && !((inlines[run - 1]?.flags ?? 0) & HIGHLIGHT))
        ? style.padX
        : 0
    const endPad =
      pill || (marked && !((inlines[run + 1]?.flags ?? 0) & HIGHLIGHT))
        ? style.padX
        : 0
    const atomized = atomize(inline.text, offsets[run], breaks)
    const parts = keepSpaces ? spacesKept(atomized) : atomized
    parts.forEach((part, i) => {
      // What it adds after the atom before it in the same run, so that the
      // kerning between them is counted, as the browser sets the run whole —
      // but not across a pair of marks that give up room (`trimBetween`):
      // the canvas trims those itself, and the trim is taken below, from
      // the mark that gives it. Nor between two CJK letters, which are not
      // kerned: each takes its own width, one every other card's same
      // character reuses, rather than a pair measured once and thrown away
      // (marks and quotes are, and keep the pair).
      const lead = i > 0 ? parts[i - 1] : null
      const pair =
        lead !== null &&
        lead.kind === 'cjk' &&
        part.kind === 'cjk' &&
        (trimBetween(lead.text, part.text) !== null ||
          (CJK_LETTER.test(lead.text) && CJK_LETTER.test(part.text)))
      let width =
        lead === null || pair
          ? measure(part.text, style.font)
          : measure(lead.text + part.text, style.font) -
            measure(lead.text, style.font)
      if (i === 0) width += startPad
      if (i === parts.length - 1) width += endPad
      const atom: Atom = {
        ...part,
        run,
        width,
        breakBefore: previous === null || part.breakBefore,
        padLeft: i === 0 ? startPad : 0,
        trimmed: false,
      }
      const before: Atom | null = previous
      const trim =
        before !== null &&
        before.kind === 'cjk' &&
        part.kind === 'cjk' &&
        before.padLeft === 0
          ? trimBetween(before.text, part.text)
          : null
      if (before !== null && trim !== null) {
        // Half the full-width mark's em, taken from the room between them.
        before.width -= (trim === 'first' ? before.width : width) / 2
        before.trimmed = true
      }
      atoms.push(atom)
      previous = atom
    })
  })
  return atoms
}

/**
 * How wide a paragraph is laid out with no room to spare (`min`: its
 * widest piece no line can break inside) and with all the room it wants
 * (`max`: its longest line) — what a table's columns are sized by.
 */
export function contentWidths(
  inlines: readonly Inline[],
  styleOf: (flags: number) => RunStyle,
  measure: Measure,
  objects: InlineObjects = {},
  keepSpaces = false,
): Readonly<{ min: number; max: number }> {
  const atoms = atomsOf(
    inlines,
    Infinity,
    styleOf,
    measure,
    objects,
    keepSpaces,
  )
  // A pill or a highlight broken in two is padded at both ends of each
  // piece (`box-decoration-break: clone`), as `breakLines` sets them.
  const boxOf = (run: number): string | null => {
    const flags = inlines[run].flags
    if (flags & (CODE | TAG)) return `pill:${run}`
    return flags & HIGHLIGHT ? 'mark' : null
  }
  const continues = (a: Atom | null, b: Atom): boolean =>
    a !== null && boxOf(a.run) !== null && boxOf(a.run) === boxOf(b.run)
  const padOf = (atom: Atom): number => styleOf(inlines[atom.run].flags).padX
  let min = 0
  let chunk = 0
  let trailing = 0
  let previous: Atom | null = null
  for (const atom of atoms) {
    if (atom === null || atom.breakBefore) {
      const broken =
        atom !== null && previous !== null && continues(previous, atom)
      min = Math.max(min, chunk + (broken && previous ? padOf(previous) : 0))
      chunk = broken ? padOf(atom) : 0
      trailing = 0
    }
    previous = atom
    if (atom === null) continue
    if (atom.kind === 'space' && !keepSpaces) {
      trailing += atom.width
      continue
    }
    chunk += trailing + atom.width
    trailing = 0
  }
  min = Math.max(min, chunk)
  const lines = breakLines(
    inlines,
    Infinity,
    styleOf,
    measure,
    objects,
    keepSpaces,
  )
  const max = Math.max(0, ...lines.map((line) => line.width))
  return { min, max: Math.max(min, max) }
}

type Placed = { atom: Atom; x: number }

/** The browser's layout unit, in px: where one run of a line ends — an
 * element's text — the next starts at the unit at or after it; and a line
 * fits if what it holds, to the unit below, does (measured in Chrome). */
const UNIT = 1 / 64
const unitUp = (x: number): number => Math.ceil(x / UNIT - 1e-6) * UNIT
const unitDown = (x: number): number => Math.floor(x / UNIT + 1e-6) * UNIT

export function breakLines(
  inlines: readonly Inline[],
  maxWidth: number,
  styleOf: (flags: number) => RunStyle,
  measure: Measure,
  objects: InlineObjects = {},
  /** `white-space: break-spaces` (`spacesKept`): spaces end a line in it. */
  keepSpaces = false,
): Line[] {
  const atoms = atomsOf(
    inlines,
    maxWidth,
    styleOf,
    measure,
    objects,
    keepSpaces,
  )

  // A pill (code, a tag) or a highlight broken over two lines is padded at
  // both ends of each (`box-decoration-break: clone`): the line it leaves
  // ends in its padding, and the line it goes on to starts with it.
  const boxOf = (run: number): string | null => {
    const flags = inlines[run].flags
    if (flags & (CODE | TAG)) return `pill:${run}`
    return flags & HIGHLIGHT ? 'mark' : null
  }
  const padOf = (atom: Atom): number => styleOf(inlines[atom.run].flags).padX
  const continues = (a: Atom | null, b: Atom | null | undefined): boolean =>
    a !== null &&
    b != null &&
    boxOf(a.run) !== null &&
    boxOf(a.run) === boxOf(b.run)

  const lines: Placed[][] = []
  let line: Placed[] = []
  /** Width of the line up to its last non-space atom. */
  let filled = 0
  /** Width of the spaces after it, which a break drops. */
  let trailing = 0
  /** The atom placed last, on this line or the one before. */
  let lastPlaced: Atom | null = null
  const finish = (next?: Atom | null) => {
    while (
      !keepSpaces &&
      line.length > 0 &&
      line[line.length - 1].atom.kind === 'space'
    ) {
      line.pop()
    }
    const end = line[line.length - 1]
    if (end && continues(end.atom, next)) {
      end.atom = { ...end.atom, width: end.atom.width + padOf(end.atom) }
    }
    lines.push(line)
    line = []
    filled = 0
    trailing = 0
  }
  /** Where an atom goes on the line: past the spaces after the last, and
   * at the unit up from there where it starts a run of its own. */
  const startOf = (atom: Atom): number => {
    const end = filled + trailing
    const last = line[line.length - 1]
    return last && last.atom.run !== atom.run ? unitUp(end) : end
  }
  const place = (given: Atom) => {
    let atom = given
    const start = startOf(given)
    trailing = start - filled
    if (line.length === 0 && continues(lastPlaced, atom)) {
      const pad = padOf(atom)
      atom = { ...atom, padLeft: atom.padLeft + pad, width: atom.width + pad }
    }
    lastPlaced = given
    line.push({ atom, x: filled + trailing })
    if (atom.kind === 'space') {
      trailing += atom.width
    } else {
      filled += trailing + atom.width
      trailing = 0
    }
  }

  // Unbreakable chunks: a chunk starts wherever a break is allowed.
  let i = 0
  while (i < atoms.length) {
    const first = atoms[i]
    if (first === null) {
      finish()
      lastPlaced = null
      i += 1
      continue
    }
    let j = i + 1
    while (j < atoms.length && atoms[j] !== null && !atoms[j]?.breakBefore) {
      j += 1
    }
    const chunk = atoms.slice(i, j) as Atom[]
    i = j
    if (!keepSpaces && chunk.length === 1 && chunk[0].kind === 'space') {
      if (line.length > 0) place(chunk[0])
      continue
    }
    const width = chunk.reduce((sum, atom) => sum + atom.width, 0)
    // A full-width closing bracket at the end of a line may give up its
    // blank half to fit there (`text-spacing-trim: normal`, its
    // `allow-end`) — a bracket only, not a full stop or a comma (measured
    // in Chrome), and only one the line would end at: one a space follows
    // keeps its em, the space hanging after it. It is only fitted so: drawn,
    // it keeps its em.
    const last = chunk[chunk.length - 1]
    const after = atoms[i]
    const endTrim =
      last.kind === 'cjk' &&
      !last.trimmed &&
      CLOSING_BRACKETS.has(last.text) &&
      after?.kind !== 'space'
        ? last.width / 2
        : 0
    // Broken after it, a box it is in pads its end on this line.
    const endPad = continues(last, after) ? padOf(last) : 0
    const fits = (from: number) =>
      unitDown(from + width + endPad - endTrim) <= maxWidth + 1e-6
    if (line.length > 0 && !fits(startOf(chunk[0]))) finish(chunk[0])
    if (fits(filled) || line.length > 0) {
      for (const atom of chunk) place(atom)
      continue
    }
    // Wider than a line on its own: cut wherever it stops fitting.
    for (const atom of chunk) {
      if (unitDown(startOf(atom) + atom.width) <= maxWidth + 1e-6) {
        place(atom)
        continue
      }
      let rest = atom.text
      let restWidth = atom.width
      while (rest !== '') {
        const room = maxWidth - filled - trailing
        const fit = longestFit(
          rest,
          room,
          styleOf(inlines[atom.run].flags).font,
          measure,
        )
        if (fit === 0 && line.length > 0) {
          finish(atom)
          continue
        }
        const take = Math.max(fit, 1)
        const chars = Array.from(rest)
        const head = chars.slice(0, take).join('')
        rest = chars.slice(take).join('')
        const headWidth =
          rest === ''
            ? restWidth
            : measure(head, styleOf(inlines[atom.run].flags).font)
        restWidth -= headWidth
        place({ ...atom, text: head, width: headWidth })
        atom.padLeft = 0
        if (rest !== '') finish(atom)
      }
    }
  }
  if (line.length > 0 || lines.length === 0) finish()

  return lines.map((placed) => ({
    pieces: piecesOf(placed, inlines, styleOf),
    width: placed.reduce((end, p) => Math.max(end, p.x + p.atom.width), 0),
  }))
}

/** How many leading characters of `text` fit in `room`. */
function longestFit(
  text: string,
  room: number,
  font: string,
  measure: Measure,
): number {
  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure(chars.slice(0, mid).join(''), font) <= room) low = mid
    else high = mid - 1
  }
  return low
}

/** A line's atoms joined back into one piece per run. */
function piecesOf(
  placed: readonly Placed[],
  inlines: readonly Inline[],
  styleOf: (flags: number) => RunStyle,
): Piece[] {
  const out: Piece[] = []
  let current: {
    run: number
    text: string
    x: number
    end: number
    padLeft: number
    height?: number
  } | null = null
  const flush = () => {
    if (!current) return
    const inline = inlines[current.run]
    out.push({
      text: current.text,
      flags: inline.flags,
      font: styleOf(inline.flags).font,
      x: current.x,
      width: current.end - current.x,
      padLeft: current.padLeft,
      ...(inline.image ? { image: inline.image, height: current.height } : {}),
      ...(inline.linkIcon ? { icon: true as const } : {}),
    })
    current = null
  }
  let closed = false
  for (const { atom, x } of placed) {
    const formula = inlines[atom.run].math
    if (formula) {
      // A formula's pieces each stand alone; the room between them is
      // only room.
      flush()
      closed = true
      if (atom.mathPiece === undefined) continue
      out.push({
        text: atom.text,
        flags: inlines[atom.run].flags,
        font: styleOf(inlines[atom.run].flags).font,
        x,
        width: atom.width,
        padLeft: 0,
        height: atom.height,
        depth: atom.depth,
        math: { formula, piece: atom.mathPiece },
      })
      continue
    }
    if (current && current.run === atom.run && !closed) {
      current.text += atom.text
      current.end = x + atom.width
      closed = atom.trimmed
      continue
    }
    closed = atom.trimmed
    flush()
    current = {
      run: atom.run,
      text: atom.text,
      x,
      end: x + atom.width,
      padLeft: atom.padLeft,
      height: atom.height,
    }
  }
  flush()
  return out
}

/** A font string's size in px (./layout.ts's `fontString`). */
function fontPx(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font)
  return match ? Number(match[1]) : 16
}
