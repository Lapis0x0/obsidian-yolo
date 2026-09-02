// Camera state (pan/zoom) and its glide animation for the `.yoloboard`
// canvas (docs/plans/08-25-yolo-whiteboard/p1-design.md §3). Split out of
// `../canvas.ts` structurally (no behavior change): that file remains the
// single state owner (board data, selection, interaction) and stays the one
// place gesture dispatch (onPointerDown/Move/Up) lives; this class owns only
// the camera's own state (`view`, the in-flight glide) and the DOM writes
// that follow from it, reached through the narrow
// `CameraControllerCallbacks` it is constructed with.
//
// `WhiteboardCanvas` is the only importer; this module must never import it
// back (single-direction dependency between the canvas and its
// collaborators).

import {
  approachScale,
  approachView,
  cameraFromView,
  dragPan,
  fitViewToBounds,
  gridStepForScale,
  panByWheel,
  scaleAfterWheel,
  screenToWorld,
  unionRect,
  viewAnchoredAt,
  viewFromCamera,
  viewSettled,
} from '../../domain/camera'
import type { ScaleBounds, ScreenPoint } from '../../domain/camera'
import {
  type BoardNode,
  type Camera,
  DEFAULT_CAMERA,
} from '../../domain/fileFormat'
import type { CanvasView } from '../../domain/virtualization'
import {
  CAMERA_GLIDE_EPSILON_DOUBLINGS,
  CAMERA_GLIDE_EPSILON_PX,
  CAMERA_GLIDE_TAU_MS,
  CAMERA_SETTLE_MS,
  FIT_CAMERA_PADDING_PX,
  GRID_MIN_SCREEN_STEP_PX,
  GRID_WORLD_STEP_PX,
  INTERACTING_TIMEOUT_MS,
  MIN_SCALE_FIT_MARGIN,
  SCALE_BOUNDS,
  WHEEL_DELTA_PER_ZOOM_DOUBLING,
  WHEEL_PAN_GLIDE_TAU_MS,
} from '../constants'

/**
 * The narrow surface `WhiteboardCanvas` injects so the camera can trigger
 * canvas-owned effects (repositioning the toolbar, feeding the
 * virtualization loop's frame-pacing, folding a settled camera into the
 * board) and read canvas-owned state (parse failure, the active edit, the
 * selection) it does not own, all without this class importing the canvas.
 */
export type CameraControllerCallbacks = Readonly<{
  isParseFailed: () => boolean
  /** Whether `target` belongs to the card currently being edited — a plain
   * wheel there scrolls the editor rather than panning the board. */
  isEditingWheelTarget: (target: EventTarget | null) => boolean
  /** Scrolls the focused card's content by a wheel delta, reporting whether
   * it took the gesture — see canvas.ts's `scrollFocusedCardBy`. */
  scrollFocusedCardBy: (
    target: EventTarget | null,
    deltaX: number,
    deltaY: number,
  ) => boolean
  /** The screen-space chrome is anchored to world positions, so it has to be
   * re-projected whenever the camera moves. */
  positionToolbar: () => void
  setInteracting: (interacting: boolean) => void
  getSelectedNodes: () => readonly BoardNode[]
  /** Every node on the board — what the zoom-out floor is derived from (see
   * `zoomScaleBounds`). The array's identity is the cache key, which works
   * because every board mutation replaces it (domain/operations.ts). */
  getAllNodes: () => readonly BoardNode[]
  /** Folds a settled/target camera into the board and persists it, iff it
   * actually changed — the comparison and the write both touch `board`,
   * which this class does not own. */
  commitCamera: (camera: Camera) => void
  /** `resetCamera` also needs the virtualization loop to catch up
   * immediately, the same as any other discrete camera jump. */
  afterCameraReset: () => void
  /** Whether the overview tier is on, which decides whether the chrome layers
   * it hides are worth writing to at all — see `applyZoomScale`. */
  isOverviewActive: () => boolean
}>

/**
 * Owns the camera's live `view`, its glide-in-flight state, and every DOM
 * write that follows from either (`transform`, the dot grid, the resize
 * handles' counter-scale). One instance per `WhiteboardCanvas`, constructed
 * once its viewport/world layer elements exist (see `ensureDom`).
 */
