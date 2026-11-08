// Markdown to the typesetter's model (./model.ts): CommonMark and GFM by
// micromark, the parser the host's own streaming renderer uses, then
// Obsidian's own syntax on top — which CommonMark reads as plain text, so it
// is found in the text it leaves:
//
//   [[note]], [[note|alias]]   a link, shown by its alias or its name
//   ![[file]]                  an embed: a block of its own when alone
//   ==text==                   a highlight, which may span other styles
//   #tag                       a tag
//   > [!type] title            a callout
//
// Front matter is dropped: a card shows a note's body.

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly'
import { gfm } from 'micromark-extension-gfm'

import { decodedUrl, imageOf } from './images'
import { mathOut, withMath } from './math'
import {
  BOLD,
  type Block,
  CODE,
  HIGHLIGHT,
  ITALIC,
  type Inline,
  LINK,
  type ListItem,
  STRIKE,
  type Section,
  TAG,
} from './model'

// The syntax tree's node types, named from the parser's own result rather
// than imported from `mdast`, a types-only package the module does not ship.
type Root = ReturnType<typeof fromMarkdown>
type RootContent = Root['children'][number]
type Paragraph = Extract<RootContent, { type: 'paragraph' }>
type PhrasingContent = Paragraph['children'][number]
type MdList = Extract<RootContent, { type: 'list' }>
type MdListItem = MdList['children'][number]
type TableRow = Extract<RootContent, { type: 'table' }>['children'][number]
/** Any block: a list item's and a quote's children are among the root's. */
type Flow = RootContent

/** A callout's first line, at any depth of quoting. */
const CALLOUT_LINE = /^((?:[ \t]*>)+)[ \t]*\[![^\]\s]+\]/
const FENCE = /^(?:[ \t]*>)*[ \t]*(```|~~~)/

/** A block's id at the end of its last line (`text ^id`). */
const BLOCK_ID = /[ \t]\^[A-Za-z0-9-]+[ \t]*$/

/**
 * Lines on their way to the parser, each with the line of the markdown it
 * came from: the steps below add lines and take some away, and a block the
 * parser finds is placed by the line it starts on in what it was given.
 */
type Lines = Readonly<{ lines: string[]; origin: number[] }>

const linesOf = (markdown: string): Lines => {
  const lines = markdown.split('\n')
  return { lines, origin: lines.map((_, i) => i) }
}

/**
 * Two things Obsidian reads off lines that CommonMark does not, outside
 * code, where such a line is only text:
 * - a callout's title is its first line alone; CommonMark would run the
 *   lines after it into the same paragraph, so that a list or a heading
 *   written straight under the title would be text. An empty quoted line
 *   after the title keeps them apart.
 * - a block's id at the end of the block is not shown.
 */
export function calloutTitlesApart(markdown: string): string {
  return calloutTitlesApartIn(linesOf(markdown)).lines.join('\n')
}

function calloutTitlesApartIn({ lines, origin }: Lines): Lines {
  const out: string[] = []
  const from: number[] = []
  let fence: string | null = null
  lines.forEach((line, i) => {
    out.push(line)
    from.push(origin[i])
    const opened = FENCE.exec(line)
    if (opened) {
      fence = fence === null ? opened[1] : fence === opened[1] ? null : fence
      return
    }
    if (fence !== null) return
    const next = lines[i + 1]
    const endsBlock = next === undefined || /^(?:[ \t]*>)*[ \t]*$/.test(next)
    if (endsBlock && BLOCK_ID.test(line)) {
      out[out.length - 1] = line.replace(BLOCK_ID, '')
    }
    const callout = CALLOUT_LINE.exec(line)
    if (!callout || next === undefined) return
    // Only where the next line goes on in the same quote with something.
    const quote = callout[1]
    if (next.startsWith(quote) && next.slice(quote.length).trim() !== '') {
      out.push(quote)
      from.push(origin[i])
    }
  })
  return { lines: out, origin: from }
}

const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/

/**
 * A line of nothing but spaces inside a list item, indented as far as the
 * item's content, is not a blank line to Obsidian where what comes next
 * leaves the item — the next item, or the list's end: the items stay
 * tight. CommonMark reads it as blank, so there it goes. Before more of
 * the item's own content it is blank to both, and parts that content from
 * what came before (a loose item). A line indented less, or empty, is
 * always blank.
 */
export function itemSpacesDropped(markdown: string): string {
  return itemSpacesDroppedIn(linesOf(markdown)).lines.join('\n')
}

function itemSpacesDroppedIn({ lines, origin }: Lines): Lines {
  const out: string[] = []
  const from: number[] = []
  const push = (line: string, i: number) => {
    out.push(line)
    from.push(origin[i])
  }
  let fence: string | null = null
  // The column the open item's content starts at; null outside a list.
  let item: number | null = null
  let afterBlank = false
  const blank = (line: string) => /^[ \t]*$/.test(line)
  lines.forEach((line, i) => {
    const opened = FENCE.exec(line)
    if (opened) {
      fence = fence === null ? opened[1] : fence === opened[1] ? null : fence
      push(line, i)
      return
    }
    if (fence !== null) {
      push(line, i)
      return
    }
    if (blank(line)) {
      if (line !== '' && item !== null && columns(line) >= item) {
        const next = lines.slice(i + 1).find((l) => !blank(l))
        const nextIndent =
          next === undefined ? 0 : columns(/^[ \t]*/.exec(next)?.[0] ?? '')
        if (nextIndent < item) return
      }
      afterBlank = true
      push(line, i)
      return
    }
    const marker = LIST_ITEM.exec(line)
    const indent = columns(/^[ \t]*/.exec(line)?.[0] ?? '')
    if (marker) {
      item =
        columns(marker[1]) + marker[2].length + Math.max(1, marker[3].length)
    } else if (item !== null && afterBlank && indent < item) {
      item = null
    }
    afterBlank = false
    push(line, i)
  })
  return { lines: out, origin: from }
}

const EMPTY_QUOTE = /^((?:[ \t]*>)+)[ \t]*$/
/** A line that starts a block of its own, outside any paragraph. */
const BLOCK_START =
  /^[ \t]*(?:>|#{1,6}(?:[ \t]|$)|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|```|~~~|(?:[-*_][ \t]*){3,}$|<|\|)/

