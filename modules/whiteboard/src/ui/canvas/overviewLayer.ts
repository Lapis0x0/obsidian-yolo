// The overview tier's renderer for the `.yoloboard` canvas: one `<canvas>`
// that draws every card and edge itself, replacing their DOM entirely below
// OVERVIEW_SCALE_THRESHOLD.
//
// Why a canvas at all, on a board whose whole rendering architecture is DOM:
// the measured ceiling is not what a card *contains* but that it exists.
// `PaintArtifactCompositor::Update` — Blink handing its paint artifacts to the
// compositor — grows with the number of mounted elements whatever they hold,
// and at 1200 mounted cards it alone eats most of a frame. That number is
// bounded at readable zooms because a screen only holds so many cards; below
// ~0.15 it is not. So the fix is not to make the cards cheaper, it is for
// there to be no cards: at that zoom nothing in one is legible anyway, and a
// few thousand rectangles is an afternoon's work for a canvas.
//
// Screen space, not world space. The canvas is a sibling of the world layer
// rather than a child: inside it, the camera's CSS `scale` would blur the
// bitmap and force a re-raster on every zoom frame. Here it is redrawn instead
// — which costs a pass over the board data per frame and nothing at rest.
//
// Groups deliberately stay in the DOM at every tier: there are a few
// dozen of them, they are the most common thing to drag at this zoom, and
// keeping them means dragging one needs no new code. That is also why the
// canvas is inserted *before* the world layer: groups paint over it, as they
// do the cards in every other tier, and so do the snap guides, the resize
// handles and an in-flight connection's curve.
//
// `WhiteboardCanvas` is the only importer; this module must never import it
// back (single-direction dependency between the canvas and its collaborators).

import type { ScreenPoint } from '../../domain/camera'
import { type ColorPreset, resolveColor } from '../../domain/color'
import {
  EDGE_CONTROL_MAX_PX,
  computeEdgeGeometry,
  resolveEdgeSides,
} from '../../domain/edges'
import {
  type BoardNode,
  type Edge,
  type EdgeId,
  type NodeId,
  isPlainText,
} from '../../domain/fileFormat'
import type { CardRect } from '../../domain/resize'
import { isSpreadTitle } from '../../domain/spread'
import {
  type CanvasView,
  computeWorldViewportRect,
} from '../../domain/virtualization'
import {
  ARRANGE_ANIMATION_MS,
  EDGE_ARROW_WORLD_PX,
  EDGE_LABEL_FONT_PX,
  EDGE_LABEL_MAX_WIDTH_EM,
  EDGE_LABEL_PADDING_PX,
  EDGE_STROKE_WORLD_PX,
  OVERVIEW_ARROW_MIN_SCREEN_PX,
  OVERVIEW_CARD_WASH_ALPHA,
  OVERVIEW_GROUP_LABEL_MIN_SCREEN_PX,
  OVERVIEW_LABEL_MIN_FONT_PX,
  OVERVIEW_MIN_EDGE_STROKE_PX,
  OVERVIEW_THEMED_BORDER_ALPHA,
  OVERVIEW_TITLE_MIN_CARD_PX,
  SPREAD_TITLE_WORLD,
  TITLE_BLOCK_LINE_HEIGHT,
  TITLE_BLOCK_WORLD_FONT_PX,
  TITLE_BLOCK_WORLD_PADDING,
} from '../constants'
import { type PdfPageLabels, nodeTitleText, wrapTitleLines } from '../lod'

const OVERVIEW_CANVAS_CLASS = 'yolo-whiteboard-overview'
const OVERVIEW_HIDDEN_CLASS = 'yolo-whiteboard-overview-hidden'
/** How dark bare text's block of ink is drawn, zoomed out past reading it. */
const OVERVIEW_TEXT_ALPHA = 0.18
/** Past this many wrapped titles the cache starts over rather than growing
 * with every card a long session has ever shown. */
const TITLE_LINES_CACHE_LIMIT = 2000

/**
 * Concrete colour values for one draw.
 *
 * The rest of the module never asks what colour anything is — every element
 * carries `--yolo-whiteboard-color` and the stylesheet paints from it. A canvas
 * cannot: it needs the value. Read once through `getComputedStyle` when the
 * tier is entered and cached for as long as it lasts ("勿逐帧读"); a theme
 * change lands on the next entry.
 *
 * The strings are kept as the browser gave them and handed straight back to
 * `fillStyle`, so any colour syntax a theme uses works. Where the stylesheet
 * mixes in transparency (`color-mix(… 70% …)`) this uses `globalAlpha` on the
 * same colour, which needs no parsing and composites the same way.
 *
 * Dropped again whenever the document's body classes change, which is how a
 * theme or light/dark switch reaches a plugin (`watchTheme`).
 */
type Palette = Readonly<{
  presets: Readonly<Record<ColorPreset, string>>
  /** Obsidian's uncoloured canvas grey — what an uncoloured node washes with. */
  neutral: string
  border: string
  accent: string
  text: string
  muted: string
  background: string
  fontFamily: string
  /** A dark theme, which shows PDF pages inverted (styles/pdf/card.css). */
  dark: boolean
}>

/**
 * The narrow surface `WhiteboardCanvas` injects so the overview can read the
 * board, the camera and the selection it does not own — and, while a gesture
 * is in flight, the geometry that has not been committed to the board yet.
 */
