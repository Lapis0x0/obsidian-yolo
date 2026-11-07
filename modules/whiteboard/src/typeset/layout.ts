// A card's blocks (./model.ts) laid out in its box, as a list of things to
// draw (./paint.ts). Laid out the way the card's own preview is
// (styles/cards/content.css): blocks take no margins and are spaced by the
// blank lines written after them, one body line each; a paragraph inside a
// quote, a callout or a loose list item is a body line from the next.
//
// Everything stops at the card's bottom edge: what is below it is never
// drawn, so it is never laid out either.

import {
  type InlineObjects,
  type Line,
  type Measure,
  type RunStyle,
  breakLines,
  contentWidths,
} from './breaking'
import type { MathLayout, MathPiece, MathSource } from './math'
import {
  BOLD,
  type Block,
  CODE,
  HIGHLIGHT,
  ITALIC,
  type Inline,
  LINK,
  STRIKE,
  type Section,
  TAG,
} from './model'
import type {
  BorderSide,
  CellBorders,
  FontFace,
  TableAlign,
  TextStyle,
  TypesetTokens,
} from './tokens'

export type DrawOp =
  | Readonly<{
      op: 'text'
      x: number
      /** The baseline. */
      y: number
      text: string
      font: string
      color: string
      /** A list's number: drawn, but not text of the card's — the DOM's is
       * a CSS marker, in no text node. */
      marker?: true
    }>
  | Readonly<{
      op: 'rect'
      x: number
      y: number
      w: number
      h: number
      radius: number
      color: string
    }>
  | Readonly<{
      op: 'frame'
      x: number
      y: number
      w: number
      h: number
      radius: number
      color: string
      width: number
    }>
  | Readonly<{
      op: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      color: string
      width: number
    }>
  | Readonly<{ op: 'dot'; x: number; y: number; r: number; color: string }>
  | Readonly<{
      op: 'image'
      x: number
      y: number
      w: number
      h: number
      /** What the source names it by (./model.ts's `InlineImage`). */
      target: string
      /** Its corners' radius. */
      radius: number
      /** What stands in for it where it is not drawn (a picture). */
      color: string
    }>
  | Readonly<{
      op: 'check'
      x: number
      y: number
      size: number
      color: string
    }>
  | Readonly<{
      /** A piece of a formula, as MathJax laid it out. */
      op: 'math'
      /** Its left edge, on the baseline. */
      x: number
      y: number
      /** Its em: what its lengths are in. */
      size: number
      piece: MathPiece
      /** The formula's outlines, which its shapes name by index. */
      paths: readonly string[]
      /** What a shape of no colour of its own is drawn in. */
      color: string
    }>

export function fontString(face: FontFace): string {
  return `${face.italic ? 'italic ' : ''}${face.weight} ${round(face.size)}px ${face.family}`
}

const round = (n: number): number => Math.round(n * 100) / 100

export type LayoutInput = Readonly<{
  sections: readonly Section[]
  width: number
  height: number
  tokens: TypesetTokens
  /** Bare text: its own inset (`plainInset`), and its colour when it has
   * one. */
  plain: boolean
  color: string | null
  measure: Measure
  /** The font's ascent and descent at its size, for placing a baseline in
   * its line box. */
  metrics: (font: string) => Readonly<{ ascent: number; descent: number }>
  /** An image's own size, by what the source names it; null when it is not
   * known, and the image is left out. */
  images?: (target: string) => Readonly<{ w: number; h: number }> | null
  /** A formula's layout; null when it is not laid out, and the formula is
   * left out. */
  math?: (formula: MathSource) => MathLayout | null
}>

type Ctx = Readonly<{
  ops: DrawOp[]
  tokens: TypesetTokens
  measure: Measure
  objects: InlineObjects
  metrics: LayoutInput['metrics']
  bottom: number
}>

/** Text in a block: how its runs are set, and the colour it starts from. */
type Voice = Readonly<{ style: TextStyle; color: string }>