export class CameraController {
  private viewValue: CanvasView = { tx: 0, ty: 0, scale: 1 }

  /**
   * Where the camera is heading and has not arrived yet. Null at rest.
   *
   * Two laws, because two gestures. `anchored` is a wheel zoom: only the
   * scale eases, and the translation is re-derived every frame from the point
   * the gesture grabbed, which is what keeps that point exactly under the
   * cursor for the whole glide. `view` eases a whole camera, whose
   * translation is not a function of its scale (domain/camera.ts's
   * `approachView`) — a fit, or a wheel pan.
   *
   * `view` carries its own time constant: how long the camera should take is
   * a property of the gesture that asked for the move, not of the machinery
   * that carries it out. A fit travels a long way and wants the weight; a
   * wheel pan is answering the hand and wants half of it (constants.ts).
   */
  private cameraGlide:
    | Readonly<{
        kind: 'anchored'
        targetScale: number
        screen: ScreenPoint
        world: ScreenPoint
      }>
    | Readonly<{ kind: 'view'; target: CanvasView; tauMs: number }>
    | null = null
  private lastGlideTime: number | null = null

  private interactingTimer: number | null = null
  private settleTimer: number | null = null

  /** Scale the counter-scale variable was last written for; it is only
   * rewritten when the zoom actually changed, so panning (which writes
   * `transform` every frame) doesn't invalidate everything computed from
   * it. */
  private appliedZoomScale: number | null = null

  /** A write to `overviewChromeEls` was skipped because the overview tier had
   * them out of the drawing; it is owed on the way out
   * (`flushOverviewChromeZoomScale`). */
  private overviewChromeStale = false

  /** Memoised zoom-out floor, keyed on the node array it was derived from —
   * see `zoomScaleBounds`. Also dropped on resize (`invalidateScaleFloor`),
   * which the node array cannot report. */
  private scaleFloor: Readonly<{
    nodes: readonly BoardNode[]
    value: number
  }> | null = null

  constructor(
    private readonly context: YoloModuleHostFileViewContextV1,
    private readonly viewportEl: HTMLElement,
    private readonly worldEl: HTMLElement,
    /** The empty element a pan captures the pointer on — see `beginPan`. */
    private readonly panCaptureEl: HTMLElement,
    /** The world layer's chrome layers — the overlays that are counter-scaled
     * rather than drawn in world units. See `applyZoomScale`, which is the
     * only thing that touches them. */
    private readonly chromeEls: readonly (HTMLElement | SVGElement)[],
    /** The same, for the layers the overview tier hides outright (the edges
     * and their labels): they read the counter-scale like the others, but
     * only while they are part of the drawing. Split out so `applyZoomScale`
     * can leave them alone while they are not. */
    private readonly overviewChromeEls: readonly (HTMLElement | SVGElement)[],
    private readonly callbacks: CameraControllerCallbacks,
  ) {}

  /** Read-only: gesture code (onPointerDown/Move/Up, resize, drag, marquee —
   * all canvas.ts-owned) reads the live view through this and `screenToWorld`
   * to convert a client point to world space; it never writes the camera
   * directly. */
  get view(): CanvasView {
    return this.viewValue
  }

  /** Viewport-relative position of a mouse event. */
  viewportPointFromEvent(e: MouseEvent): ScreenPoint {
    const rect = this.viewportEl.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  readonly onWheel = (e: WheelEvent): void => {
    if (this.callbacks.isParseFailed()) return
    // Zoom stays a canvas gesture wherever the pointer is, including over an
    // open editor — it is about the board, not about what is under the
    // cursor. (Obsidian Canvas zooms over a focused node too.)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      this.zoomBy(e.deltaY, this.viewportPointFromEvent(e))
      return
    }
    // Plain wheel inside the card being edited belongs to that card: its text
    // can be taller than it is, and a user who has clicked in to type means
    // to move through the text, not the board. Left unhandled entirely (no
    // preventDefault) so the editor's own scroller sees a normal event.
    // Only the card being edited, not any card under the pointer: on a canvas
    // the wheel pans, and you click into a card first to scroll it.
    if (this.callbacks.isEditingWheelTarget(e.target)) {
      return
    }
    // The selected card scrolls its own content, for the same reason the one
    // being edited does: a card that holds more than it can show is worth
    // looking further into, and selecting it is how the user says which card
    // they mean. Only the *focused* card — one selected on its own, the same
    // state the live media bodies answer to — and only while it has somewhere
    // to scroll; a card that fits, or one of many selected, leaves the wheel
    // to the board.
    //
    // Handled here rather than by letting the event through: a card's content
    // is unhittable by design (style.css's content mask, D7), and lifting that
    // to get the browser's scrolling would also hand back every link, checkbox
    // and callout fold the mask exists to cover. This scrolls the element
    // directly and leaves the mask absolute.
    if (this.callbacks.scrollFocusedCardBy(e.target, e.deltaX, e.deltaY)) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    this.panByWheel(e.deltaX, e.deltaY)
  }

