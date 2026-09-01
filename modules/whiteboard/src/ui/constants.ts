// Canvas tuning constants for the `.yoloboard` file view, ported from the
// S2/S3 spikes (`git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/constants.ts`) per
// docs/plans/08-25-yolo-whiteboard/p1-design.md §3. UI/host-loop tuning, not
// domain data — kept out of domain/ per that layer's zero-dependency
// contract (it doesn't need these; only src/ui/canvas.ts's rAF loop does).

/** Camera scale clamp range. `min` is the floor for a board that fits inside
 * it; a board too big to fit gets a lower one — see MIN_SCALE_FIT_MARGIN. */
export const SCALE_BOUNDS = Object.freeze({ min: 0.08, max: 2.5 })

/**
 * How far past "the whole board fits" the wheel may zoom out, as a fraction of
 * the fit scale — so a board that needs 0.04 to fit can be wheeled down to
 * 0.036 and shows a margin of empty canvas around itself rather than stopping
 * with its edges flush against the viewport.
 *
 * The floor is `min(SCALE_BOUNDS.min, fitScale * this)`: it only ever *lowers*
 * the fixed floor, so every board that already fits at 0.08 behaves exactly as
 * before, and only a board that does not gains the room to be seen whole. That
 * asymmetry is the point — 0.08 is a legibility floor for a board you are
 * working in, not a statement about boards larger than it was chosen for
 * (fit-to-all already ignores it entirely; see domain/camera.ts's
 * fitViewToBounds). See cameraController.ts's `zoomScaleBounds`.
 */
export const MIN_SCALE_FIT_MARGIN = 0.9

/** Wheel delta that doubles the zoom. 300 is Obsidian Canvas's own figure,
 * measured by driving its canvas with wheel events of four different sizes
 * and solving for the exponent — it came out identical at every size, so its
 * zoom is delta-proportional exactly like ours and only the rate differed. */
export const WHEEL_DELTA_PER_ZOOM_DOUBLING = 300

/** Screen-space margin kept around the content when the camera fits to all
 * nodes or to the selection (Shift+1 / Shift+2). */
export const FIT_CAMERA_PADDING_PX = 48

/** Time constant of the glide the camera takes toward where a gesture asked
 * it to go, rather than snapping there. Measured off Obsidian Canvas by
 * sampling its transform every frame through one wheel notch: the remaining
 * distance decays by ~0.876 per frame on a 120Hz display, i.e. e-folding
 * every ~63ms, and the whole glide is over in ~255ms. Its own source has the
 * decay as `0.984 ** dtMs`, an e-folding every 62.0ms — the measurement was
 * reading the real constant. Short enough that the easing reads as weight
 * rather than lag: twice this already feels floaty. See canvas.ts's
 * advanceCameraGlide(). */
export const CAMERA_GLIDE_TAU_MS = 63

/** Remaining distance, in doublings, below which the glide is finished and
 * the camera snaps to its target — an exponential approach never arrives, and
 * a hundredth of a doubling is a fifth of a pixel on a 260px card. */
export const CAMERA_GLIDE_EPSILON_DOUBLINGS = 0.01

/** The same cutoff for the pan half of a fit's glide. Half a pixel is below
 * anything a display can show, and unlike the zoom tolerance it is already in
 * the units the transform is written in. */
export const CAMERA_GLIDE_EPSILON_PX = 0.5

/** Screen-pixel buffer band around the viewport for virtualization, divided
 * by scale before use so its on-screen width stays constant across zoom
 * levels (see domain/virtualization.ts's computeWorldViewportRect). */
export const VIEWPORT_BUFFER_PX = 150

/** Visibility recompute throttle — matches the spikes' measured sweet spot
 * between responsiveness and recompute cost at a few hundred cards. */
export const RECOMPUTE_INTERVAL_MS = 70

/**
 * Per-frame drain quotas for the two *uniform-cost* halves of virtualization:
 * putting a card's frame in the world and taking it out again. Both are plain
 * DOM work whose cost does not depend on what the card holds, which is what
 * makes a count an honest budget for them.
 *
 * Building a card's **content** is not in here — see CONTENT_BUILD_BUDGET_MS.
 */