export function layoutCard(input: LayoutInput): DrawOp[] {
  const { tokens } = input
  const ctx: Ctx = {
    ops: [],
    tokens,
    measure: input.measure,
    objects: {
      math: input.math,
      imageSize: (image, maxWidth) => {
        const own = input.images?.(image.target)
        if (!own || own.w <= 0 || own.h <= 0) return null
        // As wide as written or as itself, never wider than its line
        // (`max-width: 100%`); as tall as written, or in proportion. Its
        // frame is inside what is written, around what it is itself
        // (`border-box`).
        const b = tokens.image.border.width
        const w = Math.min(image.width ?? own.w + 2 * b, maxWidth)
        return {
          w,
          h: image.height ?? (Math.max(0, w - 2 * b) * own.h) / own.w + 2 * b,
        }
      },
    },
    metrics: input.metrics,
    bottom: input.height,
  }
  const inset = input.plain ? tokens.plainInset : tokens.inset
  const left = inset.left
  const right = input.width - inset.right
  layoutSections(
    ctx,
    input.sections,
    left,
    right,
    inset.top,
    { style: tokens.body, color: input.color ?? tokens.body.color },
    null,
  )
  return ctx.ops
}

/**
 * Lays out a run of blocks from `y`, returning where the last one ends.
 * `between` is the gap between blocks inside a container (a quote's, a loose
 * item's); null spaces them by their blank lines, as the card itself does.
 */
function layoutSections(
  ctx: Ctx,
  sections: readonly Section[],
  left: number,
  right: number,
  y: number,
  voice: Voice,
  between: number | null,
): number {
  const line = ctx.tokens.body.lineHeight
  sections.forEach((section, i) => {
    if (y >= ctx.bottom) return
    y = layoutBlock(ctx, section.block, left, right, y, voice)
    if (i < sections.length - 1) {
      y += between ?? section.blankAfter * line
    }
  })
  return y
}

function layoutBlock(
  ctx: Ctx,
  block: Block,
  left: number,
  right: number,
  y: number,
  voice: Voice,
): number {
  const { tokens } = ctx
  switch (block.kind) {
    case 'paragraph':
      return layoutText(ctx, block.inlines, left, right, y, voice)
    case 'heading': {
      const style = tokens.headings[block.depth - 1]
      return layoutText(ctx, block.inlines, left, right, y, {
        style,
        color: voice.color === tokens.body.color ? style.color : voice.color,
      })
    }
    case 'list':
      return layoutList(ctx, block, left, right, y, voice)
    case 'quote': {
      const { quote } = tokens
      const top = y
      const end = layoutSections(
        ctx,
        block.children,
        left + quote.left + quote.indent,
        right - quote.right,
        y,
        { style: voice.style, color: quote.color },
        tokens.body.lineHeight,
      )
      ctx.ops.push({
        op: 'rect',
        x: left + quote.left,
        y: top,
        w: quote.barWidth,
        h: Math.min(end, ctx.bottom) - top,
        radius: 0,
        color: quote.barColor,
      })
      return end
    }
    case 'callout':
      return layoutCallout(ctx, block, left, right, y, voice)
    case 'code':
      return layoutCode(ctx, block.text, left, right, y)
    case 'math':
      return layoutDisplayMath(ctx, block.tex, left, right, y, voice)
    case 'table':
      return layoutTable(ctx, block, left, right, y, voice)
    case 'nothing':
    case 'host':
      return y
    case 'rule': {
      const { rule } = tokens
      const h = tokens.body.lineHeight
      const mid = y + h / 2
      ctx.ops.push({
        op: 'rect',
        x: left,
        y: mid - rule.thickness / 2,
        w: right - left,
        h: rule.thickness,
        radius: 0,
        color: rule.color,
      })
      return y + h
    }
    case 'embed': {
      // Its own height is not known without the file: a block of a few
      // lines stands for it.
      const h = tokens.body.lineHeight * 4
      ctx.ops.push({
        op: 'rect',
        x: left,
        y,
        w: right - left,
        h,
        radius: 6,
        color: tokens.embed,
      })
      return y + h
    }
  }
}

