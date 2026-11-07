// The typesetter's own model of a card's markdown: what ./parse.ts makes of
// the source, what ./layout.ts lays out. Only what a card shows has a place
// here — a block a card cannot draw becomes the nearest one it can (an
// unknown embed a placeholder, raw HTML its text).
//
// No DOM, no packages: the model crosses into a Worker in phase four
// (docs: the whiteboard GPU renderer plan), and everything here is plain
// data so it can.

import type { TableAlign } from './tokens'

/** How a run of text is set, as bits: a run can be several at once. */
export const BOLD = 1
export const ITALIC = 2
export const STRIKE = 4
export const CODE = 8
export const LINK = 16
export const TAG = 32
export const HIGHLIGHT = 64

/** An image set in a line of text, as the host sets an image embed: on
 * the baseline, as wide as written (`![[a.png|200]]`, `|200x100`) or as its
 * own width, never wider than the line. */
export type InlineImage = Readonly<{
  /** What the source names it by: a link's text, or a URL. */
  target: string
  width: number | null
  height: number | null
}>

/** A run of text set one way. `'\n'` alone is a line break; a run with an
 * `image` is that image. */
export type Inline = Readonly<{
  text: string
  flags: number
  image?: InlineImage
  /** The icon a theme puts after an external link: room in the line,
   * drawn as nothing. */
  linkIcon?: true
  /** A formula (./math.ts): `$…$` in a line, laid out by MathJax. */
  math?: Readonly<{ tex: string; display: boolean }>
}>

export type ListItem = Readonly<{
  /** null for a plain item, a boolean for a task. */
  checked: boolean | null
  children: readonly Section[]
}>

export type Block =
  | Readonly<{ kind: 'paragraph'; inlines: readonly Inline[] }>
  | Readonly<{
      kind: 'heading'
      depth: 1 | 2 | 3 | 4 | 5 | 6
      inlines: readonly Inline[]
    }>
  | Readonly<{
      kind: 'list'
      ordered: boolean
      start: number
      /** Written with blank lines between its items: each item's blocks are
       * spaced apart as paragraphs are. */
      spread: boolean
      items: readonly ListItem[]
    }>
  | Readonly<{ kind: 'quote'; children: readonly Section[] }>
  | Readonly<{
      kind: 'callout'
      /** The callout's type, lower-cased (`note`, `tip`, …). */
      type: string
      title: readonly Inline[]
      children: readonly Section[]
    }>
  | Readonly<{ kind: 'code'; text: string }>
  /** A display formula (`$$…$$`) that is a paragraph of its own. */
  | Readonly<{ kind: 'math'; tex: string }>
  | Readonly<{
      kind: 'table'
      header: readonly (readonly Inline[])[]
      rows: readonly (readonly (readonly Inline[])[])[]
      /** Each column's alignment as written (`:---`, `:---:`, `---:`);
       * null where none is, and the theme's holds. */
      align: readonly (TableAlign | null)[]
    }>
  | Readonly<{ kind: 'rule' }>
  /** A block that shows nothing but still holds its place among the
   * others — an HTML comment: the blank lines after it count. */
  | Readonly<{ kind: 'nothing' }>
  | Readonly<{ kind: 'embed'; target: string }>

/** A block and the blank source lines written after it — what a card spaces
 * its blocks by (styles/cards/content.css: the preview laid out on the
 * editor's lines). */
export type Section = Readonly<{ block: Block; blankAfter: number }>