/**
 * A line of text right after a quote's empty line is the quote's to
 * Obsidian, a paragraph of its own in it, where CommonMark has the quote
 * end there: it is marked as the quote's. A line that starts a block of
 * its own (a heading, a list) is outside it to both.
 */
export function quoteParagraphsKept(markdown: string): string {
  return quoteParagraphsKeptIn(linesOf(markdown)).lines.join('\n')
}

/** Line for line: only what a line holds changes. */
function quoteParagraphsKeptIn({ lines, origin }: Lines): Lines {
  let fence: string | null = null
  const out = lines.map((line, i) => {
    const opened = FENCE.exec(line)
    if (opened) {
      fence = fence === null ? opened[1] : fence === opened[1] ? null : fence
      return line
    }
    if (fence !== null || i === 0 || line.trim() === '') return line
    if (BLOCK_START.test(line)) return line
    const quote = EMPTY_QUOTE.exec(lines[i - 1])
    return quote ? `${quote[1]} ${line}` : line
  })
  return { lines: out, origin }
}

/** How many columns leading whitespace takes, a tab to the next stop of
 * four. */
function columns(space: string): number {
  let n = 0
  for (const ch of space) n = ch === '\t' ? n + 4 - (n % 4) : n + 1
  return n
}

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown
  const match = FRONTMATTER.exec(markdown)
  return match ? markdown.slice(match[0].length) : markdown
}

/**
 * Whether a `*` was left as text that Obsidian reads otherwise: one after
 * text and before a space can only close emphasis to CommonMark, and left
 * unpaired is shown as it is; Obsidian has been seen to open emphasis with
 * it (`\\n* a \\n* b`). Such a card is the host's to show. Any other `*`
 * left unpaired (`**3.` never closed, `*其次`, `2 * 3`) Obsidian shows as it
 * is too.
 */
export function hasStrayEmphasis(sections: readonly Section[]): boolean {
  return someInline(
    sections,
    (inline) => !(inline.flags & CODE) && /\S\*+\s/.test(inline.text),
  )
}

/** Whether a card holds HTML only the host draws (`tagKind`). */
export function hasHostHtml(sections: readonly Section[]): boolean {
  return someInline(sections, (inline) => inline.host === true, 'host')
}

