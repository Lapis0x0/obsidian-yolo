// A passage of a text or note card as an edge end reaches it
// (fileFormat.ts's `EdgeAnchor`, kind `text`): a span of the card's Markdown
// source, kept as its words, a little context either side, and where in the
// source it was last found.
//
// Found again by its words, in tiers that cost nothing in the common case:
// the source at the remembered offset still says the words (nothing moved
// before them); or the words are found where they now are, the context
// telling repeats apart; or they are gone — the passage was rewritten — and
// the end reaches the whole card. Nothing fuzzier: a passage that is not
// there any more is not quietly replaced by one that looks like it.
//
// The source is not what a card shows. A card renders its Markdown, and the
// editor hides some of it, so text read off the screen — a selection, the
// paragraph under the pointer — is matched to the source loosely
// (`findLoose`): by its letters and digits only, every mark, space and
// punctuation set aside, which is exactly what rendering adds or takes away.
//
// Pure: no DOM, no host.

import type { EdgeAnchor, EdgeAnchorQuote } from './fileFormat'

/** How many characters of context a quote keeps either side. */
export const TEXT_QUOTE_CONTEXT = 32

export type TextAnchor = Extract<EdgeAnchor, { kind: 'text' }>

/** A span of a text: start inclusive, end exclusive. */
export type TextSpan = readonly [number, number]

/** The anchor for `source.slice(start, end)`. */
export function textAnchorAt(
  source: string,
  [start, end]: TextSpan,
): TextAnchor {
  const prefix = source.slice(Math.max(0, start - TEXT_QUOTE_CONTEXT), start)
  const suffix = source.slice(end, end + TEXT_QUOTE_CONTEXT)
  return {
    kind: 'text',
    quote: {
      exact: source.slice(start, end),
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
    },
    offset: start,
  }
}

/** Where an anchor's passage is in `source` now, or null when it is gone. */
export function resolveTextAnchor(
  source: string,
  anchor: TextAnchor,
): TextSpan | null {
  const { exact } = anchor.quote
  if (exact.length === 0) return null
  if (source.startsWith(exact, anchor.offset)) {
    return [anchor.offset, anchor.offset + exact.length]
  }
  let best: number | null = null
  let bestScore = -1
  for (
    let at = source.indexOf(exact);
    at !== -1;
    at = source.indexOf(exact, at + 1)
  ) {
    const score = contextScore(source, at, at + exact.length, anchor.quote)
    // Ties go to the occurrence nearest where it was.
    if (
      score > bestScore ||
      (score === bestScore &&
        best !== null &&
        Math.abs(at - anchor.offset) < Math.abs(best - anchor.offset))
    ) {
      best = at
      bestScore = score
    }
  }
  return best === null ? null : [best, best + exact.length]
}

/**
 * Where `needle` is in `haystack`, matched by letters and digits alone (see
 * the file comment), as a span of `haystack`. Where it is there more than
 * once, the occurrence whose surroundings best match `before`/`after` (read
 * the same loose way) wins, then the one nearest `near`.
 */
export function findLoose(
  haystack: string,
  needle: string,
  context: Readonly<{ before?: string; after?: string; near?: number }> = {},
): TextSpan | null {
  const hay = looseText(haystack)
  const target = looseText(needle).text
  if (target.length === 0) return null
  const before = looseText(context.before ?? '').text
  const after = looseText(context.after ?? '').text
  let best: TextSpan | null = null
  let bestScore = -1
  for (
    let at = hay.text.indexOf(target);
    at !== -1;
    at = hay.text.indexOf(target, at + 1)
  ) {
    const end = at + target.length
    const score =
      commonSuffix(hay.text.slice(0, at), before) +
      commonPrefix(hay.text.slice(end), after)
    const span: TextSpan = [hay.map[at], hay.map[end - 1] + 1]
    const nearer =
      best !== null &&
      context.near !== undefined &&
      Math.abs(span[0] - context.near) < Math.abs(best[0] - context.near)
    if (score > bestScore || (score === bestScore && nearer)) {
      best = span
      bestScore = score
    }
  }
  return best
}

/** A text's letters and digits, lowercased, and where each came from. */
export function looseText(text: string): {
  text: string
  map: number[]
} {
  let out = ''
  const map: number[] = []
  // By code point, so a character outside the BMP stays one unit of meaning
  // and maps back to where it starts.
  let index = 0
  for (const char of text) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      const lower = char.toLowerCase()
      for (let k = 0; k < lower.length; k += 1) map.push(index)
      out += lower
    }
    index += char.length
  }
  return { text: out, map }
}

function contextScore(
  source: string,
  start: number,
  end: number,
  quote: EdgeAnchorQuote,
): number {
  return (
    commonSuffix(source.slice(0, start), quote.prefix ?? '') +
    commonPrefix(source.slice(end), quote.suffix ?? '')
  )
}

function commonPrefix(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  let k = 0
  while (k < length && a[k] === b[k]) k += 1
  return k
}

function commonSuffix(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  let k = 0
  while (k < length && a[a.length - 1 - k] === b[b.length - 1 - k]) k += 1
  return k
}