  /**
   * Aims the camera at where this notch asked it to go, and lets the rAF loop
   * carry it there — the same arrangement as the wheel zoom above, and for
   * the same reason stated there: consecutive notches accumulate against the
   * *target*, so a fast spin covers the whole distance rather than fighting
   * the easing.
   *
   * Writing the camera straight from the event instead (which this used to
   * do) makes the motion exactly as smooth as the event stream, which on a
   * 120Hz display means one moving frame per event and the rest held still —
   * see WHEEL_PAN_GLIDE_TAU_MS for what that measured against Obsidian's own
   * scrolling. The settle is left to `finishGlideFrame`: what gets persisted
   * is where the camera is going, not the frame it is passing through.
   */
  private panByWheel(deltaX: number, deltaY: number): void {
    this.cameraGlide = {
      kind: 'view',
      target: panByWheel(this.targetView, deltaX, deltaY),
      tauMs: WHEEL_PAN_GLIDE_TAU_MS,
    }
    this.markInteracting()
  }

  /**
   * Aims the camera at a new zoom, anchored on the point under the cursor.
   *
   * The camera glides there over the next few frames rather than arriving at
   * once (see `advanceCameraGlide`), so consecutive notches accumulate against
   * the *target* rather than wherever the glide currently is — otherwise
   * spinning the wheel would fight the easing and cover less ground the
   * faster it was spun. The anchor is re-taken from the live view each time,
   * which is what lets the cursor move mid-gesture and still zoom about
   * wherever it now points.
   */
  private zoomBy(deltaY: number, cursor: ScreenPoint): void {
    const glide = this.cameraGlide
    const targetScale = scaleAfterWheel(
      glide?.kind === 'anchored' ? glide.targetScale : this.viewValue.scale,
      deltaY,
      WHEEL_DELTA_PER_ZOOM_DOUBLING,
      this.zoomScaleBounds(),
    )
    const anchor = {
      screen: cursor,
      world: screenToWorld(this.viewValue, cursor),
    }
    if (this.prefersReducedMotion()) {
      this.cameraGlide = null
      this.viewValue = viewAnchoredAt(anchor.screen, anchor.world, targetScale)
      this.applyTransform()
      this.markInteracting()
      this.scheduleCameraSettle()
      return
    }
    this.cameraGlide = { kind: 'anchored', ...anchor, targetScale }
  }

  /**
   * Moves the camera one frame closer to where the last gesture aimed it.
   *
   * Driven from the rAF loop rather than by the input events themselves: the
   * motion has to continue after the wheel stops, which is the whole point of
   * gliding — a gesture ends with the camera still travelling, the way it does
   * everywhere else in Obsidian.
   */
  advanceCameraGlide(now: number): void {
    const glide = this.cameraGlide
    if (!glide) return
    // A first frame, or one after the tab was backgrounded, has no meaningful
    // elapsed time; treat it as a single 60Hz frame rather than teleporting.
    const elapsed =
      this.lastGlideTime === null
        ? 16.7
        : Math.min(now - this.lastGlideTime, 100)
    this.lastGlideTime = now

    if (glide.kind === 'anchored') {
      const next = approachScale(
        this.viewValue.scale,
        glide.targetScale,
        elapsed,
        CAMERA_GLIDE_TAU_MS,
      )
      const settled =
        Math.abs(Math.log2(next / glide.targetScale)) <
        CAMERA_GLIDE_EPSILON_DOUBLINGS
      this.viewValue = viewAnchoredAt(
        glide.screen,
        glide.world,
        settled ? glide.targetScale : next,
      )
      this.finishGlideFrame(settled)
      return
    }

    const next = approachView(
      this.viewValue,
      glide.target,
      elapsed,
      glide.tauMs,
    )
    const settled = viewSettled(
      next,
      glide.target,
      CAMERA_GLIDE_EPSILON_DOUBLINGS,
      CAMERA_GLIDE_EPSILON_PX,
    )
    this.viewValue = settled ? glide.target : next
    this.finishGlideFrame(settled)
  }