/** Whether any run of text in the sections is `test`'s, or any block is
 * of kind `kind`. */
function someInline(
  sections: readonly Section[],
  test: (inline: Inline) => boolean,
  kind?: Block['kind'],
): boolean {
  const inlines = (list: readonly Inline[]) => list.some(test)
  const inSections = (list: readonly Section[]): boolean =>
    list.some(({ block }) => {
      if (block.kind === kind) return true
      switch (block.kind) {
        case 'paragraph':
        case 'heading':
          return inlines(block.inlines)
        case 'list':
          return block.items.some((item) => inSections(item.children))
        case 'quote':
          return inSections(block.children)
        case 'callout':
          return inlines(block.title) || inSections(block.children)
        case 'table':
          return [block.header, ...block.rows].some((row) => row.some(inlines))
        default:
          return false
      }
    })
  return inSections(sections)
}

/** A card's blocks; each of the document's own knows the line of
 * `markdown` it starts on (model.ts's `Section`). */
export function parseCard(markdown: string): Section[] {
  const body = stripFrontmatter(markdown)
  const skipped = lineCount(markdown) - lineCount(body)
  const math = mathOut(body)
  const source = quoteParagraphsKeptIn(
    itemSpacesDroppedIn(
      calloutTitlesApartIn({
        lines: math.text.split('\n'),
        origin: linesLeft(body, math.cut).map((line) => line + skipped),
      }),
    ),
  )
  const tree = fromMarkdown(source.lines.join('\n'), PARSER)
  return withMath(sectionsOf(tree.children, source.origin), math.formulas)
}

const lineCount = (text: string): number => text.split('\n').length

/** For each line of `text` with the `cut` spans taken out, the line of
 * `text` it starts as: a span over lines takes its line breaks with it. */
function linesLeft(
  text: string,
  cut: readonly (readonly [number, number])[],
): number[] {
  const out = [0]
  let line = 0
  let span = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') continue
    line += 1
    while (span < cut.length && cut[span][1] <= i) span += 1
    if (span < cut.length && cut[span][0] <= i) continue
    out.push(line)
  }
  return out
}

/** The parser's extensions, made once: they describe syntax and hold no
 * state, and combining them anew for every card is a good part of its
 * parse. */
const PARSER = {
  // Emphasis next to CJK punctuation (`从而**“耗竭”**`), which CommonMark
  // leaves as text and Obsidian does not.
  extensions: [gfm(), cjkFriendlyExtension()],
  mdastExtensions: [gfmFromMarkdown()],
}

/** Blocks as sections; given where the parsed lines came from (`origin`),
 * the document's own, each with the line it starts on. */
function sectionsOf(
  nodes: readonly Flow[],
  origin: readonly number[] | null = null,
): Section[] {
  const out: Section[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    const block = blockOf(nodes[i])
    if (!block) continue
    const start = nodes[i].position?.start.line
    const end = nodes[i].position?.end.line
    const next = nodes[i + 1]?.position?.start.line
    const blankAfter =
      end !== undefined && next !== undefined ? Math.max(0, next - end - 1) : 1
    const line = origin && start !== undefined ? origin[start - 1] : undefined
    out.push(
      line === undefined ? { block, blankAfter } : { block, blankAfter, line },
    )
  }
  return out
}

