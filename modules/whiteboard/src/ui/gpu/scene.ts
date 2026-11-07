// The board's cards drawn by the GPU: each card's frame and, for a card the
// typesetter (../../typeset/) lays out, its content — glyphs from the atlas
// (./atlas.ts) and rectangles — on one WebGL2 canvas, at every zoom, at a
// cost that does not grow with the cards off screen.
//
// Three things make that so. A card's content is instances in its own
// coordinates (./instances.ts), uploaded once and kept: the camera is a
// uniform, and a card that moves changes one entry of the card table, not
// its instances. Instances are kept in chunks of the board's space, and only
// the chunks on screen are drawn. And a glyph is an id whose picture the
// atlas redraws when the zoom settles, so zooming touches no instance either.
//
// The card table holds, per slot, CARD_TEXELS texels:
//   [x, y, w, h]                          its box, world units
//   [frame depth, content depth, fade, radius]
//   [border width, shown, 0, 0]
// and the colour table one texel: [fill, border, 0, 0] as RGBA8 words.
//
// Knows nothing of boards or nodes: whoever shows the board tells it what
// each card is (`setCard`), in what order they lie (`setOrder`), and when to
// draw (`render`).

import type { CanvasView } from '../../domain/virtualization'

import { GlyphAtlas, PAGE_COUNT, PAGE_SIZE } from './atlas'
import { type CardInstances, GLYPH_WORDS, RECT_WORDS } from './instances'
import {
  CARD_TEXELS,
  FRAME_FS,
  FRAME_VS,
  GLYPH_FS,
  GLYPH_VS,
  RECT_FS,
  RECT_VS,
  SLOTS_PER_ROW,
} from './shaders'

/** A chunk's edge, world units. */
const CHUNK_WORLD = 2048
/** How long a frame may spend drawing glyphs into the atlas, ms. */
const GLYPH_BUDGET_MS = 6

export type SceneFrame = Readonly<{
  /** RGBA8 words (./instances.ts's `packColor`). */
  fill: number
  border: number
  borderWidth: number
  radius: number
}>

export type SceneCard = Readonly<{
  x: number
  y: number
  w: number
  h: number
  /** Null for a card with no frame of its own (bare text). */
  frame: SceneFrame | null
  /** How far above the bottom edge its content fades out; 0 for none. */
  fade: number
  /** Null while it has none (or never will: an image, a PDF). */
  content: CardInstances | null
}>

type Slot = {
  id: string
  index: number
  shown: boolean
  card: SceneCard
  chunk: string | null
}

type Chunk = {
  ids: Set<string>
  bbox: [number, number, number, number]
  dirty: boolean
  rects: WebGLBuffer | null
  glyphs: WebGLBuffer | null
  rectVao: WebGLVertexArrayObject | null
  glyphVao: WebGLVertexArrayObject | null
  rectCount: number
  glyphCount: number
  glyphIds: Uint32Array
}

type Gl = Readonly<{
  gl: WebGL2RenderingContext
  frame: Program
  rect: Program
  glyph: Program
  corner: WebGLBuffer
  frameVao: WebGLVertexArrayObject
  cards: WebGLTexture
  colors: WebGLTexture
  pages: WebGLTexture
  lookup: WebGLTexture
}>

type Program = Readonly<{
  program: WebGLProgram
  uniforms: Readonly<Record<string, WebGLUniformLocation | null>>
}>

export type RenderResult = Readonly<{
  /** Glyphs still owe a picture at this zoom: draw again next frame. */
  more: boolean
  cards: number
  glyphs: number
}>

