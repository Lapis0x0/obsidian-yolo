// Canvas tuning constants for the `.yoloboard` file view, ported from the
// S2/S3 spikes (`git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/constants.ts`) per
// docs/plans/08-25-yolo-whiteboard/p1-design.md §3. UI/host-loop tuning, not
// domain data — kept out of domain/ per that layer's zero-dependency
// contract (it doesn't need these; only src/ui/canvas.ts's rAF loop does).

/** Camera scale clamp range. */
export const SCALE_BOUNDS = Object.freeze({ min: 0.08, max: 2.5 })

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

/** Dot-grid spacing in world units — the finest the lattice ever gets. */
export const GRID_WORLD_STEP_PX = 20

/** On-screen spacing the grid refuses to go below. The visible step is
 * GRID_WORLD_STEP_PX doubled as many times as it takes to clear this floor,
 * which is what keeps the grid a grid across the whole zoom range: at
 * SCALE_BOUNDS.min a fixed 20-unit step would land dots 1.6px apart, i.e. a
 * grey wash. See canvas.ts's applyGrid().
 *
 * 10 is Obsidian Canvas's own floor, measured off the `<pattern>` tile in
 * its svg.canvas-background across the zoom range: it runs the same scheme
 * (same 20-unit base step, same power-of-two level switching), so matching
 * the floor makes our grid track its density at every zoom rather than
 * sitting a level sparser through the zoomed-out half. */
export const GRID_MIN_SCREEN_STEP_PX = 10