/** How a run is set in `voice`. */
function faceOf(tokens: TypesetTokens, voice: Voice, flags: number): FontFace {
  const base = voice.style
  let face: FontFace = base
  if (flags & BOLD)
    face = { ...face, weight: Math.max(face.weight, tokens.boldWeight) }
  if (flags & ITALIC) face = { ...face, italic: true }
  if (flags & CODE) {
    face = {
      ...face,
      family: tokens.code.family ?? face.family,
      size: base.size * tokens.code.scale,
    }
  } else if (flags & TAG) {
    face = {
      ...face,
      family: tokens.tag.family ?? face.family,
      size: base.size * tokens.tag.scale,
    }
  }
  return face
}

function colorOf(tokens: TypesetTokens, voice: Voice, flags: number): string {
  if (flags & TAG) return tokens.tag.color
  if (flags & LINK) return tokens.linkColor
  if (flags & CODE) return tokens.code.color
  return voice.color
}

function styler(
  tokens: TypesetTokens,
  voice: Voice,
): (flags: number) => RunStyle {
  const cache = new Map<number, RunStyle>()
  return (flags) => {
    let style = cache.get(flags)
    if (!style) {
      style = {
        font: fontString(faceOf(tokens, voice, flags)),
        padX:
          flags & CODE
            ? tokens.code.padX
            : flags & TAG
              ? tokens.tag.padX
              : flags & HIGHLIGHT
                ? tokens.highlight.padX
                : 0,
        linkIcon: tokens.linkIcon,
      }
      cache.set(flags, style)
    }
    return style
  }
}

/** Lays out runs of text as lines from `y`; returns where they end. */
function layoutText(
  ctx: Ctx,
  inlines: readonly Inline[],
  left: number,
  right: number,
  y: number,
  voice: Voice,
  firstLine?: (line: Line, top: number, baseline: number) => void,
  align: TableAlign = 'left',
): number {
  const lines = breakLines(
    inlines,
    Math.max(1, right - left),
    styler(ctx.tokens, voice),
    ctx.measure,
    ctx.objects,
    voice.style.breakSpaces === true,
  )
  const lineHeight = voice.style.lineHeight
  const below = lineHeight - voice.style.baseline
  lines.forEach((line, i) => {
    if (y >= ctx.bottom) return
    const normal = y + voice.style.baseline
    // An image stands on the baseline: one taller than the line above it
    // pushes the baseline down, and the line with it; a formula reaching
    // further below it than the line does pushes the next line down.
    const tallest = Math.max(0, ...line.pieces.map((p) => p.height ?? 0))
    const deepest = Math.max(0, ...line.pieces.map((p) => p.depth ?? 0))
    const baseline = Math.max(normal, y + tallest)
    if (i === 0) firstLine?.(line, y, baseline)
    const spare = Math.max(0, right - left - line.width)
    const shift = align === 'center' ? spare / 2 : align === 'right' ? spare : 0
    drawLine(ctx, line, left + shift, baseline, lineHeight, voice)
    y = baseline + Math.max(below, deepest)
  })
  return y
}