export const MOUNT_QUOTA_PER_FRAME = 6
export const UNMOUNT_QUOTA_PER_FRAME = 40

/**
 * Frame interval, in milliseconds, above which the canvas treats the last
 * frame as having overrun and stops starting new content builds *while the
 * camera is moving*.
 *
 * A count cannot bound content building the way it bounds the quotas above,
 * because what a card costs to build is a property of the note behind it:
 * ~2ms for a five-line card and ~25ms for a 160-line one at the point the
 * work is asked for — but most of the bill arrives later still, inside the
 * host renderer's own scheduling (measured 2026-08-31: a pan over long-note
 * cards spends its time in `measureSection` and the layout that measuring
 * forces, none of it inside the call that started it). So neither a count nor
 * a stopwatch around the call can price this work in advance.
 *
 * What can be observed is the consequence: whether frames are still arriving
 * on time. So that is what gates building — start work only after a frame
 * that came in under this bar, and the pacing tunes itself to the board, the
 * machine and the display without anyone estimating a cost. On a light board
 * every frame qualifies and nothing changes; on a heavy one the canvas builds
 * on the frames it can afford and skips the ones it cannot.
 *
 * 20ms is the same bar the benchmark counts dropped frames at: comfortably
 * above a 120Hz frame (8.3ms) and a 60Hz one (16.7ms), so an on-time frame at
 * either rate qualifies, and nothing slower than 50fps does.
 *
 * Only while the camera moves. At rest a long frame costs nothing visible and
 * the only thing waiting is the content itself, so building runs at full rate
 * — a board opening fills as fast as it can.
 */
export const FRAME_ON_TIME_MS = 20

/** How long the world element keeps its "interacting" class (which is what
 * gates `will-change: transform`) after the last pan/zoom input. */
export const INTERACTING_CLASS_TIMEOUT_MS = 250

/** How long the camera must sit idle after the last pan/zoom input before
 * it's folded into the board and persisted (p1-design §3: "手势结束（而非
 * 逐帧）把 camera 写回 board 并 requestSave"). */
export const CAMERA_SETTLE_MS = 300

/** Pointer movement (screen px) beyond which a press-and-move gesture that
 * started on a card is treated as a drag rather than a click-to-edit
 * (docs/plans/08-25-yolo-whiteboard/p1-design.md's W3-A task brief: "~4px"). */
export const DRAG_THRESHOLD_PX = 4

/** World scale below which a card shows only its title block and its content
 * is not constructed at all — not merely hidden (p3-canvas-parity D8: "降级时
 * 根本不构造内容组件，只挂占位标题"). Checked at the same ~70ms throttle as
 * recomputeVisibility, not per frame — see canvas.ts's updateDegradedState(). */
export const DEGRADE_SCALE_THRESHOLD = 0.35

/**
 * Width of the hysteresis band above DEGRADE_SCALE_THRESHOLD, in zoom
 * doublings: once degraded, a card's content is rebuilt only after the camera
 * comes back this far past the threshold it fell through.
 *
 * A single threshold was fine while degrading was a CSS class; now that
 * crossing it destroys and rebuilds every visible card's markdown, a zoom
 * that settles on the boundary would do exactly that on alternate throttle
 * ticks (p3-canvas-parity D8: "跨越阈值来回抖动时不能反复构造/销毁打爆帧").
 *
 * Expressed in doublings because that is the unit the wheel works in (see
 * WHEEL_DELTA_PER_ZOOM_DOUBLING): a quarter doubling is ~75 delta — inside a
 * single mouse notch, so one deliberate notch still crosses the band in one
 * go, and far outside the few-delta dither a trackpad emits at rest.
 */
const DEGRADE_RESTORE_DOUBLINGS = 0.25

/** Scale a degraded card's content is built again at — see above. */
export const DEGRADE_RESTORE_SCALE =
  DEGRADE_SCALE_THRESHOLD * 2 ** DEGRADE_RESTORE_DOUBLINGS

