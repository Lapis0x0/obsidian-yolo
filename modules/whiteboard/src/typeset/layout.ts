// A card's blocks (./model.ts) laid out in its box, as a list of things to
// draw (./paint.ts). Laid out the way the card's own preview is
// (styles/cards/content.css): blocks take no margins and are spaced by the
// blank lines written after them, one body line each; a paragraph inside a
// quote, a callout or a loose list item is a body line from the next.
//
// Everything stops at the card's bottom edge: what is below it is never
// drawn, so it is never laid out either.

import { type Line, type Measure, type RunStyle, breakLines } from './breaking'
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
import type { FontFace, TextStyle, TypesetTokens } from './tokens'

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
      op: 'check'
      x: number
      y: number
      size: number
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
}>

type Ctx = Readonly<{
  ops: DrawOp[]
  tokens: TypesetTokens
  measure: Measure
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
        left + quote.indent,
        right,
        y,
        { style: voice.style, color: quote.color },
        tokens.body.lineHeight,
      )
      ctx.ops.push({
        op: 'rect',
        x: left,
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
    case 'table':
      return layoutTable(ctx, block, left, right, y, voice)
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
          flags & CODE ? tokens.code.padX : flags & TAG ? tokens.tag.padX : 0,
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
): number {
  const lines = breakLines(
    inlines,
    Math.max(1, right - left),
    styler(ctx.tokens, voice),
    ctx.measure,
  )
  const lineHeight = voice.style.lineHeight
  lines.forEach((line, i) => {
    if (y >= ctx.bottom) return
    const baseline = baselineIn(ctx, fontString(voice.style), y, lineHeight)
    if (i === 0) firstLine?.(line, y, baseline)
    drawLine(ctx, line, left, baseline, lineHeight, voice)
    y += lineHeight
  })
  return y
}

function baselineIn(
  ctx: Ctx,
  font: string,
  top: number,
  lineHeight: number,
): number {
  // Whole pixels, as the browser keeps a font's ascent and descent: a
  // baseline placed with the font's own fractions sits a fraction lower
  // than the card's.
  const { ascent, descent } = ctx.metrics(font)
  const a = Math.round(ascent)
  const d = Math.round(descent)
  return top + (lineHeight - (a + d)) / 2 + a
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
  for (const piece of line.pieces) {
    const x = left + piece.x
    const { ascent, descent } = ctx.metrics(piece.font)
    if (piece.flags & HIGHLIGHT) {
      ops.push({
        op: 'rect',
        x,
        y: baseline - ascent,
        w: piece.width,
        h: ascent + descent,
        radius: 2,
        color: tokens.highlight,
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
  }
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
        y: baselineIn(ctx, font, start, lineHeight),
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
    y = Math.max(end, start + lineHeight) + L.padY
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
  const titleStyle: TextStyle = { ...voice.style, weight: c.titleWeight }
  // The title row: the icon's place, then the title.
  const icon = titleStyle.size * 1.1
  cursor = layoutText(
    ctx,
    callout.title,
    inner.left + icon + titleStyle.size * 0.4,
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
          () => ({ font, padX: 0 }),
          ctx.measure,
        )
      : [
          {
            pieces: [{ text: raw, flags: 0, font, x: 0, width: 0, padLeft: 0 }],
            width: 0,
          },
        ]
    for (const line of lines) {
      const baseline = baselineIn(ctx, font, cursor, c.lineHeight)
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
  const { table: t } = ctx.tokens
  const rows = [table.header, ...table.rows]
  const columns = Math.max(0, ...rows.map((row) => row.length))
  if (columns === 0) return y
  const headVoice: Voice = {
    style: { ...voice.style, weight: t.headerWeight },
    color: voice.color,
  }
  // Each column as wide as its widest cell on one line, shrunk evenly to
  // the card when they do not all fit — the table's own auto layout, near
  // enough.
  const natural = new Array<number>(columns).fill(0)
  rows.forEach((row, r) => {
    const style = styler(ctx.tokens, r === 0 ? headVoice : voice)
    row.forEach((cell, c) => {
      const width = cell.reduce(
        (sum, run) => sum + ctx.measure(run.text, style(run.flags).font),
        0,
      )
      natural[c] = Math.max(natural[c], width + t.padX * 2)
    })
  })
  const room = right - left
  const total = natural.reduce((a, b) => a + b, 0)
  const widths =
    total <= room ? natural : natural.map((w) => (w / total) * room)
  y += t.marginY
  let cursor = y
  const tableWidth = widths.reduce((a, b) => a + b, 0)
  rows.forEach((row, r) => {
    if (cursor >= ctx.bottom) return
    const rowVoice = r === 0 ? headVoice : voice
    let x = left
    let tallest = rowVoice.style.lineHeight + t.padY * 2
    // A row is as tall as its tallest cell.
    widths.forEach((width, c) => {
      const cell = row[c] ?? []
      const end = layoutText(
        ctx,
        cell,
        x + t.padX,
        x + width - t.padX,
        cursor + t.padY,
        rowVoice,
      )
      tallest = Math.max(tallest, end - cursor + t.padY)
      x += width
    })
    ctx.ops.push({
      op: 'line',
      x1: left,
      y1: cursor,
      x2: left + tableWidth,
      y2: cursor,
      color: t.border,
      width: t.borderWidth,
    })
    cursor += tallest
  })
  // The closing rule, and the columns' sides.
  ctx.ops.push({
    op: 'line',
    x1: left,
    y1: cursor,
    x2: left + tableWidth,
    y2: cursor,
    color: t.border,
    width: t.borderWidth,
  })
  let x = left
  for (let c = 0; c <= columns; c += 1) {
    ctx.ops.push({
      op: 'line',
      x1: x,
      y1: y,
      x2: x,
      y2: Math.min(cursor, ctx.bottom),
      color: t.border,
      width: t.borderWidth,
    })
    x += widths[c] ?? 0
  }
  return cursor + t.marginY
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