  /** What both glide laws do with the frame they just computed. */
  private finishGlideFrame(settled: boolean): void {
    this.applyTransform()
    this.markInteracting()
    if (!settled) return
    this.cameraGlide = null
    this.lastGlideTime = null
    // The counter-scale is written here rather than per frame — see
    // `applyZoomScale`.
    this.applyZoomScale()
    this.scheduleCameraSettle()
  }

  /**
   * The range interactive zoom is clamped to, which is `SCALE_BOUNDS` for
   * every board that fits inside it and a lower floor for one that does not
   * (constants.ts's MIN_SCALE_FIT_MARGIN).
   *
   * A fixed 0.08 floor is a legibility limit chosen for a board you are
   * working in; on a board too wide to fit at that scale it becomes something
   * else — a rule that the board may never be seen whole by hand. Fit-to-all
   * has always been exempt (domain/camera.ts's fitViewToBounds); this gives
   * the wheel the same reach, and no more.
   *
   * Memoised on the node array rather than recomputed per wheel event: the
   * viewport size is a layout read, and a zoom gesture arrives as a stream of
   * events on frames whose layout is already dirty from the transform the last
   * one wrote. Board mutations replace the array and so invalidate it for free;
   * a resize does not, and calls `invalidateScaleFloor` instead.
   */
  private zoomScaleBounds(): ScaleBounds {
    const nodes = this.callbacks.getAllNodes()
    if (this.scaleFloor?.nodes !== nodes) {
      this.scaleFloor = { nodes, value: this.computeScaleFloor(nodes) }
    }
    const min = this.scaleFloor.value
    return min < SCALE_BOUNDS.min
      ? { min, max: SCALE_BOUNDS.max }
      : SCALE_BOUNDS
  }

  private computeScaleFloor(nodes: readonly BoardNode[]): number {
    const fit = this.fitViewFor(nodes)
    if (!fit) return SCALE_BOUNDS.min
    return Math.min(SCALE_BOUNDS.min, fit.scale * MIN_SCALE_FIT_MARGIN)
  }

  /** Drops the memoised floor — for the one input it is derived from that the
   * node array cannot report having changed (canvas.ts's `onResize`). */
  invalidateScaleFloor(): void {
    this.scaleFloor = null
  }