function drawLine(
  ctx: Ctx,
  line: Line,
  left: number,
  baseline: number,
  lineHeight: number,
  voice: Voice,
): void {
  const { tokens, ops } = ctx
  line.pieces.forEach((piece, index) => {
    const x = left + piece.x
    if (piece.icon) return
    if (piece.math) {
      const layout = ctx.objects.math?.(piece.math.formula)
      const part = layout?.pieces[piece.math.piece]
      if (!layout || !part) return
      ops.push({
        op: 'math',
        x,
        y: baseline,
        size: part.width > 0 ? piece.width / part.width : 0,
        piece: part,
        paths: layout.paths,
        color: colorOf(tokens, voice, piece.flags),
      })
      return
    }
    if (piece.image) {
      const h = piece.height ?? 0
      const { border, radius } = tokens.image
      const b = border.width
      if (b > 0) {
        // A stroke centred on its path: half a border in from the edge.
        ops.push({
          op: 'frame',
          x: x + b / 2,
          y: baseline - h + b / 2,
          w: piece.width - b,
          h: h - b,
          radius: Math.max(0, radius - b / 2),
          width: b,
          color: border.color,
        })
      }
      ops.push({
        op: 'image',
        x: x + b,
        y: baseline - h + b,
        w: Math.max(0, piece.width - 2 * b),
        h: Math.max(0, h - 2 * b),
        target: piece.image.target,
        radius: Math.max(0, radius - b),
        color: tokens.embed,
      })
      return
    }
    const { ascent, descent } = ctx.metrics(piece.font)
    // A highlight's box runs under every piece of it on the line: drawn
    // once, at its first.
    if (
      piece.flags & HIGHLIGHT &&
      !(line.pieces[index - 1]?.flags & HIGHLIGHT)
    ) {
      let end = index
      while (line.pieces[end + 1]?.flags & HIGHLIGHT) end += 1
      const last = line.pieces[end]
      const h = tokens.highlight
      ops.push({
        op: 'rect',
        x,
        y: baseline - ascent - h.padY,
        w: last.x + last.width - piece.x,
        h: ascent + descent + h.padY * 2,
        radius: h.radius,
        color: h.background,
      })
    }
    if (piece.flags & (CODE | TAG)) {
      const pill = piece.flags & CODE ? tokens.code : tokens.tag
      const h = Math.min(lineHeight, (ascent + descent) * 1.15)
      ops.push({
        op: 'rect',
        x,
        y: baseline - ascent - (h - ascent - descent) / 2,
        w: piece.width,
        h,
        radius: pill.radius,
        color: pill.background,
      })
    }
    const color = colorOf(tokens, voice, piece.flags)
    ops.push({
      op: 'text',
      x: x + piece.padLeft,
      y: baseline,
      text: piece.text,
      font: piece.font,
      color,
    })
    if (piece.flags & STRIKE) {
      const mid = baseline - ascent * 0.32
      ops.push({
        op: 'line',
        x1: x,
        y1: mid,
        x2: x + piece.width,
        y2: mid,
        color,
        width: Math.max(1, voice.style.size / 14),
      })
    }
  })
}

/**
 * A display formula: a block of its own, its margin and padding above and
 * below, each
 * piece a line centred in the block — taller than the line where the
 * formula is, as a line with an inline block in it is (`layoutText`). One
 * wider than the block starts at its left and runs past its right.
 */
function layoutDisplayMath(
  ctx: Ctx,
  tex: string,
  left: number,
  right: number,
  y: number,
  voice: Voice,
): number {
  const layout = ctx.objects.math?.({ tex, display: true })
  if (!layout) return y
  const { style } = voice
  const em = style.size
  // Its container's margin and padding, outside the lines.
  const margin = (ctx.tokens.math.margin + ctx.tokens.math.padding) * em
  const below = style.lineHeight - style.baseline
  let top = y + margin
  for (const piece of layout.pieces) {
    const baseline = top + Math.max(style.baseline, piece.height * em)
    const w = piece.width * em
    ctx.ops.push({
      op: 'math',
      x: left + Math.max(0, (right - left - w) / 2),
      y: baseline,
      size: em,
      piece,
      paths: layout.paths,
      color: voice.color,
    })
    top = baseline + Math.max(below, piece.depth * em)
  }
  return top + margin
}

