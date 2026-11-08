// The GPU scene's (./scene.ts) glyphs: every glyph a card uses gets an id
// once, and a picture of it — drawn by the canvas with the document's fonts,
// a theme's web fonts included — in one of a few atlas pages.
//
// A glyph is drawn at the size it shows at on screen, not at one size scaled
// to every other: scaled, text is soft next to the DOM's, and at the size it
// shows it is the DOM's (the spike's S3, docs/plans). So a glyph's picture
// is redrawn when the zoom settles somewhere new (`rasterScale`), and until
// then the one it has is stretched — which is what a glyph id buys: the
// instances that name it never change, only what the id points to.
//
// What an id points to lives in a lookup texture, two texels an id:
//   [x, y, w, h]                          where on its page, device pixels
//   [left, top, raster scale, page|color] from the origin to the picture's
//                                         corner, device pixels at the scale
//                                         it was drawn at
// A raster scale of 0 is a glyph with no picture yet, which draws nothing.
//
// When the pages are full the oldest is emptied and its glyphs lose their
// pictures, to be drawn again when next asked for.

import type { PathTransform } from '../typesetting/typesetProtocol'

import { fontSize, isColorGlyph, resizeFont } from './glyphs'

/** An atlas page's edge, in device pixels. */
export const PAGE_SIZE = 2048
export const PAGE_COUNT = 4
/** Ids a row of the lookup texture holds. */
export const LOOKUP_IDS_PER_ROW = 1024
/** Clear space around a glyph's picture, so that sampling at its edge never
 * reads its neighbour's. */
const PAD = 2
/** The largest a glyph is drawn, device pixels per em: above it a glyph is
 * stretched, rather than one glyph filling a page. */
const MAX_GLYPH_PX = 128
/** The smallest; below it a glyph is too small to read anyway. */
const MIN_GLYPH_PX = 2
/** How far a picture's scale can be from the one asked for and still count
 * as drawn at it. */
const SCALE_TOLERANCE = 0.005
/** The sizes a glyph's ink is measured at, once, px per em: its bounds at
 * any size are the larger of the two in proportion. Not one: the system
 * font changes its shapes with its size (optical sizes; a "…" reaches
 * 0.18em further below 32px than above), and a picture's box must never
 * be smaller than its ink. */
const INK_PX = [12, 96] as const

type Glyph = Readonly<{
  text: string
  /** The font as the typesetter names it, at its world size. */
  font: string
  /** The em, in world units. */
  size: number
  color: boolean
  icon: 'check' | null
  /** An outline's: drawn from its path, with its transform. */
  path: Readonly<{
    shape: Path2D
    transform: PathTransform
    /** Its bounds, in world units from its origin. */
    bounds: Readonly<{
      left: number
      top: number
      right: number
      bottom: number
    }>
  }> | null
}>

type Shelf = { y: number; height: number; x: number }

/** What was drawn on one shelf since the GPU last had the page: a shelf
 * fills from the left, so what one frame adds to it is one span. */
type Span = { x0: number; x1: number; y: number; height: number }

type Page = {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  shelves: Shelf[]
  /** Drawn since the GPU last had the page, by shelf. Only these go up:
   * read back whole rows, a frame's few glyphs cost a page's width each. */
  dirty: Map<number, Span>
  /** Glyph ids whose pictures are on this page. */
  holds: Set<number>
}

export class GlyphAtlas {
  private readonly glyphs: Glyph[] = []
  /** A text glyph's ink, per px of its size: [left, ascent, right,
   * descent] as `measureText` has them. Measured the first time it is drawn,
   * not every time: a settled zoom redraws every glyph on screen. */
  private readonly inks: (readonly [number, number, number, number])[] = []
  private readonly ids = new Map<string, number>()
  private readonly pages: Page[] = []
  /** The page drawn into next. */
  private current = 0
  /** The lookup texture's contents, LOOKUP_IDS_PER_ROW * 8 floats a row. */
  private lookup = new Float32Array(LOOKUP_IDS_PER_ROW * 8 * 16)
  private lookupDirty: [number, number] | null = null
  private readonly measuring: CanvasRenderingContext2D

  constructor(private readonly doc: Document) {
    const ctx = doc.createElement('canvas').getContext('2d')
    if (!ctx) throw new Error('no 2D canvas')
    this.measuring = ctx
    for (let i = 0; i < PAGE_COUNT; i++) this.pages.push(this.newPage())
  }