function blockOf(node: Flow): Block | null {
  switch (node.type) {
    case 'paragraph': {
      const embed = soleEmbed(node.children)
      if (embed !== null) return { kind: 'embed', target: embed }
      return { kind: 'paragraph', inlines: inlinesOf(node.children) }
    }
    case 'heading':
      return {
        kind: 'heading',
        depth: node.depth,
        inlines: inlinesOf(node.children),
      }
    case 'list':
      return {
        kind: 'list',
        ordered: node.ordered === true,
        start: node.start ?? 1,
        spread: node.spread === true || node.children.some((i) => i.spread),
        items: node.children.map(itemOf),
      }
    case 'blockquote':
      return (
        calloutOf(node.children) ?? {
          kind: 'quote',
          children: sectionsOf(node.children),
        }
      )
    case 'code':
      return { kind: 'code', text: node.value }
    case 'table': {
      const [head, ...rows] = node.children
      return {
        kind: 'table',
        header: head ? cellsOf(head) : [],
        rows: rows.map(cellsOf),
        align: (node.align ?? []).map((a) => a ?? null),
      }
    }
    case 'thematicBreak':
      return { kind: 'rule' }
    case 'html': {
      if (/^\s*<!--[\s\S]*-->\s*$/.test(node.value)) return { kind: 'nothing' }
      // An element HTML has, drawn as the browser draws it: the host's.
      for (const tag of node.value.match(HTML_TAG) ?? []) {
        if (tagKind(tag) === 'host') return { kind: 'host' }
      }
      // Its text, a line per `<br>` — a last one ends the block rather than
      // starting a line — and the source's own line ends a space, as HTML
      // has them; the tags of no element dropped, as Obsidian's sanitizer
      // drops them.
      const parts = node.value.split(/<br\s*\/?>/i).map((part) =>
        part
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      // No line break and no text: nothing to show.
      if (parts.length === 1 && parts[0] === '') return null
      if (parts[parts.length - 1] === '') parts.pop()
      const inlines: Inline[] = []
      parts.forEach((part, k) => {
        if (k > 0) inlines.push({ text: '\n', flags: 0 })
        if (part !== '') inlines.push({ text: part, flags: 0 })
      })
      return { kind: 'paragraph', inlines }
    }
    default:
      // Definitions, footnote definitions, YAML: nothing a card shows.
      return null
  }
}

/** A tag, or a comment, in HTML a card holds. */
const HTML_TAG = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g

/**
 * What a tag written in a card is, as Obsidian's reading view shows it
 * (measured, 2026-11-08): a line break; one of an element HTML has, which
 * the browser draws (`<sup>`, `<span>`, `<details>`) — the host's to show;
 * or the tag of no element, which an AI's notes are full of (`<memory>`,
 * `<issue>`, `<why it matters>`) and the sanitizer drops, keeping what is
 * between. Not one written `<mask/>`: closed in itself, it takes the text
 * after it with it — the host's too. A comment shows nothing.
 */
function tagKind(tag: string): 'break' | 'host' | 'dropped' {
  if (tag.startsWith('<!--')) return 'dropped'
  const name = /^<\/?([A-Za-z][\w-]*)/.exec(tag)?.[1].toLowerCase()
  if (name === undefined) return 'dropped'
  if (name === 'br') return 'break'
  if (HTML_ELEMENTS.has(name) || /\/\s*>$/.test(tag)) return 'host'
  return 'dropped'
}

/** HTML's elements, obsolete ones with them, and SVG's and MathML's roots. */
const HTML_ELEMENTS = new Set(
  (
    'a abbr acronym address area article aside audio b base basefont bdi ' +
    'bdo big blink blockquote body br button canvas caption center cite ' +
    'code col colgroup data datalist dd del details dfn dialog dir div dl ' +
    'dt em embed fieldset figcaption figure font footer form frame ' +
    'frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img ' +
    'input ins kbd label legend li link main map mark marquee math menu ' +
    'meta meter nav nobr noembed noframes noscript object ol optgroup ' +
    'option output p param picture plaintext pre progress q rb rp rt rtc ' +
    'ruby s samp script search section select slot small source span ' +
    'strike strong style sub summary sup svg table tbody td template ' +
    'textarea tfoot th thead time title tr track tt u ul var video wbr xmp'
  ).split(' '),
)

const EMPTY_TASK = /^\[([ xX])\]\s*$/

function itemOf(item: MdListItem): ListItem {
  // `- [ ]` with nothing after it: GFM reads the box as text, Obsidian
  // draws an empty task.
  const [first, ...rest] = item.children
  const lead =
    first?.type === 'paragraph' && first.children.length === 1
      ? first.children[0]
      : null
  const empty =
    item.checked == null && lead?.type === 'text'
      ? EMPTY_TASK.exec(lead.value)
      : null
  if (empty) {
    return { checked: empty[1] !== ' ', children: sectionsOf(rest) }
  }
  return {
    checked: typeof item.checked === 'boolean' ? item.checked : null,
    children: sectionsOf(item.children),
  }
}

function cellsOf(row: TableRow): Inline[][] {
  return row.children.map((cell) => inlinesOf(cell.children))
}

const CALLOUT_HEAD = /^\[!([^\]\s]+)\]([+-]?)[ \t]*/

