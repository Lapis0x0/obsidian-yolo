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
import { type ColorPreset, PRESET_HEX, resolveColor } from '../../domain/color'
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
import { fileNodeKind } from '../../domain/naming'
import type {
  AnnotationColor,
  PdfAnnotation,
} from '../../domain/pdfAnnotations'
import { fileNodeOf, isPortal, portalWeight } from '../../domain/portals'
import type { CardRect } from '../../domain/resize'
import { isSpreadTitle } from '../../domain/spread'
import {
  type CanvasView,
  computeWorldViewportRect,
} from '../../domain/virtualization'
import {
  EDGE_ARROW_WORLD_PX,
  EDGE_LABEL_FONT_PX,
  EDGE_LABEL_MAX_WIDTH_EM,
  EDGE_LABEL_PADDING_PX,
  EDGE_PASSAGE_MARK_WORLD_PX,
  EDGE_STROKE_WORLD_PX,
  LIFT_SHADOW,
  OVERVIEW_ARROW_MIN_SCREEN_PX,
  OVERVIEW_CARD_WASH_ALPHA,
  OVERVIEW_LABEL_MIN_FONT_PX,
  OVERVIEW_MIN_EDGE_STROKE_PX,
  OVERVIEW_THEMED_BORDER_ALPHA,
  OVERVIEW_THEMED_CARD_WASH_ALPHA,
  OVERVIEW_TITLE_MIN_CARD_PX,
  TITLE_BLOCK_LINE_HEIGHT,
  TITLE_BLOCK_WORLD_FONT_PX,
  TITLE_BLOCK_WORLD_PADDING,
} from '../constants'
import { type PdfPageLabels, nodeTitleText, wrapTitleLines } from '../lod'
import type { PageFrame } from '../pdf/annotationGeometry'
import { pageMarks, paintPageMarks } from '../pdf/pageMarks'
import { READER_METRICS } from '../pdf/readerLayout'
import type { Pose } from '../tween'

import {
  TITLE_LOOK,
  type Title,
  type TitleBadgeTone,
  type TitleMeasure,
  titleBox,
  titleScale,
} from './nodeTitle'

const OVERVIEW_CANVAS_CLASS = 'yolo-whiteboard-overview'
const OVERVIEW_HIDDEN_CLASS = 'yolo-whiteboard-overview-hidden'
/** How dark bare text's block of ink is drawn, zoomed out past reading it. */
const OVERVIEW_TEXT_ALPHA = 0.18
/** A group's wash (`drawGroupWashes`): how much of its colour an open
 * frame, a collapsed box and a lit one are filled with — the accent's being
 * lighter, as a full colour against a preset — and the corners of each, in
 * the element's units (styles/cards/group.css). */
const GROUP_WASH = {
  open: 0.08,
  folded: 0.12,
  lit: 0.16,
  litAccent: 0.07,
  radius: 16,
  foldedRadius: 12,
} as const
/** Below this many CSS pixels wide a page is drawn as its card alone, not
 * its picture: there is nothing of the page left to see, and a minimap holds
 * hundreds of pages each narrower than a pixel — scaling every one of their
 * thumbnails down was most of what redrawing it cost. */
const PICTURE_MIN_SCREEN_PX = 4
/** Past this many wrapped titles the cache starts over rather than growing
 * with every card a long session has ever shown. */
const TITLE_LINES_CACHE_LIMIT = 2000

/** The surface a draw is for: its size in CSS pixels, which decides
 * whether a card or an edge is on it at all; whether it carries text —
 * titles and edge labels, which the tier sizes for a screen and the
 * minimap has no room for; and whether it shows the selection, which is
 * the board being worked on, not the board being found your way around. */
type Surface = Readonly<{
  width: number
  height: number
  text: boolean
  selection: boolean
  /** The board's own screen, whose cards' content `contentLayer` may draw
   * — not the minimap's. */
  screen: boolean
}>

/**
 * Another layer that draws some of the cards this one would: the GPU scene
 * (../gpu/gpuBoard.ts), over this canvas and under the world. Each frame
 * this layer draws, it starts a pass and asks, card by card, whether the
 * other draws it; a card it says yes to it draws whole — surface, colour,
 * border, selection and content — and this layer draws nothing of it but its
 * title line.
 */
export type ContentLayer = Readonly<{
  begin: () => void
  /** Whether it draws `node`'s content this frame, laid out at `rect`
   * (world units) — and, a card in motion (./motions.ts), shown `look.scale`
   * times that size from its top-left at `look.alpha`, turned and picked up
   * as `look` says; a yes is a promise to. */
  claim: (node: BoardNode, rect: CardRect, look?: CardLook) => boolean
}>

/** How a card in motion is shown, beyond where: scaled from its top-left,
 * how opaque, turned about its centre (radians), and how far picked up —
 * what its shadow shows (../tween.ts's `Pose`). */
export type CardLook = Readonly<{
  scale: number
  alpha: number
  rotate?: number
  lift?: number
}>

/** How `node` shown at `pose` looks (`CardLook`). */
function lookOf(node: BoardNode, pose: Pose): CardLook {
  return {
    scale: pose.w / node.w,
    alpha: pose.opacity,
    rotate: pose.rotate,
    lift: pose.lift,
  }
}

/** A page's annotations as the overview draws them: its highlights one path
 * per colour, in page fractions, and its framed areas. */

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
  /** What each PDF annotation colour paints with (styles/pdf/
   * annotations.css). */
  annotations: Readonly<Record<AnnotationColor, string>>
  /** What each title's badge is tinted with (styles/cards/
   * node-title.css). */
  badges: Readonly<Record<TitleBadgeTone, string>>
  /** A dark theme, which shows PDF pages inverted (styles/pdf/card.css). */
  dark: boolean
}>

/**
 * The narrow surface `WhiteboardCanvas` injects so the overview can read the
 * board, the camera and the selection it does not own — and, while a gesture
 * is in flight, the geometry that has not been committed to the board yet.
 */
/** A portal's contents, and the frame they show through, in world units —
 * and `scale`, what they are drawn at (domain/portals.ts's
 * `ComposedPortal`): what is sized in world units inside a card, its type,
 * is drawn that much larger or smaller. */
export type PortalLayer = Readonly<{
  /** The frame it is cut to; null for cards picked up out of it, which are
   * in the hand rather than behind the frame, and drawn at its scale still. */
  clip: Readonly<{ x: number; y: number; w: number; h: number }> | null
  scale: number
  nodes: readonly BoardNode[]
  edges: readonly Edge[]
}>