/**
 * Size a text card is created at. Deliberately at the small end of what the
 * spikes' boards used (226-334 wide) — an empty card should not take half
 * the screen; the user resizes the ones that grow.
 *
 * Both dimensions are whole grid cells (20 x 14 — see GRID_WORLD_STEP_PX,
 * which is derived from the width). A card whose height were not would have
 * its top edge on the lattice and its bottom edge between two lines once a
 * drag snapped it there, so a column of cards could never be given even
 * gaps by dragging alone.
 */
export const NEW_CARD_SIZE = Object.freeze({ w: 260, h: 182 })

/**
 * Size a card that shows something else is created at: a note, an image, a
 * web page.
 *
 * Bigger than an empty text card, and for the opposite reason. What a text
 * card will hold does not exist yet, so the small end is the polite guess;
 * what these hold exists already and is not ours to abridge — a note shown
 * two lines at a time, or a picture at a fifth of its size, is a card that
 * has to be resized before it can be read at all.
 *
 * 390 is 30 grid cells, the whole-cell neighbour of Obsidian Canvas's own
 * 400 x 400 `defaultFileNodeDimensions` (its text nodes are 250 x 60, and it
 * splits the two for the same reason). Whole cells for the reason above, and
 * a literal for the same reason NEW_CARD_SIZE is one: the cell is derived
 * from the card, not the other way round.
 */
export const NEW_EMBED_CARD_SIZE = Object.freeze({ w: 390, h: 390 })

/** World-space stagger between cards created by one multi-file drop, so
 * three dropped notes read as three cards rather than one. */
export const DROP_STAGGER_PX = 24

/** How long an in-progress card edit may sit unwritten. Blur used to be the
 * only write point, which left everything typed since the card was opened
 * living in the editor and nowhere else; this bounds what a crash costs.
 * Throttled rather than per-keystroke because a note card's write is a real
 * file write, and the board's own save is debounced downstream anyway. */
export const EDIT_PERSIST_THROTTLE_MS = 400

/**
 * How many grid cells a default card spans.
 *
 * The grid is fixed by this ratio rather than by an absolute world spacing
 * because the ratio is what the eye actually judges — and unlike a spacing,
 * it does not move with the camera: dot spacing and card size both scale, so
 * `step / cardWidth` is the same at every zoom. Two boards agree visually
 * when they agree here, whatever they are zoomed to.
 *
 * 20 is Obsidian Canvas's figure for its default card — a 400-unit card on a
 * 20-unit grid. (Its default *text* node, 250x60, would give 12.5, but that
 * is a one-line sticky rather than a card, and its own file cards do not
 * follow it.)
 */
const GRID_CELLS_PER_CARD = 20

/** Dot-grid spacing in world units — the finest the lattice ever gets. */
export const GRID_WORLD_STEP_PX = NEW_CARD_SIZE.w / GRID_CELLS_PER_CARD

/**
 * On-screen spacing the grid refuses to go below. The visible step is
 * GRID_WORLD_STEP_PX doubled as many times as it takes to clear this floor.
 *
 * This is what keeps the grid a grid once the cards it belongs to are no
 * longer the thing being looked at: zoomed all the way out, an unbounded
 * 13-unit step would land dots ~1px apart, which is not a grid but a grey
 * wash. 10 is Obsidian Canvas's floor, measured off the `<pattern>` tile in
 * its svg.canvas-background across the zoom range — a lower bound in screen
 * pixels is a legibility limit, not a matter of taste, so there is no reason
 * to differ from a value that visibly works. See canvas.ts's applyGrid().
 */
export const GRID_MIN_SCREEN_STEP_PX = 10

/**
 * Smallest a card may be dragged, in grid cells.
 *
 * Obsidian Canvas enforces no floor at all — `node.resize({width: 1})` sticks,
 * collapsing a node into a line that cannot be grabbed again. Expressed in
 * cells rather than pixels for the same reason the grid itself is: it is the
 * ratio to a card that carries meaning, so a future change to the default
 * card size drags the floor along with it instead of silently orphaning it.
 *
 * 4x3 is the smallest rectangle that still holds one line of 13px body text
 * with its 6px/10px padding and border — below that a card cannot show its
 * own content, which is the point at which "small" turns into "broken".
 */
const MIN_CARD_CELLS = Object.freeze({ w: 4, h: 3 })