function layoutList(
  ctx: Ctx,
  list: Extract<Block, { kind: 'list' }>,
  left: number,
  right: number,
  y: number,
  voice: Voice,
): number {
  const { tokens } = ctx
  const { list: L, task } = tokens
  const textLeft = left + L.indent
  list.items.forEach((item, index) => {
    if (y >= ctx.bottom) return
    y += L.padY
    const isTask = item.checked !== null
    const contentLeft = isTask ? textLeft + task.textX : textLeft
    const itemVoice: Voice =
      item.checked === true
        ? { style: voice.style, color: task.doneColor }
        : voice
    const start = y
    const end = layoutSections(
      ctx,
      item.checked === true && task.doneStrike
        ? item.children.map((s) => ({ ...s, block: struck(s.block) }))
        : item.children,
      contentLeft,
      right,
      y,
      itemVoice,
      list.spread ? tokens.body.lineHeight : 0,
    )
    // The marker sits on the item's first line.
    const lineHeight = voice.style.lineHeight
    const centre = start + lineHeight / 2
    if (isTask) {
      const x = textLeft + task.boxX
      const top = centre - task.size / 2
      if (item.checked && task.checked !== null) {
        ctx.ops.push({
          op: 'rect',
          x,
          y: top,
          w: task.size,
          h: task.size,
          radius: task.radius,
          color: task.checked,
        })
      } else {
        // Unticked, or ticked by a mark over an outline only.
        ctx.ops.push({
          op: 'frame',
          x: x + task.borderWidth / 2,
          y: top + task.borderWidth / 2,
          w: task.size - task.borderWidth,
          h: task.size - task.borderWidth,
          radius: task.radius,
          color: task.border,
          width: task.borderWidth,
        })
      }
      if (item.checked) {
        ctx.ops.push({
          op: 'check',
          x,
          y: top,
          size: task.size,
          color: task.mark,
        })
      }
    } else if (list.ordered) {
      const label = `${list.start + index}.`
      const font = fontString(voice.style)
      const width = ctx.measure(label, font)
      ctx.ops.push({
        op: 'text',
        x: textLeft + L.numberRight - width,
        y: start + voice.style.baseline,
        text: label,
        font,
        color: L.numberColor,
        marker: true,
      })
    } else {
      ctx.ops.push({
        op: 'dot',
        x: textLeft + L.bulletX,
        y: centre,
        r: L.bulletRadius,
        color: L.bulletColor,
      })
    }
    // A loose item's last paragraph keeps a line below it, but the last
    // item's (styles/cards/content.css).
    const last = item.children[item.children.length - 1]?.block
    const after =
      list.spread && index < list.items.length - 1 && last?.kind === 'paragraph'
        ? tokens.body.lineHeight
        : 0
    y = Math.max(end, start + lineHeight) + after + L.padY
  })
  return y
}

/** A done task's text, struck through. */
function struck(block: Block): Block {
  if (block.kind !== 'paragraph') return block
  return {
    kind: 'paragraph',
    inlines: block.inlines.map((i) =>
      i.text === '\n' ? i : { text: i.text, flags: i.flags | STRIKE },
    ),
  }
}

function layoutCallout(
  ctx: Ctx,
  callout: Extract<Block, { kind: 'callout' }>,
  left: number,
  right: number,
  y: number,
  voice: Voice,
): number {
  const { tokens } = ctx
  const c = tokens.callout
  const look = c.types[callout.type] ??
    c.types.note ?? { color: tokens.linkColor, background: 'transparent' }
  const color = look.color
  const background: Extract<DrawOp, { op: 'rect' }> = {
    op: 'rect',
    x: left,
    y,
    w: right - left,
    h: 0,
    radius: c.radius,
    color: look.background,
  }
  const at = ctx.ops.length
  ctx.ops.push(background)
  const inner = { left: left + c.padX, right: right - c.padX }
  let cursor = y + c.padY
  const titleStyle = c.title
  // The title row: the icon's place, then the title.
  const icon = c.icon
  cursor = layoutText(
    ctx,
    callout.title,
    inner.left + c.titleIndent,
    inner.right,
    cursor,
    { style: titleStyle, color },
    (_line, top) => {
      ctx.ops.push({
        op: 'rect',
        x: inner.left,
        y: top + (titleStyle.lineHeight - icon) / 2,
        w: icon,
        h: icon,
        radius: icon / 4,
        color: withAlpha(color, 0.35),
      })
    },
  )
  if (callout.children.length > 0) {
    cursor += c.titleGap
    cursor = layoutSections(
      ctx,
      callout.children,
      inner.left,
      inner.right,
      cursor,
      voice,
      tokens.body.lineHeight,
    )
  }
  cursor += callout.children.length > 0 ? c.padBottom : c.padY
  ctx.ops[at] = { ...background, h: cursor - y }
  return cursor
}

