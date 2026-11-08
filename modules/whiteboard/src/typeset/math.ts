// Math in a card's markdown, found as Obsidian finds it — before CommonMark,
// which has no math and would read a formula's `*` and `_` as emphasis.
//
// Obsidian's rules, as its reading view applies them (measured, 2026-11-08):
//   - `$$…$$` is display math wherever it is, its TeX running over lines and
//     blank lines alike;
//   - `$…$` is inline math when the TeX starts and ends with something
//     other than a space and no digit follows the closing `$` (`$5 and $10`
//     is prices); it may run over a line's end, not over a blank line;
//   - a `\$` is a dollar, and code is code: whichever starts first wins, so
//     a backtick inside a formula is the formula's;
//   - formulas are taken left to right, each from the end of the last
//     (`$a$$b$` is two).
//
// Each formula is put out of the parser's way as a character of its own —
// one from the Private Use Area, which no markdown syntax reads, and one
// the card does not use itself (an icon font's) — and put back as math once
// the card is parsed (`withMath`).

import type { Block, Inline, ListItem, Section } from './model'

/** A formula as written: its TeX, and whether it is display math. */
export type MathSource = Readonly<{ tex: string; display: boolean }>

/** A formula as MathJax lays it out (../ui/typesetting: by the host's math
 * engine). */
export type MathLayout = YoloModuleHostMathLayoutV1
export type MathPiece = YoloModuleHostMathPieceV1

const FIRST = 0xe000
const LAST = 0xf8ff
const PRIVATE_USE = /[-]/
const FENCE = /^(?:[ \t]*>)*[ \t]*(```|~~~)/

/** Formulas taken out of a card's markdown, by the character each was
 * left as. */
export type Formulas = ReadonlyMap<string, MathSource>

/** `markdown` with each formula in it a character of its own, the
 * formulas, and where in `markdown` each was taken from (`cut`, from and
 * to): a formula over lines takes them with it. */
export function mathOut(markdown: string): Readonly<{
  text: string
  formulas: Formulas
  cut: readonly (readonly [number, number])[]
}> {
  const formulas = new Map<string, MathSource>()
  const cut: [number, number][] = []
  if (!markdown.includes('$')) return { text: markdown, formulas, cut }
  // The characters the card uses itself are not a formula's.
  const taken = PRIVATE_USE.test(markdown)
    ? new Set(Array.from(markdown).filter((ch) => PRIVATE_USE.test(ch)))
    : null
  let code = FIRST
  const nextMark = (): string | null => {
    while (code <= LAST) {
      const mark = String.fromCharCode(code++)
      if (!taken?.has(mark)) return mark
    }
    return null
  }
  let out = ''
  let i = 0
  let fence: string | null = null
  let lineStart = true
  const n = markdown.length
  while (i < n) {
    if (lineStart) {
      lineStart = false
      const end = lineEnd(markdown, i)
      const opened = FENCE.exec(markdown.slice(i, end))
      if (opened) {
        fence = fence === null ? opened[1] : fence === opened[1] ? null : fence
      }
      if (fence !== null || opened) {
        // A fenced block's lines are code, its fences included.
        out += markdown.slice(i, end + 1)
        i = end + 1
        lineStart = true
        continue
      }
    }
    const ch = markdown[i]
    if (ch === '\n') {
      out += ch
      i += 1
      lineStart = true
      continue
    }
    if (ch === '\\') {
      out += markdown.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === '`') {
      const run = runOf(markdown, i, '`')
      const close = closingRun(markdown, i + run, run)
      const end = close === -1 ? i + run : close + run
      out += markdown.slice(i, end)
      i = end
      continue
    }
    if (ch !== '$') {
      out += ch
      i += 1
      continue
    }
    const run = runOf(markdown, i, '$')
    const found =
      run >= 2
        ? displayAt(markdown, i)
        : run === 1
          ? inlineAt(markdown, i)
          : null
    const mark = found ? nextMark() : null
    if (!found || mark === null) {
      out += markdown.slice(i, i + run)
      i += run
      continue
    }
    out += mark
    formulas.set(mark, found.formula)
    // A formula that ran over lines takes them with it.
    cut.push([i, found.end])
    i = found.end
  }
  return { text: out, formulas, cut }
}

/** `$$…$$` from `at`: to the next `$$` not escaped. */
function displayAt(
  s: string,
  at: number,
): Readonly<{ formula: MathSource; end: number }> | null {
  for (let k = at + 2; k < s.length - 1; k += 1) {
    if (s[k] === '\\') {
      k += 1
      continue
    }
    if (s[k] === '$' && s[k + 1] === '$') {
      const tex = s.slice(at + 2, k)
      if (tex.trim() === '') return null
      return { formula: { tex, display: true }, end: k + 2 }
    }
  }
  return null
}

/** `$…$` from `at`: to the next `$` not escaped, when the TeX hugs its
 * dollars, no digit follows, and no blank line is between. */
function inlineAt(
  s: string,
  at: number,
): Readonly<{ formula: MathSource; end: number }> | null {
  if (at + 1 >= s.length || /\s/.test(s[at + 1])) return null
  for (let k = at + 1; k < s.length; k += 1) {
    const c = s[k]
    if (c === '\\') {
      k += 1
      continue
    }
    if (c === '\n' && /^\n[ \t]*\n/.test(s.slice(k, k + 64))) return null
    if (c !== '$') continue
    if (/\s/.test(s[k - 1]) || /\d/.test(s[k + 1] ?? '')) return null
    return { formula: { tex: s.slice(at + 1, k), display: false }, end: k + 1 }
  }
  return null
}

