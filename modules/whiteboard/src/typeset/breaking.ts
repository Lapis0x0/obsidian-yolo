// Lines out of a paragraph's runs (./model.ts's Inline), the way a browser
// breaks a card's text: at spaces, around CJK characters, never before a
// closing mark or after an opening one (the CJK rule a browser follows under
// `line-break: auto`), and inside a word only when the word alone is wider
// than the line (`overflow-wrap: break-word`).
//
// Widths come from `measure`, so the same breaker runs against a canvas, in
// a Worker, or in a test against made-up widths.

import { CODE, type Inline, TAG } from './model'

export type Measure = (text: string, font: string) => number

/** How a run is set: its font, and the room a pill (inline code, a tag)
 * takes on either side of its text. */
export type RunStyle = Readonly<{ font: string; padX: number }>

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
}>

export type Line = Readonly<{ pieces: readonly Piece[]; width: number }>

/** Marks a line may not start with. */
const CLOSING = new Set(
  Array.from('，。、；：？！）」』】》〉〕〗｝’”…‥—–·～%％,.;:?!)]}' + 'ー々'),
)
/** Marks a line may not end with. */
const OPENING = new Set(Array.from('（「『【《〈〔〖｛‘“([{'))

/** Full-width marks whose ink sits in one half of their em, the other half
 * blank: closing ones on the left, opening ones on the right. */
const HALF_CLOSING = new Set(Array.from('，。、；：）」』】》〉〕〗｝'))
const HALF_OPENING = new Set(Array.from('（「『【《〈〔〖｛'))

/**
 * Whether a full-width mark followed by `next` gives up the blank half
 * between them — the browser's `text-spacing-trim: normal`, which sets
 * "，「" or "」。" in an em and a half rather than two.
 */
function trimsBefore(mark: string, next: string): boolean {
  if (HALF_CLOSING.has(mark)) {
    return HALF_CLOSING.has(next) || HALF_OPENING.has(next)
  }
  return HALF_OPENING.has(mark) && HALF_OPENING.has(next)
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

type AtomKind = 'space' | 'cjk' | 'word'

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
}

function atomize(text: string): { text: string; kind: AtomKind }[] {
  const out: { text: string; kind: AtomKind }[] = []
  let word = ''
  let space = ''
  const flushWord = () => {
    if (word !== '') out.push({ text: word, kind: 'word' })
    word = ''
  }
  const flushSpace = () => {
    if (space !== '') out.push({ text: space, kind: 'space' })
    space = ''
  }
  for (const ch of text) {
    if (isSpace(ch)) {
      flushWord()
      space += ch
      continue
    }
    flushSpace()
    if (isCjk(ch.codePointAt(0) ?? 0)) {
      flushWord()
      out.push({ text: ch, kind: 'cjk' })
      continue
    }
    word += ch
  }
  flushWord()
  flushSpace()
  return out
}

function canBreakBetween(
  a: { text: string; kind: AtomKind },
  b: { text: string; kind: AtomKind },
): boolean {
  if (a.kind === 'space' || b.kind === 'space') return true
  if (CLOSING.has(b.text.charAt(0))) return false
  if (OPENING.has(a.text.charAt(a.text.length - 1))) return false
  return a.kind === 'cjk' || b.kind === 'cjk'
}

type Placed = { atom: Atom; x: number }

export function breakLines(
  inlines: readonly Inline[],
  maxWidth: number,
  styleOf: (flags: number) => RunStyle,
  measure: Measure,
): Line[] {
  // Atoms, run by run, each knowing whether a line may break before it.
  const atoms: (Atom | null)[] = [] // null: a hard break
  let previous: Atom | null = null
  inlines.forEach((inline, run) => {
    if (inline.text === '\n') {
      atoms.push(null)
      previous = null
      return
    }
    const style = styleOf(inline.flags)
    const pill = (inline.flags & (CODE | TAG)) !== 0 ? style.padX : 0
    const parts = atomize(inline.text)
    parts.forEach((part, i) => {
      let width = measure(part.text, style.font)
      if (i === 0) width += pill
      if (i === parts.length - 1) width += pill
      const atom: Atom = {
        ...part,
        run,
        width,
        breakBefore: previous === null || canBreakBetween(previous, part),
        padLeft: i === 0 ? pill : 0,
        trimmed: false,
      }
      const before: Atom | null = previous
      if (
        before !== null &&
        before.kind === 'cjk' &&
        part.kind === 'cjk' &&
        before.padLeft === 0 &&
        trimsBefore(before.text, part.text)
      ) {
        before.width /= 2
        before.trimmed = true
      }
      atoms.push(atom)
      previous = atom
    })
  })

  const lines: Placed[][] = []
  let line: Placed[] = []
  /** Width of the line up to its last non-space atom. */
  let filled = 0
  /** Width of the spaces after it, which a break drops. */
  let trailing = 0
  const finish = () => {
    while (line.length > 0 && line[line.length - 1].atom.kind === 'space') {
      line.pop()
    }
    lines.push(line)
    line = []
    filled = 0
    trailing = 0
  }
  const place = (atom: Atom) => {
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
      i += 1
      continue
    }
    let j = i + 1
    while (j < atoms.length && atoms[j] !== null && !atoms[j]?.breakBefore) {
      j += 1
    }
    const chunk = atoms.slice(i, j) as Atom[]
    i = j
    if (chunk.length === 1 && chunk[0].kind === 'space') {
      if (line.length > 0) place(chunk[0])
      continue
    }
    const width = chunk.reduce((sum, atom) => sum + atom.width, 0)
    if (line.length > 0 && filled + trailing + width > maxWidth) finish()
    if (filled + width <= maxWidth || line.length > 0) {
      for (const atom of chunk) place(atom)
      continue
    }
    // Wider than a line on its own: cut wherever it stops fitting.
    for (const atom of chunk) {
      if (filled + trailing + atom.width <= maxWidth) {
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
          finish()
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
        if (rest !== '') finish()
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
    })
    current = null
  }
  let closed = false
  for (const { atom, x } of placed) {
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
    }
  }
  flush()
  return out
}