export const MIN_CARD_SIZE = Object.freeze({
  w: GRID_WORLD_STEP_PX * MIN_CARD_CELLS.w,
  h: GRID_WORLD_STEP_PX * MIN_CARD_CELLS.h,
})

/**
 * Resize-handle size in screen pixels at 1:1 zoom.
 *
 * The handle is laid out in world space (it lives in the transformed layer
 * with the cards), so the canvas divides this by the square root of the scale
 * — Obsidian Canvas's own law, measured off its `--zoom-multiplier` across
 * the zoom range: 1/sqrt(scale) exactly, at every sample. The effect is a
 * handle whose *screen* size is 20*sqrt(scale): ~9px zoomed right out, 20px
 * at 1:1, ~28px zoomed right in. Constant world size would make it
 * ungrabbable when zoomed out; constant screen size would make it swallow the
 * card when zoomed in. See cameraController.ts's applyZoomScale(), which
 * writes the multiplier every dimension in the world layer that is chrome
 * rather than drawing is computed from.
 */
export const RESIZE_HANDLE_PX = 20

/**
 * How far outside a card a connection drag still counts as landing on it, in
 * world units.
 *
 * A band, not a point, because the pointer that is *at* a card's border is
 * ambiguous by a pixel or two, and the connection points sit on the border.
 * 12 is Obsidian Canvas's 15 scaled to our card (its default node is 400
 * units wide to our 260) — the figure that matters is how big the band is
 * relative to the card it forgives you for missing.
 */
export const CONNECT_SNAP_WORLD_PX = 12

/**
 * How near two edges must be, in *screen* pixels, for a drag or a resize to
 * line them up (domain/snapping.ts).
 *
 * Screen rather than world: this is a statement about the pointer, which has
 * the same precision however far the board is zoomed, so the canvas divides
 * it by the scale before handing it over. 15 is Obsidian Canvas's
 * `objectSnapDistance`, and it does the same division.
 */
export const SNAP_SCREEN_PX = 15

/**
 * Clear space between the selection toolbar and the selection it acts on, in
 * screen pixels — the toolbar lives in the viewport layer, so this is a fact
 * about the screen and does not scale with the camera.
 *
 * Obsidian Canvas's own gap is measured in world units and so grows with zoom
 * (24px on screen at scale 0.48). We keep it constant instead: ours is a
 * screen-space chrome element, and chrome that drifts away from what it acts
 * on as you zoom in is chrome that has to be chased.
 */
export const TOOLBAR_GAP_PX = 8

/** How close to the viewport's edge the toolbar may come before it is clamped
 * back in — the same figure decides when it flips below the selection. */
export const TOOLBAR_MARGIN_PX = 8

// -----------------------------------------------------------------------
// Constants shared across canvas.ts and its `ui/canvas/*` collaborators
// (CardRenderer, EdgeLayer). Everything below is either a DOM class name or a
// tiny data constant read on both sides of one of those class boundaries; a
// constant used by only one file lives locally in that file instead (see
// cardRenderer.ts's and edgeLayer.ts's own top-of-file consts).
// -----------------------------------------------------------------------

export const SVG_NS = 'http://www.w3.org/2000/svg'

/** Obsidian's own link nodes load nothing but http(s) (`setFrameUrl`), which
 * is also what keeps `data:`/`javascript:` URLs out of the frame. */
export const WEB_URL_PATTERN = /^https?:\/\//i

export const CARD_SELECTED_CLASS = 'yolo-whiteboard-card-selected'
/** The single-selected card, mirroring Obsidian Canvas's `is-focused`. */
export const CARD_FOCUSED_CLASS = 'yolo-whiteboard-card-focused'
export const GROUP_LABEL_CLASS = 'yolo-whiteboard-group-label'
/** Marks a body whose content is its own interaction surface — media
 * transport controls, an embedded web page — and so is exempt from the
 * content mask once its card is the single selection. See style.css. */
export const CARD_BODY_LIVE_CLASS = 'yolo-whiteboard-card-body-live'

export const EDGE_HIT_CLASS = 'yolo-whiteboard-edge-hit'
export const EDGE_LABEL_CLASS = 'yolo-whiteboard-edge-label'
export const EDGE_HIDDEN_CLASS = 'yolo-whiteboard-edge-hidden'