function runOf(s: string, at: number, ch: string): number {
  let k = at
  while (s[k] === ch) k += 1
  return k - at
}

/** Where a run of exactly `length` backticks starts from `from`; -1 when
 * none does — the opening run is then text. */
function closingRun(s: string, from: number, length: number): number {
  for (let k = from; k < s.length; ) {
    if (s[k] !== '`') {
      k += 1
      continue
    }
    const run = runOf(s, k, '`')
    if (run === length) return k
    k += run
  }
  return -1
}

function lineEnd(s: string, from: number): number {
  const end = s.indexOf('\n', from)
  return end === -1 ? s.length : end
}

/**
 * The parsed card with its formulas back: each one's character an inline
 * formula, set as the text around it is (bold, a link, a highlight), and a
 * paragraph that is a display formula alone that formula's block.
 */
export function withMath(
  sections: readonly Section[],
  formulas: Formulas,
): Section[] {
  if (formulas.size === 0) return [...sections]
  const inlines = (list: readonly Inline[]): Inline[] => {
    const out: Inline[] = []
    for (const inline of list) {
      if (inline.image || inline.linkIcon || !PRIVATE_USE.test(inline.text)) {
        out.push(inline)
        continue
      }
      let text = ''
      for (const ch of inline.text) {
        const formula = formulas.get(ch)
        if (!formula) {
          text += ch
          continue
        }
        if (text !== '') out.push({ text, flags: inline.flags })
        text = ''
        out.push({ text: MATH_TEXT, flags: inline.flags, math: formula })
      }
      if (text !== '') out.push({ text, flags: inline.flags })
    }
    return out
  }
  const block = (b: Block): Block => {
    switch (b.kind) {
      case 'paragraph': {
        const next = inlines(b.inlines)
        const formula = soleDisplay(next)
        return formula
          ? { kind: 'math', tex: formula.tex }
          : { kind: 'paragraph', inlines: next }
      }
      case 'heading':
        return { ...b, inlines: inlines(b.inlines) }
      case 'list':
        return {
          ...b,
          items: b.items.map(
            (item): ListItem => ({ ...item, children: list(item.children) }),
          ),
        }
      case 'quote':
        return { ...b, children: list(b.children) }
      case 'callout':
        return { ...b, title: inlines(b.title), children: list(b.children) }
      case 'table':
        return {
          ...b,
          header: b.header.map(inlines),
          rows: b.rows.map((row) => row.map(inlines)),
        }
      default:
        return b
    }
  }
  const list = (sections: readonly Section[]): Section[] =>
    sections.map((section) => ({ ...section, block: block(section.block) }))
  return list(sections)
}

/** What a formula is in a paragraph's text: an object a line may break
 * either side of, as the browser treats an inline block. */
const MATH_TEXT = '￼'

/** The display formula a paragraph is, alone but for the line breaks and
 * spaces around it. */
function soleDisplay(inlines: readonly Inline[]): MathSource | null {
  let found: MathSource | null = null
  for (const inline of inlines) {
    if (inline.math) {
      if (!inline.math.display || found) return null
      found = inline.math
      continue
    }
    if (inline.image || inline.linkIcon || inline.text.trim() !== '') {
      return null
    }
  }
  return found
}

/** Every formula a card's parsed sections lay out, each once; and whether
 * one is display math in a line of text, which a card does not lay out —
 * the host's to show. */
export function formulasIn(sections: readonly Section[]): Readonly<{
  formulas: readonly MathSource[]
  looseDisplay: boolean
}> {
  const seen = new Map<string, MathSource>()
  let looseDisplay = false
  const add = (formula: MathSource) => {
    seen.set(mathKey(formula), formula)
  }
  const inlines = (list: readonly Inline[]) => {
    for (const inline of list) {
      if (!inline.math) continue
      if (inline.math.display) looseDisplay = true
      add(inline.math)
    }
  }
  const walk = (list: readonly Section[]) => {
    for (const { block } of list) {
      switch (block.kind) {
        case 'math':
          add({ tex: block.tex, display: true })
          break
        case 'paragraph':
        case 'heading':
          inlines(block.inlines)
          break
        case 'list':
          for (const item of block.items) walk(item.children)
          break
        case 'quote':
          walk(block.children)
          break
        case 'callout':
          inlines(block.title)
          walk(block.children)
          break
        case 'table':
          for (const row of [block.header, ...block.rows]) {
            for (const cell of row) inlines(cell)
          }
          break
        default:
          break
      }
    }
  }
  walk(sections)
  return { formulas: [...seen.values()], looseDisplay }
}

/** A formula's key among a board's: its kind and its TeX. */
export function mathKey(formula: MathSource): string {
  return `${formula.display ? 'D' : 'I'}${formula.tex}`
}

/** The font a formula's text (a character its math font has no glyph of)
 * is set in, at `size` world units to its em. */
export function mathTextFont(
  shape: Readonly<{
    size: number
    family: string
    italic: boolean
    bold: boolean
  }>,
  size: number,
): string {
  const px = Math.round(shape.size * size * 100) / 100
  return `${shape.italic ? 'italic ' : ''}${shape.bold ? 700 : 400} ${px}px ${shape.family}`
}