function layoutCode(
  ctx: Ctx,
  text: string,
  left: number,
  right: number,
  y: number,
): number {
  const { codeBlock: c } = ctx.tokens
  const style: TextStyle = {
    family: c.family,
    size: c.size,
    weight: 400,
    italic: false,
    color: c.color,
    lineHeight: c.lineHeight,
    baseline: c.baseline,
  }
  const font = fontString(style)
  const inner = { left: left + c.padX, right: right - c.padX }
  const at = ctx.ops.length
  const box: Extract<DrawOp, { op: 'rect' }> = {
    op: 'rect',
    x: left,
    y,
    w: right - left,
    h: 0,
    radius: c.radius,
    color: c.background,
  }
  ctx.ops.push(box)
  let cursor = y + c.padY
  const source = text.replace(/\t/g, '    ').split('\n')
  for (const raw of source) {
    if (cursor >= ctx.bottom) break
    const lines = c.wrap
      ? breakLines(
          [{ text: raw === '' ? ' ' : raw, flags: 0 }],
          Math.max(1, inner.right - inner.left),
          () => ({ font, padX: 0, linkIcon: 0 }),
          ctx.measure,
        )
      : [
          {
            pieces: [{ text: raw, flags: 0, font, x: 0, width: 0, padLeft: 0 }],
            width: 0,
          },
        ]
    for (const line of lines) {
      const baseline = cursor + c.baseline
      for (const piece of line.pieces) {
        if (piece.text === '') continue
        ctx.ops.push({
          op: 'text',
          x: inner.left + piece.x,
          y: baseline,
          text: piece.text,
          font,
          color: c.color,
        })
      }
      cursor += c.lineHeight
    }
  }
  cursor += c.padY
  ctx.ops[at] = { ...box, h: cursor - y }
  return cursor
}

function layoutTable(
  ctx: Ctx,
  table: Extract<Block, { kind: 'table' }>,
  left: number,
  right: number,
  y: number,
  voice: Voice,
): number {
  const { tokens } = ctx
  const t = tokens.table
  const rows = [table.header, ...table.rows]
  const columns = Math.max(0, ...rows.map((row) => row.length))
  if (columns === 0) return y
  const voiceOf = (style: TextStyle): Voice => ({
    style,
    color: voice.color === tokens.body.color ? style.color : voice.color,
  })
  const headVoice = voiceOf(t.header)
  const cellVoice = voiceOf(t.cell)
  const rowVoice = (r: number) => (r === 0 ? headVoice : cellVoice)
  const grid = tableGrid(t, rows.length, columns)

  // Columns: how much of each is not its content (padding, borders), and
  // how wide its content wants to be.
  const chrome = Array.from(
    { length: columns },
    (_, c) => t.padX * 2 + grid.left(c) + grid.right(c),
  )
  const widths = columnWidths(
    ctx,
    rows,
    chrome,
    right - left - grid.outerX,
    rowVoice,
  )
  const xs = [left + grid.startX]
  widths.forEach((w, c) => xs.push(xs[c] + w + grid.gapX))
  const tableRight = xs[columns] - grid.gapX + grid.endX

  y += t.marginY
  const tableTop = y
  let cursor = y + grid.startY
  const fills: DrawOp[] = []
  const borders: DrawOp[] = []
  rows.forEach((row, r) => {
    if (cursor >= ctx.bottom) return
    const themed = r === 0 ? t.headerAlign : t.align
    const under = ctx.ops.length
    // A row is as tall as its tallest cell.
    let tallest = rowVoice(r).style.lineHeight + t.padY * 2
    const top = cursor + grid.top(r)
    widths.forEach((width, c) => {
      const x = xs[c] + grid.left(c)
      const end = layoutText(
        ctx,
        row[c] ?? [],
        x + t.padX,
        x + width - grid.left(c) - grid.right(c) - t.padX,
        top + t.padY,
        rowVoice(r),
        undefined,
        table.align[c] ?? themed,
      )
      tallest = Math.max(tallest, end - top + t.padY)
    })
    const height = grid.top(r) + tallest + grid.bottom(r)
    const fill = r === 0 ? t.headerBackground : t.rowBackgrounds[(r - 1) % 2]
    if (paints(fill)) {
      fills.push({
        op: 'rect',
        x: xs[0],
        y: cursor,
        w: xs[columns] - grid.gapX - xs[0],
        h: height,
        radius: 0,
        color: fill,
      })
    }
    // The row's fill goes under its text.
    ctx.ops.splice(under, 0, ...fills.splice(0))
    borders.push(...grid.cellBorders(r, xs, widths, cursor, height))
    cursor += height + grid.gapY
  })
  const tableBottom = cursor - grid.gapY + grid.endY
  ctx.ops.push(
    ...borders,
    ...grid.frame(
      left,
      tableTop,
      tableRight,
      Math.min(tableBottom, ctx.bottom),
    ),
  )
  return tableBottom + t.marginY
}