export type OverviewLayerCallbacks = Readonly<{
  getView: () => CanvasView
  /** Every non-group node, in board order — groups keep their DOM. */
  getCardNodes: () => readonly BoardNode[]
  getEdges: () => readonly Edge[]
  getNode: (id: NodeId) => BoardNode | undefined
  isSelected: (id: NodeId) => boolean
  isEdgeSelected: (id: EdgeId) => boolean
  /** The edge whose label is being typed, or null. That one label stays in
   * the DOM for the length of the rename (canvas.ts's `syncEdgeRenameChrome`)
   * because a canvas holds no caret, so this is the one this layer must not
   * draw as well. */
  getRenamingEdgeId: () => EdgeId | null
  /**
   * Live rectangles for the nodes a drag or a resize is moving, or null when
   * nothing is. In the DOM tiers this feedback is a `transform` on the card's
   * element; here it is the same numbers, drawn.
   */
  getLiveRects: () => ReadonlyMap<NodeId, CardRect> | null
  /** What a PDF card's or a sheet's title says about its page — see
   * ui/lod.ts's `nodeTitleText`. */
  pdfPageLabels: PdfPageLabels
  /** "25 pages", localized, for an open spread's title. */
  spreadPageCountLabel: (id: NodeId) => string
  /** A small picture of a spread's page (ui/pdf/thumbnails.ts), as the
   * theme shows it, or null while it has none. */
  pageThumbnail: (
    path: string,
    page: number,
    dark: boolean,
  ) => ImageBitmap | null
}>

/**
 * Owns the overview `<canvas>`, its backing-store size, the theme colours it
 * draws in, and the dirty flag that keeps a still board from being redrawn.
 * One instance per `WhiteboardCanvas`, constructed in `ensureDom`.
 */
export class OverviewLayer {
  private readonly canvasEl: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private active = false
  private dirty = false
  private palette: Palette | null = null
  /** Titles already broken into lines, by text and the card's world size.
   * Kept in world units, so a zoom does not invalidate them; dropped with the
   * palette, whose font they were measured in. */
  private readonly titleLines = new Map<string, readonly string[]>()
  /** Cards in flight — see `animate`. */
  private readonly motions = new Map<
    NodeId,
    Readonly<{
      direction: 'in' | 'out'
      offset: Readonly<{ x: number; y: number }>
      delay: number
      start: number
    }>
  >()
  /** Where each spread title's line was last drawn, in world units. */
  private readonly titleRects = new Map<
    NodeId,
    Readonly<{ x: number; y: number; w: number; h: number }>
  >()
  /** Viewport size in CSS pixels, pushed in rather than measured: reading it
   * here would force a layout flush on a frame that has just written the
   * world's transform. `WhiteboardCanvas` already measures the viewport on its
   * visibility tick and passes what it read. */
  private width = 0
  private height = 0
  private appliedDpr = 0
  private appliedWidth = 0
  private appliedHeight = 0
  /** The camera the last draw was made for — see `render`. */
  private lastView: CanvasView | null = null
  /** Watches for the theme changing under a tier that has already read its
   * colours — see `watchTheme`. */
  private themeObserver: MutationObserver | null = null

  constructor(
    private readonly context: YoloModuleHostFileViewContextV1,
    /** The element whose computed style the theme colours are read from — the
     * view root, which is where the board's own colour tokens are declared. */
    private readonly styleSourceEl: HTMLElement,
    parentEl: HTMLElement,
    private readonly callbacks: OverviewLayerCallbacks,
  ) {
    const doc = context.getDocument()
    this.canvasEl = doc.createElement('canvas')
    this.canvasEl.className = `${OVERVIEW_CANVAS_CLASS} ${OVERVIEW_HIDDEN_CLASS}`
    parentEl.appendChild(this.canvasEl)
    this.ctx = this.canvasEl.getContext('2d')
    this.watchTheme()
  }

  /**
   * Drops the cached palette when the theme changes.
   *
   * The colours are read once per entry into the tier and then held, which is
   * right — reading computed style per frame is not a thing to do — but a tier
   * can outlast a theme: switching to dark while zoomed out would leave the
   * board drawn in the light one's colours until the next entry, which may be
   * minutes of panning away.
   *
   * Obsidian gives a plugin no theme event; what it does is rewrite the body's
   * classes (`theme-dark`/`theme-light`, the active theme's own), so that is
   * what is watched. A false positive costs one `getComputedStyle` on the next
   * frame that draws, which is why this stays a class-attribute watch rather
   * than anything that tries to work out whether the colours really moved.
   *
   * The observer is the *view's own* window's, and watches the view's own
   * document: in a popout both are that window's, not the main one's
   * (CLAUDE.md, Popout / Multi-window).
   */
  private watchTheme(): void {
    const doc = this.styleSourceEl.ownerDocument
    const win = doc.defaultView
    if (!win) return
    this.themeObserver = new win.MutationObserver(() => {
      this.palette = null
      this.titleLines.clear()
      this.dirty = true
    })
    this.themeObserver.observe(doc.body, {
      attributes: true,
      attributeFilter: ['class'],
    })
  }

  get isActive(): boolean {
    return this.active
  }

  /**
   * Enters or leaves the tier. Entering drops the cached palette so the theme
   * is re-read: the moment the tier is entered is both the only moment the
   * values are needed and a cheap place to spend one `getComputedStyle`. A
   * theme that changes *during* the tier is caught by `watchTheme`.
   */
  setActive(active: boolean): void {
    if (active === this.active) return
    this.active = active
    this.canvasEl.classList.toggle(OVERVIEW_HIDDEN_CLASS, !active)
    this.lastView = null
    if (active) {
      this.palette = null
      this.titleLines.clear()
      this.dirty = true
      return
    }
    this.motions.clear()
    this.clear()
  }

