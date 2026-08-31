import { fromMarkdown } from 'mdast-util-from-markdown'

/**
 * Streaming markdown is re-rendered on every animation frame. Handing the whole
 * document to a single parser means every frame re-parses everything that came
 * before, which turns a long answer into O(n²) work. Splitting the source into
 * top-level blocks lets the renderer memoize the blocks that are already
 * finished and re-parse only the one the stream is still writing into.
 *
 * The split has to be conservative: some markdown constructs only resolve when
 * the whole document is parsed together, and cutting them apart would render
 * them wrong. Those documents are returned as a single block.
 */

export type MarkdownBlockSplit = {
  /** The exact source these blocks were derived from. */
  source: string
  /** Top-level blocks; `blocks.join('')` always reproduces `source`. */
  blocks: string[]
}

// A footnote reference and its definition have to live in the same syntax tree,
// otherwise the reference renders as literal text and the definition as an
// orphan paragraph. Matches both `[^label]` and `[^label]:`.
//
// The label is restricted to word characters and hyphens on purpose. A looser
// class such as `[^\]\s]+` also matches regex character classes like `[^\s]`
// or `[^"]`, which appear constantly in the code this plugin's answers are
// full of — every one of those would force the whole answer down the
// unsplittable path and give back the O(n²) parse we are here to remove.
const FOOTNOTE_PATTERN = /\[\^[\w-]{1,200}\]/

// Same problem for link reference definitions: `[ref]: https://…` resolves
// `[text][ref]` from anywhere in the document, so the two must be parsed
// together.
const LINK_REFERENCE_DEFINITION_PATTERN = /^ {0,3}\[[^\]\n]+\]:/m

function requiresWholeDocumentParse(markdown: string): boolean {
  return (
    FOOTNOTE_PATTERN.test(markdown) ||
    LINK_REFERENCE_DEFINITION_PATTERN.test(markdown)
  )
}

function countDisplayMathDelimiters(source: string): number {
  let count = 0
  for (let index = source.indexOf('$$'); index >= 0; ) {
    count++
    index = source.indexOf('$$', index + 2)
  }
  return count
}

/**
 * A display math block that contains a blank line is parsed as several
 * top-level nodes, because the block splitter deliberately runs without the
 * math extension. An odd number of `$$` therefore means the block was cut in
 * half and has to be joined with what follows.
 */
function mergeUnbalancedDisplayMath(blocks: string[]): string[] {
  const merged: string[] = []
  let pending = ''

  for (const block of blocks) {
    pending += block
    if (countDisplayMathDelimiters(pending) % 2 === 0) {
      merged.push(pending)
      pending = ''
    }
  }

  if (pending.length > 0) {
    merged.push(pending)
  }

  return merged
}

function splitTopLevelBlocks(markdown: string): string[] {
  const tree = fromMarkdown(markdown)
  const blocks: string[] = []
  let cursor = 0

  for (const node of tree.children) {
    const end = node.position?.end.offset
    if (end === undefined || end <= cursor) {
      continue
    }
    // Slicing from the previous block's end keeps the separators between
    // blocks, so joining the blocks reproduces the source exactly.
    blocks.push(markdown.slice(cursor, end))
    cursor = end
  }

  if (blocks.length === 0) {
    return markdown.length > 0 ? [markdown] : []
  }

  if (cursor < markdown.length) {
    blocks[blocks.length - 1] += markdown.slice(cursor)
  }

  return mergeUnbalancedDisplayMath(blocks)
}

/**
 * Splits `markdown` into top-level blocks.
 *
 * Pass the previous result as `previous` while streaming: as long as the new
 * source extends the old one, every block but the last is already terminated
 * and can be reused verbatim, so only the trailing block is re-parsed. The
 * trailing block is never frozen because appended text can still extend it
 * (an open paragraph, a growing list, an unclosed fence).
 */
export function splitMarkdownBlocks(
  markdown: string,
  previous?: MarkdownBlockSplit | null,
): MarkdownBlockSplit {
  if (markdown.length === 0) {
    return { source: '', blocks: [] }
  }

  if (requiresWholeDocumentParse(markdown)) {
    return { source: markdown, blocks: [markdown] }
  }

  if (previous && previous.source === markdown) {
    return previous
  }

  if (
    previous &&
    previous.blocks.length > 1 &&
    markdown.startsWith(previous.source)
  ) {
    const frozen = previous.blocks.slice(0, -1)
    const frozenLength = frozen.reduce(
      (total, block) => total + block.length,
      0,
    )
    return {
      source: markdown,
      blocks: [...frozen, ...splitTopLevelBlocks(markdown.slice(frozenLength))],
    }
  }

  return { source: markdown, blocks: splitTopLevelBlocks(markdown) }
}
