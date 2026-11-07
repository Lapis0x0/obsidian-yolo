// MathJax's SVG output, read into a layout (../../../src/core/runtime-components/contracts.ts's
// `MathLayout`): what a formula draws, as paths, rectangles and text, with
// no SVG or DOM left in it.
//
// The output is a container of one `<svg>` per piece, a `<mjx-break>`
// between two where inline math may wrap. Inside a piece, groups carry
// transforms and colours down to the shapes: glyphs as `<path>`, rules as
// `<rect>`, a `\cancel` stroke as `<line>`, a `\boxed` frame as an unfilled
// `<rect>`, and text the font has no glyph for as `<text>`. What is drawn
// any other way (an `\enclose{circle}`'s ellipse) gives no layout: the
// formula is left to MathJax in the DOM.

import type {
  MathLayout,
  MathPiece,
  MathShape,
} from '../../../src/core/runtime-components/contracts'

/** The lite DOM's reading methods, as much of them as is used here. */
export type LiteReader = Readonly<{
  kind(node: unknown): string
  childNodes(node: unknown): unknown[]
  getAttribute(node: unknown, name: string): string | null | undefined
  textContent(node: unknown): string
}>

type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** MathJax's units: a thousand to the em. */
const UNITS = 1000

/** The room `<mjx-break size="n">` leaves, in ems: MathJax's own spaces,
 * from none to a thick one and a third. */
const BREAK_SPACES = [0.001, 0.111, 0.167, 0.222, 0.278, 0.333]

class NotShapes extends Error {}

/** A formula's layout from what MathJax made of it, or null when something
 * in it is not drawn as these shapes. */
export function readLayout(
  lite: LiteReader,
  container: unknown,
): MathLayout | null {
  const paths: string[] = []
  const pathIndex = new Map<string, number>()
  const pathOf = (d: string): number => {
    let index = pathIndex.get(d)
    if (index === undefined) {
      index = paths.length
      pathIndex.set(d, index)
      paths.push(d)
    }
    return index
  }
  const pieces: MathPiece[] = []
  try {
    for (const node of lite.childNodes(container)) {
      const kind = lite.kind(node)
      if (kind === 'svg') {
        pieces.push(readPiece(lite, node, pathOf))
        continue
      }
      // A `prebreak` only marks where a forced break's line ends.
      if (kind !== 'mjx-break' || has(lite, node, 'prebreak')) continue
      const last = pieces.pop()
      if (last) pieces.push({ ...last, after: breakAfter(lite, node) })
    }
  } catch (error) {
    if (error instanceof NotShapes) return null
    throw error
  }
  return pieces.length > 0 ? { paths, pieces } : null
}

function breakAfter(lite: LiteReader, node: unknown): number | 'newline' {
  if (has(lite, node, 'newline')) return 'newline'
  const size = lite.getAttribute(node, 'size')
  if (size !== null && size !== undefined) {
    return BREAK_SPACES[Number(size)] ?? 0
  }
  // A space MathJax has no size for: its letter-spacing, less the space
  // character's em.
  const style = lite.getAttribute(node, 'style') ?? ''
  const spacing = /letter-spacing:\s*(-?[\d.]+)em/.exec(style)
  return spacing ? Number(spacing[1]) + 1 : 0
}

function readPiece(
  lite: LiteReader,
  svg: unknown,
  pathOf: (d: string) => number,
): MathPiece {
  // `viewBox="left -height width height+depth"`, in MathJax's units.
  const [left, top, width, tall] = (lite.getAttribute(svg, 'viewBox') ?? '')
    .split(/\s+/)
    .map(Number)
  if (![left, top, width, tall].every(Number.isFinite)) throw new NotShapes()
  const shapes: MathShape[] = []
  // From MathJax's units, y up from the baseline, to ems from the piece's
  // left, y down.
  const root: Matrix = [1 / UNITS, 0, 0, 1 / UNITS, -left / UNITS, 0]
  for (const child of lite.childNodes(svg)) {
    readNode(lite, child, root, null, shapes, pathOf)
  }
  return {
    width: width / UNITS,
    height: -top / UNITS,
    depth: (tall + top) / UNITS,
    after: 0,
    shapes,
  }
}

function readNode(
  lite: LiteReader,
  node: unknown,
  outer: Matrix,
  outerColor: string | null,
  shapes: MathShape[],
  pathOf: (d: string) => number,
): void {
  const kind = lite.kind(node)
  if (kind === '#text' || kind === '#comment' || kind === 'title') return
  const at = multiply(outer, transformOf(lite, node))
  const color = colorOf(lite, node) ?? outerColor
  switch (kind) {
    case 'g':
    case 'svg':
      if (kind === 'svg' && lite.getAttribute(node, 'viewBox')) {
        // A nested viewport rescales what is in it: not met in TeX output.
        throw new NotShapes()
      }
      for (const child of lite.childNodes(node)) {
        readNode(
          lite,
          child,
          kind === 'svg' ? multiply(at, translate(lite, node)) : at,
          color,
          shapes,
          pathOf,
        )
      }
      return
    case 'path': {
      const d = lite.getAttribute(node, 'd')
      if (!d) return
      shapes.push({ kind: 'path', path: pathOf(d), transform: at, color })
      return
    }
    case 'rect':
      readRect(lite, node, at, color, shapes)
      return
    case 'line':
      readLine(lite, node, at, color, shapes, pathOf)
      return
    case 'text':
      readText(lite, node, at, color, shapes)
      return
    default:
      throw new NotShapes()
  }
}