  /** Resolved per gesture rather than cached: the setting can change while a
   * view is open, and this runs once per wheel gesture, not per frame. */
  private prefersReducedMotion(): boolean {
    return this.context
      .getWindow()
      .matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  private applyTransform(): void {
    this.worldEl.style.transform = `translate(${this.viewValue.tx}px, ${this.viewValue.ty}px) scale(${this.viewValue.scale})`
    this.applyGrid()
    // Not mid-glide: see `applyZoomScale`. The glide's last frame writes it
    // through `finishGlideFrame`.
    if (!this.cameraGlide) this.applyZoomScale()
    // The screen-space chrome is anchored to world positions, so it has to be
    // re-projected whenever the camera moves. Both are no-ops when nothing is
    // selected and nothing is being typed, which is the common case.
    this.callbacks.positionToolbar()
  }

  /**
   * Counter-scales everything that lives in the world layer but is not part
   * of the drawing — the resize handles, the edges' stroke widths and
   * arrowheads, the edge labels' type — and would otherwise be scaled along
   * with the cards.
   *
   * 1/sqrt(scale) rather than 1/scale: see RESIZE_HANDLE_PX (constants.ts).
   * The result is chrome whose *screen* size grows as sqrt(scale) — visible
   * zoomed out, not overbearing zoomed in — which is Obsidian Canvas's
   * `--zoom-multiplier`, the same law and the same value.
   *
   * Written only when the zoom actually changed, and never mid-glide:
   * everything downstream of this variable re-lays-out when it changes (the
   * labels are text), which is not something to do on every frame of a zoom.
   * Obsidian Canvas holds the value for the length of its own animation for
   * the same reason. The sizes therefore lag a zoom by its glide and land
   * with it.
   *
   * Written on each chrome layer rather than once on the world layer they
   * share, which would be the shorter code and is the trap. Blink does not
   * track which elements actually read a custom property: setting one on an
   * element invalidates the style of its entire subtree, and the world
   * layer's subtree is every card on the board. Measured on a 1200-card
   * board, the single world-level write restyled 8400 elements in ~60ms on
   * the frame a zoom settled — a visible stall, for a value no card reads.
   * The chrome layers hold every element that does read it, and nothing
   * else, so the restyle is now the size of what is counter-scaled.
   */
  private applyZoomScale(): void {
    if (this.appliedZoomScale === this.viewValue.scale) return
    this.appliedZoomScale = this.viewValue.scale
    this.writeZoomScale(this.chromeEls)
    // The edges and their labels are `display: none` for the length of the
    // overview tier (the canvas draws the edges instead), and a hidden subtree
    // skips layout but not style: writing this there restyles every path,
    // marker and label on the board — thousands of elements, on the frame a
    // zoom settles — for a value nothing on screen is reading. Owed, not
    // dropped: `flushOverviewChromeZoomScale` pays it as the tier ends.
    if (this.callbacks.isOverviewActive()) {
      this.overviewChromeStale = true
      return
    }
    this.writeZoomScale(this.overviewChromeEls)
  }

  /**
   * Writes the counter-scale the overview tier's hidden layers went without.
   * Called by the canvas as the tier ends — before the stylesheet puts them
   * back in the drawing, so they are never seen at the wrong weight.
   */
  flushOverviewChromeZoomScale(): void {
    if (!this.overviewChromeStale) return
    this.overviewChromeStale = false
    this.writeZoomScale(this.overviewChromeEls)
  }

  /** The counter-scale for the zoom `applyZoomScale` last accepted — which is
   * not necessarily the live one, since the value deliberately lags a glide
   * and lands with it. */
  private writeZoomScale(els: readonly (HTMLElement | SVGElement)[]): void {
    const value = String(
      1 / Math.sqrt(this.appliedZoomScale ?? this.viewValue.scale),
    )
    for (const el of els) {
      el.style.setProperty('--yolo-whiteboard-zoom-multiplier', value)
    }
  }

  /**
   * Places the dot grid. It is painted on the viewport (screen space), not
   * inside the world layer, because a world-space grid would be scaled by
   * the camera along with everything else — dots would swell into blobs
   * zoomed in and vanish zoomed out. Instead the lattice is positioned by
   * hand: spacing tracks the camera scale, the tile origin tracks the camera
   * translation, and the dot itself (style.css owns its size and colour)
   * stays constant on screen. The result is anchored to world coordinates —
   * it pans with the board and spreads as you zoom in — which is the whole
   * point of a grid rather than a decorative backdrop.
   *
   * Writing background-position per frame repaints the viewport. That is
   * paint only (no reflow) and the card layer above it remains a composited
   * transform, so the pan path keeps its compositor fast-path; it is also
   * simpler than a second scaled layer just for the grid.
   */
  private applyGrid(): void {
    const { scale, tx, ty } = this.viewValue
    const step =
      gridStepForScale(scale, GRID_WORLD_STEP_PX, GRID_MIN_SCREEN_STEP_PX) *
      scale
    this.viewportEl.style.backgroundSize = `${step}px ${step}px`
    this.viewportEl.style.backgroundPosition = `${tx}px ${ty}px`
  }

  /**
   * "The camera is moving" — held for a short tail after the last input so
   * the canvas can pace content building by whether frames keep up (see
   * WhiteboardCanvas.frame).
   *
   * This used to also put `will-change: transform` on the world for the same
   * window, and it must not come back. A composited world is painted into
   * tiles by the raster threads *after* the main thread is done, and a pan
   * keeps exposing tiles they have not rastered yet; whenever one is
   * missing, cc fills the whole root surface with the page background
   * before drawing (cc/trees/layer_tree_host_impl.cc, "If any tiles are
   * missing, then fill behind the entire root render surface"), which is a
   * white flash across the entire window, sidebar included. On a 3000-card,
   * 3000-edge board at reading zoom that was 23–46% of compositor draws
   * (measured 2026-09-02 from the "missing tiles" arg on cc's draw_result
   * events; the will-change also split the world into eight layers, ~400 MB
   * of tiles). Without the hint the world paints with the root layer and its
   * tiles are required before the frame is drawn: never a flash, and on that
   * board no slow frames either.
   */
  private markInteracting(): void {
    this.callbacks.setInteracting(true)
    const win = this.context.getWindow()
    if (this.interactingTimer !== null) win.clearTimeout(this.interactingTimer)
    this.interactingTimer = win.setTimeout(() => {
      this.callbacks.setInteracting(false)
    }, INTERACTING_TIMEOUT_MS)
  }

  private scheduleCameraSettle(): void {
    const win = this.context.getWindow()
    if (this.settleTimer !== null) win.clearTimeout(this.settleTimer)
    this.settleTimer = win.setTimeout(() => {
      this.settleTimer = null
      this.commitCameraNow()
    }, CAMERA_SETTLE_MS)
  }

  /**
   * Where the camera has come to rest, or is on its way to. Mid-glide the
   * live view is a frame on the way to somewhere; what the user asked for is
   * the target, and persisting an intermediate frame would reopen the board
   * half-way through a move the gesture had already finished.
   */
  private get targetView(): CanvasView {
    const glide = this.cameraGlide
    if (!glide) return this.viewValue
    return glide.kind === 'anchored'
      ? viewAnchoredAt(glide.screen, glide.world, glide.targetScale)
      : glide.target
  }

  private commitCameraNow(): void {
    const win = this.context.getWindow()
    if (this.settleTimer !== null) {
      win.clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    if (this.callbacks.isParseFailed()) return
    this.callbacks.commitCamera(cameraFromView(this.targetView))
  }

  // -----------------------------------------------------------------------
  // Pan gesture (middle-drag anywhere, or Alt+left-drag from empty canvas).
  // The gesture's own state machine (which `Interaction` is active, whether a
  // press has crossed the drag threshold) stays in canvas.ts alongside the
  // other pointer gestures it dispatches; only the camera math and the DOM
  // writes that follow from it live here.
  // -----------------------------------------------------------------------

  /**
   * The pointer is captured on `panCaptureEl`, not on the viewport, and that
   * is the whole of how the gesture shows its cursor. While an element holds
   * the capture, Blink hit-tests every move to *that element* and takes the
   * cursor from its style (event_handler.cc's `PerformMouseEventHitTest`
   * with a capture target, then `SelectCursor`), so an empty element whose
   * only style is `cursor: grabbing` is the grabbing cursor for the length of
   * the pan and nothing else.
   *
   * It used to be a class on the viewport. `cursor` is inherited, and an
   * inherited property flipped on the viewport is recomputed on everything
   * under it — every card, and every path and label of every edge, culled or
   * not. On a 3000-edge board that was ~130ms at press and ~130ms again at
   * release (measured 2026-09-02: 7.4k elements restyled each way), which is
   * what a pan there felt like: a freeze on the way in and a freeze on the
   * way out. The capture element has no descendants and its style never
   * changes, so a pan now touches no style at all.
   */
  beginPan(pointerId: number): void {
    // Direct manipulation wins over a glide in flight: the drag reads the
    // live camera as its origin, so a glide still advancing under it would
    // add its own motion to the hand's. Grabbing a scroller mid-animation
    // cancels it everywhere else for the same reason.
    this.cameraGlide = null
    this.lastGlideTime = null
    this.panCaptureEl.setPointerCapture(pointerId)
    this.markInteracting()
  }

  updatePan(
    origin: CanvasView,
    start: ScreenPoint,
    current: ScreenPoint,
  ): void {
    this.viewValue = dragPan(origin, start, current)
    this.applyTransform()
    this.markInteracting()
    this.scheduleCameraSettle()
  }

  finishPan(): void {
    this.commitCameraNow()
  }

  /** Frames the current selection. The single implementation behind Shift+2,
   * the toolbar's focus button and the context menu's item, so the three can
   * never mean slightly different things. Declines an empty selection, which
   * is what lets the key fall through to Obsidian. */
  zoomToSelection(): boolean {
    const selected = this.callbacks.getSelectedNodes()
    if (selected.length === 0) return false
    return this.fitCameraToNodes(selected)
  }

  /**
   * Frames `nodes` (zoom to fit / zoom to selection).
   *
   * The camera glides there rather than cutting, on the same law the wheel
   * uses and the one Obsidian Canvas animates its own viewport with: the move
   * is what tells you where you came from, and over a large jump that is
   * exactly when a cut is most disorienting.
   *
   * `immediate` is for the one fit with nothing to travel from — a board
   * being framed against a real viewport for the first time, where the
   * position it would glide out of is a placeholder the user never saw.
   * Obsidian exempts the same case (`finishViewportAnimation`), and reduced
   * motion takes the same path.
   */
  fitCameraToNodes(
    nodes: readonly BoardNode[],
    options?: Readonly<{ immediate?: boolean }>,
  ): boolean {
    const target = this.fitViewFor(nodes)
    if (!target) return false
    this.moveCameraTo(target, options)
    return true
  }

  /** The view that frames `nodes`, or null when there are none — shared by the
   * fit gestures and by the zoom-out floor they define (`zoomScaleBounds`), so
   * "zoomed out as far as the wheel goes" and "fit to all" cannot drift into
   * meaning different amounts of board. */
  private fitViewFor(nodes: readonly BoardNode[]): CanvasView | null {
    const bounds = unionRect(
      nodes.map((node) => ({
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
      })),
    )
    if (!bounds) return null
    const rect = this.viewportEl.getBoundingClientRect()
    return fitViewToBounds(
      bounds,
      { width: rect.width, height: rect.height },
      FIT_CAMERA_PADDING_PX,
      SCALE_BOUNDS,
    )
  }

  /**
   * Sends the camera to `target`, gliding unless told otherwise. Every
   * destination the canvas picks for itself — both fits and the reset — goes
   * through here, so they cannot end up moving in different ways.
   */
  private moveCameraTo(
    target: CanvasView,
    options?: Readonly<{ immediate?: boolean }>,
  ): void {
    if (options?.immediate === true || this.prefersReducedMotion()) {
      this.cameraGlide = null
      this.lastGlideTime = null
      this.viewValue = target
      this.applyTransform()
      this.markInteracting()
    } else {
      this.cameraGlide = { kind: 'view', target, tauMs: CAMERA_GLIDE_TAU_MS }
    }
    // Persisted from the target either way, so a board closed mid-glide
    // reopens where the move was going rather than wherever it had got to.
    this.commitCameraNow()
  }

  /**
   * Puts the camera back where a new board starts: the world origin, at 1:1.
   *
   * Obsidian Canvas has no such action. Its "reset zoom" control — measured on
   * a running 1.13.7 — is `zoomBy(-zoom)`: it returns the scale to 1 and
   * leaves the position exactly where it was, which is no help at all to
   * someone who has panned into empty space. Fit-to-all (Shift+1) already
   * answers "show me everything"; this answers the other half, "take me back",
   * and it has a fixed destination because our world origin means something —
   * it is where a new board is centred and where an imported one is parked.
   */
  resetCamera(): void {
    this.moveCameraTo(viewFromCamera(DEFAULT_CAMERA))
    this.callbacks.afterCameraReset()
  }

  /** Resets the camera to a freshly loaded board's stored position — used by
   * `setViewData` for both a first load and an externally-rewritten file.
   * A glide aimed at the previous board's camera has nothing to say about
   * this one, and would drag the new view away from where it opened, so this
   * snaps rather than gliding. */
  loadCamera(camera: Camera): void {
    this.viewValue = viewFromCamera(camera)
    this.cameraGlide = null
    this.lastGlideTime = null
    this.applyTransform()
  }

  /** Releases the two debounce timers this class owns. `WhiteboardCanvas`
   * cancels its own rAF handle separately (the virtualization loop is not
   * this class's concern) and calls this alongside it. */
  dispose(): void {
    const win = this.context.getWindow()
    if (this.interactingTimer !== null) {
      win.clearTimeout(this.interactingTimer)
      this.interactingTimer = null
    }
    this.callbacks.setInteracting(false)
    if (this.settleTimer !== null) {
      win.clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }
}
