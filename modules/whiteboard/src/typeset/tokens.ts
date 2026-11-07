// Everything ./layout.ts needs to know about how a card looks, as numbers and
// colours: read off a card the host rendered (ui/pictures/typesetStyle.ts),
// so the typesetter lays out what the stylesheet lays out rather than a copy
// of it kept in step by hand. Lengths are world pixels; colours are strings
// a canvas accepts.

export type FontFace = Readonly<{
  family: string
  /** In world pixels. */
  size: number
  weight: number
  italic: boolean
}>

export type TableAlign = 'left' | 'center' | 'right'

export type BorderSide = Readonly<{ width: number; color: string }>
/** Top, right, bottom, left. */
export type CellBorders = readonly [
  BorderSide,
  BorderSide,
  BorderSide,
  BorderSide,
]

export type TextStyle = FontFace &
  Readonly<{
    color: string
    /** The line box, in world pixels. */
    lineHeight: number
    /** From a line's top to its baseline, as the browser puts it: how it
     * shares the line's spare height out above and below the text rounds
     * in ways a font's metrics do not tell. */
    baseline: number
    /** `white-space: break-spaces` (a table cell's): spaces are kept, and
     * take their room at the end of a line. */
    breakSpaces?: boolean
  }>

export type Pill = Readonly<{
  color: string
  background: string
  /** The run's type size over the text it sits in. */
  scale: number
  family: string | null
  padX: number
  radius: number
}>

export type Insets = Readonly<{
  top: number
  right: number
  bottom: number
  left: number
}>

export type TypesetTokens = Readonly<{
  /** From the card's outer edge to where its content starts (border and
   * padding together). */
  inset: Insets
  /** The same, for bare text (fileFormat.ts's `plain`): no frame, no
   * scrollbar gutter. */
  plainInset: Insets
  body: TextStyle
  headings: readonly [
    TextStyle,
    TextStyle,
    TextStyle,
    TextStyle,
    TextStyle,
    TextStyle,
  ]
  boldWeight: number
  linkColor: string
  /** How much wider an external link is than its text: the icon a theme
   * puts after it, and its margin. */
  linkIcon: number
  /** A highlight's box (`<mark>`): its fill, and the padding and corners
   * a theme gives it, which take room in the line as a pill's do. */
  highlight: Readonly<{
    background: string
    padX: number
    padY: number
    radius: number
  }>
  muted: string
  code: Pill
  tag: Pill
  list: Readonly<{
    /** From a list's left edge to its items' text, per level. */
    indent: number
    /** From an item's text to the centre of its bullet (negative). */
    bulletX: number
    bulletRadius: number
    bulletColor: string
    /** From an item's text to the right edge of its number (negative). */
    numberRight: number
    numberColor: string
    /** Above and below each item's content. */
    padY: number
  }>
  task: Readonly<{
    /** From where an item's text would be to the box's left edge. */
    boxX: number
    size: number
    radius: number
    border: string
    borderWidth: number
    /** A ticked box's fill; null when it has none and the tick is drawn
     * over the box's outline instead. */
    checked: string | null
    mark: string
    /** From where an item's text would be to a task's text. */
    textX: number
    doneColor: string
    doneStrike: boolean
  }>
  quote: Readonly<{
    /** From the content's edges to the quote's: its own margins. */
    left: number
    right: number
    barWidth: number
    barColor: string
    /** From the quote's left edge to its text. */
    indent: number
    color: string
  }>
  callout: Readonly<{
    radius: number
    padX: number
    padY: number
    /** Below the title row, before the content. */
    titleGap: number
    /** Below the content's last line, to the callout's bottom edge. */
    padBottom: number
    /** The title's type: its own size and line, not the body's. */
    title: TextStyle
    /** Where the title's text starts, from the title row's left: past the
     * icon and the gap after it. */
    titleIndent: number
    /** The icon's size, on the title's first line. */
    icon: number
    /** Per type, its title's colour and its background; `note` stands for
     * any type not listed. */
    types: Readonly<
      Record<string, Readonly<{ color: string; background: string }>>
    >
  }>
  codeBlock: Readonly<{
    family: string
    size: number
    lineHeight: number
    /** From a line's top to its baseline (`TextStyle`'s). */
    baseline: number
    color: string
    background: string
    radius: number
    padX: number
    padY: number
    wrap: boolean
  }>
  table: Readonly<{
    /** The table's own border, all round. */
    frame: BorderSide
    /** `border-collapse: collapse`: a cell's border and its neighbour's
     * are one line, as wide as the wider; otherwise each cell has its own,
     * `spacing` apart. */
    collapse: boolean
    spacing: number
    /** Each cell's borders, a header cell's and a body cell's, in the
     * first column and the last: a theme draws a column's sides by which
     * end it is. A column between them takes the first's, but the last's
     * left side. */
    borders: Readonly<{
      header: Readonly<{ first: CellBorders; last: CellBorders }>
      body: Readonly<{ first: CellBorders; last: CellBorders }>
    }>
    padX: number
    padY: number
    /** Above and below the table. */
    marginY: number
    /** How a header cell's text and a body cell's are set and aligned. */
    header: TextStyle
    cell: TextStyle
    headerAlign: TableAlign
    align: TableAlign
    /** The least a header cell and a body cell are wide, padding included
     * (a theme's `--table-column-min-width`, in `ch` of each one's own
     * type). */
    headerMinWidth: number
    minWidth: number
    /** The header row's fill, and the body rows' in turn from the first. */
    headerBackground: string
    rowBackgrounds: readonly [string, string]
  }>
  rule: Readonly<{ color: string; thickness: number }>
  /** What an embed's placeholder is filled with. */
  embed: string
  /** An image's frame: its border, inside the size it takes (`border-box`),
   * and its corners' radius. */
  image: Readonly<{ border: BorderSide; radius: number }>
  /** An emoji's advance in the text's em: the browser lays an emoji out
   * narrower than a canvas measures it. */
  emoji: number
  /** Above and below a display formula (`$$…$$`), in its em: its
   * container's margin and, inside that, its padding, as the stylesheet
   * gives them. */
  math: Readonly<{ margin: number; padding: number }>
}>

/**
 * How far in from a card's left and right edges what it shows is cut off:
 * at its content box for a framed card — where a table or a code block too
 * wide for it is cut, by the section around it that scrolls sideways — and
 * at its own edges for bare text, which has no box of its own.
 */
export function contentClip(
  tokens: TypesetTokens,
  plain: boolean,
): Readonly<{ left: number; right: number }> {
  return plain
    ? { left: 0, right: 0 }
    : { left: tokens.inset.left, right: tokens.inset.right }
}