  /** The board, the camera or the selection moved: the next frame redraws.
   * Nothing else does — a still board costs nothing. */
  markDirty(): void {
    this.dirty = true
  }

  setViewportSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.dirty = true
  }

  /** Called once per frame from the canvas's rAF loop, after the camera has
   * advanced — so what is drawn is the camera the world layer was just given. */
  render(): void {
    if (!this.active) return
    const view = this.callbacks.getView()
    // The camera controller replaces its view object rather than mutating it,
    // so identity is an exact "has the camera moved" test that costs one
    // comparison — no notification path from the camera to here, and no way
    // for the two to disagree about whether a frame is needed.
    if (view !== this.lastView) this.dirty = true
    if (!this.dirty) return
    const ctx = this.ctx
    if (!ctx || this.width === 0 || this.height === 0) return
    this.dirty = false
    this.lastView = view
    this.palette ??= this.readPalette(ctx)
    this.resizeBackingStore(ctx)
    ctx.clearRect(0, 0, this.width, this.height)
    const live = this.callbacks.getLiveRects()
    // Edges first, so a card covers the line that ends at it rather than the
    // other way round -- the order the DOM tiers paint in.
    this.drawEdges(ctx, view, live)
    this.drawCards(ctx, view, live)
    this.drawMotions(ctx, view)
    ctx.globalAlpha = 1
  }

  /**
   * Moves a card in from `offset` (world units from where it is) while it
   * fades in, or out to it while it fades away — the overview tier's side of
   * a PDF spread being dealt out or gathered back (canvas.ts). The DOM tiers
   * do this with Web Animations on the elements; here there are no elements,
   * so the canvas carries the motion and redraws every frame until it ends.
   * A card that has gone out stays unseen until it leaves the board.
   */
  animate(
    id: NodeId,
    motion: Readonly<{
      direction: 'in' | 'out'
      offset: Readonly<{ x: number; y: number }>
      delay: number
    }>,
  ): void {
    if (!this.active) return
    this.motions.set(id, {
      ...motion,
      start: this.context.getWindow().performance.now(),
    })
    this.dirty = true
  }

  /** Puts cards back where they are, at full opacity, mid-motion or not. */
  stopAnimating(ids: Iterable<NodeId>): void {
    for (const id of ids) this.motions.delete(id)
    this.dirty = true
  }

  /** The cards in motion, each at its own place and opacity; the next frame
   * is owed while any is still moving. */
  private drawMotions(ctx: CanvasRenderingContext2D, view: CanvasView): void {
    const palette = this.palette
    if (!palette || this.motions.size === 0) return
    const now = this.context.getWindow().performance.now()
    /** A card came to rest this frame: the next is still owed, since it is
     * `drawCards` that draws it from there on. */
    let landed = false
    let moving = false
    for (const [id, motion] of this.motions) {
      const node = this.callbacks.getNode(id)
      const elapsed = now - motion.start - motion.delay
      const t = Math.min(1, Math.max(0, elapsed / ARRANGE_ANIMATION_MS))
      if (!node) {
        this.motions.delete(id)
        continue
      }
      // Drawn here on the frame it arrives too — `drawCards` skipped it
      // this frame — and handed back to `drawCards` from the next.
      if (motion.direction === 'in' && t >= 1) {
        this.motions.delete(id)
        landed = true
      }
      if (t < 1) moving = true
      // ARRANGE_ANIMATION_EASING's curve, near enough for 220ms: fast out
      // of the start, settling into the end.
      const eased = 1 - (1 - t) ** 4
      const away = motion.direction === 'in' ? 1 - eased : eased
      const alpha = 1 - away
      if (alpha <= 0) continue
      const x = (node.x + motion.offset.x * away) * view.scale + view.tx
      const y = (node.y + motion.offset.y * away) * view.scale + view.ty
      const w = node.w * view.scale
      const h = node.h * view.scale
      ctx.globalAlpha = alpha
      ctx.fillStyle = palette.background
      ctx.fillRect(x, y, w, h)
      // The wash every card wears here (`drawCards`), or the card would land
      // white and turn grey the frame it stops moving.
      ctx.globalAlpha = alpha * OVERVIEW_CARD_WASH_ALPHA
      ctx.fillStyle = this.colorOf(node, palette) ?? palette.neutral
      ctx.fillRect(x, y, w, h)
      // A page's picture, as it will be drawn once it lands (`drawCards`),
      // and then no title.
      const picture =
        node.type === 'pdf-page'
          ? this.callbacks.pageThumbnail(node.file, node.page, palette.dark)
          : null
      if (picture) {
        ctx.globalAlpha = alpha
        ctx.drawImage(picture, x, y, w, h)
      }
      // The border it will have when it lands (`drawCards`): a selection's
      // ring, the faint accent of a selected spread's sheet, or the plain
      // one — so nothing changes the frame it stops.
      const selected = this.callbacks.isSelected(node.id)
      const ofSelected =
        !selected &&
        node.type === 'pdf-page' &&
        this.callbacks.isSelected(node.parent)
      ctx.globalAlpha = ofSelected ? alpha * 0.45 : alpha
      ctx.lineWidth = selected ? 2 : 1
      ctx.strokeStyle = selected || ofSelected ? palette.accent : palette.border
      ctx.beginPath()
      this.strokeRectPath(ctx, { x, y, w, h })
      ctx.stroke()
      ctx.globalAlpha = alpha
      ctx.lineWidth = 1
      if (picture || w < OVERVIEW_TITLE_MIN_CARD_PX) continue
      const title = nodeTitleText(node, this.callbacks.pdfPageLabels)
      ctx.font = `500 ${TITLE_BLOCK_WORLD_FONT_PX * view.scale}px ${palette.fontFamily}`
      ctx.fillStyle = palette.text
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(title, x + w / 2, y + h / 2, w)
    }
    ctx.globalAlpha = 1
    if (moving || landed) this.dirty = true
  }

  destroy(): void {
    this.themeObserver?.disconnect()
    this.themeObserver = null
    this.canvasEl.remove()
  }

  private clear(): void {
    this.ctx?.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height)
  }

  /**
   * Matches the backing store to the viewport and the display's pixel ratio.
   * `devicePixelRatio` comes from the view's own window, which in an Obsidian
   * popout is a different window on a possibly different display (Popout /
   * Multi-window, CLAUDE.md).
   */
  private resizeBackingStore(ctx: CanvasRenderingContext2D): void {
    const dpr = this.context.getWindow().devicePixelRatio || 1
    const w = Math.round(this.width * dpr)
    const h = Math.round(this.height * dpr)
    if (
      w !== this.appliedWidth ||
      h !== this.appliedHeight ||
      dpr !== this.appliedDpr
    ) {
      this.canvasEl.width = w
      this.canvasEl.height = h
      this.appliedWidth = w
      this.appliedHeight = h
      this.appliedDpr = dpr
    }
    // Re-stated every frame: resizing the backing store resets the context.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private readPalette(ctx: CanvasRenderingContext2D): Palette {
    const style = this.context.getWindow().getComputedStyle(this.styleSourceEl)
    const read = (name: string, fallback: string): string => {
      const value = style.getPropertyValue(name).trim()
      return value.length > 0 && this.parses(ctx, value) ? value : fallback
    }
    return {
      presets: {
        '1': read('--yolo-whiteboard-color-1', '#e93147'),
        '2': read('--yolo-whiteboard-color-2', '#ec7500'),
        '3': read('--yolo-whiteboard-color-3', '#e0ac00'),
        '4': read('--yolo-whiteboard-color-4', '#08b94e'),
        '5': read('--yolo-whiteboard-color-5', '#00bfbc'),
        '6': read('--yolo-whiteboard-color-6', '#7852ee'),
      },
      neutral: read('--yolo-whiteboard-color', '#c0c0c0'),
      border: read('--background-modifier-border', '#dcddde'),
      accent: read('--interactive-accent', '#7c3aed'),
      text: read('--text-normal', '#222222'),
      muted: read('--text-muted', '#5c5c5c'),
      background: read('--background-primary', '#ffffff'),
      fontFamily: style.fontFamily || 'sans-serif',
      dark: this.styleSourceEl.closest('.theme-dark') !== null,
    }
  }

  /** Whether the canvas can paint with this colour — a theme may hand back a
   * value the 2D context does not accept, and a rejected `fillStyle` silently
   * keeps the previous colour, which would paint the board in the wrong one
   * rather than in the fallback. */
  private parses(ctx: CanvasRenderingContext2D, value: string): boolean {
    const before = ctx.fillStyle
    ctx.fillStyle = value
    const accepted = ctx.fillStyle !== before
    ctx.fillStyle = before
    // A value that normalises to exactly what was already set reads as
    // rejected; accepting the false negative costs a fallback colour, where
    // the false positive would cost a wrong one.
    return accepted
  }

  /** A node's colour, or null when it has none — the same three-way resolution
   * the DOM path makes (domain/color.ts), landing on a value instead of a
   * class. */
  private colorOf(node: BoardNode, palette: Palette): string | null {
    const resolved = resolveColor(node.color)
    switch (resolved.kind) {
      case 'preset':
        return palette.presets[resolved.preset]
      case 'custom':
        return resolved.hex
      case 'none':
        return null
    }
  }

  private colorOfEdge(edge: Edge, palette: Palette): string {
    const resolved = resolveColor(edge.color)
    switch (resolved.kind) {
      case 'preset':
        return palette.presets[resolved.preset]
      case 'custom':
        return resolved.hex
      case 'none':
        return palette.neutral
    }
  }

  // -----------------------------------------------------------------------
  // Cards
  //
  // Drawn as a DOM card with no content yet is (the switch is direct, so the
  // two tiers have to look the same): an opaque fill,
  // a wash of the node's colour over it, a border, and — only where a card is
  // big enough on screen for the line to mean anything — its title block.
  //
  // Batched by colour rather than drawn card by card. Every `fillStyle` write
  // is a state change in the rasteriser, and a board has at most seven colours;
  // one path per colour turns three thousand of them into a handful.
  // -----------------------------------------------------------------------

  private drawCards(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    live: ReadonlyMap<NodeId, CardRect> | null,
  ): void {
    const palette = this.palette
    if (!palette) return
    const nodes = this.callbacks.getCardNodes()
    // Screen rects of everything on screen, kept once so the passes below
    // agree and the projection is done once per card rather than four times.
    const visible: {
      node: BoardNode
      x: number
      y: number
      w: number
      h: number
    }[] = []
    const texts: typeof visible = []
    const spreadTitles: typeof visible = []
    for (const node of nodes) {
      // Drawn on their own, at their own opacity (`drawMotions`).
      if (this.motions.has(node.id)) continue
      const rect = live?.get(node.id) ?? node
      const x = rect.x * view.scale + view.tx
      const y = rect.y * view.scale + view.ty
      const w = rect.w * view.scale
      const h = rect.h * view.scale
      if (x >= this.width || y >= this.height || x + w <= 0 || y + h <= 0) {
        continue
      }
      const item = { node, x, y, w, h }
      if (isPlainText(node)) texts.push(item)
      else if (isSpreadTitle(node)) spreadTitles.push(item)
      else visible.push(item)
    }
    // Bare text has no card to draw: at this distance it is a block of ink,
    // in its colour, as greyed-out text is drawn — and a selection ring when
    // it is selected, drawn with the cards' below.
    if (texts.length > 0) {
      ctx.globalAlpha = OVERVIEW_TEXT_ALPHA
      for (const text of texts) {
        ctx.fillStyle = this.colorOf(text.node, palette) ?? palette.text
        ctx.fillRect(text.x, text.y, text.w, text.h)
      }
      ctx.globalAlpha = 1
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 2
      ctx.beginPath()
      let anySelected = false
      for (const text of texts) {
        if (!this.callbacks.isSelected(text.node.id)) continue
        this.strokeRectPath(ctx, text)
        anySelected = true
      }
      if (anySelected) ctx.stroke()
      ctx.lineWidth = 1
    }
    this.drawSpreadTitles(ctx, view, spreadTitles)
    if (visible.length === 0) return

    // 1. The opaque surface, in one path.
    ctx.globalAlpha = 1
    ctx.fillStyle = palette.background
    ctx.beginPath()
    for (const card of visible) ctx.rect(card.x, card.y, card.w, card.h)
    ctx.fill()

    // 2. The colour wash, one path per colour.
    const byColor = new Map<string, typeof visible>()
    for (const card of visible) {
      const color = this.colorOf(card.node, palette) ?? palette.neutral
      const bucket = byColor.get(color)
      if (bucket) bucket.push(card)
      else byColor.set(color, [card])
    }
    ctx.globalAlpha = OVERVIEW_CARD_WASH_ALPHA
    for (const [color, cards] of byColor) {
      ctx.fillStyle = color
      ctx.beginPath()
      for (const card of cards) ctx.rect(card.x, card.y, card.w, card.h)
      ctx.fill()
    }

    // 2b. A spread's pages, as pictures of themselves where there is one —
    //     what the page shows in the DOM tiers, over its wash as the page's
    //     canvas is over its card. Such a page needs no title: it shows its
    //     own.
    const pictured = new Set<NodeId>()
    ctx.globalAlpha = 1
    for (const card of visible) {
      const node = card.node
      if (node.type !== 'pdf-page') continue
      const picture = this.callbacks.pageThumbnail(
        node.file,
        node.page,
        palette.dark,
      )
      if (!picture) continue
      ctx.drawImage(picture, card.x, card.y, card.w, card.h)
      pictured.add(node.id)
    }

    // 3. Borders. An uncoloured card takes the theme's border token at full
    //    strength; a coloured one takes its own colour at the stylesheet's 70%.
    ctx.lineWidth = 1
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.border
    ctx.beginPath()
    for (const card of visible) {
      if (this.colorOf(card.node, palette) !== null) continue
      if (this.callbacks.isSelected(card.node.id)) continue
      this.strokeRectPath(ctx, card)
    }
    ctx.stroke()
    ctx.globalAlpha = OVERVIEW_THEMED_BORDER_ALPHA
    for (const [color, cards] of byColor) {
      ctx.strokeStyle = color
      ctx.beginPath()
      let any = false
      for (const card of cards) {
        if (this.colorOf(card.node, palette) === null) continue
        if (this.callbacks.isSelected(card.node.id)) continue
        this.strokeRectPath(ctx, card)
        any = true
      }
      if (any) ctx.stroke()
    }

    // 4. Selection, over everything: one ring, in the accent, at the weight the
    //    stylesheet gives a selected card.
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.accent
    ctx.lineWidth = 2
    ctx.beginPath()
    let anySelected = false
    for (const card of visible) {
      if (!this.callbacks.isSelected(card.node.id)) continue
      this.strokeRectPath(ctx, card)
      anySelected = true
    }
    if (anySelected) ctx.stroke()
    ctx.lineWidth = 1

    // 4b. The sheets of a selected spread, lit faintly — the stylesheet's
    //     `.yolo-whiteboard-spread-sheet-of-selected`.
    ctx.globalAlpha = 0.45
    ctx.beginPath()
    let anyLit = false
    for (const card of visible) {
      const node = card.node
      if (node.type !== 'pdf-page') continue
      if (this.callbacks.isSelected(node.id)) continue
      if (!this.callbacks.isSelected(node.parent)) continue
      this.strokeRectPath(ctx, card)
      anyLit = true
    }
    if (anyLit) ctx.stroke()
    ctx.globalAlpha = 1

    // 5. Titles, where a card is wide enough on screen to hold one. The type
    //    and the box it wraps in are the DOM card's title block — 32 world
    //    units, so it shrinks with the card — which is what makes the switch
    //    between tiers invisible.
    const fontPx = TITLE_BLOCK_WORLD_FONT_PX * view.scale
    const lineHeight = fontPx * TITLE_BLOCK_LINE_HEIGHT
    ctx.font = `500 ${fontPx}px ${palette.fontFamily}`
    ctx.fillStyle = palette.text
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const card of visible) {
      if (card.w < OVERVIEW_TITLE_MIN_CARD_PX) continue
      if (pictured.has(card.node.id)) continue
      const title = nodeTitleText(card.node, this.callbacks.pdfPageLabels)
      if (title.length === 0) continue
      const lines = this.wrapTitle(ctx, title, card.node, view.scale)
      const top = card.y + card.h / 2 - ((lines.length - 1) * lineHeight) / 2
      for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i], card.x + card.w / 2, top + i * lineHeight)
      }
    }
  }

  /** A spread's title as the DOM draws it (spread.css): one line with the
   * type, the name and the page count, the name cut short to fit between the
   * other two, no box — and a card's ring when it is selected. */
  private drawSpreadTitles(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    titles: readonly Readonly<{
      node: BoardNode
      x: number
      y: number
      w: number
      h: number
    }>[],
  ): void {
    this.titleRects.clear()
    const palette = this.palette
    if (!palette || titles.length === 0) return
    // Held at a floor on screen, as a group's label is (constants.ts's
    // OVERVIEW_GROUP_LABEL_MIN_SCREEN_PX): the name is what an overview is
    // for. Everything in the line grows by the same factor, upwards from the
    // title's bottom edge so it never covers the paper, and as far right as
    // the whole name needs.
    const grow = Math.max(
      1,
      OVERVIEW_GROUP_LABEL_MIN_SCREEN_PX /
        (SPREAD_TITLE_WORLD.nameFont * view.scale),
    )
    const u = view.scale * grow
    const pad = SPREAD_TITLE_WORLD.padding * u
    const gap = SPREAD_TITLE_WORLD.gap * u
    const badgeText = 'PDF'
    const badgeFont = `600 ${SPREAD_TITLE_WORLD.badgeFont * u}px ${palette.fontFamily}`
    const nameFont = `500 ${SPREAD_TITLE_WORLD.nameFont * u}px ${palette.fontFamily}`
    const countFont = `${SPREAD_TITLE_WORLD.countFont * u}px ${palette.fontFamily}`
    ctx.globalAlpha = 1
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (const title of titles) {
      const name = nodeTitleText(title.node)
      const count = this.callbacks.spreadPageCountLabel(title.node.id)
      ctx.font = badgeFont
      const badgeW =
        ctx.measureText(badgeText).width +
        SPREAD_TITLE_WORLD.badgePadding * 2 * u
      ctx.font = nameFont
      const nameW = ctx.measureText(name).width
      ctx.font = countFont
      const countW = ctx.measureText(count).width
      const h = title.h * grow
      const box = {
        x: title.x,
        y: title.y + title.h - h,
        w: Math.max(title.w, pad + badgeW + gap + nameW + gap + countW + pad),
        h,
      }
      // Where it was drawn is where it is pointed at: the line reaches past
      // the node's rectangle, and a press on any of it is a press on the
      // title (`spreadTitleAt`).
      this.titleRects.set(title.node.id, {
        x: (box.x - view.tx) / view.scale,
        y: (box.y - view.ty) / view.scale,
        w: box.w / view.scale,
        h: box.h / view.scale,
      })
      if (this.callbacks.isSelected(title.node.id)) {
        ctx.strokeStyle = palette.accent
        ctx.lineWidth = 2
        ctx.beginPath()
        this.strokeRectPath(ctx, box)
        ctx.stroke()
      }
      if (title.w < OVERVIEW_TITLE_MIN_CARD_PX) continue
      const mid = box.y + box.h / 2
      // The type, on its tint.
      const badgeH = SPREAD_TITLE_WORLD.badgeHeight * u
      ctx.globalAlpha = 0.12
      ctx.fillStyle = palette.presets['1']
      ctx.fillRect(box.x + pad, mid - badgeH / 2, badgeW, badgeH)
      ctx.globalAlpha = 1
      ctx.font = badgeFont
      ctx.fillText(
        badgeText,
        box.x + pad + SPREAD_TITLE_WORLD.badgePadding * u,
        mid,
      )
      ctx.font = nameFont
      ctx.fillStyle = palette.text
      ctx.fillText(name, box.x + pad + badgeW + gap, mid)
      ctx.font = countFont
      ctx.fillStyle = palette.muted
      ctx.fillText(count, box.x + box.w - pad - countW, mid)
    }
    ctx.lineWidth = 1
  }

  /** The spread title whose drawn line is under `point` (world units), if
   * any — the line is wider and taller than the title's node at this tier. */
  spreadTitleAt(point: Readonly<{ x: number; y: number }>): NodeId | null {
    if (!this.active) return null
    for (const [id, rect] of this.titleRects) {
      if (
        point.x >= rect.x &&
        point.x <= rect.x + rect.w &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.h
      ) {
        return id
      }
    }
    return null
  }

  /** A card's title in the lines its title block would give it. Measured at
   * the font the context has now and taken back to world units, where the
   * answer does not change as the camera zooms. */
  private wrapTitle(
    ctx: CanvasRenderingContext2D,
    title: string,
    node: BoardNode,
    scale: number,
  ): readonly string[] {
    const key = `${node.w}x${node.h}\n${title}`
    const cached = this.titleLines.get(key)
    if (cached) return cached
    if (this.titleLines.size >= TITLE_LINES_CACHE_LIMIT) this.titleLines.clear()
    const padding = TITLE_BLOCK_WORLD_PADDING
    const lineHeight = TITLE_BLOCK_WORLD_FONT_PX * TITLE_BLOCK_LINE_HEIGHT
    const lines = wrapTitleLines(
      title,
      node.w - padding.x * 2,
      Math.max(1, Math.floor((node.h - padding.y * 2) / lineHeight)),
      (text) => ctx.measureText(text).width / scale,
    )
    this.titleLines.set(key, lines)
    return lines
  }

  /** Adds a card's border to the current path, inset by half a line so the
   * stroke lands inside the rectangle rather than straddling its edge. */
  private strokeRectPath(
    ctx: CanvasRenderingContext2D,
    card: Readonly<{ x: number; y: number; w: number; h: number }>,
  ): void {
    const inset = ctx.lineWidth / 2
    ctx.rect(
      card.x + inset,
      card.y + inset,
      Math.max(0, card.w - ctx.lineWidth),
      Math.max(0, card.h - ctx.lineWidth),
    )
  }

  // -----------------------------------------------------------------------
  // Edges
  //
  // The same bezier the DOM tiers draw (domain/edges.ts's
  // `computeEdgeGeometry`), so the two are visually continuous across the
  // switch, projected into screen space and batched by colour like the cards.
  //
  // Labels are drawn too, and drawn last so they sit over the curves the way
  // the opaque DOM chip does — but still inside this method, which runs before
  // the cards, because the label layer sits before the cards in the world
  // (canvas.ts's `ensureDom`) and a card covers a label that runs under it.
  // Arrowheads are drawn once they are big enough to read as arrowheads.
  // -----------------------------------------------------------------------

  private drawEdges(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    live: ReadonlyMap<NodeId, CardRect> | null,
  ): void {
    const palette = this.palette
    if (!palette) return
    // Stroke weight follows the same half-cancelled law the stylesheet uses
    // (`--yolo-whiteboard-zoom-multiplier`, 1/sqrt(scale)), which in screen
    // pixels is `1.5 * sqrt(scale)` -- with a floor, because a line thinner
    // than a pixel is drawn as a faded one and a board of them reads as haze.
    const stroke = Math.max(
      OVERVIEW_MIN_EDGE_STROKE_PX,
      EDGE_STROKE_WORLD_PX * Math.sqrt(view.scale),
    )
    const arrow = EDGE_ARROW_WORLD_PX * Math.sqrt(view.scale)
    const drawArrows = arrow >= OVERVIEW_ARROW_MIN_SCREEN_PX
    // Asked once, before the sweep: at the bottom of the tier there is no
    // label small enough to be worth drawing, and that is also where there are
    // the most edges to have skipped one for.
    const drawLabels =
      EDGE_LABEL_FONT_PX * Math.sqrt(view.scale) >= OVERVIEW_LABEL_MIN_FONT_PX

    type Segment = Readonly<{
      start: ScreenPoint
      c1: ScreenPoint
      c2: ScreenPoint
      end: ScreenPoint
      fromArrow: boolean
      toArrow: boolean
      selected: boolean
    }>
    const byColor = new Map<string, Segment[]>()
    // Labels are collected here rather than walked for separately: their
    // anchor is a point on the geometry this loop already computes.
    const labels: { text: string; x: number; y: number }[] = []
    const renamingEdgeId = this.callbacks.getRenamingEdgeId()
    const toScreen = (p: ScreenPoint): ScreenPoint => ({
      x: p.x * view.scale + view.tx,
      y: p.y * view.scale + view.ty,
    })

    // The band of the board the viewport covers, in world units, grown by the
    // margin that bounds a curve outside its endpoints (edgeLayer's
    // `edgeIsVisible` documents the bound). Rejecting an edge here costs four
    // comparisons; rejecting it after its geometry costs the geometry, and at
    // this zoom four edges in five are off screen.
    const world = computeWorldViewportRect(this.width, this.height, view, 0)
    const margin = EDGE_CONTROL_MAX_PX

    for (const edge of this.callbacks.getEdges()) {
      const fromNode = this.callbacks.getNode(edge.fromNode)
      const toNode = this.callbacks.getNode(edge.toNode)
      if (!fromNode || !toNode) continue
      const from = {
        id: edge.fromNode,
        ...(live?.get(edge.fromNode) ?? fromNode),
      }
      const to = { id: edge.toNode, ...(live?.get(edge.toNode) ?? toNode) }
      if (
        Math.min(from.x, to.x) - margin > world.right ||
        Math.max(from.x + from.w, to.x + to.w) + margin < world.left ||
        Math.min(from.y, to.y) - margin > world.bottom ||
        Math.max(from.y + from.h, to.y + to.h) + margin < world.top
      ) {
        continue
      }
      const sides = resolveEdgeSides(from, to, edge.fromSide, edge.toSide)
      const geometry = computeEdgeGeometry(
        from,
        to,
        sides.fromSide,
        sides.toSide,
      )
      const start = toScreen(geometry.start)
      const end = toScreen(geometry.end)
      // A curve stays inside the hull of its control points, so a box around
      // all four is enough to decide it cannot be seen.
      const c1 = toScreen(geometry.c1)
      const c2 = toScreen(geometry.c2)
      if (
        Math.min(start.x, end.x, c1.x, c2.x) > this.width ||
        Math.max(start.x, end.x, c1.x, c2.x) < 0 ||
        Math.min(start.y, end.y, c1.y, c2.y) > this.height ||
        Math.max(start.y, end.y, c1.y, c2.y) < 0
      ) {
        continue
      }
      const selected = this.callbacks.isEdgeSelected(edge.id)
      const color = selected ? palette.accent : this.colorOfEdge(edge, palette)
      const segment: Segment = {
        start,
        c1,
        c2,
        end,
        fromArrow: edge.fromEnd === 'arrow',
        toArrow: edge.toEnd === 'arrow',
        selected,
      }
      const bucket = byColor.get(color)
      if (bucket) bucket.push(segment)
      else byColor.set(color, [segment])
      if (!drawLabels) continue
      const text = edge.label?.trim() ?? ''
      if (text.length > 0 && edge.id !== renamingEdgeId) {
        const at = toScreen(geometry.label)
        labels.push({ text, x: at.x, y: at.y })
      }
    }
    if (byColor.size === 0) return

    ctx.globalAlpha = 1
    ctx.lineCap = 'round'
    for (const [color, segments] of byColor) {
      ctx.strokeStyle = color
      ctx.fillStyle = color
      // A selected edge is drawn heavier, exactly as the stylesheet does it, so
      // it needs its own pass at its own width.
      for (const selected of [false, true]) {
        const pass = segments.filter((s) => s.selected === selected)
        if (pass.length === 0) continue
        ctx.lineWidth = selected ? stroke * 2 : stroke
        ctx.beginPath()
        for (const s of pass) {
          ctx.moveTo(s.start.x, s.start.y)
          ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.end.x, s.end.y)
        }
        ctx.stroke()
        if (!drawArrows) continue
        ctx.beginPath()
        for (const s of pass) {
          if (s.toArrow) this.arrowHeadPath(ctx, s.c2, s.end, arrow)
          if (s.fromArrow) this.arrowHeadPath(ctx, s.c1, s.start, arrow)
        }
        ctx.fill()
      }
    }
    ctx.lineWidth = 1
    this.drawEdgeLabels(ctx, view, labels)
  }

  /**
   * The chips that name relations, over the curves they belong to.
   *
   * Not drawn while the tier only ran below 0.15, on the grounds that the type
   * was a smudge by then. That is still true down there — hence the floor —
   * but the tier now reaches 0.35, where a label is the one piece of text on
   * the board saying what a line *means*, and a board of unnamed lines is the
   * thing this zoom exists to read.
   *
   * One line, ellipsised at the stylesheet's `max-width`, where the element
   * wraps: wrapping buys a second row of type this small, which is not a
   * trade. The chip is a plain rectangle rather than the element's rounded
   * one — its radius is 4 world units, under a pixel and a half here, so the
   * corners are a rounding error and `fillRect` is what a rounding error
   * should cost.
   */
  private drawEdgeLabels(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    labels: readonly Readonly<{ text: string; x: number; y: number }>[],
  ): void {
    const palette = this.palette
    if (!palette || labels.length === 0) return
    // The counter-scaled law the stylesheet uses, in screen pixels: a size
    // written in world units as `15 * 1/sqrt(scale)` lands at `15 * sqrt`.
    const root = Math.sqrt(view.scale)
    const fontPx = EDGE_LABEL_FONT_PX * root
    const padX = EDGE_LABEL_PADDING_PX.x * root
    const padY = EDGE_LABEL_PADDING_PX.y * root
    const lineHeight = fontPx * 1.3
    const maxTextWidth = EDGE_LABEL_MAX_WIDTH_EM * fontPx

    ctx.globalAlpha = 1
    ctx.font = `${fontPx}px ${palette.fontFamily}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const drawn: { text: string; width: number; x: number; y: number }[] = []
    for (const label of labels) {
      const text = this.ellipsise(ctx, label.text, maxTextWidth)
      const width = ctx.measureText(text).width
      const x = label.x - width / 2
      const y = label.y
      // Off-screen labels are cheap to skip and not cheap to draw: an edge is
      // kept for its curve, and the curve's midpoint can be well outside the
      // viewport the curve crosses.
      if (
        x - padX > this.width ||
        x + width + padX < 0 ||
        y - lineHeight / 2 - padY > this.height ||
        y + lineHeight / 2 + padY < 0
      ) {
        continue
      }
      drawn.push({ text, width, x, y })
    }
    if (drawn.length === 0) return

    ctx.fillStyle = palette.background
    for (const label of drawn) {
      ctx.fillRect(
        label.x - padX,
        label.y - lineHeight / 2 - padY,
        label.width + padX * 2,
        lineHeight + padY * 2,
      )
    }
    ctx.fillStyle = palette.text
    for (const label of drawn) ctx.fillText(label.text, label.x, label.y)
  }

  /** The text as it fits, with an ellipsis where it stops — what the element's
   * `max-width` plus wrapping does, minus the wrapping. Binary search rather
   * than a character at a time: `measureText` is the cost here, and a label
   * long enough to need cutting is long enough for the difference to show. */
  private ellipsise(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
  ): string {
    if (ctx.measureText(text).width <= maxWidth) return text
    let low = 0
    let high = text.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    return `${text.slice(0, low)}…`
  }

  /** A filled triangle at `tip`, pointing the way the curve arrives there —
   * which the last control point gives, since a bezier leaves its endpoint
   * along the line to its neighbouring control point. */
  private arrowHeadPath(
    ctx: CanvasRenderingContext2D,
    from: ScreenPoint,
    tip: ScreenPoint,
    size: number,
  ): void {
    const dx = tip.x - from.x
    const dy = tip.y - from.y
    const length = Math.hypot(dx, dy)
    if (length < 1e-3) return
    const ux = dx / length
    const uy = dy / length
    const baseX = tip.x - ux * size
    const baseY = tip.y - uy * size
    const halfWidth = size / 2
    ctx.moveTo(tip.x, tip.y)
    ctx.lineTo(baseX - uy * halfWidth, baseY + ux * halfWidth)
    ctx.lineTo(baseX + uy * halfWidth, baseY - ux * halfWidth)
    ctx.closePath()
  }
}
