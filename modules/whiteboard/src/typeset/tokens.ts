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

export type TextStyle = FontFace &
  Readonly<{
    color: string
    /** The line box, in world pixels. */
    lineHeight: number
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
  highlight: string
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
    titleWeight: number
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
    color: string
    background: string
    radius: number
    padX: number
    padY: number
    wrap: boolean
  }>
  table: Readonly<{
    border: string
    borderWidth: number
    padX: number
    padY: number
    headerWeight: number
    /** Above and below the table. */
    marginY: number
  }>
  rule: Readonly<{ color: string; thickness: number }>
  /** What an embed's placeholder is filled with. */
  embed: string
}>