export type OverviewLayerCallbacks = Readonly<{
  getView: () => CanvasView
  /** Every non-group node, in board order — groups keep their DOM. */
  getCardNodes: () => readonly BoardNode[]
  /** How wide an open spread's title may run before its name is cut
   * short, in world units (domain/spread.ts's `spreadTitleMaxWidth`). */
  spreadTitleMaxWidth: (id: NodeId) => number
  /** The title a card wears (./nodeTitle.ts's `titleOf`), or null. */
  titleOf: (node: BoardNode) => Title | null
  /** How wide titles lay out, in the DOM's font (./nodeTitle.ts). */
  titleMeasure: () => TitleMeasure
  /** The groups. Their frames, titles and borders are their DOM's at every
   * tier, but their washes are drawn here, under the cards
   * (`drawGroupWashes`); the minimap draws them whole (`paintBoard`). */
  getGroupNodes: () => readonly BoardNode[]
  /** The frame a node behind a portal shows through, which its group's wash
   * is cut to; null for the board's own. */
  portalClipOf: (
    id: NodeId,
  ) => Readonly<{ x: number; y: number; w: number; h: number }> | null
  /** The group a drag in progress has lit, whose wash deepens. */
  litGroup: () => NodeId | null
  getEdges: () => readonly Edge[]
  /** What is behind each open portal (domain/portals.ts), cut to where it
   * shows through: drawn after the board's own, each in its frame.
   * `getCardNodes` and `getEdges` are the board's own. */
  getPortalLayers: () => readonly PortalLayer[]
  getNode: (id: NodeId) => BoardNode | undefined
  isSelected: (id: NodeId) => boolean
  isEdgeSelected: (id: EdgeId) => boolean
  /** The edge whose label is being typed, or null. That one label stays in
   * the DOM for the length of the rename (canvas.ts's `syncEdgeRenameChrome`)
   * because a canvas holds no caret, so this is the one this layer must not
   * draw as well. */
  getRenamingEdgeId: () => EdgeId | null
  /** Whether the card has its DOM in the world layer now — outside the tier,
   * the cards that do not are the ones this layer draws (`render`). */
  isMounted: (id: NodeId) => boolean
  /**
   * Live rectangles for the nodes a drag or a resize is moving, or null when
   * nothing is. In the DOM tiers this feedback is a `transform` on the card's
   * element; here it is the same numbers, drawn.
   */
  getLiveRects: () => ReadonlyMap<NodeId, CardRect> | null
  /** Where a node in motion is shown now (./motions.ts), or null for one
   * shown where the board has it. */
  poseOf: (id: NodeId) => Pose | null
  /** Cards that have left the board and are shown on their way out
   * (./motions.ts's `departures`), drawn with the board's own. */
  departures: () => Iterable<Readonly<{ node: BoardNode; pose: Pose }>>
  /** What the collapsed groups show in their boxes, where (canvas.ts's
   * `foldedShown`), drawn with the board's own. */
  folded: () => Iterable<Readonly<{ node: BoardNode; pose: Pose }>>
  /** What a PDF card's or a sheet's title says about its page — see
   * ui/lod.ts's `nodeTitleText`. */
  pdfPageLabels: PdfPageLabels
  /** The small picture standing for a card (../pictures/pictures.ts), as
   * the theme shows it — for a PDF card, the one of its page `page` — or
   * null while it has none. */
  picture: (node: BoardNode, dark: boolean, page?: number) => ImageBitmap | null
  /** What draws some cards' content instead of their pictures, if
   * anything does. */
  contentLayer: () => ContentLayer | null
  /** The annotations on a page that has a picture, and where its PDF points
   * land on it (../pictures/pdfPages.ts's `pageFrame`); null when there are
   * none to draw. */
  pageAnnotations: (
    path: string,
    page: number,
  ) => Readonly<{
    frame: PageFrame
    annotations: readonly PdfAnnotation[]
  }> | null
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
  /** Outside the tier, whether the canvas is showing cards the DOM has not
   * mounted yet — see `renderUnmounted`. */
  private underlay = false
  private dirty = false
  /** Counts `markDirty` calls — see `revision`. */
  private revisionCount = 0
  private palette: Palette | null = null
  /** Titles already broken into lines, by text and the card's world size.
   * Kept in world units, so a zoom does not invalidate them; dropped with the
   * palette, whose font they were measured in. */
  private readonly titleLines = new Map<string, readonly string[]>()
  /** Where each title was last drawn, in world units. */
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
      this.markDirty()
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
    this.underlay = false
    this.canvasEl.classList.toggle(OVERVIEW_HIDDEN_CLASS, !active)
    this.lastView = null
    if (active) {
      this.palette = null
      this.titleLines.clear()
      this.dirty = true
      return
    }
    this.clear()
    this.callbacks.contentLayer()?.begin()
  }

  /** The board, the camera or the selection moved: the next frame redraws.
   * Nothing else does — a still board costs nothing. */
  markDirty(): void {
    this.dirty = true
    this.revisionCount += 1
  }

  /** Cards were mounted or unmounted: outside the tier that changes what the
   * canvas has to draw, though not what the board shows (`revision`) — and
   * inside it too, behind a portal that builds what is behind it. */
  markMountsChanged(): void {
    this.dirty = true
  }

  /**
   * Changes whenever what the board shows does — its contents, the
   * selection, a picture arriving, the theme — and not when the camera
   * moves, which reaches `render` by the view's identity instead. What a
   * surface holding the board at a view of its own (the minimap) watches to
   * know when to draw again.
   */
  get revision(): number {
    return this.revisionCount
  }

  /**
   * Draws the whole board into another surface — the minimap's
   * (./minimap.ts) — with this tier's drawing, so the two show the board the
   * same way. Groups too, which the tier leaves to the DOM: on a surface of
   * its own they are the landmarks the board is read by — and no text, which
   * the tier sizes for a screen: a PDF's title would run across a minimap.
   * No selection either: a minimap is for finding your way, and a ring
   * there only repeats what the board already shows. The caller owns the
   * context's transform and clears it first.
   */
  paintBoard(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    size: Readonly<{ width: number; height: number }>,
  ): void {
    this.palette ??= this.readPalette(ctx)
    const live = this.callbacks.getLiveRects()
    const surface = { ...size, text: false, selection: false, screen: false }
    this.drawGroups(ctx, view, live)
    this.drawBoard(ctx, view, surface, live)
    ctx.globalAlpha = 1
  }

  /** Edges, then cards — the board's own, then each portal's in its frame
   * — and the portals' frames over what they frame (`drawFrames`). Behind a
   * portal, what `skipBehind` names is left out: in the tier, the cards a
   * portal zoomed in on shows built (canvas.ts's `drawnPortals`). */
  private drawBoard(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    surface: Surface,
    live: ReadonlyMap<NodeId, CardRect> | null,
    skipBehind?: (id: NodeId) => boolean,
  ): void {
    this.drawEdges(ctx, view, surface, live)
    this.drawCards(ctx, view, surface, live)
    this.inPortals(ctx, view, (layer) => {
      this.drawEdges(ctx, view, surface, live, layer.edges, layer.scale)
      this.drawCards(
        ctx,
        view,
        surface,
        live,
        skipBehind,
        layer.nodes,
        layer.scale,
      )
      return true
    })
    this.drawFrames(ctx, view, surface, live)
    this.inPortals(ctx, view, (layer) =>
      this.drawFrames(ctx, view, surface, live, skipBehind, layer.nodes),
    )
  }

  /**
   * A portal is its frame and nothing else (portal.css): what shows through
   * it is drawn cut to it (`inPortals`), and its name is its title line. The
   * frame goes over what it frames — drawn after it, as the DOM keeps what
   * is behind a portal inside its border (canvas.ts's `portalClip`) — and
   * the selection's ring with it. True if any was drawn.
   */
  private drawFrames(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    surface: Surface,
    live: ReadonlyMap<NodeId, CardRect> | null,
    skip?: (id: NodeId) => boolean,
    nodes: readonly BoardNode[] = this.callbacks.getCardNodes(),
  ): boolean {
    const palette = this.palette
    if (!palette) return false
    const frames: {
      node: BoardNode
      x: number
      y: number
      w: number
      h: number
    }[] = []
    for (const node of nodes) {
      if (!isPortal(node) || skip?.(node.id)) continue
      const rect = live?.get(node.id) ?? node
      const x = rect.x * view.scale + view.tx
      const y = rect.y * view.scale + view.ty
      const w = rect.w * view.scale
      const h = rect.h * view.scale
      if (
        x >= surface.width ||
        y >= surface.height ||
        x + w <= 0 ||
        y + h <= 0
      ) {
        continue
      }
      frames.push({ node, x, y, w, h })
    }
    if (frames.length === 0) return false
    const isSelected = (id: NodeId): boolean =>
      surface.selection && this.callbacks.isSelected(id)
    // A card's border, and a selected card's ring (`drawCards`).
    ctx.globalAlpha = 1
    ctx.lineWidth = 1
    ctx.strokeStyle = palette.border
    ctx.beginPath()
    for (const frame of frames) {
      if (!isSelected(frame.node.id)) this.strokeRectPath(ctx, frame)
    }
    ctx.stroke()
    ctx.strokeStyle = palette.accent
    ctx.lineWidth = 2
    ctx.beginPath()
    for (const frame of frames) {
      if (isSelected(frame.node.id)) this.strokeRectPath(ctx, frame)
    }
    ctx.stroke()
    ctx.lineWidth = 1
    return true
  }

  /** Runs `draw` for each open portal, with the context cut to its frame;
   * true if any of them drew. */
  private inPortals(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    draw: (layer: PortalLayer) => boolean,
  ): boolean {
    let drew = false
    for (const layer of this.callbacks.getPortalLayers()) {
      const { clip } = layer
      if (!clip) {
        if (draw(layer)) drew = true
        continue
      }
      const x = clip.x * view.scale + view.tx
      const y = clip.y * view.scale + view.ty
      const w = clip.w * view.scale
      const h = clip.h * view.scale
      if (x >= this.width || y >= this.height || x + w <= 0 || y + h <= 0) {
        continue
      }
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, w, h)
      ctx.clip()
      if (draw(layer)) drew = true
      ctx.restore()
    }
    return drew
  }

  /**
   * Every group's wash — the faint fill of its colour its frame is — under
   * every card. The rest of a group is its element's, in the world layer
   * over the board's drawing; its wash cannot be: a fill over the GPU scene
   * and this canvas tinted every card it held with it. Drawn where the
   * group is shown (a frame reaching out, carried, folding), in its own
   * colour or the board's grey, deeper while a drag has it lit — in the
   * accent for a group of no colour — and cut to the portal it is behind.
   * Whether any was drawn.
   */
  private drawGroupWashes(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    surface: Surface,
    live: ReadonlyMap<NodeId, CardRect> | null,
  ): boolean {
    const palette = this.palette
    if (!palette) return false
    const lit = this.callbacks.litGroup()
    let drew = false
    for (const node of this.callbacks.getGroupNodes()) {
      const rect = this.callbacks.poseOf(node.id) ?? live?.get(node.id) ?? node
      const x = rect.x * view.scale + view.tx
      const y = rect.y * view.scale + view.ty
      const w = rect.w * view.scale
      const h = rect.h * view.scale
      if (x >= surface.width || y >= surface.height || x + w <= 0 || y + h <= 0)
        continue
      const own = this.colorOf(node, palette)
      const folded = node.type === 'group' && node.stash !== undefined
      const alpha =
        node.id === lit
          ? own === null
            ? GROUP_WASH.litAccent
            : GROUP_WASH.lit
          : folded
            ? GROUP_WASH.folded
            : GROUP_WASH.open
      const clip = this.callbacks.portalClipOf(node.id)
      ctx.save()
      if (clip) {
        ctx.beginPath()
        ctx.rect(
          clip.x * view.scale + view.tx,
          clip.y * view.scale + view.ty,
          clip.w * view.scale,
          clip.h * view.scale,
        )
        ctx.clip()
      }
      ctx.globalAlpha = alpha
      ctx.fillStyle =
        own ?? (node.id === lit ? palette.accent : palette.neutral)
      ctx.beginPath()
      ctx.roundRect(
        x,
        y,
        w,
        h,
        (folded ? GROUP_WASH.foldedRadius : GROUP_WASH.radius) *
          view.scale *
          (rect.w / node.w),
      )
      ctx.fill()
      ctx.restore()
      drew = true
    }
    ctx.globalAlpha = 1
    return drew
  }

  /** The groups as frames: a faint wash of their colour and its border —
   * the group stylesheet's look with the label left out, which at a
   * minimap's size would be a smudge. */
  private drawGroups(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    live: ReadonlyMap<NodeId, CardRect> | null,
    groups: readonly BoardNode[] = this.callbacks.getGroupNodes(),
  ): void {
    const palette = this.palette
    if (!palette) return
    ctx.lineWidth = 1
    for (const node of groups) {
      const rect = live?.get(node.id) ?? node
      const color = this.colorOf(node, palette) ?? palette.neutral
      const x = rect.x * view.scale + view.tx
      const y = rect.y * view.scale + view.ty
      const w = rect.w * view.scale
      const h = rect.h * view.scale
      ctx.fillStyle = color
      ctx.globalAlpha = OVERVIEW_CARD_WASH_ALPHA / 2
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = color
      ctx.globalAlpha = OVERVIEW_THEMED_BORDER_ALPHA
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
    }
    ctx.globalAlpha = 1
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
    if (!this.active) {
      this.renderUnmounted(ctx, view)
      return
    }
    this.palette ??= this.readPalette(ctx)
    this.resizeBackingStore(ctx)
    ctx.clearRect(0, 0, this.width, this.height)
    const live = this.callbacks.getLiveRects()
    // Edges first, so a card covers the line that ends at it rather than the
    // other way round -- the order the DOM tiers paint in.
    const surface = {
      width: this.width,
      height: this.height,
      text: true,
      selection: true,
      screen: true,
    }
    this.callbacks.contentLayer()?.begin()
    // Recorded as the frame draws them — the board's own and every
    // portal's — so cleared once, before any.
    this.titleRects.clear()
    this.drawGroupWashes(ctx, view, surface, live)
    this.drawBoard(ctx, view, surface, live, (id) =>
      this.callbacks.isMounted(id),
    )
    ctx.globalAlpha = 1
  }

  /**
   * Outside the tier: the cards on screen whose DOM has not been mounted
   * yet, drawn as the tier draws them, under the world layer.
   *
   * The DOM tiers mount what the camera shows a few cards a frame
   * (MOUNT_QUOTA_PER_FRAME) and look again at what it shows every
   * RECOMPUTE_INTERVAL_MS, so a camera that widens faster than that — a
   * sharp zoom out from reading a page — showed blank board where the cards
   * it had not mounted yet were, and then had them appear. The tier's exit
   * already covers that moment by drawing on until the mount queue drains
   * (canvas.ts's `settleOverviewLinger`); this is the same handoff for every
   * other moment: a card that mounts covers its own drawing from the frame it
   * mounts in, so there is never a frame where it is shown by neither.
   *
   * Only the cards with no DOM, not the whole board as in the tier: a bare
   * text card's DOM is transparent, and what the tier draws for one would
   * show through it. Nor edges: theirs is still in the document. When it
   * draws nothing the canvas goes out of the document again, so a board whose
   * cards are all there costs a pass over them per camera move and nothing
   * at rest.
   */
  private renderUnmounted(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
  ): void {
    this.palette ??= this.readPalette(ctx)
    this.resizeBackingStore(ctx)
    if (this.underlay) ctx.clearRect(0, 0, this.width, this.height)
    this.titleRects.clear()
    const surface = {
      width: this.width,
      height: this.height,
      text: true,
      selection: true,
      screen: true,
    }
    this.callbacks.contentLayer()?.begin()
    const live = this.callbacks.getLiveRects()
    const mounted = (id: NodeId) => this.callbacks.isMounted(id)
    const washed = this.drawGroupWashes(ctx, view, surface, live)
    const ownDrew = this.drawCards(ctx, view, surface, live, mounted)
    const portalsDrew = this.inPortals(ctx, view, (layer) =>
      this.drawCards(
        ctx,
        view,
        surface,
        live,
        mounted,
        layer.nodes,
        layer.scale,
      ),
    )
    const ownFramesDrew = this.drawFrames(ctx, view, surface, live, mounted)
    const portalFramesDrew = this.inPortals(ctx, view, (layer) =>
      this.drawFrames(ctx, view, surface, live, mounted, layer.nodes),
    )
    const drew =
      washed || ownDrew || portalsDrew || ownFramesDrew || portalFramesDrew
    ctx.globalAlpha = 1
    if (drew === this.underlay) return
    this.underlay = drew
    this.canvasEl.classList.toggle(OVERVIEW_HIDDEN_CLASS, !drew)
    if (!drew) this.clear()
  }

  /**
   * The cards in motion this frame that the content layer does not draw
   * (`drawCards`), each where it is shown (./motions.ts) and as opaque —
   * card by card rather than batched, since each has its own opacity, and
   * over the cards at rest. Drawn as they are drawn at rest, so nothing
   * changes the frame one stops moving: its surface, its wash, its picture,
   * its border, and its title block where it has no picture. Whether any
   * was drawn.
   */
  private drawMoving(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    moving: readonly Readonly<{ node: BoardNode; pose: Pose }>[],
  ): boolean {
    const palette = this.palette
    if (!palette) return false
    let drew = false
    const dpr = this.context.getWindow().devicePixelRatio || 1
    for (const { node, pose } of moving) {
      const alpha = pose.opacity
      if (alpha <= 0) continue
      drew = true
      const x = pose.x * view.scale + view.tx
      const y = pose.y * view.scale + view.ty
      const w = pose.w * view.scale
      const h = pose.h * view.scale
      ctx.save()
      if (pose.rotate) {
        ctx.translate(x + w / 2, y + h / 2)
        ctx.rotate(pose.rotate)
        ctx.translate(-x - w / 2, -y - h / 2)
      }
      ctx.globalAlpha = alpha
      ctx.fillStyle = palette.background
      // Picked up, its surface casts the shadow — in the card's units, as
      // the card's own does (drag.css). A shadow's offset and blur are in
      // device pixels, turned by nothing: it falls straight down whatever
      // the card does.
      const lift = pose.lift ?? 0
      if (lift > 0) {
        const unit = (pose.w / node.w) * view.scale * dpr
        ctx.shadowColor = `rgba(0, 0, 0, ${LIFT_SHADOW.alpha * lift})`
        ctx.shadowBlur = LIFT_SHADOW.blur * unit
        ctx.shadowOffsetY = LIFT_SHADOW.offsetY * unit
      }
      ctx.fillRect(x, y, w, h)
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
      const picture = this.pictureOf(node, { w }, palette.dark)
      const own = this.colorOf(node, palette)
      if (!picture || own !== null) {
        ctx.globalAlpha =
          alpha *
          (picture
            ? OVERVIEW_THEMED_CARD_WASH_ALPHA[palette.dark ? 'dark' : 'light']
            : OVERVIEW_CARD_WASH_ALPHA)
        ctx.fillStyle = own ?? palette.neutral
        ctx.fillRect(x, y, w, h)
      }
      ctx.globalAlpha = alpha
      const pictured = this.drawPicture(
        ctx,
        node,
        { x, y, w, h },
        palette.dark,
        view.scale,
        picture,
      )
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
      if (!pictured && w >= OVERVIEW_TITLE_MIN_CARD_PX) {
        const title = nodeTitleText(node, this.callbacks.pdfPageLabels)
        ctx.font = `500 ${TITLE_BLOCK_WORLD_FONT_PX * view.scale * (pose.w / node.w)}px ${palette.fontFamily}`
        ctx.fillStyle = palette.text
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(title, x + w / 2, y + h / 2, w)
      }
      ctx.restore()
    }
    ctx.globalAlpha = 1
    return drew
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
        '1': read('--yolo-whiteboard-color-1', PRESET_HEX['1']),
        '2': read('--yolo-whiteboard-color-2', PRESET_HEX['2']),
        '3': read('--yolo-whiteboard-color-3', PRESET_HEX['3']),
        '4': read('--yolo-whiteboard-color-4', PRESET_HEX['4']),
        '5': read('--yolo-whiteboard-color-5', PRESET_HEX['5']),
        '6': read('--yolo-whiteboard-color-6', PRESET_HEX['6']),
      },
      neutral: read('--yolo-whiteboard-color', '#c0c0c0'),
      border: read('--yolo-whiteboard-card-border', '#e8e8e8'),
      accent: read('--interactive-accent', '#7c3aed'),
      text: read('--text-normal', '#222222'),
      muted: read('--text-muted', '#5c5c5c'),
      background: read('--yolo-whiteboard-card-background', '#ffffff'),
      fontFamily: style.fontFamily || 'sans-serif',
      annotations: {
        yellow: read('--color-yellow', '#e0ac00'),
        green: read('--color-green', '#08b94e'),
        blue: read('--color-blue', '#086ddd'),
        pink: read('--color-pink', '#d53984'),
        purple: read('--color-purple', '#7852ee'),
      },
      badges: {
        red: read('--color-red', '#e93147'),
        blue: read('--color-blue', '#086ddd'),
      },
      dark: this.styleSourceEl.closest('.theme-dark') !== null,
    }
  }

  /** Whether the canvas can paint with this colour — a theme may hand back a
   * value the 2D context does not accept, and a rejected `fillStyle` silently
   * keeps the previous colour, which would paint the board in the wrong one
   * rather than in the fallback. */
  private parses(ctx: CanvasRenderingContext2D, value: string): boolean {
    const before = ctx.fillStyle
    // Tried against two different colours, so a value that happens to be
    // the one already set — the text colour the last frame's titles left
    // there, when the theme is read again — is not taken for rejected.
    const acceptedOver = (probe: string): boolean => {
      ctx.fillStyle = probe
      ctx.fillStyle = value
      return ctx.fillStyle !== probe
    }
    const accepted = acceptedOver('#000000') || acceptedOver('#ffffff')
    ctx.fillStyle = before
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
    surface: Surface,
    live: ReadonlyMap<NodeId, CardRect> | null,
    skip?: (id: NodeId) => boolean,
    nodes: readonly BoardNode[] = this.callbacks.getCardNodes(),
    unit = 1,
  ): boolean {
    const moving: { node: BoardNode; pose: Pose }[] = []
    const still = this.drawStillCards(
      ctx,
      view,
      surface,
      live,
      moving,
      skip,
      nodes,
      unit,
    )
    const own =
      surface.screen && unit === 1 && nodes === this.callbacks.getCardNodes()
    if (!own) return this.drawMoving(ctx, view, moving) || still
    // Over the cards at rest: what the collapsed groups show in their boxes,
    // then what is on its way into one, then everything in motion.
    const content = this.callbacks.contentLayer()
    const boxed = this.drawPosed(
      ctx,
      view,
      surface,
      this.callbacks.folded(),
      content,
    )
    const flying = this.drawPosed(
      ctx,
      view,
      surface,
      this.callbacks.departures(),
      content,
    )
    return this.drawMoving(ctx, view, moving) || boxed || flying || still
  }

  /**
   * Nodes the board does not have where they are shown — what a collapsed
   * group shows in its box, a card on its way into one — each at its pose:
   * by the content layer where it can, as a card in motion is otherwise
   * (`drawMoving`), and a group as its frame. Whether this canvas drew any.
   */
  private drawPosed(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    surface: Surface,
    posed: Iterable<Readonly<{ node: BoardNode; pose: Pose }>>,
    content: ContentLayer | null,
  ): boolean {
    const palette = this.palette
    if (!palette) return false
    const unclaimed: { node: BoardNode; pose: Pose }[] = []
    let drew = false
    for (const { node, pose } of posed) {
      const x = pose.x * view.scale + view.tx
      const y = pose.y * view.scale + view.ty
      const w = pose.w * view.scale
      const h = pose.h * view.scale
      if (x >= surface.width || y >= surface.height || x + w <= 0 || y + h <= 0)
        continue
      if (node.type === 'group') {
        // The frame's look (`drawGroups`), as small as it is shown.
        const color = this.colorOf(node, palette) ?? palette.neutral
        ctx.fillStyle = color
        ctx.globalAlpha = (OVERVIEW_CARD_WASH_ALPHA / 2) * pose.opacity
        ctx.fillRect(x, y, w, h)
        ctx.strokeStyle = color
        ctx.globalAlpha = OVERVIEW_THEMED_BORDER_ALPHA * pose.opacity
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
        drew = true
        continue
      }
      const laidOut = { x: pose.x, y: pose.y, w: node.w, h: node.h }
      if (content?.claim(node, laidOut, lookOf(node, pose))) continue
      unclaimed.push({ node, pose })
    }
    ctx.globalAlpha = 1
    return this.drawMoving(ctx, view, unclaimed) || drew
  }

  /** `drawCards`' cards at rest, batched — and the ones in motion, set
   * aside in `moving` for `drawMoving` unless the content layer draws them.
   * Only the board's own cards on screen move: a minimap or a collapsed
   * group's pictures show where things are, and a portal's cards are where
   * it shows them. */
  private drawStillCards(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    surface: Surface,
    live: ReadonlyMap<NodeId, CardRect> | null,
    moving: { node: BoardNode; pose: Pose }[],
    skip: ((id: NodeId) => boolean) | undefined,
    nodes: readonly BoardNode[],
    unit: number,
  ): boolean {
    const posed = surface.screen && unit === 1
    const isSelected = (id: NodeId): boolean =>
      surface.selection && this.callbacks.isSelected(id)
    const palette = this.palette
    if (!palette) return false
    // What a world unit inside these cards measures on screen: behind a
    // portal at another scale (`PortalLayer`), type is drawn that much
    // larger or smaller.
    const typeScale = view.scale * unit
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
    const titles: TitleLine[] = []
    // The board's own cards on its own screen may have their content drawn
    // by the content layer; a portal's, drawn at its scale, never do.
    const content =
      surface.screen && unit === 1 && nodes === this.callbacks.getCardNodes()
        ? this.callbacks.contentLayer()
        : null
    for (const node of nodes) {
      if (skip?.(node.id)) continue
      const pose = posed ? this.callbacks.poseOf(node.id) : null
      const rect = pose ?? live?.get(node.id) ?? node
      const x = rect.x * view.scale + view.tx
      const y = rect.y * view.scale + view.ty
      const w = rect.w * view.scale
      const h = rect.h * view.scale
      if (
        x >= surface.width ||
        y >= surface.height ||
        x + w <= 0 ||
        y + h <= 0
      ) {
        continue
      }
      const item = { node, x, y, w, h }
      // Its title stands over it as the DOM's does (./nodeTitle.ts) — and a
      // PDF's stays drawn here while the card fades in under it: a spread
      // folding keeps its title in place throughout.
      const title = this.callbacks.titleOf(node)
      // One in motion carries its title along while it keeps its size (an
      // arrangement, a card arriving) or is picked up, and turns it as it
      // turns; shrinking into a fold, it goes.
      const scale = pose ? pose.w / node.w : 1
      if (title && scale > 0.99) {
        titles.push({
          node,
          title,
          x,
          y,
          w,
          h,
          room:
            (title.own ? this.callbacks.spreadTitleMaxWidth(node.id) : node.w) /
            unit,
          turn: pose?.rotate
            ? { x: x + w / 2, y: y + h / 2, angle: pose.rotate }
            : undefined,
        })
      }
      // An open spread's title node is its title and nothing else: still or
      // carried, there is no card of it to draw.
      if (title?.own) continue
      if (pose) {
        const laidOut = { x: pose.x, y: pose.y, w: node.w, h: node.h }
        if (!content?.claim(node, laidOut, lookOf(node, pose))) {
          moving.push({ node, pose })
        }
        continue
      }
      if (content?.claim(node, rect)) continue
      if (isPlainText(node)) texts.push(item)
      else if (!isPortal(node)) visible.push(item)
    }
    // Bare text has no card to draw: at this distance it is its picture of
    // itself (../pictures/cardPictures.ts) where it has one, and a block of
    // ink, in its colour, as greyed-out text is drawn, until it does — and a
    // selection ring when it is selected, drawn with the cards' below.
    if (texts.length > 0) {
      for (const text of texts) {
        ctx.globalAlpha = 1
        if (this.drawPicture(ctx, text.node, text, palette.dark, view.scale)) {
          continue
        }
        ctx.globalAlpha = OVERVIEW_TEXT_ALPHA
        ctx.fillStyle = this.colorOf(text.node, palette) ?? palette.text
        ctx.fillRect(text.x, text.y, text.w, text.h)
      }
      ctx.globalAlpha = 1
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 2
      ctx.beginPath()
      let anySelected = false
      for (const text of texts) {
        if (!isSelected(text.node.id)) continue
        this.strokeRectPath(ctx, text)
        anySelected = true
      }
      if (anySelected) ctx.stroke()
      ctx.lineWidth = 1
    }
    const drew = texts.length > 0 || (surface.text && titles.length > 0)
    if (visible.length === 0) {
      if (surface.text) this.drawTitles(ctx, view, titles, unit)
      return drew
    }

    // 1. The opaque surface, in one path.
    ctx.globalAlpha = 1
    ctx.fillStyle = palette.background
    ctx.beginPath()
    for (const card of visible) ctx.rect(card.x, card.y, card.w, card.h)
    ctx.fill()

    // 2. The colour wash, one path per colour and strength. A card that has
    //    a picture of itself (../pictures/) — its content, a PDF's pages, an
    //    image — is drawn as the DOM tiers show it with that content: washed
    //    only if it has a colour, and as lightly as cards/color.css washes
    //    it. One without stands in its title block's look, washed whatever
    //    its colour. Every card's colour is kept too (`byColor`), for the
    //    borders below.
    const pictures = new Map<NodeId, ImageBitmap>()
    for (const card of visible) {
      const picture = this.pictureOf(card.node, card, palette.dark)
      if (picture) pictures.set(card.node.id, picture)
    }
    const byColor = new Map<string, typeof visible>()
    const washes = new Map<number, Map<string, typeof visible>>()
    for (const card of visible) {
      const own = this.colorOf(card.node, palette)
      const color = own ?? palette.neutral
      const bucket = byColor.get(color)
      if (bucket) bucket.push(card)
      else byColor.set(color, [card])
      const pictured = pictures.has(card.node.id)
      if (pictured && own === null) continue
      const alpha = pictured
        ? OVERVIEW_THEMED_CARD_WASH_ALPHA[palette.dark ? 'dark' : 'light']
        : OVERVIEW_CARD_WASH_ALPHA
      const strength = washes.get(alpha) ?? new Map<string, typeof visible>()
      washes.set(alpha, strength)
      const wash = strength.get(color)
      if (wash) wash.push(card)
      else strength.set(color, [card])
    }
    for (const [alpha, strength] of washes) {
      ctx.globalAlpha = alpha
      for (const [color, cards] of strength) {
        ctx.fillStyle = color
        ctx.beginPath()
        for (const card of cards) ctx.rect(card.x, card.y, card.w, card.h)
        ctx.fill()
      }
    }

    // 2b. The pictures, over their wash as the content is over its card.
    //     Such a card needs no title block: it shows its own.
    ctx.globalAlpha = 1
    for (const card of visible) {
      const picture = pictures.get(card.node.id)
      if (picture) {
        this.drawPicture(
          ctx,
          card.node,
          card,
          palette.dark,
          view.scale,
          picture,
        )
      }
    }
    const pictured = new Set(pictures.keys())

    // 3. Borders. An uncoloured card takes the theme's border token at full
    //    strength; a coloured one takes its own colour at the stylesheet's 70%.
    ctx.lineWidth = 1
    ctx.globalAlpha = 1
    ctx.strokeStyle = palette.border
    ctx.beginPath()
    for (const card of visible) {
      if (this.colorOf(card.node, palette) !== null) continue
      if (isSelected(card.node.id)) continue
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
        if (isSelected(card.node.id)) continue
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
      if (!isSelected(card.node.id)) continue
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
      if (isSelected(node.id)) continue
      if (!isSelected(node.parent)) continue
      this.strokeRectPath(ctx, card)
      anyLit = true
    }
    if (anyLit) ctx.stroke()
    ctx.globalAlpha = 1

    if (!surface.text) return true
    // 5. Titles, where a card is wide enough on screen to hold one. The type
    //    and the box it wraps in are the DOM card's title block — 32 world
    //    units, so it shrinks with the card — which is what makes the switch
    //    between tiers invisible.
    const fontPx = TITLE_BLOCK_WORLD_FONT_PX * typeScale
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
      // Wrapped in its own size, as its title block lays it out.
      const lines = this.wrapTitle(ctx, title, fileNodeOf(card.node), typeScale)
      const top = card.y + card.h / 2 - ((lines.length - 1) * lineHeight) / 2
      for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i], card.x + card.w / 2, top + i * lineHeight)
      }
    }
    // 6. Titles, over every card, as the stylesheet stacks them
    //    (node-title.css).
    this.drawTitles(ctx, view, titles, unit)
    return true
  }

  /**
   * Titles as the DOM draws them (./nodeTitle.ts, node-title.css): the bar,
   * its mark, the name — cut short where the bar runs out of room — and the
   * note, at the size `titleScale` holds it at and where
   * `titleBox` puts it, which is where everything asking about it is told
   * it is. And a node's ring when it is selected.
   */
  private drawTitles(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    titles: readonly TitleLine[],
    unit = 1,
  ): void {
    const palette = this.palette
    if (!palette || titles.length === 0) return
    const measure = this.callbacks.titleMeasure()
    // What a pixel of the title's own measures on screen, before it is held.
    const typeScale = view.scale * unit
    const scale = titleScale(typeScale)
    const u = typeScale * scale
    const look = TITLE_LOOK
    const font = (size: number, weight: number) =>
      `${weight} ${size * u}px ${measure.family}`
    const width = (text: string, size: number, weight: number) =>
      measure.text(text, size, weight)
    ctx.globalAlpha = 1
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (const line of titles) {
      const { title, turn } = line
      if (turn) {
        ctx.save()
        ctx.translate(turn.x, turn.y)
        ctx.rotate(turn.angle)
        ctx.translate(-turn.x, -turn.y)
      }
      const content = measure.width(title)
      const box = titleBox(line, title, content, scale, typeScale, line.room)
      const toWorld = (rect: CardRect): CardRect => ({
        x: (rect.x - view.tx) / view.scale,
        y: (rect.y - view.ty) / view.scale,
        w: rect.w / view.scale,
        h: rect.h / view.scale,
      })
      // Where it was drawn is where it is pointed at: a press on any of it is
      // a press on its node (`titleLineAt`).
      this.titleRects.set(line.node.id, toWorld(box))
      // The bar: its surface, where it has one, and the selection's ring.
      const selected = this.callbacks.isSelected(line.node.id)
      if (title.boxed || selected) {
        ctx.beginPath()
        ctx.roundRect(box.x, box.y, box.w, box.h, look.radius * u)
        if (title.boxed) {
          ctx.fillStyle = palette.background
          ctx.fill()
        }
        ctx.strokeStyle = selected ? palette.accent : palette.border
        ctx.lineWidth = selected ? 2 : 1
        ctx.stroke()
      }
      const mid = box.y + box.h / 2
      let x = box.x + (look.border + look.paddingStart) * u
      // The mark.
      if (title.mark.kind === 'group') {
        const size = look.icon * u
        ctx.strokeStyle = palette.muted
        ctx.lineWidth = 2 * (size / 24)
        ctx.beginPath()
        ctx.roundRect(
          x + size / 8,
          mid - size * 0.375,
          size * 0.75,
          size * 0.75,
          size / 6,
        )
        ctx.moveTo(x + size / 8, mid - size / 8)
        ctx.lineTo(x + size * 0.875, mid - size / 8)
        ctx.stroke()
        x += size
      } else {
        const badge = look.badge
        const text = title.mark.text
        const badgeW =
          (width(text, badge.size, badge.weight) +
            text.length * badge.spacing * badge.size +
            badge.padding * 2) *
          u
        const badgeH = badge.height * u
        ctx.fillStyle = palette.badges[title.mark.tone]
        ctx.globalAlpha = 0.12
        ctx.beginPath()
        ctx.roundRect(x, mid - badgeH / 2, badgeW, badgeH, 4 * u)
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.font = font(badge.size, badge.weight)
        ctx.fillText(text, x + badge.padding * u, mid)
        x += badgeW
      }
      x += look.gap * u
      // The name, in what the rest leaves it.
      const labelW = width(title.label, look.label.size, look.label.weight)
      const room = Math.max(0, labelW - (content - box.w / typeScale / scale))
      ctx.font = font(look.label.size, look.label.weight)
      ctx.fillStyle = palette.text
      ctx.fillText(
        fitText(title.label, room, (text) =>
          width(text, look.label.size, look.label.weight),
        ),
        x,
        mid,
      )
      x += (room + look.gap) * u
      if (title.note !== null) {
        ctx.font = font(look.note.size, look.note.weight)
        ctx.fillStyle = palette.muted
        ctx.fillText(title.note, x, mid)
        x +=
          (width(title.note, look.note.size, look.note.weight) + look.gap) * u
      }
      if (turn) ctx.restore()
    }
    ctx.lineWidth = 1
  }

  /** The card whose drawn title is under `point` (world units), if any — a
   * title reaches past its node's rectangle. */
  titleLineAt(point: Readonly<{ x: number; y: number }>): NodeId | null {
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

  /**
   * The picture `drawPicture` starts from — a folded PDF card's, the first
   * page it shows — or null when the card has none to show at `rect`'s size.
   * Asked before the card's wash too: a card with a picture is washed as a
   * DOM card with content is, and one without as its title block.
   */
  private pictureOf(
    node: BoardNode,
    rect: Readonly<{ w: number }>,
    dark: boolean,
  ): ImageBitmap | null {
    if (rect.w < PICTURE_MIN_SCREEN_PX) return null
    return isFoldedPdf(node)
      ? this.callbacks.picture(node, dark, Math.floor(node.startPage ?? 1))
      : this.callbacks.picture(node, dark)
  }

  /**
   * What a card shows at this tier where it has a picture: an image card its
   * image, fitted in the card as the card fits it (cards/media.css); a sheet
   * its page; a folded PDF card the pages its reader shows from where it was
   * left (../pdf/readerLayout.ts: edge to edge at the card's width, a seam
   * between each), as far down as there are pictures; any other card its
   * content, which its picture shows over the card's whole box. False when
   * there is none (`pictureOf`).
   */
  private drawPicture(
    ctx: CanvasRenderingContext2D,
    node: BoardNode,
    rect: Readonly<{ x: number; y: number; w: number; h: number }>,
    dark: boolean,
    scale: number,
    first = this.pictureOf(node, rect, dark),
  ): boolean {
    if (!first) return false
    if (node.type === 'file' && fileNodeKind(node.file) === 'image') {
      const picture = first
      const fit = Math.min(rect.w / picture.width, rect.h / picture.height)
      const w = picture.width * fit
      const h = picture.height * fit
      ctx.drawImage(
        picture,
        rect.x + (rect.w - w) / 2,
        rect.y + (rect.h - h) / 2,
        w,
        h,
      )
      return true
    }
    if (node.type === 'pdf-page') {
      ctx.drawImage(first, rect.x, rect.y, rect.w, rect.h)
      this.drawAnnotations(ctx, node.file, node.page, rect, dark)
      return true
    }
    if (!isFoldedPdf(node)) {
      ctx.drawImage(first, rect.x, rect.y, rect.w, rect.h)
      return true
    }
    const start = node.startPage ?? 1
    let page = Math.floor(start)
    let picture: ImageBitmap | null = first
    const bottom = rect.y + rect.h
    let y = rect.y - (start - page) * pageHeight(picture, rect.w)
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.w, rect.h)
    ctx.clip()
    while (picture && y < bottom) {
      const h = pageHeight(picture, rect.w)
      ctx.drawImage(picture, rect.x, y, rect.w, h)
      this.drawAnnotations(ctx, node.file, page, { ...rect, y, h }, dark)
      y += h + READER_METRICS.gap * scale
      page += 1
      picture = y < bottom ? this.callbacks.picture(node, dark, page) : null
    }
    ctx.restore()
    return true
  }

  /** How a PDF page is shown in the theme: inverted in a dark one, and the
   * colours its annotations are painted in; null before the overview has
   * read its palette. */
  pagePalette(): Readonly<{
    dark: boolean
    annotations: Readonly<Record<AnnotationColor, string>>
  }> | null {
    return this.palette
  }

  /** A page's annotations over its picture at `page` (screen pixels):
   * ../pdf/pageMarks.ts's. */
  private drawAnnotations(
    ctx: CanvasRenderingContext2D,
    path: string,
    pageNumber: number,
    page: Readonly<{ x: number; y: number; w: number; h: number }>,
    dark: boolean,
  ): void {
    const palette = this.palette
    const shown = this.callbacks.pageAnnotations(path, pageNumber)
    if (!palette || !shown) return
    // The view's own window's, like everything else it draws with.
    const win = this.context.getWindow() as Window & typeof globalThis
    const marks = pageMarks(shown.annotations, shown.frame, win.Path2D)
    paintPageMarks(ctx, marks, page, palette.annotations, dark)
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
    surface: Surface,
    live: ReadonlyMap<NodeId, CardRect> | null,
    edges: readonly Edge[] = this.callbacks.getEdges(),
    unit = 1,
  ): void {
    const palette = this.palette
    if (!palette) return
    // Stroke weight follows the same half-cancelled law the stylesheet uses
    // (`--yolo-whiteboard-zoom-multiplier`, 1/sqrt(scale)), which in screen
    // pixels is `1.5 * sqrt(scale)` -- with a floor, because a line thinner
    // than a pixel is drawn as a faded one and a board of them reads as haze.
    // Behind a portal, of the scale they are seen at: `unit` times the
    // camera's (domain/portals.ts's `portalWeight`).
    const weight = Math.sqrt(view.scale) * portalWeight(unit)
    const stroke = Math.max(
      OVERVIEW_MIN_EDGE_STROKE_PX,
      EDGE_STROKE_WORLD_PX * weight,
    )
    const arrow = EDGE_ARROW_WORLD_PX * weight
    // The stylesheet's ring radius, under the same law.
    const ring = EDGE_PASSAGE_MARK_WORLD_PX * weight
    const drawArrows = arrow >= OVERVIEW_ARROW_MIN_SCREEN_PX
    // Asked once, before the sweep: at the bottom of the tier there is no
    // label small enough to be worth drawing, and that is also where there are
    // the most edges to have skipped one for.
    const drawLabels =
      surface.text && EDGE_LABEL_FONT_PX * weight >= OVERVIEW_LABEL_MIN_FONT_PX

    type Segment = Readonly<{
      start: ScreenPoint
      c1: ScreenPoint
      c2: ScreenPoint
      end: ScreenPoint
      fromArrow: boolean
      toArrow: boolean
      /** The end reaches a passage inside its card (edges.css's
       * `.yolo-whiteboard-edge-passage-end`): at this tier no card can say
       * where, so the end meets its side's middle and carries the ring. */
      fromMark: boolean
      toMark: boolean
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
    const world = computeWorldViewportRect(
      surface.width,
      surface.height,
      view,
      0,
    )
    const margin = EDGE_CONTROL_MAX_PX

    for (const edge of edges) {
      // Within one card an edge is drawn only where the card, drawn as a
      // reader, places its passages — never in this tier
      // (domain/edges.ts's `resolveEdgeEnds`).
      if (edge.fromNode === edge.toNode) continue
      const fromNode = this.callbacks.getNode(edge.fromNode)
      const toNode = this.callbacks.getNode(edge.toNode)
      if (!fromNode || !toNode) continue
      // To where each end is shown: moving (./motions.ts) on the board's
      // own screen, held by a gesture, or at rest.
      const shown = (id: NodeId, node: BoardNode) =>
        (surface.screen && unit === 1 ? this.callbacks.poseOf(id) : null) ??
        live?.get(id) ??
        node
      const from = { id: edge.fromNode, ...shown(edge.fromNode, fromNode) }
      const to = { id: edge.toNode, ...shown(edge.toNode, toNode) }
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
        Math.min(start.x, end.x, c1.x, c2.x) > surface.width ||
        Math.max(start.x, end.x, c1.x, c2.x) < 0 ||
        Math.min(start.y, end.y, c1.y, c2.y) > surface.height ||
        Math.max(start.y, end.y, c1.y, c2.y) < 0
      ) {
        continue
      }
      const selected =
        surface.selection && this.callbacks.isEdgeSelected(edge.id)
      const color = selected ? palette.accent : this.colorOfEdge(edge, palette)
      const segment: Segment = {
        start,
        c1,
        c2,
        end,
        fromArrow: edge.fromEnd === 'arrow',
        toArrow: edge.toEnd === 'arrow',
        fromMark: edge.fromAnchor !== undefined,
        toMark: edge.toAnchor !== undefined,
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
        this.passageMarks(ctx, pass, palette.background, ring, stroke)
      }
    }
    ctx.lineWidth = 1
    this.drawEdgeLabels(ctx, view, surface, labels, weight)
  }

  /** Rings on the ends that reach a passage, in the colour the pass is
   * stroking in, open in the board's background. */
  private passageMarks(
    ctx: CanvasRenderingContext2D,
    segments: readonly Readonly<{
      start: ScreenPoint
      end: ScreenPoint
      fromMark: boolean
      toMark: boolean
    }>[],
    background: string,
    radius: number,
    stroke: number,
  ): void {
    const points: ScreenPoint[] = []
    for (const s of segments) {
      if (s.fromMark) points.push(s.start)
      if (s.toMark) points.push(s.end)
    }
    if (points.length === 0) return
    const color = ctx.strokeStyle
    ctx.beginPath()
    for (const at of points) {
      ctx.moveTo(at.x + radius, at.y)
      ctx.arc(at.x, at.y, radius, 0, Math.PI * 2)
    }
    ctx.fillStyle = background
    ctx.fill()
    ctx.lineWidth = stroke
    ctx.strokeStyle = color
    ctx.stroke()
    ctx.fillStyle = color
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
   * trade. The chip is the element's pill — ends fully round, a hairline of
   * the card border — since at this zoom its shape is most of what is left
   * of it.
   */
  private drawEdgeLabels(
    ctx: CanvasRenderingContext2D,
    view: CanvasView,
    surface: Surface,
    labels: readonly Readonly<{ text: string; x: number; y: number }>[],
    /** `drawEdges`'s: sqrt of the scale the labels are seen at. */
    root: number,
  ): void {
    const palette = this.palette
    if (!palette || labels.length === 0) return
    // The counter-scaled law the stylesheet uses, in screen pixels: a size
    // written in world units as `15 * 1/sqrt(scale)` lands at `15 * sqrt`.
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
        x - padX > surface.width ||
        x + width + padX < 0 ||
        y - lineHeight / 2 - padY > surface.height ||
        y + lineHeight / 2 + padY < 0
      ) {
        continue
      }
      drawn.push({ text, width, x, y })
    }
    if (drawn.length === 0) return

    ctx.fillStyle = palette.background
    ctx.strokeStyle = palette.border
    ctx.lineWidth = root
    ctx.beginPath()
    for (const label of drawn) {
      const h = lineHeight + padY * 2
      ctx.roundRect(
        label.x - padX,
        label.y - lineHeight / 2 - padY,
        label.width + padX * 2,
        h,
        h / 2,
      )
    }
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = palette.muted
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