  /** How many ids there are; the lookup texture holds at least these. */
  get size(): number {
    return this.glyphs.length
  }

  /** The id of `text` set in `font`. */
  glyphId(text: string, font: string): number {
    return this.idFor(`${font}\u0000${text}`, () => ({
      text,
      font,
      size: fontSize(font),
      color: isColorGlyph(text),
      icon: null,
      path: null,
    }))
  }

  /** The id of an outline (a formula's glyph) drawn with `transform`, from
   * its path's units to world units, its origin where it is placed. */
  pathId(path: string, transform: PathTransform): number {
    return this.idFor(`\u0002${transform.join(',')}\u0000${path}`, () => {
      const bounds = pathBounds(path, transform)
      return {
        text: '',
        font: '',
        // Its em, for how large it is drawn: a thousand of its units.
        size: Math.max(Math.abs(transform[0]), Math.abs(transform[3])) * 1000,
        color: false,
        icon: null,
        path: { shape: new Path2D(path), transform, bounds },
      }
    })
  }

  /** The id of an icon `size` world units across, its origin its top-left
   * corner. */
  iconId(name: 'check', size: number): number {
    return this.idFor(`\u0001${name}\u0000${size}`, () => ({
      text: '',
      font: '',
      size,
      color: false,
      icon: name,
      path: null,
    }))
  }

  /** Whether glyph `id` has a picture drawn at `scale` device pixels per
   * world unit, or as near it as it is ever drawn. */
  hasPicture(id: number, scale: number): boolean {
    const drawn = this.lookup[id * 8 + 6]
    if (drawn === 0) return false
    const wanted = this.pictureScale(id, scale)
    return Math.abs(drawn - wanted) <= wanted * SCALE_TOLERANCE
  }

  /** Whether glyph `id` has any picture at all. */
  hasAnyPicture(id: number): boolean {
    return this.lookup[id * 8 + 6] !== 0
  }

  /** Draws glyph `id`'s picture for `scale` device pixels per world unit. */
  draw(id: number, scale: number): void {
    const glyph = this.glyphs[id]
    const at = this.pictureScale(id, scale)
    const px = glyph.size * at
    let left: number
    let top: number
    let w: number
    let h: number
    if (glyph.icon) {
      left = PAD
      top = PAD
      w = Math.ceil(px) + PAD * 2
      h = w
    } else if (glyph.path) {
      const { bounds } = glyph.path
      left = Math.ceil(Math.max(0, -bounds.left * at)) + PAD
      top = Math.ceil(Math.max(0, -bounds.top * at)) + PAD
      w = left + Math.ceil(Math.max(0, bounds.right * at)) + PAD
      h = top + Math.ceil(Math.max(0, bounds.bottom * at)) + PAD
    } else {
      const [inkLeft, ascent, inkRight, descent] = glyph.color
        ? this.measure(glyph, px).map((v) => v / px)
        : this.inkOf(id)
      left = Math.ceil(Math.max(0, inkLeft * px)) + PAD
      top = Math.ceil(Math.max(0, ascent * px)) + PAD
      w = left + Math.ceil(Math.max(0, inkRight * px)) + PAD
      h = top + Math.ceil(Math.max(0, descent * px)) + PAD
    }
    const spot = this.place(w, h)
    const page = this.pages[spot.page]
    const ctx = page.ctx
    ctx.clearRect(spot.x, spot.y, w, h)
    if (glyph.icon) {
      drawCheck(ctx, spot.x + PAD, spot.y + PAD, px)
    } else if (glyph.path) {
      const [a, b, c, d] = glyph.path.transform
      ctx.save()
      ctx.setTransform(
        a * at,
        b * at,
        c * at,
        d * at,
        spot.x + left,
        spot.y + top,
      )
      ctx.fillStyle = '#fff'
      ctx.fill(glyph.path.shape)
      ctx.restore()
    } else {
      ctx.font = resizeFont(glyph.font, px)
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      ctx.fillText(glyph.text, spot.x + left, spot.y + top)
    }
    page.holds.add(id)
    const span = page.dirty.get(spot.y)
    if (span) {
      span.x0 = Math.min(span.x0, spot.x)
      span.x1 = Math.max(span.x1, spot.x + w)
      span.height = Math.max(span.height, h)
    } else {
      page.dirty.set(spot.y, {
        x0: spot.x,
        x1: spot.x + w,
        y: spot.y,
        height: h,
      })
    }
    this.setLookup(id, [
      spot.x,
      spot.y,
      w,
      h,
      -left,
      -top,
      at,
      spot.page + (glyph.color ? 16 : 0),
    ])
  }

