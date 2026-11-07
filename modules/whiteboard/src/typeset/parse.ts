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
import { gfm } from 'micromark-extension-gfm'

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

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown
  const match = FRONTMATTER.exec(markdown)
  return match ? markdown.slice(match[0].length) : markdown
}

export function parseCard(markdown: string): Section[] {
  const tree = fromMarkdown(stripFrontmatter(markdown), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
  return sectionsOf(tree.children)
}

function sectionsOf(nodes: readonly Flow[]): Section[] {
  const out: Section[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    const block = blockOf(nodes[i])
    if (!block) continue
    const end = nodes[i].position?.end.line
    const next = nodes[i + 1]?.position?.start.line
    const blankAfter =
      end !== undefined && next !== undefined ? Math.max(0, next - end - 1) : 1
    out.push({ block, blankAfter })
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
      }
    }
    case 'thematicBreak':
      return { kind: 'rule' }
    case 'html': {
      const text = node.value.replace(/<[^>]*>/g, '').trim()
      return text === ''
        ? null
        : { kind: 'paragraph', inlines: [{ text, flags: 0 }] }
    }
    default:
      // Definitions, footnote definitions, YAML: nothing a card shows.
      return null
  }
}

function itemOf(item: MdListItem): ListItem {
  return {
    checked: typeof item.checked === 'boolean' ? item.checked : null,
    children: sectionsOf(item.children),
  }
}

function cellsOf(row: TableRow): Inline[][] {
  return row.children.map((cell) => inlinesOf(cell.children))
}

const CALLOUT_HEAD = /^\[!([^\]\s]+)\][+-]?[ \t]*/

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
  const sections = sectionsOf(rest)
  const children: Section[] =
    bodyNodes.length > 0
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
  if (only.type === 'image') return only.url
  if (only.type !== 'text') return null
  const match = SOLE_EMBED.exec(only.value.trim())
  return match ? match[1] : null
}

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
      return
    case 'image':
    case 'imageReference':
      if (node.alt) push(out, node.alt, flags | LINK, state)
      return
    case 'break':
      out.push({ text: '\n', flags: 0 })
      return
    case 'html':
      if (/^<br\s*\/?>$/i.test(node.value.trim())) {
        out.push({ text: '\n', flags: 0 })
      }
      return
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
      const bar = target.indexOf('|')
      const shown = bar === -1 ? target : target.slice(bar + 1)
      push(out, shown, flags | LINK, state)
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