/** A title the canvas draws (`drawTitles`) over the node at `x, y, w, h`,
 * screen pixels: an open spread's, which is its node, or one over a card. */
type TitleLine = Readonly<{
  node: BoardNode
  title: Title
  x: number
  y: number
  w: number
  h: number
  /** What it heads, in the node's own units (`titleBox`). */
  room: number
  /** Turned with its card, picked up: by `angle` radians about the card's
   * centre, screen pixels. */
  turn?: Readonly<{ x: number; y: number; angle: number }>
}>

/** `text`, cut short with an ellipsis to fit in `room` as `measure`
 * measures it. */
function fitText(
  text: string,
  room: number,
  measure: (text: string) => number,
): string {
  if (measure(text) <= room + 0.5) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measure(`${text.slice(0, mid)}…`) <= room) low = mid
    else high = mid - 1
  }
  return low === 0 ? '' : `${text.slice(0, low)}…`
}

/** A PDF card as its reader: not an open spread's title. */
function isFoldedPdf(
  node: BoardNode,
): node is Extract<BoardNode, { type: 'file' }> {
  return (
    node.type === 'file' &&
    fileNodeKind(node.file) === 'pdf' &&
    !isSpreadTitle(node)
  )
}

/** A page's height at `width`, in the shape of its picture. */
function pageHeight(picture: ImageBitmap, width: number): number {
  return (width * picture.height) / picture.width
}