type TableTokens = TypesetTokens['table']

/**
 * Where a table's borders and cells are, by the stylesheet's model: with
 * `border-collapse: separate` each cell has its own borders inside its box,
 * `spacing` apart and the table's frame round them all; collapsed, a cell's
 * border and its neighbour's (or the frame) are one line as wide as the
 * wider, centred on where they meet, and each cell keeps half of it.
 */
function tableGrid(t: TableTokens, rows: number, columns: number) {
  const sides = (r: number, c: number): CellBorders => {
    const group = r === 0 ? t.borders.header : t.borders.body
    if (columns === 1) {
      const [top, , bottom, leftSide] = group.first
      return [top, group.last[1], bottom, leftSide]
    }
    if (c === 0) return group.first
    if (c === columns - 1) return group.last
    const [top, rightSide, bottom] = group.first
    return [top, rightSide, bottom, group.last[3]]
  }
  const frame = t.frame.width
  if (!t.collapse) {
    const s = t.spacing
    // Rows of one kind are alike: the body's first row stands for all.
    const at = (r: number) => (r === 0 ? 0 : 1)
    return {
      startX: frame + s,
      endX: s + frame,
      startY: frame + s,
      endY: s + frame,
      gapX: s,
      gapY: s,
      outerX: frame * 2 + s * (columns + 1),
      left: (c: number) => Math.max(sides(1, c)[3].width, sides(0, c)[3].width),
      right: (c: number) =>
        Math.max(sides(1, c)[1].width, sides(0, c)[1].width),
      top: (r: number) => sides(at(r), 0)[0].width,
      bottom: (r: number) => sides(at(r), 0)[2].width,
      cellBorders: (
        r: number,
        xs: readonly number[],
        widths: readonly number[],
        y: number,
        height: number,
      ): DrawOp[] =>
        widths.flatMap((w, c) => boxBorders(sides(r, c), xs[c], y, w, height)),
      frame: (x1: number, y1: number, x2: number, y2: number): DrawOp[] =>
        boxBorders(
          [t.frame, t.frame, t.frame, t.frame],
          x1,
          y1,
          x2 - x1,
          y2 - y1,
        ),
    }
  }
  // Collapsed: one line where two meet.
  const vertical = (c: number): BorderSide => {
    const candidates: BorderSide[] = []
    for (const r of [0, 1]) {
      if (c > 0) candidates.push(sides(r, c - 1)[1])
      if (c < columns) candidates.push(sides(r, c)[3])
    }
    if (c === 0 || c === columns) candidates.push(t.frame)
    return widest(candidates)
  }
  const horizontal = (r: number): BorderSide => {
    const candidates: BorderSide[] = []
    if (r > 0) candidates.push(sides(Math.min(r - 1, 1), 0)[2])
    if (r < rows) candidates.push(sides(Math.min(r, 1), 0)[0])
    if (r === 0 || r === rows) candidates.push(t.frame)
    return widest(candidates)
  }
  return {
    startX: vertical(0).width / 2,
    endX: vertical(columns).width / 2,
    startY: 0,
    endY: 0,
    gapX: 0,
    gapY: 0,
    outerX: (vertical(0).width + vertical(columns).width) / 2,
    left: (c: number) => vertical(c).width / 2,
    right: (c: number) => vertical(c + 1).width / 2,
    top: (r: number) => horizontal(r).width / 2,
    bottom: (r: number) => horizontal(r + 1).width / 2,
    cellBorders: (
      r: number,
      xs: readonly number[],
      widths: readonly number[],
      y: number,
      height: number,
    ): DrawOp[] => {
      const out: DrawOp[] = []
      const x2 = xs[widths.length]
      const line = horizontal(r)
      if (line.width > 0) {
        out.push(band(xs[0], y - line.width / 2, x2 - xs[0], line.width, line))
      }
      if (r === rows - 1) {
        const last = horizontal(rows)
        if (last.width > 0) {
          out.push(
            band(
              xs[0],
              y + height - last.width / 2,
              x2 - xs[0],
              last.width,
              last,
            ),
          )
        }
      }
      for (let c = 0; c <= widths.length; c += 1) {
        const side = vertical(c)
        if (side.width <= 0) continue
        out.push(band(xs[c] - side.width / 2, y, side.width, height, side))
      }
      return out
    },
    frame: (): DrawOp[] => [],
  }
}

