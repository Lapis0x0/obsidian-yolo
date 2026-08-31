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
import type { ScreenPoint } from '../../domain/camera'
import { DEFAULT_CAMERA, type BoardNode, type Camera } from '../../domain/fileFormat'
import type { CanvasView } from '../../domain/virtualization'
import {
  CAMERA_GLIDE_EPSILON_DOUBLINGS,
  CAMERA_GLIDE_EPSILON_PX,
  CAMERA_GLIDE_TAU_MS,
  CAMERA_SETTLE_MS,
  FIT_CAMERA_PADDING_PX,
  GRID_MIN_SCREEN_STEP_PX,
  GRID_WORLD_STEP_PX,
  INTERACTING_CLASS_TIMEOUT_MS,
  SCALE_BOUNDS,
  WHEEL_DELTA_PER_ZOOM_DOUBLING,
} from '../constants'

const VIEWPORT_PANNING_CLASS = 'yolo-whiteboard-viewport-panning'
// will-change only while actively interacting (S1/S2 finding: a permanent
// will-change wastes compositor memory for no benefit at rest).
const WORLD_INTERACTING_CLASS = 'yolo-whiteboard-world-interacting'

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
  /** The screen-space chrome is anchored to world positions, so it has to be
   * re-projected whenever the camera moves. */
  positionToolbar: () => void
  setInteracting: (interacting: boolean) => void
  getSelectedNodes: () => readonly BoardNode[]
  /** Folds a settled/target camera into the board and persists it, iff it
   * actually changed — the comparison and the write both touch `board`,
   * which this class does not own. */
  commitCamera: (camera: Camera) => void
  /** `resetCamera` also needs the virtualization loop to catch up
   * immediately, the same as any other discrete camera jump. */
  afterCameraReset: () => void
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
   * cursor for the whole glide. `view` is a fit: its translation is not a
   * function of its scale, so both ease (domain/camera.ts's `approachView`).
   */
  private cameraGlide:
    | Readonly<{
        kind: 'anchored'
        targetScale: number
        screen: ScreenPoint
        world: ScreenPoint
      }>
    | Readonly<{ kind: 'view'; target: CanvasView }>
    | null = null
  private lastGlideTime: number | null = null

  private interactingTimer: number | null = null
  private settleTimer: number | null = null

  /** Scale the counter-scale variable was last written for; it is only
   * rewritten when the zoom actually changed, so panning (which writes
   * `transform` every frame) doesn't invalidate everything computed from
   * it. */
  private appliedZoomScale: number | null = null

  constructor(
    private readonly context: YoloModuleHostFileViewContextV1,
    private readonly viewportEl: HTMLElement,
    private readonly worldEl: HTMLElement,
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
    e.preventDefault()
    this.viewValue = panByWheel(this.viewValue, e.deltaX, e.deltaY)
    this.applyTransform()
    this.markInteracting()
    this.scheduleCameraSettle()
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
      SCALE_BOUNDS,
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
      CAMERA_GLIDE_TAU_MS,
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
   */
  private applyZoomScale(): void {
    if (this.appliedZoomScale === this.viewValue.scale) return
    this.appliedZoomScale = this.viewValue.scale
    this.worldEl.style.setProperty(
      '--yolo-whiteboard-zoom-multiplier',
      String(1 / Math.sqrt(this.viewValue.scale)),
    )
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

  private markInteracting(): void {
    this.worldEl.classList.add(WORLD_INTERACTING_CLASS)
    this.callbacks.setInteracting(true)
    const win = this.context.getWindow()
    if (this.interactingTimer !== null) win.clearTimeout(this.interactingTimer)
    this.interactingTimer = win.setTimeout(() => {
      this.worldEl.classList.remove(WORLD_INTERACTING_CLASS)
      this.callbacks.setInteracting(false)
    }, INTERACTING_CLASS_TIMEOUT_MS)
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

  beginPan(pointerId: number): void {
    this.viewportEl.classList.add(VIEWPORT_PANNING_CLASS)
    this.viewportEl.setPointerCapture(pointerId)
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
    this.viewportEl.classList.remove(VIEWPORT_PANNING_CLASS)
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
    const bounds = unionRect(
      nodes.map((node) => ({
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
      })),
    )
    if (!bounds) return false
    const rect = this.viewportEl.getBoundingClientRect()
    const target = fitViewToBounds(
      bounds,
      { width: rect.width, height: rect.height },
      FIT_CAMERA_PADDING_PX,
      SCALE_BOUNDS,
    )
    this.moveCameraTo(target, options)
    return true
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
      this.cameraGlide = { kind: 'view', target }
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