/** A quote whose first line is `[!type] title`: a callout. */
function calloutOf(quoted: readonly Flow[]): Block | null {
  const [first, ...rest] = quoted
  if (first?.type !== 'paragraph') return null
  const lead = first.children[0]
  if (lead?.type !== 'text') return null
  const head = CALLOUT_HEAD.exec(lead.value)
  if (!head) return null
  // The title runs to the end of the first line; what follows it in the
  // paragraph is the callout's first paragraph of content.
  const titleNodes: PhrasingContent[] = []
  const bodyNodes: PhrasingContent[] = []
  let inTitle = true
  first.children.forEach((child, index) => {
    if (!inTitle) {
      bodyNodes.push(child)
      return
    }
    if (child.type === 'text') {
      const value =
        index === 0 ? child.value.slice(head[0].length) : child.value
      const newline = value.indexOf('\n')
      if (newline === -1) {
        titleNodes.push({ ...child, value })
        return
      }
      titleNodes.push({ ...child, value: value.slice(0, newline) })
      const after = value.slice(newline + 1)
      if (after !== '') bodyNodes.push({ ...child, value: after })
      inTitle = false
      return
    }
    if (child.type === 'break') {
      inTitle = false
      return
    }
    titleNodes.push(child)
  })
  const type = head[1].toLowerCase()
  const title = inlinesOf(titleNodes)
  // Folded (`[!type]-`): only its title shows.
  const folded = head[2] === '-'
  const sections = folded ? [] : sectionsOf(rest)
  const children: Section[] =
    bodyNodes.length > 0 && !folded
      ? [
          {
            block: { kind: 'paragraph', inlines: inlinesOf(bodyNodes) },
            blankAfter: sections.length > 0 ? 1 : 0,
          },
          ...sections,
        ]
      : sections
  return {
    kind: 'callout',
    type,
    title:
      title.length > 0
        ? title
        : [{ text: type.charAt(0).toUpperCase() + type.slice(1), flags: 0 }],
    children,
  }
}

const SOLE_EMBED = /^!\[\[([^\]\n]+)\]\]$/

function soleEmbed(children: readonly PhrasingContent[]): string | null {
  if (children.length !== 1) return null
  const only = children[0]
  if (only.type !== 'text') return null
  const match = SOLE_EMBED.exec(only.value.trim())
  // An image is set in its line, as the host sets it (`imageOf`).
  return match && !imageOf(match[1]) ? match[1] : null
}

/** What an image stands for in a run of text: one object, as the DOM's
 * `<img>` is one. */
export const IMAGE_TEXT = '\uFFFC'

/** A highlight is a toggle in the text, not a node: it can open in one run
 * and close in another (`==a **b** c==`). */
type InlineState = { highlight: boolean }

export function inlinesOf(nodes: readonly PhrasingContent[]): Inline[] {
  const out: Inline[] = []
  const state: InlineState = { highlight: false }
  for (const node of nodes) walk(node, 0, out, state)
  return merge(out)
}

function walk(
  node: PhrasingContent,
  flags: number,
  out: Inline[],
  state: InlineState,
): void {
  switch (node.type) {
    case 'text':
      obsidianText(node.value, flags, out, state)
      return
    case 'emphasis':
      for (const child of node.children) walk(child, flags | ITALIC, out, state)
      return
    case 'strong':
      for (const child of node.children) walk(child, flags | BOLD, out, state)
      return
    case 'delete':
      for (const child of node.children) walk(child, flags | STRIKE, out, state)
      return
    case 'inlineCode':
      push(out, node.value, flags | CODE, state)
      return
    case 'link':
    case 'linkReference':
      for (const child of node.children) walk(child, flags | LINK, out, state)
      // A link to a URL is an external one: a theme marks it with an icon.
      if (node.type === 'link' && URL_SCHEME.test(node.url)) {
        out.push({ text: LINK_ICON_TEXT, flags: flags | LINK, linkIcon: true })
      }
      return
    case 'image': {
      const image = imageOf(decodedUrl(node.url))
      if (image) out.push({ text: IMAGE_TEXT, flags, image })
      else if (node.alt) push(out, node.alt, flags | LINK, state)
      return
    }
    case 'imageReference':
      if (node.alt) push(out, node.alt, flags | LINK, state)
      return
    case 'break':
      out.push({ text: '\n', flags: 0 })
      return
    case 'html':
      switch (tagKind(node.value.trim())) {
        case 'break':
          out.push({ text: '\n', flags: 0 })
          return
        case 'host':
          out.push({ text: '', flags, host: true })
          return
        default:
          // A tag of no element (`<memory>`), or a comment: nothing shown.
          return
      }
    case 'footnoteReference':
      push(out, `[${node.identifier}]`, flags | LINK, state)
      return
    default:
      // Nothing else a paragraph holds draws as text.
      return
  }
}

