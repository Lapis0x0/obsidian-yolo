// Pure text matching for the PDF reader's in-document search
// (./pdfSearch.ts). No DOM, no host: a page arrives as its text items (the
// Host API's `page.getTextItems()`, one per text-layer span) and a match
// leaves as a selection tuple — `[startItem, startOffset, endItem, endOffset]`
// in the raw item text — which is exactly what the page's text layer turns
// back into a DOM range (`textLayer.createRange`) once the page is laid out.
// So a document is searched without building a single text layer, and a hit
// on a page nobody has scrolled to yet is still a precise place.
//
// Matching is deliberately forgiving in the ways a PDF's text needs and
// nothing more:
//   - case-insensitive, and compatibility-normalized (NFKC) one source
//     character at a time, so a ligature "ﬁ" matches "fi" and full-width
//     "ＡＢＣ" matches "abc" while every output character still points back at
//     the one character it came from;
//   - whitespace of any kind and length is one space, and a query's leading
//     and trailing whitespace is dropped;
//   - a line break joins the two lines with a space between Latin text and
//     with nothing between CJK text — a Chinese sentence wrapped across two
//     lines is one sentence, an English one is two words. No word boundaries
//     are assumed anywhere, so a query matches inside a word or a CJK run.

export type SearchTextItem = Readonly<{ text: string; endsLine: boolean }>

export type SearchTuple = readonly [
  startIndex: number,
  startOffset: number,
  endIndex: number,
  endOffset: number,
]

/** A page's text folded for matching, and where each of its characters came
 * from. */
export type PageSearchIndex = Readonly<{
  text: string
  /** Per character of `text`: the item it came from, the UTF-16 offset of
   * its source character in that item, and that source character's length. */
  items: Int32Array
  offsets: Int32Array
  lengths: Int32Array
}>

/** Scripts written without spaces between words, where a line break is not
 * a word break. Kana, CJK ideographs (with extensions and compatibility),
 * CJK punctuation and the full-width forms. */
export const UNSPACED_SCRIPT =
  /[\u2e80-\u2fff\u3000-\u30ff\u3100-\u31ff\u3200-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

const WHITESPACE = /\s/

/** A query folded the way page text is. Empty when it has nothing to find. */
export function normalizeQuery(query: string): string {
  let out = ''
  for (const char of query) {
    const folded = foldChar(char)
    if (folded === ' ') {
      if (out !== '' && !out.endsWith(' ')) out += ' '
      continue
    }
    out += folded
  }
  return out.endsWith(' ') ? out.slice(0, -1) : out
}

export function buildPageSearchIndex(
  items: readonly SearchTextItem[],
): PageSearchIndex {
  let text = ''
  const itemAt: number[] = []
  const offsetAt: number[] = []
  const lengthAt: number[] = []
  // A line ended and the next character decides what joins it.
  let lineBreak = false
  let lastChar = ''

  const push = (
    chunk: string,
    item: number,
    offset: number,
    length: number,
  ): void => {
    for (let k = 0; k < chunk.length; k += 1) {
      itemAt.push(item)
      offsetAt.push(offset)
      lengthAt.push(length)
    }
    text += chunk
    lastChar = chunk[chunk.length - 1]
  }

  items.forEach((item, index) => {
    let offset = 0
    for (const char of item.text) {
      const folded = foldChar(char)
      if (folded === ' ') {
        if (text !== '' && lastChar !== ' ')
          push(' ', index, offset, char.length)
        lineBreak = false
      } else if (folded !== '') {
        if (
          lineBreak &&
          lastChar !== ' ' &&
          !UNSPACED_SCRIPT.test(lastChar) &&
          !UNSPACED_SCRIPT.test(folded[0])
        ) {
          // The joining space belongs to the character after it: a match can
          // never begin or end on it (queries are trimmed), so where it
          // points only has to be somewhere real.
          push(' ', index, offset, char.length)
        }
        lineBreak = false
        push(folded, index, offset, char.length)
      }
      offset += char.length
    }
    if (item.endsLine) lineBreak = true
  })

  return {
    text,
    items: Int32Array.from(itemAt),
    offsets: Int32Array.from(offsetAt),
    lengths: Int32Array.from(lengthAt),
  }
}

/** Every non-overlapping occurrence of an already-normalized query, in
 * reading order, as selection tuples. */
export function findInPage(
  index: PageSearchIndex,
  normalizedQuery: string,
): SearchTuple[] {
  const matches: SearchTuple[] = []
  if (normalizedQuery === '') return matches
  let from = 0
  for (;;) {
    const at = index.text.indexOf(normalizedQuery, from)
    if (at < 0) return matches
    const last = at + normalizedQuery.length - 1
    matches.push([
      index.items[at],
      index.offsets[at],
      index.items[last],
      index.offsets[last] + index.lengths[last],
    ])
    from = at + normalizedQuery.length
  }
}

function foldChar(char: string): string {
  if (WHITESPACE.test(char)) return ' '
  const folded = char.normalize('NFKC').toLowerCase()
  // Compatibility decomposition can itself produce a space ("¨" becomes a
  // space and a combining diaeresis); a space inside one folded character is
  // not a word gap anyone typed.
  return folded.replace(/\s+/g, '')
}