  /**
   * Hands what changed to the GPU: what was drawn on each page, and the
   * lookup's rows that changed. The lookup texture is re-made, larger,
   * when there are more ids than it has room for.
   */
  upload(
    gl: WebGL2RenderingContext,
    pages: WebGLTexture,
    lookup: WebGLTexture,
    lookupRows: number,
  ): number {
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, pages)
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i]
      for (const { x0, x1, y, height } of page.dirty.values()) {
        const pixels = page.ctx.getImageData(x0, y, x1 - x0, height)
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          x0,
          y,
          i,
          x1 - x0,
          height,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        )
      }
      page.dirty.clear()
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    const rowsNeeded = Math.ceil(
      Math.max(1, this.glyphs.length) / LOOKUP_IDS_PER_ROW,
    )
    gl.bindTexture(gl.TEXTURE_2D, lookup)
    if (rowsNeeded > lookupRows) {
      const rows = Math.max(rowsNeeded, lookupRows * 2)
      this.ensureLookup(rows)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        LOOKUP_IDS_PER_ROW * 2,
        rows,
        0,
        gl.RGBA,
        gl.FLOAT,
        this.lookup.subarray(0, rows * LOOKUP_IDS_PER_ROW * 8),
      )
      this.lookupDirty = null
      return rows
    }
    if (this.lookupDirty) {
      const [r0, r1] = this.lookupDirty
      const stride = LOOKUP_IDS_PER_ROW * 8
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        r0,
        LOOKUP_IDS_PER_ROW * 2,
        r1 - r0 + 1,
        gl.RGBA,
        gl.FLOAT,
        this.lookup.subarray(r0 * stride, (r1 + 1) * stride),
      )
      this.lookupDirty = null
    }
    return lookupRows
  }

  /** Forgets every picture, as after the GPU lost what it had been given. */
  forgetPictures(): void {
    for (const page of this.pages) this.emptyPage(page)
    this.current = 0
  }

  /** The scale a glyph's picture is drawn at to show at `scale`. */
  private pictureScale(id: number, scale: number): number {
    const size = this.glyphs[id].size
    return Math.min(Math.max(scale, MIN_GLYPH_PX / size), MAX_GLYPH_PX / size)
  }

  /** A text glyph's ink per px of its size, for any size (`INK_PX`). A
   * colour glyph (an emoji) is not asked: its pictures are bitmaps chosen by
   * size, and are measured at the size they are drawn. */
  private inkOf(id: number): readonly [number, number, number, number] {
    let ink = this.inks[id]
    if (!ink) {
      const glyph = this.glyphs[id]
      const [small, large] = INK_PX.map((px) =>
        this.measure(glyph, px).map((v) => v / px),
      )
      ink = [
        Math.max(small[0], large[0]),
        Math.max(small[1], large[1]),
        Math.max(small[2], large[2]),
        Math.max(small[3], large[3]),
      ]
      this.inks[id] = ink
    }
    return ink
  }

  /** A text glyph's ink at `px`: [left, ascent, right, descent]. */
  private measure(glyph: Glyph, px: number): number[] {
    const ctx = this.measuring
    ctx.font = resizeFont(glyph.font, px)
    const m = ctx.measureText(glyph.text)
    return [
      m.actualBoundingBoxLeft,
      m.actualBoundingBoxAscent,
      m.actualBoundingBoxRight,
      m.actualBoundingBoxDescent,
    ]
  }

  private idFor(key: string, make: () => Glyph): number {
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.glyphs.length
      this.glyphs.push(make())
      this.ids.set(key, id)
      this.ensureLookup(Math.ceil((id + 1) / LOOKUP_IDS_PER_ROW))
    }
    return id
  }

  private ensureLookup(rows: number): void {
    const needed = rows * LOOKUP_IDS_PER_ROW * 8
    if (this.lookup.length >= needed) return
    const grown = new Float32Array(Math.max(needed, this.lookup.length * 2))
    grown.set(this.lookup)
    this.lookup = grown
  }

  private setLookup(id: number, values: readonly number[]): void {
    this.lookup.set(values, id * 8)
    const row = Math.floor(id / LOOKUP_IDS_PER_ROW)
    const d = this.lookupDirty
    this.lookupDirty = d
      ? [Math.min(d[0], row), Math.max(d[1], row)]
      : [row, row]
  }

  /** Room for a w × h picture: on a shelf of the current page that fits it,
   * on a new shelf, or on the next page — emptied first if it is full. */
  private place(w: number, h: number): { page: number; x: number; y: number } {
    for (let tries = 0; tries <= this.pages.length; tries++) {
      const page = this.pages[this.current]
      const spot = shelfSpot(page.shelves, w, h)
      if (spot) return { page: this.current, ...spot }
      this.current = (this.current + 1) % this.pages.length
      // The pages have all been used: the oldest gives way.
      if (this.pages[this.current].shelves.length > 0) {
        this.emptyPage(this.pages[this.current])
      }
    }
    throw new Error(`a ${w}×${h} glyph is larger than an atlas page`)
  }

  /** Empties a page here; on the GPU it keeps its old pictures, which
   * nothing reads once their ids point nowhere, and each new one goes up
   * over them with the clear space around it. */
  private emptyPage(page: Page): void {
    page.ctx.clearRect(0, 0, PAGE_SIZE, PAGE_SIZE)
    page.shelves = []
    page.dirty.clear()
    for (const id of page.holds) this.setLookup(id, [0, 0, 0, 0, 0, 0, 0, 0])
    page.holds.clear()
  }

  private newPage(): Page {
    const canvas = this.doc.createElement('canvas')
    canvas.width = PAGE_SIZE
    canvas.height = PAGE_SIZE
    // Read back row by row for the upload: kept in memory rather than on the
    // GPU, where every read would wait for it.
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2D canvas')
    return { canvas, ctx, shelves: [], dirty: new Map(), holds: new Set() }
  }
}