function widest(sides: readonly BorderSide[]): BorderSide {
  return sides.reduce((a, b) => (b.width > a.width ? b : a), {
    width: 0,
    color: 'transparent',
  })
}

/** A filled band: a border drawn as the box it is. */
function band(
  x: number,
  y: number,
  w: number,
  h: number,
  side: BorderSide,
): DrawOp {
  return { op: 'rect', x, y, w, h, radius: 0, color: side.color }
}

/** A box's own borders, inside it. */
function boxBorders(
  [top, right, bottom, left]: CellBorders,
  x: number,
  y: number,
  w: number,
  h: number,
): DrawOp[] {
  const out: DrawOp[] = []
  if (top.width > 0) out.push(band(x, y, w, top.width, top))
  if (bottom.width > 0) {
    out.push(band(x, y + h - bottom.width, w, bottom.width, bottom))
  }
  if (left.width > 0) out.push(band(x, y, left.width, h, left))
  if (right.width > 0) {
    out.push(band(x + w - right.width, y, right.width, h, right))
  }
  return out
}

/**
 * A table's columns, as the browser's automatic table layout sizes them:
 * each at least as wide as the widest piece of its cells no line can break
 * inside (and a theme's least cell width), at most as wide as its longest
 * line, its padding and borders (`chrome`) included. The table takes the
 * room there is between the two, and a column gets its share of what is
 * over its least by how much more it would take — so a table that cannot
 * fit at its least is wider than the card, and cut off by it, as the
 * browser's is.
 */
function columnWidths(
  ctx: Ctx,
  rows: readonly (readonly (readonly Inline[])[])[],
  chrome: readonly number[],
  room: number,
  voiceOf: (row: number) => Voice,
): number[] {
  const t = ctx.tokens.table
  const min = [...chrome]
  const max = [...chrome]
  rows.forEach((row, r) => {
    const style = styler(ctx.tokens, voiceOf(r))
    const least = r === 0 ? t.headerMinWidth : t.minWidth
    row.forEach((cell, c) => {
      if (c >= chrome.length) return
      const widths = contentWidths(
        cell,
        style,
        ctx.measure,
        ctx.objects,
        voiceOf(r).style.breakSpaces === true,
      )
      min[c] = Math.max(min[c], least, widths.min + chrome[c])
      max[c] = Math.max(max[c], widths.max + chrome[c], min[c])
    })
  })
  const sumMin = min.reduce((a, b) => a + b, 0)
  const sumMax = max.reduce((a, b) => a + b, 0)
  const width = Math.min(sumMax, Math.max(sumMin, room))
  if (sumMax <= sumMin) return max
  const share = (width - sumMin) / (sumMax - sumMin)
  return min.map((m, c) => m + (max[c] - m) * share)
}

/** Whether a computed colour paints anything. */
function paints(color: string): boolean {
  return !(
    color === 'transparent' ||
    /,\s*0\)$/.test(color) ||
    /\/\s*0\)$/.test(color)
  )
}

/** `color` at `alpha` of its own opacity, for a colour a canvas reads as
 * `rgb()`/`rgba()`; anything else is returned as it is. */
export function withAlpha(color: string, alpha: number): string {
  const match =
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      color.trim(),
    )
  if (!match) return color
  const a0 =
    match[4] === undefined
      ? 1
      : match[4].endsWith('%')
        ? Number.parseFloat(match[4]) / 100
        : Number.parseFloat(match[4])
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${round(a0 * alpha)})`
}