/** What CommonMark left as text that Obsidian does not: wikilinks and
 * embeds, highlight marks, tags. Newlines in text are soft breaks, which
 * Obsidian shows as line breaks. */
const OBSIDIAN =
  /(!?)\[\[([^\]\n]+?)\]\]|==|(^|[\s([{（「『【，。、；：！？,.;:!?])#([^\s#,.;:!?'"()[\]{}，。、；：！？（）「」『』【】“”‘’<>`*~=]+)|\n/gu

/** A URL's scheme: what makes a link an external one. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
/** What an external link's icon is in a paragraph's text: an object the
 * line may break either side of, as the browser treats an inline block. */
const LINK_ICON_TEXT = '\uFFFC'

/** What a wikilink shows, as Obsidian's reading view does: its alias, or
 * its target with each heading or block step after a " > " — and none
 * before one in the note itself. */
export function linkText(target: string): string {
  const bar = target.indexOf('|')
  if (bar !== -1) return target.slice(bar + 1)
  return target.replace(/^#/, '').replace(/#/g, ' > ')
}

/** A tag needs one character that is not a digit: `#123` is text. */
const TAG_HAS_NAME = /\D/

function obsidianText(
  value: string,
  flags: number,
  out: Inline[],
  state: InlineState,
): void {
  let at = 0
  OBSIDIAN.lastIndex = 0
  for (
    let match = OBSIDIAN.exec(value);
    match !== null;
    match = OBSIDIAN.exec(value)
  ) {
    const index = match.index
    const token = match[0]
    if (token === '==') {
      push(out, value.slice(at, index), flags, state)
      state.highlight = !state.highlight
      at = index + 2
      continue
    }
    if (token === '\n') {
      push(out, value.slice(at, index), flags, state)
      out.push({ text: '\n', flags: 0 })
      at = index + 1
      continue
    }
    if (match[2] !== undefined) {
      push(out, value.slice(at, index), flags, state)
      const target = match[2]
      const image = match[1] === '!' ? imageOf(target) : null
      if (image) {
        out.push({ text: IMAGE_TEXT, flags, image })
        at = index + token.length
        continue
      }
      push(out, linkText(target), flags | LINK, state)
      at = index + token.length
      continue
    }
    // A tag: what preceded the `#` stays text.
    if (!TAG_HAS_NAME.test(match[4] ?? '')) continue
    const lead = match[3] ?? ''
    push(out, value.slice(at, index + lead.length), flags, state)
    push(out, `#${match[4]}`, flags | TAG, state)
    at = index + token.length
  }
  push(out, value.slice(at), flags, state)
}

function push(
  out: Inline[],
  text: string,
  flags: number,
  state: InlineState,
): void {
  if (text === '') return
  out.push({ text, flags: state.highlight ? flags | HIGHLIGHT : flags })
}

/** Adjacent runs set alike, joined: fewer pieces to measure and draw. */
function merge(runs: readonly Inline[]): Inline[] {
  const out: Inline[] = []
  for (const run of runs) {
    const last = out[out.length - 1]
    if (
      last &&
      !last.image &&
      !run.image &&
      !last.linkIcon &&
      !run.linkIcon &&
      !last.math &&
      !run.math &&
      !last.host &&
      !run.host &&
      last.flags === run.flags &&
      last.text !== '\n' &&
      run.text !== '\n' &&
      (run.flags & (CODE | TAG)) === 0
    ) {
      out[out.length - 1] = { text: last.text + run.text, flags: run.flags }
    } else {
      out.push(run)
    }
  }
  return out
}