/** Where on a page with these `shelves` a w × h picture goes, the shelf it
 * goes on taken or made; null when the page has no room for it. A picture
 * goes on the lowest shelf it fits on without wasting more than a third of
 * its height. */
export function shelfSpot(
  shelves: Shelf[],
  w: number,
  h: number,
  size = PAGE_SIZE,
): { x: number; y: number } | null {
  if (w > size || h > size) return null
  for (const shelf of shelves) {
    if (h <= shelf.height && h * 1.5 >= shelf.height && shelf.x + w <= size) {
      const x = shelf.x
      shelf.x += w
      return { x, y: shelf.y }
    }
  }
  const last = shelves[shelves.length - 1]
  const y = last ? last.y + last.height : 0
  if (y + h > size) return null
  shelves.push({ y, height: h, x: w })
  return { x: 0, y }
}

/** The task list's tick (../../typeset/paint.ts's), in a box `size`
 * across. */
function drawCheck(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save()
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = Math.max(1, size / 8)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(x + size * 0.27, y + size * 0.52)
  ctx.lineTo(x + size * 0.43, y + size * 0.68)
  ctx.lineTo(x + size * 0.74, y + size * 0.34)
  ctx.stroke()
  ctx.restore()
}

/** Where a path's points reach, through `transform`: its control points
 * too, so a little more than its ink at a curve, never less. */
function pathBounds(
  path: string,
  transform: PathTransform,
): Readonly<{ left: number; top: number; right: number; bottom: number }> {
  const [a, b, c, d] = transform
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  const reach = (x: number, y: number) => {
    const tx = a * x + c * y
    const ty = b * x + d * y
    left = Math.min(left, tx)
    right = Math.max(right, tx)
    top = Math.min(top, ty)
    bottom = Math.max(bottom, ty)
  }
  let x = 0
  let y = 0
  let command = 'M'
  const tokens =
    path.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  let i = 0
  const next = (): number => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++]
    const relative = command === command.toLowerCase()
    const ox = relative ? x : 0
    const oy = relative ? y : 0
    switch (command.toUpperCase()) {
      case 'Z':
        continue
      case 'H':
        x = ox + next()
        break
      case 'V':
        y = oy + next()
        break
      case 'A': {
        i += 5
        x = ox + next()
        y = oy + next()
        break
      }
      default: {
        // M, L, T: a point; Q, S: two; C: three — the last where it ends.
        const points = { Q: 2, S: 2, C: 3 }[command.toUpperCase()] ?? 1
        for (let k = 0; k < points; k += 1) {
          const px = ox + next()
          const py = oy + next()
          reach(px, py)
          if (k === points - 1) {
            x = px
            y = py
          }
        }
        if (command === 'M') command = 'L'
        if (command === 'm') command = 'l'
        continue
      }
    }
    reach(x, y)
  }
  return left <= right
    ? { left, top, right, bottom }
    : { left: 0, top: 0, right: 0, bottom: 0 }
}