export class GpuScene {
  private readonly atlas: GlyphAtlas
  private readonly slots = new Map<string, Slot>()
  private readonly free: number[] = []
  private slotCount = 0
  private readonly chunks = new Map<string, Chunk>()
  private geometry = new Float32Array(SLOTS_PER_ROW * CARD_TEXELS * 4)
  private colorWords = new Uint32Array(SLOTS_PER_ROW * 4)
  private tableRows = 0
  private tablesDirty = true
  /** The rows of the card tables written since they were last uploaded:
   * only those go up, for a texture rewritten whole while the frame before
   * still reads it makes the GPU wait for that frame. */
  private dirtyRows: [number, number] | null = null
  private lookupRows = 0
  /** Each card's place from the bottom. */
  private ranks = new Map<string, number>()
  private g: Gl | null = null
  private lost = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.atlas = new GlyphAtlas(canvas.ownerDocument)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
    this.g = this.init()
  }

  /** Whether it can draw: WebGL2 is there and its context is not lost. */
  get usable(): boolean {
    return this.g !== null && !this.lost
  }

  /** The atlas, whose ids a card's content names (./instances.ts's
   * `InstanceDeps`). */
  get glyphs(): GlyphAtlas {
    return this.atlas
  }

  setCard(id: string, card: SceneCard): void {
    let slot = this.slots.get(id)
    if (!slot) {
      const index = this.free.pop() ?? this.slotCount++
      slot = { id, index, shown: true, card, chunk: null }
      this.slots.set(id, slot)
    }
    const before = slot.card
    slot.card = card
    const chunk = chunkKey(card)
    if (slot.chunk !== chunk) {
      if (slot.chunk !== null) this.leaveChunk(id, slot.chunk)
      this.joinChunk(id, chunk)
      this.growChunk(chunk, card)
      slot.chunk = chunk
    } else if (before.content !== card.content) {
      this.markChunk(chunk)
    } else {
      this.growChunk(chunk, card)
    }
    this.writeSlot(slot)
  }

  /** Whether a card is drawn; one that is not keeps all it has. */
  setShown(id: string, shown: boolean): void {
    const slot = this.slots.get(id)
    if (!slot || slot.shown === shown) return
    slot.shown = shown
    this.writeSlot(slot)
  }

  /** The card `id` is, if the scene has it. */
  cardOf(id: string): SceneCard | null {
    return this.slots.get(id)?.card ?? null
  }

  removeCard(id: string): void {
    const slot = this.slots.get(id)
    if (!slot) return
    if (slot.chunk !== null) this.leaveChunk(id, slot.chunk)
    this.slots.delete(id)
    this.free.push(slot.index)
    this.clearSlot(slot.index)
  }

  /** The cards bottom to top; a card not named lies under all that are. */
  setOrder(ids: readonly string[]): void {
    this.ranks = new Map(ids.map((id, i) => [id, i]))
    for (const slot of this.slots.values()) this.writeSlot(slot)
  }

  /** Draws the scene at `view`. `settled`: the camera has come to rest, so
   * glyphs are drawn afresh for the zoom it rests at. */
  render(view: CanvasView, settled: boolean): RenderResult {
    const g = this.g
    if (!g || this.lost) return { more: false, cards: 0, glyphs: 0 }
    const { gl } = g
    const win = this.canvas.ownerDocument.defaultView
    const dpr = win?.devicePixelRatio ?? 1
    const cssW = this.canvas.clientWidth
    const cssH = this.canvas.clientHeight
    const w = Math.max(1, Math.round(cssW * dpr))
    const h = Math.max(1, Math.round(cssH * dpr))
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h

    const x0 = -view.tx / view.scale
    const y0 = -view.ty / view.scale
    const x1 = x0 + cssW / view.scale
    const y1 = y0 + cssH / view.scale
    const visible: Chunk[] = []
    for (const chunk of this.chunks.values()) {
      const b = chunk.bbox
      if (b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0) continue
      if (chunk.dirty) this.buildChunk(g, chunk)
      visible.push(chunk)
    }

    const more = this.drawGlyphs(visible, view.scale * dpr, settled)
    this.lookupRows = this.atlas.upload(gl, g.pages, g.lookup, this.lookupRows)
    if (this.tablesDirty) this.uploadTables(g)

    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clearDepth(1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.DEPTH_TEST)

    const cam = [view.tx, view.ty, view.scale, dpr] as const
    const common = (p: Program) => {
      gl.useProgram(p.program)
      gl.uniform4f(p.uniforms.cam, ...cam)
      gl.uniform2f(p.uniforms.viewport, cssW, cssH)
      gl.uniform1i(p.uniforms.cards, 0)
    }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, g.cards)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, g.colors)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, g.lookup)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, g.pages)

    // Opaque frames first, writing the depth that hides what is under them.
    common(g.frame)
    gl.uniform1i(g.frame.uniforms.colors, 1)
    gl.uniform1f(g.frame.uniforms.edgePass, 0)
    gl.depthFunc(gl.LESS)
    gl.depthMask(true)
    gl.bindVertexArray(g.frameVao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.slotCount)

    // Content, behind every card above its own.
    gl.depthMask(false)
    common(g.rect)
    for (const chunk of visible) {
      if (chunk.rectCount === 0) continue
      gl.bindVertexArray(chunk.rectVao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, chunk.rectCount)
    }
    common(g.glyph)
    gl.uniform1i(g.glyph.uniforms.lookup, 2)
    gl.uniform1i(g.glyph.uniforms.pages, 3)
    gl.uniform1f(g.glyph.uniforms.snap, settled ? 1 : 0)
    gl.uniform1f(g.glyph.uniforms.pageSize, PAGE_SIZE)
    let glyphs = 0
    for (const chunk of visible) {
      if (chunk.glyphCount === 0) continue
      gl.bindVertexArray(chunk.glyphVao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, chunk.glyphCount)
      glyphs += chunk.glyphCount
    }

    // Then the frames' edges and borders, over whatever they lie on.
    common(g.frame)
    gl.uniform1i(g.frame.uniforms.colors, 1)
    gl.uniform1f(g.frame.uniforms.edgePass, 1)
    gl.depthFunc(gl.LEQUAL)
    gl.bindVertexArray(g.frameVao)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.slotCount)

    gl.bindVertexArray(null)
    gl.depthMask(true)
    return { more, cards: visible.reduce((n, c) => n + c.ids.size, 0), glyphs }
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    const g = this.g
    if (g) {
      for (const chunk of this.chunks.values()) this.releaseChunk(g, chunk)
      g.gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.g = null
  }

  /** Draws the pictures the glyphs on screen are missing — at the zoom the
   * camera rests at when it does, any picture at all while it moves —
   * until the frame's budget is spent. True if some are still missing. */
  private drawGlyphs(
    visible: readonly Chunk[],
    scale: number,
    settled: boolean,
  ): boolean {
    const win = this.canvas.ownerDocument.defaultView
    const now = () => win?.performance.now() ?? 0
    const start = now()
    let checked = 0
    for (const chunk of visible) {
      for (const id of chunk.glyphIds) {
        const has = settled
          ? this.atlas.hasPicture(id, scale)
          : this.atlas.hasAnyPicture(id)
        if (has) continue
        // Time is read only every few glyphs: a glyph costs microseconds.
        if ((++checked & 15) === 0 && now() - start > GLYPH_BUDGET_MS) {
          return true
        }
        this.atlas.draw(id, scale)
      }
    }
    return false
  }

  private joinChunk(id: string, key: string): void {
    let chunk = this.chunks.get(key)
    if (!chunk) {
      chunk = {
        ids: new Set(),
        bbox: [Infinity, Infinity, -Infinity, -Infinity],
        dirty: true,
        rects: null,
        glyphs: null,
        rectVao: null,
        glyphVao: null,
        rectCount: 0,
        glyphCount: 0,
        glyphIds: new Uint32Array(0),
      }
      this.chunks.set(key, chunk)
    }
    chunk.ids.add(id)
    chunk.dirty = true
  }

  private leaveChunk(id: string, key: string): void {
    const chunk = this.chunks.get(key)
    if (!chunk) return
    chunk.ids.delete(id)
    chunk.dirty = true
    if (chunk.ids.size === 0) {
      if (this.g) this.releaseChunk(this.g, chunk)
      this.chunks.delete(key)
    }
  }

  private markChunk(key: string): void {
    const chunk = this.chunks.get(key)
    if (chunk) chunk.dirty = true
  }

  /** A card moved within its chunk: its instances stay, the chunk's bounds
   * take it in. */
  private growChunk(key: string, card: SceneCard): void {
    const chunk = this.chunks.get(key)
    if (!chunk) return
    const b = chunk.bbox
    b[0] = Math.min(b[0], card.x)
    b[1] = Math.min(b[1], card.y)
    b[2] = Math.max(b[2], card.x + card.w)
    b[3] = Math.max(b[3], card.y + card.h)
  }

  private buildChunk(g: Gl, chunk: Chunk): void {
    const { gl } = g
    let rectCount = 0
    let glyphCount = 0
    const bbox: [number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
    ]
    const used = new Set<number>()
    for (const id of chunk.ids) {
      const slot = this.slots.get(id)
      if (!slot) continue
      const { card } = slot
      bbox[0] = Math.min(bbox[0], card.x)
      bbox[1] = Math.min(bbox[1], card.y)
      bbox[2] = Math.max(bbox[2], card.x + card.w)
      bbox[3] = Math.max(bbox[3], card.y + card.h)
      if (!card.content) continue
      rectCount += card.content.rects.length / RECT_WORDS
      glyphCount += card.content.glyphs.length / GLYPH_WORDS
      for (const glyph of card.content.glyphIds) used.add(glyph)
    }
    const rects = new Uint32Array(rectCount * RECT_WORDS)
    const glyphs = new Uint32Array(glyphCount * GLYPH_WORDS)
    let ri = 0
    let gi = 0
    for (const id of chunk.ids) {
      const slot = this.slots.get(id)
      const content = slot?.card.content
      if (!slot || !content) continue
      rects.set(content.rects, ri)
      for (let i = ri; i < ri + content.rects.length; i += RECT_WORDS) {
        rects[i] = slot.index
      }
      ri += content.rects.length
      glyphs.set(content.glyphs, gi)
      for (let i = gi; i < gi + content.glyphs.length; i += GLYPH_WORDS) {
        glyphs[i] = slot.index
      }
      gi += content.glyphs.length
    }
    if (!chunk.rects) {
      chunk.rects = gl.createBuffer()
      chunk.glyphs = gl.createBuffer()
      chunk.rectVao = this.instanceVao(g, chunk.rects, 'rect')
      chunk.glyphVao = this.instanceVao(g, chunk.glyphs, 'glyph')
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.rects)
    gl.bufferData(gl.ARRAY_BUFFER, rects, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.glyphs)
    gl.bufferData(gl.ARRAY_BUFFER, glyphs, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    chunk.rectCount = rectCount
    chunk.glyphCount = glyphCount
    chunk.glyphIds = Uint32Array.from(used)
    chunk.bbox = bbox
    chunk.dirty = false
  }

  private instanceVao(
    g: Gl,
    buffer: WebGLBuffer | null,
    kind: 'rect' | 'glyph',
  ): WebGLVertexArrayObject {
    const { gl } = g
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('no vertex array')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, g.corner)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const stride = (kind === 'rect' ? RECT_WORDS : GLYPH_WORDS) * 4
    const attr = (
      loc: number,
      size: number,
      type: 'float' | 'uint' | 'color',
      word: number,
    ) => {
      gl.enableVertexAttribArray(loc)
      if (type === 'uint') {
        gl.vertexAttribIPointer(loc, size, gl.UNSIGNED_INT, stride, word * 4)
      } else if (type === 'color') {
        gl.vertexAttribPointer(loc, 4, gl.UNSIGNED_BYTE, true, stride, word * 4)
      } else {
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, word * 4)
      }
      gl.vertexAttribDivisor(loc, 1)
    }
    attr(1, 1, 'uint', 0)
    if (kind === 'rect') {
      attr(2, 4, 'float', 1)
      attr(3, 2, 'float', 5)
      attr(4, 4, 'color', 7)
      attr(5, 4, 'color', 8)
    } else {
      attr(2, 2, 'float', 1)
      attr(3, 1, 'uint', 3)
      attr(4, 4, 'color', 4)
    }
    gl.bindVertexArray(null)
    return vao
  }

  private releaseChunk(g: Gl, chunk: Chunk): void {
    const { gl } = g
    gl.deleteBuffer(chunk.rects)
    gl.deleteBuffer(chunk.glyphs)
    gl.deleteVertexArray(chunk.rectVao)
    gl.deleteVertexArray(chunk.glyphVao)
    chunk.rects = null
    chunk.glyphs = null
    chunk.rectVao = null
    chunk.glyphVao = null
    chunk.dirty = true
  }

  private writeSlot(slot: Slot): void {
    this.ensureTables(slot.index)
    const { card } = slot
    const rank = this.ranks.get(slot.id) ?? -1
    // Two depths a card, frame then content, from the back (1) to the
    // front (0); a card not in the order lies at the back.
    const layers = this.ranks.size * 2 + 2
    const layer = (rank + 1) * 2
    const at = slot.index * CARD_TEXELS * 4
    const frame = card.frame
    this.geometry.set(
      [
        card.x,
        card.y,
        card.w,
        card.h,
        1 - (layer + 0.5) / layers,
        1 - (layer + 1.5) / layers,
        card.fade,
        frame?.radius ?? 0,
        frame?.borderWidth ?? 0,
        slot.shown ? 1 : 0,
        0,
        0,
      ],
      at,
    )
    this.colorWords.set(
      [frame?.fill ?? 0, frame?.border ?? 0, 0, 0],
      slot.index * 4,
    )
    this.markRow(slot.index)
  }

  private markRow(index: number): void {
    const row = Math.floor(index / SLOTS_PER_ROW)
    const d = this.dirtyRows
    this.dirtyRows = d ? [Math.min(d[0], row), Math.max(d[1], row)] : [row, row]
    this.tablesDirty = true
  }

  private clearSlot(index: number): void {
    this.geometry.fill(
      0,
      index * CARD_TEXELS * 4,
      (index + 1) * CARD_TEXELS * 4,
    )
    this.colorWords.fill(0, index * 4, index * 4 + 4)
    this.markRow(index)
  }

  private ensureTables(index: number): void {
    const rows = Math.floor(index / SLOTS_PER_ROW) + 1
    const geometry = rows * SLOTS_PER_ROW * CARD_TEXELS * 4
    if (this.geometry.length >= geometry) return
    const grownGeometry = new Float32Array(geometry * 2)
    grownGeometry.set(this.geometry)
    this.geometry = grownGeometry
    const grownColors = new Uint32Array(rows * 2 * SLOTS_PER_ROW * 4)
    grownColors.set(this.colorWords)
    this.colorWords = grownColors
  }

  private uploadTables(g: Gl): void {
    const { gl } = g
    const geometryRow = SLOTS_PER_ROW * CARD_TEXELS * 4
    const colorRow = SLOTS_PER_ROW * 4
    const rows = this.geometry.length / geometryRow
    if (rows !== this.tableRows) {
      gl.bindTexture(gl.TEXTURE_2D, g.cards)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        SLOTS_PER_ROW * CARD_TEXELS,
        rows,
        0,
        gl.RGBA,
        gl.FLOAT,
        this.geometry,
      )
      gl.bindTexture(gl.TEXTURE_2D, g.colors)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32UI,
        SLOTS_PER_ROW,
        rows,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        this.colorWords,
      )
    } else if (this.dirtyRows) {
      const [r0, r1] = this.dirtyRows
      const count = r1 - r0 + 1
      gl.bindTexture(gl.TEXTURE_2D, g.cards)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        r0,
        SLOTS_PER_ROW * CARD_TEXELS,
        count,
        gl.RGBA,
        gl.FLOAT,
        this.geometry.subarray(r0 * geometryRow, (r1 + 1) * geometryRow),
      )
      gl.bindTexture(gl.TEXTURE_2D, g.colors)
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        r0,
        SLOTS_PER_ROW,
        count,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        this.colorWords.subarray(r0 * colorRow, (r1 + 1) * colorRow),
      )
    }
    this.tableRows = rows
    this.dirtyRows = null
    this.tablesDirty = false
  }

  private init(): Gl | null {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: true,
    })
    if (!gl) return null
    const corner = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, corner)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    )
    // The frame program reads only the corner.
    const frameVao = gl.createVertexArray()
    gl.bindVertexArray(frameVao)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    const table = (filter: number) => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return t
    }
    const pages = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, pages)
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.RGBA8,
      PAGE_SIZE,
      PAGE_SIZE,
      PAGE_COUNT,
    )
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const g: Gl = {
      gl,
      frame: compile(gl, FRAME_VS, FRAME_FS),
      rect: compile(gl, RECT_VS, RECT_FS),
      glyph: compile(gl, GLYPH_VS, GLYPH_FS),
      corner: required(corner),
      frameVao: required(frameVao),
      cards: required(table(gl.NEAREST)),
      colors: required(table(gl.NEAREST)),
      pages: required(pages),
      lookup: required(table(gl.NEAREST)),
    }
    this.tableRows = 0
    this.lookupRows = 0
    this.tablesDirty = true
    return g
  }

  private readonly onLost = (event: Event) => {
    // Asked back: the browser restores the context when it can.
    event.preventDefault()
    this.lost = true
  }

  private readonly onRestored = () => {
    this.lost = false
    for (const chunk of this.chunks.values()) {
      chunk.rects = null
      chunk.glyphs = null
      chunk.rectVao = null
      chunk.glyphVao = null
      chunk.dirty = true
    }
    this.atlas.forgetPictures()
    this.g = this.init()
  }
}

/** The chunk a card is kept in: the one its top-left corner is in. */
function chunkKey(card: SceneCard): string {
  return `${Math.floor(card.x / CHUNK_WORLD)},${Math.floor(card.y / CHUNK_WORLD)}`
}

function compile(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
): Program {
  const program = required(gl.createProgram())
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = required(gl.createShader(type))
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? 'shader')
    }
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'program')
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)
    if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name)
  }
  return { program, uniforms }
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('WebGL could not make a resource')
  return value
}
