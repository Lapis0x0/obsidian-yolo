// The typesetter's own model of a card's markdown: what ./parse.ts makes of
// the source, what ./layout.ts lays out. Only what a card shows has a place
// here — a block a card cannot draw becomes the nearest one it can (an
// unknown embed a placeholder, raw HTML its text).
//
// No DOM, no packages: the model crosses into a Worker in phase four
// (docs: the whiteboard GPU renderer plan), and everything here is plain
// data so it can.

/** How a run of text is set, as bits: a run can be several at once. */
export const BOLD = 1
export const ITALIC = 2
export const STRIKE = 4
export const CODE = 8
export const LINK = 16
export const TAG = 32
export const HIGHLIGHT = 64

/** A run of text set one way. `'\n'` alone is a line break. */
export type Inline = Readonly<{ text: string; flags: number }>

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
  | Readonly<{
      kind: 'table'
      header: readonly (readonly Inline[])[]
      rows: readonly (readonly (readonly Inline[])[])[]
    }>
  | Readonly<{ kind: 'rule' }>
  | Readonly<{ kind: 'embed'; target: string }>

/** A block and the blank source lines written after it — what a card spaces
 * its blocks by (styles/cards/content.css: the preview laid out on the
 * editor's lines). */
export type Section = Readonly<{ block: Block; blankAfter: number }>
