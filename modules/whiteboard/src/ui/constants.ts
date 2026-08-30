// Canvas tuning constants for the `.yoloboard` file view, ported from the
// S2/S3 spikes (`git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/constants.ts`) per
// docs/plans/08-25-yolo-whiteboard/p1-design.md §3. UI/host-loop tuning, not
// domain data — kept out of domain/ per that layer's zero-dependency
// contract (it doesn't need these; only src/ui/canvas.ts's rAF loop does).

/** Camera scale clamp range. */
export const SCALE_BOUNDS = Object.freeze({ min: 0.08, max: 2.5 })

/** Wheel delta that doubles the zoom. 300 is Obsidian Canvas's own figure,
 * measured by driving its canvas with wheel events of four different sizes
 * and solving for the exponent — it came out identical at every size, so its
 * zoom is delta-proportional exactly like ours and only the rate differed. */
export const WHEEL_DELTA_PER_ZOOM_DOUBLING = 300

/** Time constant of the glide the camera takes toward the zoom a gesture
 * asked for, rather than snapping to it. Measured off Obsidian Canvas by
 * sampling its transform every frame through one wheel notch: the remaining
 * distance decays by ~0.876 per frame on a 120Hz display, i.e. e-folding
 * every ~63ms, and the whole glide is over in ~255ms. Short enough that the
 * easing reads as weight rather than lag — twice this already feels floaty.
 * See canvas.ts's advanceZoomGlide(). */
export const ZOOM_GLIDE_TAU_MS = 63

/** Remaining distance, in doublings, below which the glide is finished and
 * the camera snaps to its target — an exponential approach never arrives, and
 * a hundredth of a doubling is a fifth of a pixel on a 260px card. */
export const ZOOM_GLIDE_EPSILON_DOUBLINGS = 0.01

/** Screen-pixel buffer band around the viewport for virtualization, divided
 * by scale before use so its on-screen width stays constant across zoom
 * levels (see domain/virtualization.ts's computeWorldViewportRect). */
export const VIEWPORT_BUFFER_PX = 400

/** Visibility recompute throttle — matches the spikes' measured sweet spot
 * between responsiveness and recompute cost at a few hundred cards. */
export const RECOMPUTE_INTERVAL_MS = 70

/** Per-frame drain quotas: mounting is a real `MarkdownRenderer.render()`
 * call (materially more expensive than the spike's `innerHTML =`
 * simulation), so it stays conservative; unmounting is cheap DOM removal. */
export const MOUNT_QUOTA_PER_FRAME = 6
export const UNMOUNT_QUOTA_PER_FRAME = 40

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

/** World scale below which cards render a degraded (title-only) preview
 * instead of their full markdown, to skip text layout cost while zoomed far
 * out (p1-design §3: "补齐 spike 未移植项：缩放阈值降级"). Checked at the
 * same ~70ms throttle as recomputeVisibility, not per frame — see
 * canvas.ts's updateDegradedState(). */
export const DEGRADE_SCALE_THRESHOLD = 0.35

/** Size a card is created at. Deliberately at the small end of what the
 * spikes' boards used (226-334 wide) — an empty card should not take half
 * the screen; the user resizes the ones that grow. */
export const NEW_CARD_SIZE = Object.freeze({ w: 260, h: 180 })

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
 * card when zoomed in. See canvas.ts's applyHandleScale().
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