function readRect(
  lite: LiteReader,
  node: unknown,
  at: Matrix,
  color: string | null,
  shapes: MathShape[],
): void {
  const x = num(lite, node, 'x')
  const y = num(lite, node, 'y')
  const w = num(lite, node, 'width')
  const h = num(lite, node, 'height')
  if (lite.getAttribute(node, 'fill') !== 'none') {
    pushRect(shapes, at, x, y, w, h, color)
    return
  }
  // A frame: its stroke, centred on the edges, as four rules.
  const t = num(lite, node, 'stroke-width')
  if (!(t > 0)) return
  const half = t / 2
  pushRect(shapes, at, x - half, y - half, w + t, t, color)
  pushRect(shapes, at, x - half, y + h - half, w + t, t, color)
  pushRect(shapes, at, x - half, y + half, t, h - t, color)
  pushRect(shapes, at, x + w - half, y + half, t, h - t, color)
}

function pushRect(
  shapes: MathShape[],
  at: Matrix,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string | null,
): void {
  // Groups only translate and scale, so a rectangle stays one.
  if (at[1] !== 0 || at[2] !== 0) throw new NotShapes()
  const [x0, y0] = apply(at, x, y)
  const [x1, y1] = apply(at, x + w, y + h)
  shapes.push({
    kind: 'rect',
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
    color,
  })
}

/** A stroke as the quadrilateral it covers, a path of its own. */
function readLine(
  lite: LiteReader,
  node: unknown,
  at: Matrix,
  color: string | null,
  shapes: MathShape[],
  pathOf: (d: string) => number,
): void {
  const x1 = num(lite, node, 'x1')
  const y1 = num(lite, node, 'y1')
  const x2 = num(lite, node, 'x2')
  const y2 = num(lite, node, 'y2')
  const t = num(lite, node, 'stroke-width')
  const length = Math.hypot(x2 - x1, y2 - y1)
  if (!(t > 0) || length === 0) return
  const nx = (-(y2 - y1) / length) * (t / 2)
  const ny = ((x2 - x1) / length) * (t / 2)
  const points = [
    [x1 + nx, y1 + ny],
    [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny],
    [x1 - nx, y1 - ny],
  ]
  const d = `M${points.map(([x, y]) => `${round(x)} ${round(y)}`).join('L')}Z`
  shapes.push({ kind: 'path', path: pathOf(d), transform: at, color })
}

function readText(
  lite: LiteReader,
  node: unknown,
  at: Matrix,
  color: string | null,
  shapes: MathShape[],
): void {
  const text = lite.textContent(node)
  if (text === '') return
  const size = Number.parseFloat(lite.getAttribute(node, 'font-size') ?? '')
  if (!(size > 0) || at[1] !== 0 || at[2] !== 0) throw new NotShapes()
  const [x, y] = apply(at, num(lite, node, 'x'), num(lite, node, 'y'))
  shapes.push({
    kind: 'text',
    text,
    x,
    y,
    size: size * Math.abs(at[3]),
    family: lite.getAttribute(node, 'font-family') ?? 'serif',
    italic: lite.getAttribute(node, 'font-style') === 'italic',
    bold: lite.getAttribute(node, 'font-weight') === 'bold',
    color,
  })
}

function colorOf(lite: LiteReader, node: unknown): string | null {
  const fill = lite.getAttribute(node, 'fill')
  if (fill && fill !== 'currentColor' && fill !== 'none') return fill
  const stroke = lite.getAttribute(node, 'stroke')
  if (stroke && stroke !== 'currentColor' && stroke !== 'none') return stroke
  return null
}

/** A node's `transform`, as a matrix. */
function transformOf(lite: LiteReader, node: unknown): Matrix {
  const value = lite.getAttribute(node, 'transform')
  if (!value) return IDENTITY
  let out: Matrix = IDENTITY
  for (const [, name, args] of value.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const n = args
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    let step: Matrix
    if (name === 'translate') step = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]
    else if (name === 'scale') step = [n[0], 0, 0, n[1] ?? n[0], 0, 0]
    else if (name === 'matrix' && n.length === 6) {
      step = [n[0], n[1], n[2], n[3], n[4], n[5]]
    } else throw new NotShapes()
    out = multiply(out, step)
  }
  return out
}

/** A nested `<svg>`'s place, as a translation. */
function translate(lite: LiteReader, node: unknown): Matrix {
  return [1, 0, 0, 1, num(lite, node, 'x'), num(lite, node, 'y')]
}

/** `m` after `n`: a point is mapped by `n`, then by `m`. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function num(lite: LiteReader, node: unknown, name: string): number {
  const value = Number.parseFloat(lite.getAttribute(node, name) ?? '')
  return Number.isFinite(value) ? value : 0
}

function has(lite: LiteReader, node: unknown, name: string): boolean {
  const value = lite.getAttribute(node, name)
  return value !== null && value !== undefined
}

function round(n: number): string {
  return String(Math.round(n * 10) / 10)
}
