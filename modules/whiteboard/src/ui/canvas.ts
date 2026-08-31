// The `.yoloboard` file view's canvas: camera pan/zoom, viewport
// virtualization, and the note/text card static-preview <-> live-editor
// lifecycle (docs/plans/08-25-yolo-whiteboard/p1-design.md §3). Ported from
// the S2/S3 spikes' `WhiteboardFileView` (`git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/fileView.ts`) and
// translated from direct Obsidian API calls (`TextFileView`,
// `MarkdownRenderer`, `app.keymap`) to the Host API surface a module is
// actually allowed to use (Module Boundaries, CLAUDE.md) — `YoloModuleHostApiV1`
// and `YoloModuleHostFileViewContextV1`, both declared globally by
// `modules/host-sdk.d.ts`.
//
// Deliberately DOM-heavy and imperative rather than React (p1-design's task
// brief: "画布主体建议直接 DOM 命令式实现（spike 同款，性能路径更可控）") — a
// rAF loop driving virtualization mount/unmount at a few hundred cards a
// frame is not a good fit for a vdom diff.
//
// Popout safety: every DOM node, listener, timer, and rAF call goes through
// `this.context.getDocument()` / `this.context.getWindow()`, never the
// global `document`/`window` (Popout / Multi-window, CLAUDE.md) — this view
// must keep working when its leaf is dragged into an Obsidian popout
// BrowserWindow, which has its own realm.

import {
  approachScale,
  cameraFromView,
  dragPan,
  panByWheel,
  scaleAfterWheel,
  screenToWorld,
  viewAnchoredAt,
  viewFromCamera,
} from '../domain/camera'
import type { ScreenPoint } from '../domain/camera'
import { planNodeCommit } from '../domain/commit'
import {
  NODE_SIDES,
  type SideAnchor,
  anchorPoint,
  buildEdgePathD,
  computeEdgeGeometry,
  findConnectTarget,
  oppositeSide,
  rectAnchoredAt,
  resolveEdgeSides,
} from '../domain/edges'
import {
  type Board,
  type BoardNode,
  type BoardParseIssue,
  type Edge,
  type EdgeId,
  type FileNode,
  type NodeId,
  type NodeSide,
  type TextNode,
  emptyBoard,
  parseBoard,
  serializeBoard,
} from '../domain/fileFormat'
import { BoardHistory } from '../domain/history'
import {
  basenameWithoutExtension,
  cardNoteContent,
  generateCardNoteFileName,
  isMarkdownPath,
} from '../domain/naming'
import {
  addEdge,
  addNode,
  moveNodes,
  removeEdge,
  removeNode,
  replaceNode,
  updateEdge,
  updateNode,
} from '../domain/operations'
import {
  type CardRect,
  RESIZE_HANDLES,
  type ResizeHandle,
  rectOfCard,
  resizeRect,
} from '../domain/resize'
import {
  marqueeRectFromPoints,
  nodeAtPoint,
  nodesInMarquee,
} from '../domain/selection'
import { type MissingFileNode, planFileNodeSelfHeal } from '../domain/selfHeal'
import {
  type CanvasView,
  type VirtualCardRect,
  VirtualizationEngine,
  computeWorldViewportRect,
} from '../domain/virtualization'
import { createWhiteboardTranslation } from '../i18n'

import {
  CAMERA_SETTLE_MS,
  CONNECT_SNAP_WORLD_PX,
  DEGRADE_RESTORE_SCALE,
  DEGRADE_SCALE_THRESHOLD,
  DRAG_THRESHOLD_PX,
  DROP_STAGGER_PX,
  EDIT_PERSIST_THROTTLE_MS,
  GRID_MIN_SCREEN_STEP_PX,
  GRID_WORLD_STEP_PX,
  INTERACTING_CLASS_TIMEOUT_MS,
  MIN_CARD_SIZE,
  MOUNT_QUOTA_PER_FRAME,
  NEW_CARD_SIZE,
  RECOMPUTE_INTERVAL_MS,
  RESIZE_HANDLE_PX,
  SCALE_BOUNDS,
  UNMOUNT_QUOTA_PER_FRAME,
  VIEWPORT_BUFFER_PX,
  WHEEL_DELTA_PER_ZOOM_DOUBLING,
  ZOOM_GLIDE_EPSILON_DOUBLINGS,
  ZOOM_GLIDE_TAU_MS,
} from './constants'
import { degradedNodeTitle, nextDegradedState } from './lod'

const SVG_NS = 'http://www.w3.org/2000/svg'

const ROOT_CLASS = 'yolo-whiteboard-root'
const VIEWPORT_CLASS = 'yolo-whiteboard-viewport'
const VIEWPORT_HIDDEN_CLASS = 'yolo-whiteboard-viewport-hidden'
const VIEWPORT_PANNING_CLASS = 'yolo-whiteboard-viewport-panning'
const VIEWPORT_DROP_ACTIVE_CLASS = 'yolo-whiteboard-viewport-drop-active'
const WORLD_CLASS = 'yolo-whiteboard-world'
const WORLD_INTERACTING_CLASS = 'yolo-whiteboard-world-interacting'
const WORLD_DEGRADED_CLASS = 'yolo-whiteboard-world-degraded'
const CARD_CLASS = 'yolo-whiteboard-card'
const INTERACTION_LAYER_CLASS = 'yolo-whiteboard-interaction-layer'
const INTERACTION_LAYER_HIDDEN_CLASS =
  'yolo-whiteboard-interaction-layer-hidden'
const RESIZER_CLASS = 'yolo-whiteboard-resizer'
const CONNECTION_POINT_CLASS = 'yolo-whiteboard-connection-point'
const CARD_EDITING_CLASS = 'yolo-whiteboard-card-editing'
const CARD_SELECTED_CLASS = 'yolo-whiteboard-card-selected'
const CARD_DRAGGING_CLASS = 'yolo-whiteboard-card-dragging'
const CARD_BODY_CLASS = 'yolo-whiteboard-card-body'
const CARD_TITLE_CLASS = 'yolo-whiteboard-card-title'
const CARD_DEGRADED_TITLE_CLASS = 'yolo-whiteboard-card-degraded-title'
const CARD_MISSING_CLASS = 'yolo-whiteboard-card-missing'
const CARD_UNSUPPORTED_PLACEHOLDER_CLASS =
  'yolo-whiteboard-card-unsupported-placeholder'
const GROUP_CLASS = 'yolo-whiteboard-group'
const GROUP_LABEL_CLASS = 'yolo-whiteboard-group-label'
const CARD_CONNECT_TARGET_CLASS = 'yolo-whiteboard-card-connect-target'
const CARD_HINT_CLASS = 'yolo-whiteboard-card-hint'
const MARQUEE_CLASS = 'yolo-whiteboard-marquee'
const EDGES_SVG_CLASS = 'yolo-whiteboard-edges'
const EDGE_PATH_CLASS = 'yolo-whiteboard-edge-path'
const EDGE_HIT_CLASS = 'yolo-whiteboard-edge-hit'
const EDGE_ARROW_CLASS = 'yolo-whiteboard-edge-arrow'
const EDGE_LABEL_CLASS = 'yolo-whiteboard-edge-label'
const EDGE_SELECTED_CLASS = 'yolo-whiteboard-edge-selected'
const EDGE_HIDDEN_CLASS = 'yolo-whiteboard-edge-hidden'
const EDGE_PREVIEW_CLASS = 'yolo-whiteboard-edge-preview'
const EDITOR_HOST_CLASS = 'yolo-whiteboard-editor-host'
const ERROR_CLASS = 'yolo-whiteboard-error'
const ERROR_VISIBLE_CLASS = 'yolo-whiteboard-error-visible'
const ERROR_TITLE_CLASS = 'yolo-whiteboard-error-title'
const ERROR_HINT_CLASS = 'yolo-whiteboard-error-hint'
const PREHEAT_CLASS = 'yolo-whiteboard-preheat'

type NodeRuntime = {
  el: HTMLElement | null
  bodyEl: HTMLElement | null
  /** The card's read-only content surface, for both note and text cards —
   * one path, because a text card is only markdown that happens to live in
   * the board file rather than in one of its own (p3-canvas-parity D2/D11).
   * Null while the card shows a placeholder or is being edited. */
  contentView: YoloModuleHostMarkdownContentViewV1 | null
  /** What `contentView` was built against. A content view resolves links
   * against this on every render pass, so a card whose source moves needs a
   * new one rather than a `setValue`. */
  contentSourcePath: string | null
  missingFile: boolean
  /** Last known content for a *note* card (its backing file's text), cached
   * because note-card content never lives in `board` (p1-design §1.2) — this
   * is the only place it's available to seed the live editor. Unused for
   * text/pdf cards. */
  noteText: string | null
}

type EditingState = {
  readonly nodeId: NodeId
  readonly editor: YoloModuleHostMarkdownEditorV1
  readonly scopeDisposer: () => void
  /** Identifies this editing session to the history, so its many commits
   * (throttled writes plus the final flush) fold into one undo step. */
  readonly historyKey: string
  /** Pending throttled write of what is currently in the editor; see
   * `scheduleEditPersist`. */
  persistTimer: number | null
}

// -- pointer interaction state --------------------------------------------
// One of three mutually-exclusive gestures a left-button (or middle-button)
// press can start, decided at pointerdown by where it landed (canvas.ts's
// onPointerDown): panning the camera, marquee-selecting cards, or
// pressing-and-maybe-dragging a card. `interaction` holds whichever is
// active; `null` when the pointer is up.

type PanInteraction = Readonly<{
  kind: 'pan'
  origin: CanvasView
  startX: number
  startY: number
}>

/** Screen-space (viewport-local) coordinates — see startMarquee()'s doc
 * comment for why both `originLocal` and `originClient` are tracked. */
type MarqueeInteraction = Readonly<{
  kind: 'marquee'
  originLocal: ScreenPoint
  originClient: ScreenPoint
}>

/**
 * A press on a card that hasn't yet crossed `DRAG_THRESHOLD_PX`: still
 * ambiguous between "click to edit" (pointerup with `dragging === false`)
 * and "drag to move" (crossed the threshold, `dragging === true`). `ids`/
 * `startPositions` are populated only once dragging begins (see
 * `beginNodeDrag`) — they cover every currently-selected card (a group
 * drag), or just `nodeId` alone if it wasn't already selected.
 */
type NodeInteraction = {
  readonly kind: 'card'
  readonly nodeId: NodeId
  readonly startClient: ScreenPoint
  dragging: boolean
  ids: NodeId[]
  readonly startPositions: Map<NodeId, Readonly<{ x: number; y: number }>>
}

/**
 * A press on one of the eight resize handles. Like `NodeInteraction` it stays
 * ambiguous until `DRAG_THRESHOLD_PX`: the handles straddle the card's border,
 * so their inner half sits on top of the card, and a plain click there has to
 * still mean what a click on the card means (enter edit) rather than landing
 * in a dead zone. `startRect` is the card's rect at press time — every frame
 * is computed from it, never from the previous frame (see `resizeRect`).
 */
type ResizeInteraction = {
  readonly kind: 'resize'
  readonly nodeId: NodeId
  readonly handle: ResizeHandle
  readonly startClient: ScreenPoint
  readonly startRect: CardRect
  dragging: boolean
}

/**
 * A connection being dragged: either a new edge pulled out of a card's
 * connection point, or an existing edge's endpoint pulled off the card it was
 * attached to. One gesture, because they differ in nothing a pointer can
 * tell — one end is pinned, the other follows the pointer and snaps to
 * whatever it lands on — and only in what the drop commits.
 *
 * Ambiguous below `DRAG_THRESHOLD_PX` like the other two press gestures: on
 * an existing edge a press that never moves selects it (Obsidian Canvas puts
 * both on the line the same way), and on a connection point it is a fumbled
 * grab that should leave no trace.
 *
 * `candidates` is snapshotted at press time: cards cannot move during a
 * connection drag, so the drop target is searched over a fixed set rather
 * than re-derived from the board on every pointermove.
 */
type ConnectInteraction = {
  readonly kind: 'connect'
  /** The end that stays put, and the side it is anchored to. */
  readonly anchor: SideAnchor
  /** Which end of the edge is following the pointer. A new edge always
   * drags its `to` end — you pull the arrow out towards where it points. */
  readonly movingEnd: 'from' | 'to'
  /** The edge being re-attached, or null when this drag is creating one. */
  readonly edgeId: EdgeId | null
  readonly startClient: ScreenPoint
  readonly candidates: readonly VirtualCardRect[]
  dragging: boolean
  target: SideAnchor | null
}

type Interaction =
  | PanInteraction
  | MarqueeInteraction
  | NodeInteraction
  | ResizeInteraction
  | ConnectInteraction

type EdgeDomEntry = Readonly<{
  path: SVGPathElement
  /** Transparent fat stroke under `path`: a 1.5-unit curve is not something
   * a pointer can be asked to hit. */
  hit: SVGPathElement
  label: SVGTextElement | null
}>

/**
 * One instance per open leaf (and re-created on popout window migration —
 * see the `dispose()`/constructor doc comments). Implements the DOM/camera/
 * card-lifecycle behavior behind the thin `YoloModuleFileViewInstanceV1`
 * wrapper built in `src/index.tsx`.
 */
export class WhiteboardCanvas {
  private board: Board = emptyBoard()
  private nodesById = new Map<NodeId, BoardNode>()
  /**
   * Every node that is not a group, in board order — the population a card
   * gesture acts on. Groups live in the same `nodes` array (p3-canvas-parity
   * D5) but sit *behind* the cards, so a hit test that walked the whole array
   * would let a group swallow a double-click meant for the empty space inside
   * it. Derived in `syncBoardIndex`, never stored.
   */
  private cardNodes: readonly BoardNode[] = []
  private readonly runtimeByNodeId = new Map<NodeId, NodeRuntime>()
  private readonly engine = new VirtualizationEngine()
  private readonly pinnedIds = new Set<NodeId>()

  /** Undo/redo over board content. Seeded on load, pushed by
   * `applyBoardChange`, and never touched by camera movement (see
   * `applyHistoryBoard`). */
  private readonly history = new BoardHistory()
  /** The off-screen card that warms the rendering pipeline; see `preheat`. */
  private preheatView: YoloModuleHostMarkdownContentViewV1 | null = null
  private viewKeymapDisposer: (() => void) | null = null
  private editSessionCounter = 0

  private view: CanvasView = { tx: 0, ty: 0, scale: 1 }
  private interaction: Interaction | null = null
  private editing: EditingState | null = null

  // Selection (W3-A): UI state, not board data — never serialized. A
  // non-empty selection pushes a keymap scope (Delete/Backspace/Escape);
  // editing a card always clears the selection first (see enterEditMode),
  // so the two states never overlap and their keymap scopes never compete
  // for the same Backspace/Escape keystroke (a card being edited is never
  // also in `selectedIds`).
  private selectedIds = new Set<NodeId>()
  /** Edges are selected the same way and share the keymap scope, but never
   * at the same time as cards: the two are different kinds of object, and
   * Delete acting on "whatever was selected last" is the only reading of a
   * mixed selection anyone would expect. */
  private selectedEdgeIds = new Set<EdgeId>()
  private selectionScopeDisposer: (() => void) | null = null
  private marqueeEl: HTMLElement | null = null

  // Resize (W3-C): one shared handle layer for the whole board, parked over
  // whichever card the pointer is on, rather than eight handles per mounted
  // card — at a few hundred mounted cards that would be thousands of nodes
  // that only ever matter for one of them. Obsidian Canvas's own
  // `.canvas-node-interaction-layer` works the same way.
  private interactionLayerEl: HTMLElement | null = null
  private hoveredNodeId: NodeId | null = null
  /** The card the layer is currently parked on — `interactionLayerTarget()`
   * as last applied, which is what a press on a handle resizes. */
  private layerNodeId: NodeId | null = null
  /** Scale the handle counter-scale was last written for; the CSS variable
   * is only rewritten when the zoom actually changed, so panning (which
   * writes `transform` every frame) doesn't invalidate the handles' style. */
  private appliedHandleScale: number | null = null

  // Edges (W3-A): a single SVG overlay drawn into the world layer, redrawn
  // wholesale on structural change (rebuildEdgesSvg) and per-path on card
  // position change (redrawEdgesForNodes) — see those methods' doc
  // comments for the mount-independent, DOM-measurement-free approach.
  private edgesGroupEl: SVGGElement | null = null
  private boardEdgesById = new Map<EdgeId, Edge>()
  private edgeIndexByNodeId = new Map<NodeId, Set<EdgeId>>()
  private readonly edgeElsById = new Map<EdgeId, EdgeDomEntry>()
  /** The in-flight connection's curve. A sibling of the edges group rather
   * than a child, so `rebuildEdgesSvg`'s wholesale replaceChildren never
   * takes it out from under a live gesture. */
  private previewPathEl: SVGPathElement | null = null
  private connectTargetNodeId: NodeId | null = null
  private readonly arrowMarkerId = `yolo-whiteboard-edge-arrow-${Math.random().toString(36).slice(2)}`

  private lastRawData = ''
  private parseFailed = false

  // Content-freshness (W3-B): a vault-wide `modify` subscription, live for
  // the leaf's whole lifetime (set up once in ensureDom, released in
  // dispose) — a note card's backing file can change from outside this
  // whiteboard (another leaf, another app) and the mounted card should pick
  // it up without requiring the whole `.yoloboard` file to reload. Scoped
  // to '' (vault-wide) rather than per-card because cards can reference
  // files anywhere; see handleBackingFileModified for the actual filtering
  // (mounted note cards only, and never the one currently being edited).
  private vaultSubscriptionDisposer: (() => void) | null = null

  private domReady = false
  private rootEl: HTMLElement | null = null
  private viewportEl!: HTMLElement
  private worldEl!: HTMLElement
  private errorEl: HTMLElement | null = null

  private rafId: number | null = null
  private interactingTimer: number | null = null
  private settleTimer: number | null = null
  private lastRecomputeTime = 0
  /** Zoom the wheel has asked for but the camera has not reached yet, with
   * the point the gesture grabbed. Null when the camera is at rest. */
  private zoomGlide: {
    targetScale: number
    screen: ScreenPoint
    world: ScreenPoint
  } | null = null
  private lastGlideTime: number | null = null
  /** Current zoom-degrade state, updated only at recomputeVisibility's ~70ms
   * throttle (see updateDegradedState) — not evaluated per frame. */
  private degraded = false
  /** Mounted cards whose content is on the wrong side of the degrade
   * threshold: built while it should be gone, or absent while it should be
   * there. Filled wholesale when `degraded` flips and drained a few per frame
   * by `drainQueues` (p3-canvas-parity D8) — the queue only ever holds work in
   * the direction `degraded` currently points, so one set covers both. */
  private readonly contentSyncQueue = new Set<NodeId>()

  constructor(
    private readonly context: YoloModuleHostFileViewContextV1,
    private readonly host: YoloModuleHostApiV1,
  ) {}

  // -----------------------------------------------------------------------
  // YoloModuleFileViewInstanceV1 surface (src/index.tsx wires these 1:1).
  // -----------------------------------------------------------------------

  /**
   * TextFileView-style contract: must be idempotent and safe to call
   * repeatedly (host doc: "May run before the DOM is visible and
   * repeatedly (external modify); must be idempotent"). M1 doesn't
   * implement a smooth incremental refresh on external modify (out of
   * scope per p1-design §6 M1 — "modify 重渲染" ships in a later
   * milestone), so both `clear=true` and `clear=false` do the same full
   * rebuild from the freshly parsed board; the `clear` flag itself carries
   * no distinct meaning yet.
   */
  setViewData(data: string, _clear: boolean): void {
    this.ensureDom()
    this.lastRawData = data
    const result = parseBoard(data)
    this.teardownAllCards()

    if (!result.ok) {
      this.parseFailed = true
      this.board = emptyBoard()
      this.syncBoardIndex()
      this.setHoveredNode(null)
      this.showError(result.issues)
      return
    }

    this.parseFailed = false
    this.board = result.board
    this.syncBoardIndex()
    this.selfHealMissingFileNodes()
    // Baseline for undo, taken after self-heal so the repaired board is the
    // oldest state anyone can get back to. Reset rather than extended: this
    // is a different file, or the same file rewritten from outside, and
    // pushing the previous content over it is how an undo destroys data.
    this.history.reset(this.board)
    this.rebuildEdgesSvg()
    this.view = viewFromCamera(this.board.camera)
    // A glide aimed at the previous board's camera has nothing to say about
    // this one, and would drag the new view away from where it opened.
    this.zoomGlide = null
    this.lastGlideTime = null
    this.applyTransform()
    // Cards were all torn down above: whatever the layer was parked on is
    // either gone or somewhere else now.
    this.refreshInteractionLayer()
    this.showCanvas()
    this.recomputeVisibility()
    this.drainQueues()
  }

  /**
   * Must reflect live editing state without requiring blur first (host doc
   * comment on `YoloModuleFileViewInstanceV1.getViewData`). Folds in two
   * things that may not have been committed to `this.board` yet:
   *  - the live camera, even mid-gesture (before its settle debounce fires —
   *    see `commitCameraNow`) — otherwise a quick pan-then-close could lose
   *    the camera position, since the host reads `getViewData()` to snapshot
   *    final state *before* calling `dispose()` (see that method's doc
   *    comment), i.e. before any settle timer would have run;
   *  - the active card's live editor text, via the same `planNodeCommit`
   *    decision the actual commit path uses, without performing its write
   *    side effects (a note card's live text isn't part of the board at all
   *    — p1-design §1.2 — so there is nothing to fold in for that case; only
   *    a text card's `updateBoard` outcome affects serialization here).
   */
  getViewData(): string {
    if (this.parseFailed) return this.lastRawData
    let board = this.board
    const camera = cameraFromView(this.view)
    if (
      camera.x !== board.camera.x ||
      camera.y !== board.camera.y ||
      camera.scale !== board.camera.scale
    ) {
      board = { ...board, camera }
    }
    if (this.editing) {
      const liveText = this.editing.editor.getValue()
      const action = planNodeCommit(board, this.editing.nodeId, liveText)
      if (action.kind === 'updateBoard') board = action.board
    }
    return serializeBoard(board)
  }

  /** About to load a different file into this leaf. */
  clear(): void {
    this.teardownAllCards()
    this.board = emptyBoard()
    this.syncBoardIndex()
    this.parseFailed = false
    this.lastRawData = ''
  }

  onResize(): void {
    if (this.parseFailed) return
    this.recomputeVisibility()
    this.drainQueues()
  }

  /**
   * Called on view close AND on popout window migration (host rebuilds via
   * `factory()` afterwards and replays `setViewData`) — must release
   * everything, and must not lose an in-progress edit in the process. A
   * note card's live text has no other persistence path (unlike a text
   * card's, which `getViewData()` already captures independently), so
   * committing here is what prevents a mid-edit popout drag or leaf close
   * from silently discarding typed text.
   */
  dispose(): void {
    this.forceCommitActiveEdit()
    const win = this.context.getWindow()
    if (this.rafId !== null) {
      win.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.interactingTimer !== null) {
      win.clearTimeout(this.interactingTimer)
      this.interactingTimer = null
    }
    if (this.settleTimer !== null) {
      win.clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    this.viewportEl?.removeEventListener('pointerdown', this.onPointerDown)
    this.viewportEl?.removeEventListener('wheel', this.onWheel)
    this.viewportEl?.removeEventListener('dblclick', this.onDoubleClick)
    this.viewportEl?.removeEventListener('contextmenu', this.onContextMenu)
    this.viewportEl?.removeEventListener('dragover', this.onDragOver)
    this.viewportEl?.removeEventListener('dragleave', this.onDragLeave)
    this.viewportEl?.removeEventListener('drop', this.onDrop)
    win.removeEventListener('pointermove', this.onPointerMove)
    win.removeEventListener('pointerup', this.onPointerUp)
    this.vaultSubscriptionDisposer?.()
    this.vaultSubscriptionDisposer = null
    this.viewKeymapDisposer?.()
    this.viewKeymapDisposer = null

    this.teardownAllCards()
    this.preheatView?.destroy()
    this.preheatView = null
    this.rootEl?.remove()
    this.rootEl = null
    this.errorEl = null
    this.domReady = false
  }

  // -----------------------------------------------------------------------
  // DOM setup
  // -----------------------------------------------------------------------

  private ensureDom(): void {
    if (this.domReady) return
    const doc = this.context.getDocument()

    const root = doc.createElement('div')
    root.className = ROOT_CLASS

    // The host does not auto-apply a module's style.css artifact — a module
    // owns its own style injection (same pattern as modules/learning's
    // inline <style> render). Mounted under the view root so it lives in
    // the view's Document (popout-correct: a <style> in the main window
    // does nothing for a popout's document) and is torn down with the root
    // on dispose. Filled asynchronously; layout self-corrects on the next
    // visibility recompute once the rules land.
    const styleEl = doc.createElement('style')
    root.appendChild(styleEl)
    void this.host.assets
      .readText('style.css')
      .then((css) => {
        styleEl.textContent = css
      })
      .catch((error: unknown) => this.reportError('style load', error))

    const viewport = doc.createElement('div')
    viewport.className = VIEWPORT_CLASS
    const world = doc.createElement('div')
    world.className = WORLD_CLASS

    // Edges overlay: one SVG covering the whole (unbounded) world layer.
    // `overflow: visible` on a nominally 1x1px element lets paths be drawn
    // anywhere in world coordinates (including negative x/y) without
    // needing a viewBox that tracks board extent — see style.css's
    // .yolo-whiteboard-edges. Inserted before any card so it paints behind
    // them (position:absolute children with no z-index stack in DOM order).
    const edgesSvg = doc.createElementNS(SVG_NS, 'svg')
    edgesSvg.setAttribute('class', EDGES_SVG_CLASS)
    const defs = doc.createElementNS(SVG_NS, 'defs')
    const marker = doc.createElementNS(SVG_NS, 'marker')
    marker.setAttribute('id', this.arrowMarkerId)
    marker.setAttribute('markerWidth', '8')
    marker.setAttribute('markerHeight', '8')
    marker.setAttribute('refX', '7')
    marker.setAttribute('refY', '4')
    // auto-start-reverse: the same marker, reused for both marker-start and
    // marker-end (an edge's `arrow: 'both'`), points outward correctly at
    // each end without needing two separate marker defs.
    marker.setAttribute('orient', 'auto-start-reverse')
    marker.setAttribute('markerUnits', 'userSpaceOnUse')
    const arrowPath = doc.createElementNS(SVG_NS, 'path')
    arrowPath.setAttribute('class', EDGE_ARROW_CLASS)
    arrowPath.setAttribute('d', 'M0,0 L8,4 L0,8 Z')
    marker.appendChild(arrowPath)
    defs.appendChild(marker)
    edgesSvg.appendChild(defs)
    const edgesGroup = doc.createElementNS(SVG_NS, 'g')
    edgesSvg.appendChild(edgesGroup)
    const preview = doc.createElementNS(SVG_NS, 'path')
    preview.setAttribute('class', `${EDGE_PREVIEW_CLASS} ${EDGE_HIDDEN_CLASS}`)
    preview.setAttribute('marker-end', `url(#${this.arrowMarkerId})`)
    edgesSvg.appendChild(preview)
    world.appendChild(edgesSvg)

    // Built once and reused: mounted last so it sits above every card, and
    // parked (hidden) until the pointer is actually on a card.
    const interactionLayer = doc.createElement('div')
    interactionLayer.className = `${INTERACTION_LAYER_CLASS} ${INTERACTION_LAYER_HIDDEN_CLASS}`
    for (const handle of RESIZE_HANDLES) {
      const resizer = doc.createElement('div')
      resizer.className = RESIZER_CLASS
      resizer.dataset.resize = handle
      // The four side handles carry the connection point for that side,
      // nested inside them rather than laid out separately — the dot and the
      // handle want the same spot, so the only way for both to be reachable
      // is for one to sit on the other. Which of the two a press means is
      // then decided by the element it actually landed on (Obsidian Canvas
      // nests `.canvas-node-connection-point` in its resizers for exactly
      // this reason).
      const side = NODE_SIDES.find((candidate) => candidate === handle)
      if (side) {
        const connectionPoint = doc.createElement('div')
        connectionPoint.className = CONNECTION_POINT_CLASS
        connectionPoint.dataset.side = side
        resizer.appendChild(connectionPoint)
      }
      interactionLayer.appendChild(resizer)
    }
    world.appendChild(interactionLayer)

    viewport.appendChild(world)
    root.appendChild(viewport)

    const error = doc.createElement('div')
    error.className = ERROR_CLASS
    root.appendChild(error)

    this.context.contentEl.replaceChildren(root)

    this.rootEl = root
    this.viewportEl = viewport
    this.worldEl = world
    this.errorEl = error
    this.edgesGroupEl = edgesGroup
    this.previewPathEl = preview
    this.interactionLayerEl = interactionLayer
    // A freshly built world element carries none of the old one's inline
    // custom properties, so both handle variables have to be written again.
    // The size is pushed from here rather than hard-coded in the stylesheet
    // so it stays next to the doc comment explaining the counter-scale law.
    this.appliedHandleScale = null
    world.style.setProperty(
      '--yolo-whiteboard-resizer-size',
      `${RESIZE_HANDLE_PX}px`,
    )

    this.setupInteraction()
    this.registerViewKeymap()
    this.setupVaultSubscription()
    this.preheat()

    this.lastRecomputeTime = 0
    this.engine.reset()
    this.rafId = this.context.getWindow().requestAnimationFrame(this.frame)
    this.domReady = true
  }

  private setupInteraction(): void {
    const win = this.context.getWindow()
    this.viewportEl.addEventListener('pointerdown', this.onPointerDown)
    win.addEventListener('pointermove', this.onPointerMove)
    win.addEventListener('pointerup', this.onPointerUp)
    this.viewportEl.addEventListener('wheel', this.onWheel, { passive: false })
    this.viewportEl.addEventListener('dblclick', this.onDoubleClick)
    this.viewportEl.addEventListener('contextmenu', this.onContextMenu)
    this.viewportEl.addEventListener('dragover', this.onDragOver)
    this.viewportEl.addEventListener('dragleave', this.onDragLeave)
    this.viewportEl.addEventListener('drop', this.onDrop)
  }

  /** Content-freshness (p1-design §1.2): scoped to the whole vault ('' —
   * see moduleVault.ts's `doesPathAffectScope`) because a note card's
   * backing file can live anywhere; `handleBackingFileModified` does the
   * actual per-card filtering. Set up once per leaf lifetime alongside the
   * pointer listeners; released in `dispose()`. */
  private setupVaultSubscription(): void {
    this.vaultSubscriptionDisposer = this.host.vault.subscribe('', (event) => {
      if (event.type !== 'modify') return
      this.handleBackingFileModified(event.entry.path)
    })
  }

  /**
   * Warms up the host's markdown rendering pipeline once per view instance
   * (p1-design §3: "视图打开时用不可见卡预热渲染管线（S2 首卡 335ms 冷启
   * 动）") — renders into an off-screen (not `display:none`, so layout/
   * measurement work isn't skipped) element.
   *
   * Through the same content view the cards use, so what is warmed is what
   * they will actually run: the preview pipeline's parse worker included.
   */
  private preheat(): void {
    if (!this.rootEl) return
    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = PREHEAT_CLASS
    this.rootEl.appendChild(el)
    try {
      this.preheatView = this.host.ui.createMarkdownContentView({
        container: el,
        value: '_',
        sourcePath: this.sourcePathForBoard(),
      })
    } catch (error) {
      this.reportError('preheat render', error)
    }
    // Kept for the view's lifetime rather than discarded once it has drawn:
    // a content view renders on its own schedule and reports no completion,
    // and one empty off-screen card costs nothing next to guessing at a
    // moment to tear it down. Released in `dispose()`.
  }

  // -----------------------------------------------------------------------
  // Pointer interaction dispatch. A left-button press decides its gesture
  // at pointerdown by where it landed:
  //   - on a card not currently being edited -> a `NodeInteraction`,
  //     ambiguous between click-to-edit and drag-to-move until it crosses
  //     DRAG_THRESHOLD_PX (see `updateNodeInteraction`/`beginNodeDrag`);
  //   - on empty canvas with Alt held -> pan (an alt+left-drag path for
  //     trackpad users with no middle button);
  //   - on empty canvas otherwise -> marquee selection.
  // Middle-button always pans, from anywhere (including over a card).
  // Wheel handles both plain two-axis pan and ctrl/cmd-anchored zoom (the
  // ctrl/cmd-wheel signature is also how Chrome/Safari report trackpad
  // pinch). All three gestures only ever touch `this.view` + per-element
  // `transform`/`left`/`top` directly (no reflow); the camera is folded
  // into `board` and persisted only once a pan/zoom gesture settles (see
  // `scheduleCameraSettle`); a card drag/marquee commits immediately on
  // pointerup instead (no settle debounce — those are already discrete,
  // single-shot gestures, unlike the continuous wheel/pointer-pan stream).
  // -----------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.parseFailed) return
    const nodeId = this.nodeIdFromEventTarget(e.target)

    if (e.button === 1) {
      // Middle-click always pans, even starting from a card.
      e.preventDefault()
      this.startPan(e)
      return
    }
    if (e.button !== 0) return

    // The interaction layer sits above the cards, so it has to come first —
    // the press that starts a resize or a connection lands on it, never on
    // the card. Connection points are nested inside the side handles, so
    // they have to be asked about first in turn.
    const side = this.connectionSideFromEventTarget(e.target)
    if (side !== null && this.startConnect(side, e)) return
    const handle = this.resizeHandleFromEventTarget(e.target)
    if (handle !== null && this.startResize(handle, e)) return

    if (nodeId !== null) {
      // The card currently being edited owns its own pointer handling
      // (native text selection/cursor placement inside its CM6 editor) —
      // don't intercept.
      if (this.editing?.nodeId === nodeId) return
      this.interaction = {
        kind: 'card',
        nodeId,
        startClient: { x: e.clientX, y: e.clientY },
        dragging: false,
        ids: [],
        startPositions: new Map(),
      }
      this.viewportEl.setPointerCapture(e.pointerId)
      return
    }

    // Edges paint behind the cards, so a press only reaches one where no
    // card covers it — which is exactly where pressing it can mean the edge.
    const edgeId = this.edgeIdFromEventTarget(e.target)
    if (edgeId !== null && this.startEdgeReattach(edgeId, e)) return

    if (e.altKey) {
      this.startPan(e)
      return
    }

    this.startMarquee(e)
  }

  /**
   * Double-click on empty canvas creates a card.
   *
   * `dblclick` rather than a click counter read off `pointerdown`: measured
   * in a real Obsidian window, `pointerdown.detail` is 0 on both presses of
   * a double-click (only `mousedown` carries the count), while `dblclick`
   * arrives intact — the marquee's pointer capture, the reason for doubting
   * it, does not suppress it.
   */
  private readonly onDoubleClick = (e: MouseEvent): void => {
    if (this.parseFailed) return
    const world = this.worldPointFromEvent(e)
    // Which card this landed on has to come from geometry, not from
    // `e.target`: the press that preceded it captured the pointer on the
    // viewport, and capture retargets every mouse event after it to the
    // capturing element — measured in a real window, `dblclick` on a card
    // arrives naming `.yolo-whiteboard-viewport`, never the card.
    const nodeId = nodeAtPoint(this.cardNodes, world)
    if (nodeId !== null) {
      // Inside the editor this is a word selection, not a request to open
      // what is already open.
      if (this.editing?.nodeId === nodeId) return
      this.editCard(nodeId)
      return
    }
    this.createTextCardAt(world)
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.parseFailed) return
    const nodeId = this.nodeIdFromEventTarget(e.target)
    // The card being edited owns its own context menu (CM6's, with the text
    // actions that belong to an editor).
    if (nodeId !== null && this.editing?.nodeId === nodeId) return
    e.preventDefault()

    if (nodeId === null) {
      const point = this.worldPointFromEvent(e)
      this.host.ui.showMenu(e, [
        {
          title: this.t('menu.newCard'),
          icon: 'plus',
          onSelect: () => this.createTextCardAt(point),
        },
      ])
      return
    }

    const card = this.nodesById.get(nodeId)
    if (!card) return
    this.host.ui.showMenu(e, [
      ...(card.type === 'text'
        ? [
            {
              title: this.t('menu.convertToNote'),
              icon: 'file-plus',
              onSelect: () => this.convertCardToNote(nodeId),
            },
          ]
        : []),
      {
        title: this.t('menu.deleteCard'),
        icon: 'trash-2',
        onSelect: () => this.deleteNodes([nodeId]),
      },
    ])
  }

  // -- drag and drop ------------------------------------------------------
  // `dragover` must preventDefault on every event for the drop to fire at
  // all; the host resolves what the drag actually carries at `drop`, because
  // during dragover the browser hides the DataTransfer contents.

  private readonly onDragOver = (e: DragEvent): void => {
    if (this.parseFailed) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.viewportEl.classList.add(VIEWPORT_DROP_ACTIVE_CLASS)
  }

  private readonly onDragLeave = (e: DragEvent): void => {
    // Moving across a child element fires dragleave on the way out; only a
    // pointer that actually left the viewport should clear the hint.
    const related = e.relatedTarget
    if (related instanceof Node && this.viewportEl.contains(related)) return
    this.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
  }

  private readonly onDrop = (e: DragEvent): void => {
    this.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
    if (this.parseFailed) return
    e.preventDefault()
    const entries = this.host.ui.resolveDropEntries(e)
    if (entries.length === 0) return
    const notes = entries.filter(
      (entry) =>
        entry.kind === 'file' && entry.path.toLowerCase().endsWith('.md'),
    )
    if (notes.length === 0) {
      this.host.ui.notice(this.t('notice.dropUnsupported'))
      return
    }
    this.addNoteCards(
      notes.map((entry) => entry.path),
      this.worldPointFromEvent(e),
    )
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const interaction = this.interaction
    if (!interaction) {
      this.updateHover(e)
      return
    }
    switch (interaction.kind) {
      case 'pan':
        this.updatePan(interaction, e)
        break
      case 'marquee':
        this.updateMarquee(interaction, e)
        break
      case 'card':
        this.updateNodeInteraction(interaction, e)
        break
      case 'resize':
        this.updateResize(interaction, e)
        break
      case 'connect':
        this.updateConnect(interaction, e)
        break
    }
  }

  /**
   * Parks the handle layer on whichever card the pointer is over.
   *
   * Only runs when no gesture is in flight: during one, the layer is either
   * the thing being dragged (resize) or deliberately out of the way, and
   * re-deciding which card is hovered from a pointer that has been captured
   * would fight the gesture.
   *
   * The layer itself counts as "still on the card" — its handles overhang
   * the card's border and its connection points sit on it, so a pointer
   * travelling out onto one must not be read as having left, or the layer
   * would vanish from under the pointer on its way to grab it.
   */
  private updateHover(e: PointerEvent): void {
    if (this.parseFailed) return
    const target = e.target
    const onLayer =
      target instanceof Element &&
      target.closest(`.${INTERACTION_LAYER_CLASS}`) !== null
    this.setHoveredNode(
      onLayer ? this.hoveredNodeId : this.nodeIdFromEventTarget(target),
    )
  }

  private setHoveredNode(nodeId: NodeId | null): void {
    if (nodeId === this.hoveredNodeId) return
    this.hoveredNodeId = nodeId
    this.updateInteractionLayer()
  }

  /**
   * The card whose handles are showing.
   *
   * Two sources, in this order: the card under the pointer, and — when the
   * pointer is not on one — the card that is selected. Hover alone was not
   * enough. A selected card is the one the user has said they are working on,
   * and half of every handle overhangs its border, so with hover as the only
   * trigger that outer half could never be approached from outside the card:
   * the handles only existed once the pointer was already past them. Hover
   * still wins where the two disagree, so a card can be resized without
   * selecting it first.
   *
   * Only a lone selection counts. With several cards selected there is no
   * single rectangle for the handles to belong to, and resizing a
   * multi-selection is a different gesture with its own semantics that the
   * board does not have yet.
   *
   * A card being edited is not excluded. It was at first, to keep the handles
   * from swallowing a click meant to place the caret near an edge — but that
   * trade is the wrong way round: it costs the ability to resize the one card
   * the user is actually working on, to protect a gesture that has the whole
   * rest of the card to land in. Obsidian Canvas keeps all eight handles live
   * on a node being edited too.
   */
  private interactionLayerTarget(): NodeId | null {
    return (
      this.hoveredNodeId ??
      (this.selectedIds.size === 1
        ? (this.selectedIds.values().next().value ?? null)
        : null)
    )
  }

  /**
   * Parks the layer on whatever `interactionLayerTarget` now resolves to.
   *
   * `force` re-reads the target's rect even when the target is unchanged, for
   * the callers that moved the card rather than changed which one it is.
   * Without that distinction this would be a no-op for the overwhelming
   * majority of calls — a pointer crossing one card fires hundreds of moves
   * that all resolve to it, and each would otherwise rewrite four inline
   * styles.
   */
  private updateInteractionLayer(force = false): void {
    const id = this.interactionLayerTarget()
    const card = id === null ? null : this.nodesById.get(id)
    const next = card ? id : null
    if (next === this.layerNodeId && !force) return
    this.layerNodeId = next
    const layer = this.interactionLayerEl
    if (!layer) return
    layer.classList.toggle(INTERACTION_LAYER_HIDDEN_CLASS, !card)
    if (card) this.placeInteractionLayer(rectOfCard(card))
  }

  /** Re-parks the layer after something other than hover or selection moved
   * the card it is on (a drag, a board reload, a card removal). */
  private refreshInteractionLayer(): void {
    this.updateInteractionLayer(true)
  }

  private placeInteractionLayer(rect: CardRect): void {
    const layer = this.interactionLayerEl
    if (!layer) return
    layer.style.left = `${rect.x}px`
    layer.style.top = `${rect.y}px`
    layer.style.width = `${rect.w}px`
    layer.style.height = `${rect.h}px`
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    const interaction = this.interaction
    if (!interaction) return
    this.interaction = null
    switch (interaction.kind) {
      case 'pan':
        this.finishPan()
        break
      case 'marquee':
        this.finishMarquee(interaction, e)
        break
      case 'card':
        this.finishNodeInteraction(interaction, e)
        break
      case 'resize':
        this.finishResize(interaction, e)
        break
      case 'connect':
        this.finishConnect(interaction, e)
        break
    }
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.parseFailed) return
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
    if (
      this.editing &&
      this.nodeIdFromEventTarget(e.target) === this.editing.nodeId
    ) {
      return
    }
    e.preventDefault()
    this.view = panByWheel(this.view, e.deltaX, e.deltaY)
    this.applyTransform()
    this.markInteracting()
    this.scheduleCameraSettle()
  }

  /**
   * Aims the camera at a new zoom, anchored on the point under the cursor.
   *
   * The camera glides there over the next few frames rather than arriving at
   * once (see `advanceZoomGlide`), so consecutive notches accumulate against
   * the *target* rather than wherever the glide currently is — otherwise
   * spinning the wheel would fight the easing and cover less ground the
   * faster it was spun. The anchor is re-taken from the live view each time,
   * which is what lets the cursor move mid-gesture and still zoom about
   * wherever it now points.
   */
  private zoomBy(deltaY: number, cursor: ScreenPoint): void {
    const targetScale = scaleAfterWheel(
      this.zoomGlide?.targetScale ?? this.view.scale,
      deltaY,
      WHEEL_DELTA_PER_ZOOM_DOUBLING,
      SCALE_BOUNDS,
    )
    const anchor = { screen: cursor, world: screenToWorld(this.view, cursor) }
    if (this.prefersReducedMotion()) {
      this.zoomGlide = null
      this.view = viewAnchoredAt(anchor.screen, anchor.world, targetScale)
      this.applyTransform()
      this.markInteracting()
      this.scheduleCameraSettle()
      return
    }
    this.zoomGlide = { ...anchor, targetScale }
  }

  /**
   * Moves the camera one frame closer to the zoom the last gesture asked for.
   *
   * Driven from the rAF loop rather than by the input events themselves: the
   * motion has to continue after the wheel stops, which is the whole point of
   * gliding — a gesture ends with the camera still travelling, the way it does
   * everywhere else in Obsidian.
   */
  private advanceZoomGlide(now: number): void {
    const glide = this.zoomGlide
    if (!glide) return
    // A first frame, or one after the tab was backgrounded, has no meaningful
    // elapsed time; treat it as a single 60Hz frame rather than teleporting.
    const elapsed =
      this.lastGlideTime === null
        ? 16.7
        : Math.min(now - this.lastGlideTime, 100)
    this.lastGlideTime = now

    const next = approachScale(
      this.view.scale,
      glide.targetScale,
      elapsed,
      ZOOM_GLIDE_TAU_MS,
    )
    const settled =
      Math.abs(Math.log2(next / glide.targetScale)) <
      ZOOM_GLIDE_EPSILON_DOUBLINGS
    this.view = viewAnchoredAt(
      glide.screen,
      glide.world,
      settled ? glide.targetScale : next,
    )
    this.applyTransform()
    this.markInteracting()
    if (settled) {
      this.zoomGlide = null
      this.lastGlideTime = null
      this.scheduleCameraSettle()
    }
  }

  /** Viewport-relative position of a mouse event. */
  private viewportPointFromEvent(e: MouseEvent): ScreenPoint {
    const rect = this.viewportEl.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** Resolved per gesture rather than cached: the setting can change while a
   * view is open, and this runs once per wheel gesture, not per frame. */
  private prefersReducedMotion(): boolean {
    return this.context
      .getWindow()
      .matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  private applyTransform(): void {
    this.worldEl.style.transform = `translate(${this.view.tx}px, ${this.view.ty}px) scale(${this.view.scale})`
    this.applyGrid()
    this.applyHandleScale()
  }

  /**
   * Counter-scales the resize handles, which live in the world layer and
   * would otherwise be scaled along with the cards.
   *
   * 1/sqrt(scale) rather than 1/scale: see RESIZE_HANDLE_PX. Skipped unless
   * the zoom actually changed, because this writes a custom property the
   * handles' sizes are computed from, and panning calls this method every
   * frame without touching the scale.
   */
  private applyHandleScale(): void {
    if (this.appliedHandleScale === this.view.scale) return
    this.appliedHandleScale = this.view.scale
    this.worldEl.style.setProperty(
      '--yolo-whiteboard-zoom-multiplier',
      String(1 / Math.sqrt(this.view.scale)),
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
   * what Obsidian's own canvas does, and there is no way to keep a grid
   * locked to world coordinates without moving it every frame.
   */
  private applyGrid(): void {
    const { scale, tx, ty } = this.view
    const doublings = Math.max(
      0,
      Math.ceil(
        Math.log2(GRID_MIN_SCREEN_STEP_PX / (GRID_WORLD_STEP_PX * scale)),
      ),
    )
    const step = GRID_WORLD_STEP_PX * 2 ** doublings * scale
    this.viewportEl.style.backgroundSize = `${step}px ${step}px`
    this.viewportEl.style.backgroundPosition = `${tx}px ${ty}px`
  }

  // will-change only while actively interacting (S1/S2 finding: a permanent
  // will-change wastes compositor memory for no benefit at rest).
  private markInteracting(): void {
    this.worldEl.classList.add(WORLD_INTERACTING_CLASS)
    const win = this.context.getWindow()
    if (this.interactingTimer !== null) win.clearTimeout(this.interactingTimer)
    this.interactingTimer = win.setTimeout(() => {
      this.worldEl.classList.remove(WORLD_INTERACTING_CLASS)
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

  private commitCameraNow(): void {
    const win = this.context.getWindow()
    if (this.settleTimer !== null) {
      win.clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    if (this.parseFailed) return
    // Mid-glide, the view is a frame on the way to somewhere; what the user
    // asked for is the target. Persisting the intermediate one would reopen
    // the board half-way through a zoom the gesture had already finished.
    const glide = this.zoomGlide
    const camera = cameraFromView(
      glide
        ? viewAnchoredAt(glide.screen, glide.world, glide.targetScale)
        : this.view,
    )
    const current = this.board.camera
    if (
      camera.x === current.x &&
      camera.y === current.y &&
      camera.scale === current.scale
    ) {
      return
    }
    this.board = { ...this.board, camera }
    this.context.requestSave()
  }

  // -----------------------------------------------------------------------
  // Pan gesture (middle-drag anywhere, or Alt+left-drag from empty canvas).
  // -----------------------------------------------------------------------

  private startPan(e: PointerEvent): void {
    this.interaction = {
      kind: 'pan',
      origin: { ...this.view },
      startX: e.clientX,
      startY: e.clientY,
    }
    this.viewportEl.classList.add(VIEWPORT_PANNING_CLASS)
    this.viewportEl.setPointerCapture(e.pointerId)
    this.markInteracting()
  }

  private updatePan(interaction: PanInteraction, e: PointerEvent): void {
    this.view = dragPan(
      interaction.origin,
      { x: interaction.startX, y: interaction.startY },
      { x: e.clientX, y: e.clientY },
    )
    this.applyTransform()
    this.markInteracting()
    this.scheduleCameraSettle()
  }

  private finishPan(): void {
    this.viewportEl.classList.remove(VIEWPORT_PANNING_CLASS)
    this.commitCameraNow()
  }

  // -----------------------------------------------------------------------
  // Marquee selection (left-drag from empty canvas). The overlay div lives
  // in the *viewport* layer (a sibling of the scaled/panned world layer),
  // so it's drawn in plain screen coordinates and never needs to account
  // for the camera transform itself — only its two corner points get
  // converted to world space, once, at pointerup (p1-design's W3-A task
  // brief allows either a live per-move highlight or a single hit-test at
  // release; this takes the latter, cheaper option — repainting a
  // dashed-rectangle overlay already gives the user drag feedback, and
  // hit-testing every card on every pointermove has no payoff for M1's
  // board sizes).
  // -----------------------------------------------------------------------

  private startMarquee(e: PointerEvent): void {
    const rect = this.viewportEl.getBoundingClientRect()
    const originLocal = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    this.interaction = {
      kind: 'marquee',
      originLocal,
      originClient: { x: e.clientX, y: e.clientY },
    }
    this.viewportEl.setPointerCapture(e.pointerId)
    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = MARQUEE_CLASS
    this.viewportEl.appendChild(el)
    this.marqueeEl = el
    this.applyMarqueeRect(originLocal, originLocal)
  }

  /** `originClient` is the raw pointerdown screen position (page-relative,
   * comparable across pointermove events without re-querying
   * getBoundingClientRect on every one); `originLocal` is that same instant
   * converted once to viewport-local coordinates. Since the viewport itself
   * doesn't move mid-gesture, the current local position is just
   * `originLocal` plus how far the pointer has moved since. */
  private currentMarqueePoint(
    interaction: MarqueeInteraction,
    e: PointerEvent,
  ): ScreenPoint {
    return {
      x: interaction.originLocal.x + (e.clientX - interaction.originClient.x),
      y: interaction.originLocal.y + (e.clientY - interaction.originClient.y),
    }
  }

  private updateMarquee(
    interaction: MarqueeInteraction,
    e: PointerEvent,
  ): void {
    this.applyMarqueeRect(
      interaction.originLocal,
      this.currentMarqueePoint(interaction, e),
    )
  }

  private applyMarqueeRect(a: ScreenPoint, b: ScreenPoint): void {
    if (!this.marqueeEl) return
    this.marqueeEl.style.transform = `translate(${Math.min(a.x, b.x)}px, ${Math.min(a.y, b.y)}px)`
    this.marqueeEl.style.width = `${Math.abs(a.x - b.x)}px`
    this.marqueeEl.style.height = `${Math.abs(a.y - b.y)}px`
  }

  private finishMarquee(
    interaction: MarqueeInteraction,
    e: PointerEvent,
  ): void {
    const current = this.currentMarqueePoint(interaction, e)
    this.marqueeEl?.remove()
    this.marqueeEl = null
    const worldA = screenToWorld(this.view, interaction.originLocal)
    const worldB = screenToWorld(this.view, current)
    // A zero-size marquee (a plain click on empty canvas, no movement)
    // naturally selects nothing here, subsuming "click empty clears
    // selection" without a separate code path. Edges are not marquee-
    // selectable (a band drawn across the canvas is about the cards it
    // covers), but a marquee still ends whatever edge selection was up.
    this.setEdgeSelection([])
    this.setSelection(
      nodesInMarquee(this.board.nodes, marqueeRectFromPoints(worldA, worldB)),
    )
  }

  // -----------------------------------------------------------------------
  // Card press: click-to-select vs. drag-to-move, disambiguated by
  // DRAG_THRESHOLD_PX. A plain click (never crosses the threshold) selects
  // the card; editing is a second, deliberate step — double-click, or Enter
  // on the selection (W3-E, matching Obsidian Canvas). Selecting first is
  // what makes a single click safe: the card can then be dragged, deleted,
  // resized or wired up without a caret landing in it and an editor
  // mounting on every glance. A brand-new card is the exception and opens
  // straight into editing — there is nothing in it to select.
  // A drag moves either just the pressed card, or the whole
  // current selection if the pressed card was already part of it (and
  // never enters edit mode). Position updates during drag write only
  // `transform` on the affected card elements (compositor-friendly, no
  // layout write) — `left`/`top` are reconciled to the final board values
  // once on drop, matching how a freshly-mounted card is positioned.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Resize (W3-C): eight handles on one shared layer that follows the
  // pointer's card. A press on a handle is ambiguous exactly the way a press
  // on a card is — the handles straddle the border, so their inner half
  // overlaps the card, and a click there that never moves must still open
  // the editor rather than do nothing. Once it does move, every frame writes
  // `left`/`top`/`width`/`height` on the one card being resized: unlike a
  // drag (which can ride on `transform`), a resize changes layout by
  // definition, and one card's layout is a cost worth paying for the card
  // showing its real content the whole way. The board is written once, on
  // pointerup.
  // -----------------------------------------------------------------------

  /** The handle a press landed on, or null if it landed anywhere else. */
  private resizeHandleFromEventTarget(
    target: EventTarget | null,
  ): ResizeHandle | null {
    if (!(target instanceof Element)) return null
    if (!target.classList.contains(RESIZER_CLASS)) return null
    const handle = (target as HTMLElement).dataset.resize
    return RESIZE_HANDLES.find((candidate) => candidate === handle) ?? null
  }

  /** False when there is nothing to resize (the hovered card went away
   * between hover and press), so the caller can fall through. */
  private startResize(handle: ResizeHandle, e: PointerEvent): boolean {
    const nodeId = this.layerNodeId
    const card = nodeId === null ? null : this.nodesById.get(nodeId)
    if (!card || nodeId === null) return false
    // Keeps the press from moving focus. Without it, grabbing a handle on the
    // card you are writing in blurs its editor, which commits and closes it —
    // adjusting a card's width should not cost you the caret you were at.
    e.preventDefault()
    this.interaction = {
      kind: 'resize',
      nodeId,
      handle,
      startClient: { x: e.clientX, y: e.clientY },
      startRect: rectOfCard(card),
      dragging: false,
    }
    this.viewportEl.setPointerCapture(e.pointerId)
    return true
  }

  private updateResize(interaction: ResizeInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      const dx = e.clientX - interaction.startClient.x
      const dy = e.clientY - interaction.startClient.y
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      interaction.dragging = true
      // Exempt from virtualization unmount for the gesture's duration, the
      // same way a dragged card is: a card being resized must not vanish
      // because a corner of it wandered out of the buffer band.
      this.pinnedIds.add(interaction.nodeId)
    }
    this.applyResizeRect(interaction, this.resizedRect(interaction, e))
  }

  private resizedRect(
    interaction: ResizeInteraction,
    e: PointerEvent,
  ): CardRect {
    return resizeRect(
      interaction.startRect,
      interaction.handle,
      (e.clientX - interaction.startClient.x) / this.view.scale,
      (e.clientY - interaction.startClient.y) / this.view.scale,
      MIN_CARD_SIZE,
    )
  }

  /** Live (uncommitted) geometry for the card, its handles and its edges. */
  private applyResizeRect(
    interaction: ResizeInteraction,
    rect: CardRect,
  ): void {
    const el = this.runtimeByNodeId.get(interaction.nodeId)?.el
    if (el) {
      el.style.left = `${rect.x}px`
      el.style.top = `${rect.y}px`
      el.style.width = `${rect.w}px`
      el.style.height = `${rect.h}px`
    }
    this.placeInteractionLayer(rect)
    this.redrawEdgesForNodes(
      new Set([interaction.nodeId]),
      new Map([[interaction.nodeId, rect]]),
    )
  }

  private finishResize(interaction: ResizeInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      // A click, not a drag: the handle overlaps the card, so this means
      // what the same click on the card means.
      this.setSelection([interaction.nodeId])
      return
    }

    this.pinnedIds.delete(interaction.nodeId)
    const rect = this.resizedRect(interaction, e)
    this.applyBoardChange(updateNode(this.board, interaction.nodeId, rect))
    this.applyResizeRect(interaction, rect)
    // The card's footprint changed, so its mount state may have too.
    this.recomputeVisibility()
  }

  // -----------------------------------------------------------------------
  // Connections (W3-D): drag a card's connection point to another card to
  // wire them up, or drag an existing edge's endpoint to re-wire it
  // (p1-design §3: "锚定边默认按两卡相对位置自动选，拖动连线端点可手动改").
  //
  // Both ends are written explicitly on an edge made this way. The format
  // allows omitting a side (= re-picked from relative position at render
  // time), but that is the right default for an edge nobody placed by hand —
  // one the user pulled out of a specific dot onto a specific side should
  // keep the shape they drew, not re-route itself the next time a card moves.
  //
  // The drop target is found geometrically (domain/edges.ts's
  // `findConnectTarget`), not by hit-testing the DOM: a target card may not
  // be mounted at all, and the snap band reaches past a card's border where
  // there is no element to hit.
  //
  // Dropping on open canvas creates a text card there and connects it —
  // Obsidian offers a menu at this point, but its three options are its three
  // node types; ours has one, and a menu with one item is a speed bump in
  // front of the gesture's whole purpose.
  // -----------------------------------------------------------------------

  /** The connection point a press landed on, or null for anything else. */
  private connectionSideFromEventTarget(
    target: EventTarget | null,
  ): NodeSide | null {
    if (!(target instanceof Element)) return null
    if (!target.classList.contains(CONNECTION_POINT_CLASS)) return null
    const side = (target as HTMLElement).dataset.side
    return NODE_SIDES.find((candidate) => candidate === side) ?? null
  }

  private edgeIdFromEventTarget(target: EventTarget | null): EdgeId | null {
    if (!(target instanceof Element)) return null
    if (!target.classList.contains(EDGE_HIT_CLASS)) return null
    return (target as SVGPathElement).dataset.edgeId ?? null
  }

  /** False when the card the layer was parked on is gone, so the caller can
   * fall through to the gesture the press would otherwise have been. */
  private startConnect(side: NodeSide, e: PointerEvent): boolean {
    const nodeId = this.layerNodeId
    if (nodeId === null || !this.nodesById.has(nodeId)) return false
    // Same reason as startResize: a press on the layer must not blur the
    // editor of the card it is parked on.
    e.preventDefault()
    // Pointer capture moves :hover off the dot for the rest of the drag, and
    // a connection visibly starting from nothing reads as a glitch.
    if (this.interactionLayerEl)
      this.interactionLayerEl.dataset.connecting = side
    this.beginConnect({ nodeId, side }, 'to', null, e)
    return true
  }

  /**
   * A press on an edge grabs whichever of its two ends is nearer — the same
   * press that, without movement, selects it. There is no separate endpoint
   * handle to aim at: the end you meant is the one you pressed next to.
   */
  private startEdgeReattach(edgeId: EdgeId, e: PointerEvent): boolean {
    const edge = this.boardEdgesById.get(edgeId)
    const from = edge && this.nodesById.get(edge.fromNode)
    const to = edge && this.nodesById.get(edge.toNode)
    if (!edge || !from || !to) return false
    const sides = resolveEdgeSides(from, to, edge.fromSide, edge.toSide)
    const world = this.worldPointFromEvent(e)
    const toFrom = distanceBetween(world, anchorPoint(from, sides.fromSide))
    const toTo = distanceBetween(world, anchorPoint(to, sides.toSide))
    const movingEnd = toFrom <= toTo ? 'from' : 'to'
    const anchor: SideAnchor =
      movingEnd === 'from'
        ? { nodeId: edge.toNode, side: sides.toSide }
        : { nodeId: edge.fromNode, side: sides.fromSide }
    this.beginConnect(anchor, movingEnd, edgeId, e)
    return true
  }

  private beginConnect(
    anchor: SideAnchor,
    movingEnd: 'from' | 'to',
    edgeId: EdgeId | null,
    e: PointerEvent,
  ): void {
    this.interaction = {
      kind: 'connect',
      anchor,
      movingEnd,
      edgeId,
      startClient: { x: e.clientX, y: e.clientY },
      candidates: this.board.nodes.filter((node) => node.id !== anchor.nodeId),
      dragging: false,
      target: null,
    }
    this.viewportEl.setPointerCapture(e.pointerId)
  }

  private updateConnect(
    interaction: ConnectInteraction,
    e: PointerEvent,
  ): void {
    if (!interaction.dragging) {
      const dx = e.clientX - interaction.startClient.x
      const dy = e.clientY - interaction.startClient.y
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      interaction.dragging = true
      // The edge being re-attached is replaced by the preview for the
      // duration, so its old shape doesn't hang there contradicting it.
      if (interaction.edgeId !== null) {
        this.setEdgeHidden(interaction.edgeId, true)
      }
    }
    const world = this.worldPointFromEvent(e)
    interaction.target = findConnectTarget(
      world,
      interaction.candidates,
      CONNECT_SNAP_WORLD_PX,
    )
    this.setConnectTarget(interaction.target?.nodeId ?? null)
    this.drawConnectPreview(interaction, world)
  }

  /** The in-flight curve: from the pinned end to the snapped target, or to a
   * zero-size rect at the pointer when there is nothing to snap to (whose
   * anchor point is the pointer itself, whatever side it is asked for). */
  private drawConnectPreview(
    interaction: ConnectInteraction,
    world: ScreenPoint,
  ): void {
    const preview = this.previewPathEl
    const anchorCard = this.nodesById.get(interaction.anchor.nodeId)
    if (!preview || !anchorCard) return
    const target = interaction.target
    const targetCard = target ? this.nodesById.get(target.nodeId) : null
    const free: VirtualCardRect =
      target && targetCard
        ? targetCard
        : { id: '', x: world.x, y: world.y, w: 0, h: 0 }
    const freeSide =
      target && targetCard ? target.side : oppositeSide(interaction.anchor.side)
    const geometry =
      interaction.movingEnd === 'to'
        ? computeEdgeGeometry(
            anchorCard,
            free,
            interaction.anchor.side,
            freeSide,
          )
        : computeEdgeGeometry(
            free,
            anchorCard,
            freeSide,
            interaction.anchor.side,
          )
    preview.setAttribute('d', buildEdgePathD(geometry))
    preview.classList.remove(EDGE_HIDDEN_CLASS)
  }

  private setConnectTarget(nodeId: NodeId | null): void {
    if (nodeId === this.connectTargetNodeId) return
    const previous = this.connectTargetNodeId
    if (previous !== null) {
      this.runtimeByNodeId
        .get(previous)
        ?.el?.classList.remove(CARD_CONNECT_TARGET_CLASS)
    }
    this.connectTargetNodeId = nodeId
    if (nodeId !== null) {
      this.runtimeByNodeId
        .get(nodeId)
        ?.el?.classList.add(CARD_CONNECT_TARGET_CLASS)
    }
  }

  private finishConnect(
    interaction: ConnectInteraction,
    e: PointerEvent,
  ): void {
    this.setConnectTarget(null)
    this.previewPathEl?.classList.add(EDGE_HIDDEN_CLASS)
    if (this.interactionLayerEl) {
      delete this.interactionLayerEl.dataset.connecting
    }
    if (interaction.edgeId !== null) {
      this.setEdgeHidden(interaction.edgeId, false)
    }

    if (!interaction.dragging) {
      // A press that never moved: on an edge that means selecting it, and on
      // a connection point it means nothing at all.
      if (interaction.edgeId !== null) {
        this.setEdgeSelection([interaction.edgeId])
      }
      return
    }

    const created =
      interaction.target === null
        ? this.createNodeForConnection(interaction, this.worldPointFromEvent(e))
        : null
    const target = interaction.target ?? created
    if (!target) return

    // One history step for the whole gesture: `createNodeForConnection` has
    // already put its card on `this.board` without committing, so the card
    // and the edge that justified it are undone together.
    this.applyBoardChange(
      interaction.edgeId === null
        ? addEdge(this.board, this.connectedEdge(interaction, target))
        : updateEdge(
            this.board,
            interaction.edgeId,
            interaction.movingEnd === 'from'
              ? { fromNode: target.nodeId, fromSide: target.side }
              : { toNode: target.nodeId, toSide: target.side },
          ),
    )
    this.rebuildEdgesSvg()

    if (created) {
      this.recomputeVisibility()
      this.drainQueues()
      this.enterEditMode(created.nodeId)
    }
  }

  private connectedEdge(
    interaction: ConnectInteraction,
    target: SideAnchor,
  ): Edge {
    const { anchor, movingEnd } = interaction
    const from = movingEnd === 'to' ? anchor : target
    const to = movingEnd === 'to' ? target : anchor
    return {
      id: this.nextEdgeId(),
      fromNode: from.nodeId,
      toNode: to.nodeId,
      fromSide: from.side,
      toSide: to.side,
      // JSON Canvas's defaults: the arrow is at the end you pulled towards.
      fromEnd: 'none',
      toEnd: 'arrow',
      extra: {},
    }
  }

  /** The card a connection dropped on open canvas lands on, placed so the
   * incoming edge meets its facing side. Added to the board here; the edge
   * to it, and the editor on it, follow in `finishConnect`. */
  private createNodeForConnection(
    interaction: ConnectInteraction,
    drop: ScreenPoint,
  ): SideAnchor | null {
    if (this.parseFailed) return null
    const side = oppositeSide(interaction.anchor.side)
    const rect = rectAnchoredAt(drop, side, NEW_CARD_SIZE)
    const node: TextNode = {
      id: this.nextNodeId(),
      type: 'text',
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: rect.w,
      h: rect.h,
      text: '',
      extra: {},
    }
    this.board = addNode(this.board, node)
    return { nodeId: node.id, side }
  }

  private updateNodeInteraction(
    interaction: NodeInteraction,
    e: PointerEvent,
  ): void {
    if (!interaction.dragging) {
      const dx = e.clientX - interaction.startClient.x
      const dy = e.clientY - interaction.startClient.y
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      this.beginNodeDrag(interaction)
    }
    this.updateNodeDragPositions(interaction, e)
  }

  private beginNodeDrag(interaction: NodeInteraction): void {
    interaction.dragging = true
    if (!this.selectedIds.has(interaction.nodeId)) {
      this.setSelection([interaction.nodeId])
    }
    interaction.ids = Array.from(this.selectedIds)
    for (const id of interaction.ids) {
      const card = this.nodesById.get(id)
      if (!card) continue
      interaction.startPositions.set(id, { x: card.x, y: card.y })
      // Exempt every dragged card from virtualization unmount for the
      // duration of the drag (mirrors the existing editing-card pin).
      this.pinnedIds.add(id)
      this.runtimeByNodeId.get(id)?.el?.classList.add(CARD_DRAGGING_CLASS)
    }
  }

  private worldDelta(
    interaction: NodeInteraction,
    e: PointerEvent,
  ): Readonly<{ dx: number; dy: number }> {
    return {
      dx: (e.clientX - interaction.startClient.x) / this.view.scale,
      dy: (e.clientY - interaction.startClient.y) / this.view.scale,
    }
  }

  private updateNodeDragPositions(
    interaction: NodeInteraction,
    e: PointerEvent,
  ): void {
    const { dx, dy } = this.worldDelta(interaction, e)
    const overrides = new Map<NodeId, CardRect>()
    for (const id of interaction.ids) {
      const start = interaction.startPositions.get(id)
      const card = this.nodesById.get(id)
      if (!start || !card) continue
      overrides.set(id, {
        x: start.x + dx,
        y: start.y + dy,
        w: card.w,
        h: card.h,
      })
      const el = this.runtimeByNodeId.get(id)?.el
      if (el) el.style.transform = `translate(${dx}px, ${dy}px)`
    }
    this.redrawEdgesForNodes(new Set(interaction.ids), overrides)
    // The handle layer sits in the same world space as the cards but is not
    // one of them, so a drag has to carry it along explicitly.
    const dragged = overrides.get(this.layerNodeId ?? '')
    if (dragged) this.placeInteractionLayer(dragged)
  }

  private finishNodeInteraction(
    interaction: NodeInteraction,
    e: PointerEvent,
  ): void {
    if (!interaction.dragging) {
      this.setSelection([interaction.nodeId])
      return
    }

    const { dx, dy } = this.worldDelta(interaction, e)
    if (dx !== 0 || dy !== 0) {
      this.applyBoardChange(moveNodes(this.board, interaction.ids, dx, dy))
    }
    for (const id of interaction.ids) {
      this.pinnedIds.delete(id)
      const el = this.runtimeByNodeId.get(id)?.el
      if (!el) continue
      el.classList.remove(CARD_DRAGGING_CLASS)
      // A literal-string style assignment is disallowed (obsidianmd/
      // no-static-styles-assignment) even for a reset; setCssProps is the
      // sanctioned escape hatch (Obsidian and Style Constraints, CLAUDE.md).
      el.setCssProps({ transform: '' })
      const card = this.nodesById.get(id)
      if (card) {
        el.style.left = `${card.x}px`
        el.style.top = `${card.y}px`
      }
    }
    this.redrawEdgesForNodes(new Set(interaction.ids))
    this.refreshInteractionLayer()
    // Dragged cards may have moved on/off screen — re-evaluate mount state
    // immediately rather than waiting for the next throttled recompute
    // (mirrors onResize()'s direct call).
    this.recomputeVisibility()
    this.drainQueues()
  }

  // -----------------------------------------------------------------------
  // Board mutation and history (W3-E).
  //
  // Every content change goes through `applyBoardChange`: it is what keeps
  // "changed the board", "recorded a step", and "asked the host to save" from
  // ever drifting apart. Two things deliberately do not go through it — the
  // camera (a viewpoint, not content: an undo that moves the viewport is the
  // least welcome kind) and note-card self-heal (the view repairing a stale
  // reference, not something the user did).
  // -----------------------------------------------------------------------

  private applyBoardChange(next: Board, historyKey?: string): void {
    if (next === this.board) return
    this.board = next
    this.syncBoardIndex()
    this.history.push(next, historyKey)
    this.context.requestSave()
  }

  private undo(): void {
    this.applyHistoryBoard(this.history.undo())
  }

  private redo(): void {
    this.applyHistoryBoard(this.history.redo())
  }

  /**
   * Puts a snapshot back on screen.
   *
   * Structural sharing does the diffing for us: a card the undone change
   * never touched is the very same object, so it keeps the DOM and the
   * rendered Markdown it already has, and only what actually differs is
   * dropped and re-mounted by the normal virtualization path. Undoing one
   * card's move on a 300-card board therefore re-renders one card.
   */
  private applyHistoryBoard(next: Board | null): void {
    if (!next || this.parseFailed) return
    const previous = this.nodesById
    // The snapshot's camera is discarded: see this section's doc comment.
    this.board = { ...next, camera: cameraFromView(this.view) }
    this.syncBoardIndex()
    for (const [id, card] of previous) {
      if (this.nodesById.get(id) !== card) this.purgeNodeRuntime(id)
    }
    this.clearSelection()
    this.rebuildEdgesSvg()
    this.refreshInteractionLayer()
    this.recomputeVisibility()
    this.drainQueues()
    this.context.requestSave()
  }

  /** Undo/redo live on the view's own keymap, so they are armed exactly
   * while this board is the leaf being looked at. While a card's editor has
   * the caret, they belong to that editor — CodeMirror has its own history,
   * and the text being typed is not a board change yet. */
  private registerViewKeymap(): void {
    const run = (action: () => void) => () => {
      if (this.editing) return false
      action()
      return true
    }
    const undo = run(() => this.undo())
    const redo = run(() => this.redo())
    this.viewKeymapDisposer = this.context.registerKeymap([
      { modifiers: ['Mod'], key: 'Z', handler: undo },
      { modifiers: ['Mod', 'Shift'], key: 'Z', handler: redo },
      // Windows' second redo binding, which Obsidian Canvas also carries.
      { modifiers: ['Mod'], key: 'Y', handler: redo },
    ])
  }

  // -----------------------------------------------------------------------
  // Selection (W3-A). `selectedIds` is UI state only — never touches
  // `board` or triggers requestSave by itself. Pushes/pops a keymap scope
  // exactly when the selection transitions to/from empty, so
  // Delete/Backspace/Escape are only ever intercepted while there's
  // something to act on (and, by construction, never while a card is being
  // edited — see the class-field doc comment on `selectedIds`).
  // -----------------------------------------------------------------------

  private setSelection(ids: readonly NodeId[]): void {
    if (ids.length > 0) this.setEdgeSelection([])
    const next = new Set(ids)
    for (const id of this.selectedIds) {
      if (!next.has(id))
        this.runtimeByNodeId.get(id)?.el?.classList.remove(CARD_SELECTED_CLASS)
    }
    for (const id of next) {
      if (!this.selectedIds.has(id))
        this.runtimeByNodeId.get(id)?.el?.classList.add(CARD_SELECTED_CLASS)
    }
    this.selectedIds = next
    this.syncSelectionKeymapScope()
    // Selection is one of the two things that decides where the handles are.
    this.updateInteractionLayer()
  }

  private setEdgeSelection(ids: readonly EdgeId[]): void {
    if (ids.length > 0) this.setSelection([])
    const next = new Set(ids)
    for (const id of this.selectedEdgeIds) {
      if (!next.has(id)) this.markEdgeSelected(id, false)
    }
    for (const id of next) {
      if (!this.selectedEdgeIds.has(id)) this.markEdgeSelected(id, true)
    }
    this.selectedEdgeIds = next
    this.syncSelectionKeymapScope()
  }

  private markEdgeSelected(id: EdgeId, selected: boolean): void {
    this.edgeElsById
      .get(id)
      ?.path.classList.toggle(EDGE_SELECTED_CLASS, selected)
  }

  /** Clears both kinds of selection — what a click on empty canvas, or
   * entering a card's editor, means. */
  private clearSelection(): void {
    if (this.selectedIds.size > 0) this.setSelection([])
    if (this.selectedEdgeIds.size > 0) this.setEdgeSelection([])
  }

  /** One scope for both kinds of selection, pushed while either is non-empty
   * and popped when both are. */
  private syncSelectionKeymapScope(): void {
    const hasSelection =
      this.selectedIds.size > 0 || this.selectedEdgeIds.size > 0
    if (hasSelection && !this.selectionScopeDisposer) {
      this.pushSelectionKeymapScope()
    } else if (!hasSelection && this.selectionScopeDisposer) {
      this.popSelectionKeymapScope()
    }
  }

  private pushSelectionKeymapScope(): void {
    this.selectionScopeDisposer = this.context.registerKeymap([
      {
        modifiers: [],
        key: 'Backspace',
        handler: () => {
          this.deleteSelection()
          return true
        },
      },
      {
        modifiers: [],
        key: 'Delete',
        handler: () => {
          this.deleteSelection()
          return true
        },
      },
      {
        modifiers: [],
        key: 'Enter',
        handler: () => {
          if (this.selectedIds.size !== 1) return false
          const id = this.selectedIds.values().next().value
          return id !== undefined && this.editCard(id)
        },
      },
      {
        modifiers: [],
        key: 'Escape',
        handler: () => {
          this.clearSelection()
          return true
        },
      },
    ])
  }

  private popSelectionKeymapScope(): void {
    this.selectionScopeDisposer?.()
    this.selectionScopeDisposer = null
  }

  /** Only one of the two selections is ever non-empty (see `selectedEdgeIds`). */
  private deleteSelection(): void {
    if (this.selectedEdgeIds.size > 0) {
      this.deleteEdges(Array.from(this.selectedEdgeIds))
      return
    }
    if (this.selectedIds.size === 0) return
    this.deleteNodes(Array.from(this.selectedIds))
  }

  private deleteEdges(ids: readonly EdgeId[]): void {
    if (this.parseFailed || ids.length === 0) return
    let board = this.board
    for (const id of ids) {
      if (board.edges.some((edge) => edge.id === id))
        board = removeEdge(board, id)
    }
    this.applyBoardChange(board)
    this.setEdgeSelection([])
    this.rebuildEdgesSvg()
  }

  private deleteNodes(ids: readonly NodeId[]): void {
    if (this.parseFailed || ids.length === 0) return
    if (this.editing && ids.includes(this.editing.nodeId)) {
      // Commit through the one blur path before the card stops existing,
      // rather than leaving an editor mounted on a deleted card.
      this.editing.editor.blur()
    }
    let board = this.board
    for (const id of ids) {
      if (board.nodes.some((node) => node.id === id))
        board = removeNode(board, id)
    }
    this.applyBoardChange(board)
    for (const id of ids) this.purgeNodeRuntime(id)
    this.clearSelection()
    this.refreshInteractionLayer()
    // Deleting cards cascades edge removal (operations.ts's removeCard) —
    // the edge *set* changed, not just endpoint positions, so a full
    // rebuild (rather than redrawEdgesForNodes) is the correct response.
    this.rebuildEdgesSvg()
  }

  // -----------------------------------------------------------------------
  // Card creation and conversion.
  //
  // Double-click and the canvas context menu both create a *text* card: it
  // is pure board data, so the cheapest gesture on the canvas carries no
  // side effect outside the file. "Card as note" (p1-design §1.2) is
  // reached deliberately, through `convertCardToNote` — the user decides
  // when a card earns a file, rather than every stray double-click leaving
  // an empty note in the vault.

  /** Creates an empty text card centered on `world` and opens it for typing. */
  private createTextCardAt(world: ScreenPoint): void {
    if (this.parseFailed) return
    // Below the LOD threshold enterEditMode declines, which would leave this
    // gesture producing an invisible empty card with no editor.
    if (this.degraded) return
    const node: TextNode = {
      id: this.nextNodeId(),
      type: 'text',
      x: Math.round(world.x - NEW_CARD_SIZE.w / 2),
      y: Math.round(world.y - NEW_CARD_SIZE.h / 2),
      w: NEW_CARD_SIZE.w,
      h: NEW_CARD_SIZE.h,
      text: '',
      extra: {},
    }
    this.applyBoardChange(addNode(this.board, node))
    this.clearSelection()
    // The card has to exist in the DOM before an editor can be mounted into
    // it, and mounting is normally driven by the rAF loop. Draining now
    // makes the new card available in this same turn; it is inside the
    // viewport by construction, so it is always in the mount queue.
    this.recomputeVisibility()
    this.drainQueues()
    this.context.requestSave()
    this.enterEditMode(node.id)
  }

  /** Adds one note card per vault path, staggered from `world`. */
  private addNoteCards(paths: readonly string[], world: ScreenPoint): void {
    if (this.parseFailed || paths.length === 0) return
    let board = this.board
    for (const [index, path] of paths.entries()) {
      const offset = index * DROP_STAGGER_PX
      board = addNode(board, {
        id: this.nextNodeId(),
        type: 'file',
        x: Math.round(world.x - NEW_CARD_SIZE.w / 2 + offset),
        y: Math.round(world.y - NEW_CARD_SIZE.h / 2 + offset),
        w: NEW_CARD_SIZE.w,
        h: NEW_CARD_SIZE.h,
        file: path,
        extra: {},
      })
    }
    this.applyBoardChange(board)
    this.recomputeVisibility()
    this.drainQueues()
  }

  /**
   * Turns a text card into a note card backed by a real vault file.
   *
   * The card keeps its id, position, and edges (`replaceCard`); only its
   * identity changes. Its markdown is written as `cardNoteContent` splits
   * it: the leading heading that named the file does not also stay in the
   * body, because from here on the card shows that name as its title.
   */
  private convertCardToNote(id: NodeId): void {
    if (this.parseFailed) return
    const card = this.nodesById.get(id)
    if (!card || card.type !== 'text') return
    if (this.editing?.nodeId === id) {
      // Commit the live text first so the note is written from what the user
      // currently sees, not from the last committed snapshot.
      this.editing.editor.blur()
    }
    const current = this.nodesById.get(id)
    if (!current || current.type !== 'text') return
    void this.writeCardNote(current)
  }

  private async writeCardNote(node: TextNode): Promise<void> {
    const { baseName, body } = cardNoteContent(
      node.text,
      this.t('file.newNoteBaseName'),
    )
    try {
      // No ensureFolder: the board's own folder exists by definition.
      const folderPath = this.boardFolderPath()
      const existingNames = new Set(
        this.host.vault
          .listChildren(folderPath)
          .filter((entry) => entry.kind === 'file')
          .map((entry) => entry.name),
      )
      const fileName = generateCardNoteFileName(baseName, existingNames)
      const path = folderPath ? `${folderPath}/${fileName}` : fileName
      await this.host.vault.createText(path, body)

      // The board may have moved on while the file was being written.
      const latest = this.nodesById.get(node.id)
      if (!latest || latest.type !== 'text') return
      const note: FileNode = {
        id: latest.id,
        type: 'file',
        x: latest.x,
        y: latest.y,
        w: latest.w,
        h: latest.h,
        file: path,
        extra: latest.extra,
      }
      this.applyBoardChange(replaceNode(this.board, latest.id, note))
      // The card's content now comes from a file rather than from the board,
      // so its mounted preview has to be rebuilt against the new source.
      this.purgeNodeRuntime(latest.id)
      this.recomputeVisibility()
      this.drainQueues()
      this.context.requestSave()
      this.host.ui.notice(
        this.t('notice.convertedToNote').replace('{path}', path),
      )
    } catch (error) {
      this.reportError('convert card to note', error)
      this.host.ui.notice(this.t('error.convertFailed'))
    }
  }

  /**
   * The board's own folder — where a converted card's note is written.
   *
   * Deliberately not a `<board name> Cards/` subfolder (p1-design §1.2's
   * original rule): a folder named after the board has to be renamed and
   * moved whenever the board is, and until it is, one board's cards sit in
   * two different folders. Writing beside the board needs no such rule and
   * cannot drift. A board at the vault root returns '', which every vault
   * call here already treats as the root.
   */
  private boardFolderPath(): string {
    const boardPath = this.sourcePathForBoard()
    const lastSlash = boardPath.lastIndexOf('/')
    return lastSlash === -1 ? '' : boardPath.slice(0, lastSlash)
  }

  private nextNodeId(): NodeId {
    const uuid = this.context.getWindow().crypto.randomUUID()
    return `c-${uuid}`
  }

  private nextEdgeId(): EdgeId {
    const uuid = this.context.getWindow().crypto.randomUUID()
    return `e-${uuid}`
  }

  private nextEditSessionId(): number {
    this.editSessionCounter += 1
    return this.editSessionCounter
  }

  private worldPointFromEvent(e: MouseEvent): ScreenPoint {
    return screenToWorld(this.view, this.viewportPointFromEvent(e))
  }

  /** Matched on the data attribute rather than on a class, because both
   * kinds of mounted node carry it (a card and a group frame) and every
   * gesture that asks "which node is this" means either. */
  private nodeIdFromEventTarget(target: EventTarget | null): NodeId | null {
    if (!(target instanceof Element)) return null
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Element.closest()'s generic return type defaults to `Element` here (no type argument to infer it from); the assertion is required for `.dataset` below to type-check under tsc even though this lint rule's own type resolution disagrees.
    const nodeEl = target.closest('[data-node-id]') as HTMLElement | null
    return nodeEl?.dataset.nodeId ?? null
  }

  /** Fully removes a card no longer present in `board` (as opposed to
   * `unmountNode`, which keeps its runtime entry around — minus the DOM —
   * for a card that's merely scrolled off-screen but still valid). Keeps
   * the virtualization engine's bookkeeping in sync via `markUnmounted`
   * since a removed card is absent from the `cards` array `recompute()`
   * iterates, so it would otherwise never be queued for unmount on its
   * own. */
  private purgeNodeRuntime(id: NodeId): void {
    const runtime = this.runtimeByNodeId.get(id)
    if (runtime) {
      this.destroyContentView(runtime)
      runtime.el?.remove()
    }
    this.runtimeByNodeId.delete(id)
    this.pinnedIds.delete(id)
    this.contentSyncQueue.delete(id)
    this.engine.markUnmounted(id)
  }

  // -----------------------------------------------------------------------
  // Virtualization loop
  // -----------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    this.advanceZoomGlide(now)
    if (now - this.lastRecomputeTime > RECOMPUTE_INTERVAL_MS) {
      this.recomputeVisibility()
      this.lastRecomputeTime = now
    }
    this.drainQueues()
    this.rafId = this.context.getWindow().requestAnimationFrame(this.frame)
  }

  private recomputeVisibility(): void {
    if (this.parseFailed || !this.viewportEl) return
    const rect = computeWorldViewportRect(
      this.viewportEl.clientWidth,
      this.viewportEl.clientHeight,
      this.view,
      VIEWPORT_BUFFER_PX,
    )
    this.engine.recompute(this.board.nodes, rect, this.pinnedIds)
    this.updateDegradedState()
  }

  /**
   * Flips the zoom-degrade state at this method's ~70ms throttle
   * (recomputeVisibility's caller), not per frame — p1-design §3's
   * "阈值切换时机放在相机 settle 或节流点，不逐帧判断切换". This throttle
   * point (rather than only the longer 300ms camera-settle debounce) keeps
   * a deliberate zoom-out gesture feeling responsive.
   *
   * Crossing the threshold now costs real work in both directions (D8: below
   * it a card's content is not constructed at all, above it every card that
   * came up bare has to build its own), so every mounted card is queued and
   * `drainQueues` pays for a few of them per frame rather than the whole
   * screenful at the moment of crossing. The card being edited is left out:
   * its body holds a live editor with unwritten text, which is not something
   * a zoom level gets to tear down.
   */
  private updateDegradedState(): void {
    const next = nextDegradedState(this.view.scale, this.degraded, {
      enter: DEGRADE_SCALE_THRESHOLD,
      restore: DEGRADE_RESTORE_SCALE,
    })
    if (next === this.degraded) return
    this.degraded = next
    this.worldEl.classList.toggle(WORLD_DEGRADED_CLASS, next)
    // Whatever was queued was work in the other direction, and is now moot.
    this.contentSyncQueue.clear()
    for (const [id, runtime] of this.runtimeByNodeId) {
      if (!runtime.el || this.editing?.nodeId === id) continue
      this.contentSyncQueue.add(id)
    }
  }

  private drainQueues(): void {
    const { toMount, toUnmount } = this.engine.drain(
      MOUNT_QUOTA_PER_FRAME,
      UNMOUNT_QUOTA_PER_FRAME,
    )
    for (const id of toMount) this.mountNode(id)
    for (const id of toUnmount) this.unmountNode(id)
    // Same frame budget as the mount/unmount queues above, and the same
    // asymmetry: building content is the expensive direction and shares the
    // mount quota with the cards that just mounted (so a frame never starts
    // more than MOUNT_QUOTA_PER_FRAME renders however the work is split),
    // while tearing it down is cheap DOM removal.
    this.drainContentSync(
      this.degraded
        ? UNMOUNT_QUOTA_PER_FRAME
        : MOUNT_QUOTA_PER_FRAME - toMount.length,
    )
  }

  /** Brings up to `budget` mounted cards' content into line with the current
   * degrade state. A Set iterates in insertion order and tolerates deletion
   * mid-iteration, so it serves as both the queue and the membership test. */
  private drainContentSync(budget: number): void {
    if (budget <= 0) return
    let done = 0
    for (const id of this.contentSyncQueue) {
      if (done >= budget) return
      this.contentSyncQueue.delete(id)
      done += 1
      this.syncNodeContent(id)
    }
  }

  private syncNodeContent(id: NodeId): void {
    const runtime = this.runtimeByNodeId.get(id)
    if (!runtime?.el || !runtime.bodyEl) return
    // Entered edit mode after being queued: the editor owns the body now.
    if (this.editing?.nodeId === id) return
    if (!this.degraded) {
      void this.renderCardPreview(id)
      return
    }
    // Destroyed, not parked — the same rule an off-screen card follows
    // (p3-canvas-parity D13); the card's title block is what stands in for it.
    this.destroyContentView(runtime)
    runtime.bodyEl.replaceChildren()
  }

  // -----------------------------------------------------------------------
  // Card mount/unmount
  // -----------------------------------------------------------------------

  private mountNode(id: NodeId): void {
    const node = this.nodesById.get(id)
    const existing = this.runtimeByNodeId.get(id)
    if (!node || existing?.el) return

    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = node.type === 'group' ? GROUP_CLASS : CARD_CLASS
    el.style.left = `${node.x}px`
    el.style.top = `${node.y}px`
    el.style.width = `${node.w}px`
    el.style.height = `${node.h}px`
    el.dataset.nodeId = id
    // Re-apply selection state — a selected node can unmount (scrolled
    // off-screen) and remount without its selection ever changing.
    if (this.selectedIds.has(id)) el.classList.add(CARD_SELECTED_CLASS)

    // A group is a labelled frame behind the cards, not a card: it has no
    // body, no content view and no degraded form (p3-canvas-parity D5, and
    // batch 3 for the membership interactions). Everything else a node gets
    // here — selection, dragging, resizing, edges — it gets for free, because
    // it goes through the same runtime as a card.
    if (node.type === 'group') {
      const label = doc.createElement('div')
      label.className = GROUP_LABEL_CLASS
      label.textContent = node.label ?? ''
      el.appendChild(label)
      this.worldEl.appendChild(el)
      this.runtimeByNodeId.set(id, {
        el,
        bodyEl: null,
        contentView: null,
        contentSourcePath: null,
        missingFile: false,
        noteText: null,
      })
      return
    }

    // A file-backed card carries its title in its file name, not in its
    // text: Obsidian's convention is that a note's name *is* its title, so a
    // note dragged onto the board would otherwise arrive as a body with
    // nothing naming it. Drawn as card chrome and never written into the
    // file — the card is a live reference to someone's note, and a board
    // that displays a note must not rewrite it to do so.
    //
    // It stays through edit mode, which is where this parts ways with
    // Obsidian Canvas: Canvas's in-card title is the embed's own inline
    // title, so it disappears the moment the embed is swapped for an editor
    // (measured), and Canvas covers that with a second label outside the
    // card. One title that never moves beats two that take turns.
    if (node.type === 'file') {
      const title = doc.createElement('div')
      title.className = CARD_TITLE_CLASS
      title.textContent = basenameWithoutExtension(node.file)
      el.appendChild(title)
    }

    const body = doc.createElement('div')
    body.className = CARD_BODY_CLASS
    el.appendChild(body)

    // Degraded (low-zoom) title block: always built — it is a line of text,
    // and it is what the card *is* below the threshold, where its body holds
    // nothing (renderCardPreview's degrade gate). Swapped for the body by the
    // world element's WORLD_DEGRADED_CLASS — see style.css. Computed once from
    // card data at mount time; card title-affecting fields (file/markdown)
    // never change post-mount in M1, only position does.
    const degradedTitle = doc.createElement('div')
    degradedTitle.className = CARD_DEGRADED_TITLE_CLASS
    degradedTitle.textContent = degradedNodeTitle(node)
    el.appendChild(degradedTitle)

    // Click-to-edit vs. drag-to-move is disambiguated centrally in
    // onPointerDown/Move/Up (DRAG_THRESHOLD_PX) rather than a per-card
    // `click` listener, so the same gesture can also drive dragging.

    this.worldEl.appendChild(el)
    this.runtimeByNodeId.set(id, {
      el,
      bodyEl: body,
      contentView: null,
      contentSourcePath: null,
      missingFile: false,
      noteText: existing?.noteText ?? null,
    })

    void this.renderCardPreview(id)
  }

  private unmountNode(id: NodeId): void {
    const runtime = this.runtimeByNodeId.get(id)
    if (!runtime?.el) return
    // A pinned (editing) card is never queued for unmount by the
    // virtualization engine, but stay defensive: only the commit path
    // (finishEdit) ever destroys a live editor.
    if (this.editing?.nodeId === id) return
    // Destroy rather than park (p3-canvas-parity D13): an off-screen card
    // keeps nothing but its cached text, and a detach pool would have to
    // manage capacity, invalidation and content sync to earn its keep.
    this.destroyContentView(runtime)
    this.contentSyncQueue.delete(id)
    runtime.el.remove()
    runtime.el = null
    runtime.bodyEl = null
  }

  private destroyContentView(runtime: NodeRuntime): void {
    runtime.contentView?.destroy()
    runtime.contentView = null
    runtime.contentSourcePath = null
  }

  /**
   * Builds whatever a card shows below its title — rendered markdown, or a
   * placeholder for the cases that have no markdown to show.
   *
   * The single gate for all of it, which is why the degrade check lives here
   * rather than at the call sites: below the threshold nothing is built at all
   * (p3-canvas-parity D8), and that has to include the note card's `readText`
   * — at the zoom where the most cards are on screen, a file read each is the
   * larger half of the cost. `updateDegradedState` queues every mounted card
   * when the camera comes back up, so a card skipped here is not forgotten.
   */
  private async renderCardPreview(id: NodeId): Promise<void> {
    const node = this.nodesById.get(id)
    const runtime = this.runtimeByNodeId.get(id)
    // A group has no body: it is a frame, drawn once at mount.
    if (!node || node.type === 'group' || !runtime?.bodyEl) return
    if (this.degraded) return

    if (node.type === 'file') {
      // A JSON Canvas file node can point at anything in the vault. Only
      // markdown has text a card can show; the rest get a placeholder until
      // media cards (P3 batch 2) and the PDF card (M2) land.
      if (!isMarkdownPath(node.file)) {
        this.renderUnsupportedFilePlaceholder(runtime, node.file)
        return
      }
      const entry = this.host.vault.getEntry(node.file)
      if (!entry || entry.kind !== 'file') {
        runtime.missingFile = true
        runtime.noteText = null
        this.renderMissingFilePlaceholder(runtime, node.file)
        return
      }
      let text: string
      try {
        text = await this.host.vault.readText(node.file)
      } catch (error) {
        this.reportError('readText', error)
        if (this.runtimeByNodeId.get(id) === runtime) {
          runtime.missingFile = true
          this.renderMissingFilePlaceholder(runtime, node.file)
        }
        return
      }
      if (this.runtimeByNodeId.get(id) !== runtime) return // unmounted meanwhile
      runtime.missingFile = false
      runtime.noteText = text
      this.renderMarkdownInto(id, runtime, text, node.file)
      return
    }

    // text node: markdown lives directly in the board.
    this.renderMarkdownInto(id, runtime, node.text, this.sourcePathForBoard())
  }

  /**
   * Puts markdown on a card through the one content path both card types
   * share (p3-canvas-parity D2/D11): the host's windowed preview, which
   * mounts only the sections near its own scroll position, so a card holding
   * a long note costs a screenful rather than the whole document.
   *
   * Synchronous by design — the view renders on its own schedule once it is
   * in the document, and there is nothing here to wait for.
   */
  private renderMarkdownInto(
    id: NodeId,
    runtime: NodeRuntime,
    markdown: string,
    sourcePath: string,
  ): void {
    const bodyEl = runtime.bodyEl
    // The card may have been unmounted or swapped into edit mode while the
    // text that got here was being read.
    if (!bodyEl || this.editing?.nodeId === id) {
      this.destroyContentView(runtime)
      return
    }
    // New text in the same document is a `setValue`; a different document
    // needs a new view, because links resolve against what the view was
    // built for.
    if (runtime.contentView && runtime.contentSourcePath === sourcePath) {
      runtime.contentView.setValue(markdown)
      return
    }
    this.destroyContentView(runtime)
    bodyEl.replaceChildren()
    try {
      runtime.contentView = this.host.ui.createMarkdownContentView({
        container: bodyEl,
        value: markdown,
        sourcePath,
      })
      runtime.contentSourcePath = sourcePath
    } catch (error) {
      this.reportError('markdown render', error)
    }
  }

  private renderMissingFilePlaceholder(
    runtime: NodeRuntime,
    path: string,
  ): void {
    this.destroyContentView(runtime)
    if (!runtime.bodyEl) return
    const doc = this.context.getDocument()
    const placeholder = doc.createElement('div')
    placeholder.className = CARD_MISSING_CLASS
    const title = doc.createElement('div')
    title.textContent = this.t('card.missingFile')
    const hint = doc.createElement('div')
    hint.className = CARD_HINT_CLASS
    hint.textContent = this.t('card.missingFileHint').replace('{path}', path)
    placeholder.append(title, hint)
    runtime.bodyEl.replaceChildren(placeholder)
  }

  /** What a file card shows while its file type has no card of its own — a
   * PDF (M2), an image or a video (P3 batch 2), anything else. Named after
   * the file so the card still says which one it is. */
  private renderUnsupportedFilePlaceholder(
    runtime: NodeRuntime,
    path: string,
  ): void {
    this.destroyContentView(runtime)
    if (!runtime.bodyEl) return
    const doc = this.context.getDocument()
    const placeholder = doc.createElement('div')
    placeholder.className = CARD_UNSUPPORTED_PLACEHOLDER_CLASS
    const title = doc.createElement('div')
    title.textContent = this.t('card.unsupportedFile')
    const hint = doc.createElement('div')
    hint.className = CARD_HINT_CLASS
    hint.textContent = this.t('card.unsupportedFileHint').replace(
      '{path}',
      path,
    )
    placeholder.append(title, hint)
    runtime.bodyEl.replaceChildren(placeholder)
  }

  // -----------------------------------------------------------------------
  // Edges: a single SVG overlay in the world layer draws every edge
  // (p1-design §3: "世界层内单个 SVG overlay 画全部 edges...只在 edges 或
  // 端点卡片位移时重绘（不进逐帧路径）"). Two redraw paths:
  //   - `rebuildEdgesSvg` — full rebuild, for a structural change (a new
  //     file loaded, an edge drawn or deleted, or a card delete cascading
  //     edge removal). Costs one pass over the board's edges, and only ever
  //     runs on a discrete user action — never during a gesture.
  //   - `redrawEdgesForNodes` — updates only the `d`/label position of
  //     edges incident to the given card ids, via `edgeIndexByNodeId`.
  //     Used on every card-drag pointermove (with live override positions)
  //     and once more after a drag commits (against the final board data).
  // Endpoint coordinates always come from board data (via
  // `effectiveNodeRect`), never the DOM — an edge still draws correctly
  // even when one of its endpoint cards isn't currently mounted
  // (virtualization) or is mid-drag (temporary override coordinates).
  // -----------------------------------------------------------------------

  private rebuildEdgesSvg(): void {
    this.clearEdgesSvg()
    this.boardEdgesById = new Map(
      this.board.edges.map((edge) => [edge.id, edge]),
    )
    for (const edge of this.board.edges) {
      this.indexEdgeIncidence(edge)
      this.createEdgeDom(edge)
      this.redrawEdge(edge.id)
    }
    this.restoreEdgeSelection()
  }

  private clearEdgesSvg(): void {
    this.edgesGroupEl?.replaceChildren()
    this.edgeElsById.clear()
    this.boardEdgesById = new Map()
    this.edgeIndexByNodeId = new Map()
  }

  private indexEdgeIncidence(edge: Edge): void {
    this.addEdgeIndex(edge.fromNode, edge.id)
    this.addEdgeIndex(edge.toNode, edge.id)
  }

  private addEdgeIndex(nodeId: NodeId, edgeId: EdgeId): void {
    let ids = this.edgeIndexByNodeId.get(nodeId)
    if (!ids) {
      ids = new Set()
      this.edgeIndexByNodeId.set(nodeId, ids)
    }
    ids.add(edgeId)
  }

  private createEdgeDom(edge: Edge): void {
    if (!this.edgesGroupEl) return
    const doc = this.context.getDocument()
    // Hit path first so the visible one paints over it; it is transparent,
    // and the only element of the pair a pointer can land on.
    const hit = doc.createElementNS(SVG_NS, 'path')
    hit.setAttribute('class', EDGE_HIT_CLASS)
    hit.dataset.edgeId = edge.id
    this.edgesGroupEl.appendChild(hit)

    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', EDGE_PATH_CLASS)
    if (edge.toEnd === 'arrow') {
      path.setAttribute('marker-end', `url(#${this.arrowMarkerId})`)
    }
    if (edge.fromEnd === 'arrow') {
      path.setAttribute('marker-start', `url(#${this.arrowMarkerId})`)
    }
    this.edgesGroupEl.appendChild(path)

    let label: SVGTextElement | null = null
    if (edge.label && edge.label.trim().length > 0) {
      label = doc.createElementNS(SVG_NS, 'text')
      label.setAttribute('class', EDGE_LABEL_CLASS)
      label.setAttribute('text-anchor', 'middle')
      label.setAttribute('dominant-baseline', 'middle')
      label.textContent = edge.label
      this.edgesGroupEl.appendChild(label)
    }

    this.edgeElsById.set(edge.id, { path, hit, label })
  }

  /** Takes an edge off the canvas without touching the board — the preview
   * stands in for it while its endpoint is being dragged. */
  private setEdgeHidden(edgeId: EdgeId, hidden: boolean): void {
    const dom = this.edgeElsById.get(edgeId)
    if (!dom) return
    dom.path.classList.toggle(EDGE_HIDDEN_CLASS, hidden)
    dom.label?.classList.toggle(EDGE_HIDDEN_CLASS, hidden)
  }

  /** Board-data rect for `id`, or its live drag position from `overrides`
   * when provided (see `updateNodeDragPositions`) — the single lookup both
   * `redrawEdge` call sites (live drag, and the post-commit redraw against
   * final data) go through. */
  private effectiveNodeRect(
    id: NodeId,
    overrides?: ReadonlyMap<NodeId, CardRect>,
  ): VirtualCardRect | null {
    const card = this.nodesById.get(id)
    if (!card) return null
    const override = overrides?.get(id)
    return override ? { id: card.id, ...override } : card
  }

  /** Drops selected ids whose edge is gone and re-applies the class to the
   * rest, after a rebuild has replaced every path element. */
  private restoreEdgeSelection(): void {
    const surviving = Array.from(this.selectedEdgeIds).filter((id) =>
      this.boardEdgesById.has(id),
    )
    this.selectedEdgeIds = new Set(surviving)
    for (const id of surviving) this.markEdgeSelected(id, true)
    this.syncSelectionKeymapScope()
  }

  private redrawEdge(
    edgeId: EdgeId,
    overrides?: ReadonlyMap<NodeId, CardRect>,
  ): void {
    const edge = this.boardEdgesById.get(edgeId)
    const dom = this.edgeElsById.get(edgeId)
    if (!edge || !dom) return
    const from = this.effectiveNodeRect(edge.fromNode, overrides)
    const to = this.effectiveNodeRect(edge.toNode, overrides)
    if (!from || !to) return // dangling edges are rejected at parse time; stay defensive
    const { fromSide, toSide } = resolveEdgeSides(
      from,
      to,
      edge.fromSide,
      edge.toSide,
    )
    const geometry = computeEdgeGeometry(from, to, fromSide, toSide)
    const d = buildEdgePathD(geometry)
    dom.path.setAttribute('d', d)
    dom.hit.setAttribute('d', d)
    if (dom.label) {
      dom.label.setAttribute('x', String(geometry.label.x))
      dom.label.setAttribute('y', String(geometry.label.y))
    }
  }

  private redrawEdgesForNodes(
    nodeIds: ReadonlySet<NodeId>,
    overrides?: ReadonlyMap<NodeId, CardRect>,
  ): void {
    const edgeIds = new Set<EdgeId>()
    for (const id of nodeIds) {
      const incident = this.edgeIndexByNodeId.get(id)
      if (!incident) continue
      for (const edgeId of incident) edgeIds.add(edgeId)
    }
    for (const edgeId of edgeIds) this.redrawEdge(edgeId, overrides)
  }

  // -----------------------------------------------------------------------
  // Edit lifecycle: click -> live CM6 editor; blur (native, or a
  // programmatic `.blur()` from Escape / a card switch / teardown) -> the
  // single `finishEdit` commit path. Never write back from anywhere else —
  // this is what keeps blur and Escape from double-committing
  // (p1-design §3).
  // -----------------------------------------------------------------------

  /**
   * Whether this node has text a card can edit: a text node always, a file
   * node only while it points at markdown. A group has no text surface, and
   * neither does a PDF or an image.
   */
  private isEditableNode(node: BoardNode): boolean {
    return (
      node.type === 'text' ||
      (node.type === 'file' && isMarkdownPath(node.file))
    )
  }

  /** Opens a card for editing if that node is editable. False when it is not,
   * so a key binding can decline instead of silently swallowing the
   * keystroke. */
  private editCard(id: NodeId): boolean {
    const node = this.nodesById.get(id)
    if (!node || !this.isEditableNode(node)) return false
    this.enterEditMode(id)
    return true
  }

  private enterEditMode(id: NodeId): void {
    if (this.parseFailed) return
    // Degraded cards render as a title block with the body hidden (D8), so
    // an editor mounted now would be invisible; zooming back in is the way
    // to edit.
    if (this.degraded) return
    const node = this.nodesById.get(id)
    if (!node || !this.isEditableNode(node)) return
    const runtime = this.runtimeByNodeId.get(id)
    if (!runtime?.bodyEl || runtime.missingFile) return
    // A file card's initial content is read asynchronously on mount
    // (renderCardPreview); if the user clicks to edit before that first
    // read resolves, there's no known draft to seed the editor with yet —
    // entering edit mode anyway would risk a blur immediately after
    // overwriting the file with empty text.
    if (node.type === 'file' && runtime.noteText === null) return

    if (this.editing) {
      if (this.editing.nodeId === id) return
      // Force a real DOM blur on the previously-active editor so it commits
      // through the exact same path before this one takes over.
      this.editing.editor.blur()
    }
    // A card being edited is never also selected (see `selectedIds`). Cleared
    // after the blur above, which selects the card it just left. Keeping the
    // two apart is what stops the selection's own bindings from stealing
    // Enter and Escape from the editor — the keys they mean most.
    this.clearSelection()

    const initialText =
      node.type === 'text' ? node.text : (runtime.noteText ?? '')
    this.destroyContentView(runtime)
    runtime.bodyEl.replaceChildren()
    runtime.el?.classList.add(CARD_EDITING_CLASS)
    runtime.bodyEl.classList.add(EDITOR_HOST_CLASS)
    this.pinnedIds.add(id)

    const editor = this.host.ui.createMarkdownEditor({
      container: runtime.bodyEl,
      value: initialText,
      // What `[[links]]` in this card resolve against, and where an attachment
      // pasted into it is filed. A note card is its own document; a text card
      // lives inside the board file, so "here" is the board.
      sourcePath: node.type === 'file' ? node.file : this.sourcePathForBoard(),
      onChange: () => this.scheduleEditPersist(id),
      onBlur: (text) => this.finishEdit(id, text),
    })
    const scopeDisposer = this.context.registerKeymap([
      {
        modifiers: [],
        key: 'Escape',
        handler: () => {
          editor.blur()
          return true
        },
      },
    ])
    this.editing = {
      nodeId: id,
      editor,
      scopeDisposer,
      historyKey: `edit-${this.nextEditSessionId()}`,
      persistTimer: null,
    }
    editor.focus()
  }

  /**
   * Persists in-progress edits without waiting for the user to leave the card.
   *
   * Blur alone used to be the only write point, which meant everything typed
   * since the card was opened was held in the editor and nowhere else — a
   * crash mid-edit lost it. Throttled rather than per-keystroke because the
   * board's own save is debounced downstream anyway, and a note card's write
   * is a real file write.
   */
  private scheduleEditPersist(id: NodeId): void {
    const editing = this.editing
    if (!editing || editing.nodeId !== id) return
    // Leading edge already scheduled: the timer reads the editor when it
    // fires, so it always writes the latest text and never needs restarting.
    if (editing.persistTimer !== null) return
    const win = this.context.getWindow()
    editing.persistTimer = win.setTimeout(() => {
      editing.persistTimer = null
      if (this.editing !== editing) return
      this.commitCardText(id, editing.editor.getValue(), editing.historyKey)
    }, EDIT_PERSIST_THROTTLE_MS)
  }

  /** Writes a card's text to wherever that card's content lives — the note
   * file for a note card, the board for a text card. */
  private commitCardText(id: NodeId, text: string, historyKey?: string): void {
    const action = planNodeCommit(this.board, id, text)
    switch (action.kind) {
      case 'writeNoteFile': {
        const runtime = this.runtimeByNodeId.get(id)
        if (runtime) runtime.noteText = action.markdown
        void this.host.vault
          .writeText(action.file, action.markdown)
          .catch((error: unknown) => this.reportError('writeText', error))
        break
      }
      case 'updateBoard':
        this.applyBoardChange(action.board, historyKey)
        break
      case 'noop':
        break
    }
  }

  private finishEdit(id: NodeId, text: string): void {
    const editing = this.editing
    if (!editing || editing.nodeId !== id) return // stale callback: already exited some other way
    this.editing = null
    if (editing.persistTimer !== null) {
      this.context.getWindow().clearTimeout(editing.persistTimer)
    }
    editing.scopeDisposer()
    editing.editor.destroy()
    this.pinnedIds.delete(id)

    const runtime = this.runtimeByNodeId.get(id)
    runtime?.el?.classList.remove(CARD_EDITING_CLASS)
    runtime?.bodyEl?.classList.remove(EDITOR_HOST_CLASS)

    // Final flush: the throttled writes may have left the last keystrokes
    // unpersisted, and a no-op commit costs nothing. Still under the
    // session's history key — the whole session is one step to undo.
    this.commitCardText(id, text, editing.historyKey)
    void this.renderCardPreview(id)
    // Leaving the editor lands on the card, not on nothing: Escape steps
    // out to the selected card and only a second Escape clears it. A blur
    // caused by pressing somewhere else is overwritten by whatever that
    // press selects, a moment later in the same gesture.
    if (this.nodesById.has(id)) this.setSelection([id])
  }

  /** Commits the active edit (if any) through the single `finishEdit` path
   * by forcing a real blur — used by every non-interactive teardown
   * (`dispose`, `setViewData`, `clear`) so none of them need their own
   * write-back logic. */
  private forceCommitActiveEdit(): void {
    if (!this.editing) return
    this.editing.editor.blur()
  }

  // -----------------------------------------------------------------------
  // Teardown / error state
  // -----------------------------------------------------------------------

  private teardownAllCards(): void {
    this.forceCommitActiveEdit()
    this.interaction = null
    this.marqueeEl?.remove()
    this.marqueeEl = null
    this.popSelectionKeymapScope()
    this.selectedIds = new Set()
    for (const runtime of this.runtimeByNodeId.values()) {
      this.destroyContentView(runtime)
      runtime.el?.remove()
      runtime.el = null
      runtime.bodyEl = null
    }
    this.runtimeByNodeId.clear()
    this.pinnedIds.clear()
    this.contentSyncQueue.clear()
    this.engine.reset()
    this.clearEdgesSvg()
  }

  private syncBoardIndex(): void {
    this.nodesById = new Map(this.board.nodes.map((node) => [node.id, node]))
    this.cardNodes = this.board.nodes.filter((node) => node.type !== 'group')
  }

  // ---------------------------------------------------------------------
  // Self-heal (p1-design §1.2, "自愈层"): run once per setViewData, right
  // after a board finishes parsing. Only markdown file nodes are covered —
  // relocating any other file type has no vault API to enumerate candidates
  // the way `listMarkdownFiles()` does for notes (out of scope; the actual
  // decision of *which* nodes get relocated lives in domain/selfHeal.ts so
  // it's unit-testable without a vault fixture). A node with zero or multiple
  // same-basename candidates is left alone — it keeps rendering as the
  // existing "file missing" placeholder (renderMissingFilePlaceholder)
  // rather than risk repointing to the wrong note.
  // ---------------------------------------------------------------------

  private selfHealMissingFileNodes(): void {
    const missing: MissingFileNode[] = []
    for (const node of this.board.nodes) {
      if (node.type !== 'file' || !isMarkdownPath(node.file)) continue
      const entry = this.host.vault.getEntry(node.file)
      if (entry && entry.kind === 'file') continue
      missing.push({ nodeId: node.id, file: node.file })
    }
    if (missing.length === 0) return

    const relocations = planFileNodeSelfHeal(
      missing,
      this.host.vault.listMarkdownFiles(),
    )
    if (relocations.length === 0) return

    let board = this.board
    for (const relocation of relocations) {
      board = updateNode(board, relocation.nodeId, { file: relocation.file })
    }
    // Not a history step: this is the view repairing a stale reference, not
    // something the user did, and it runs before the baseline snapshot is
    // taken (see setViewData).
    this.board = board
    this.syncBoardIndex()
    this.context.requestSave()
  }

  // ---------------------------------------------------------------------
  // Content-freshness (p1-design §1.2, "内容时效"): a mounted note card's
  // static preview reflects an external edit to its backing file without
  // requiring the whole `.yoloboard` to reload. Two guards keep this from
  // fighting the edit lifecycle:
  //   - a card currently in edit mode is skipped entirely — the live
  //     editor's content is authoritative and must never be silently
  //     replaced out from under a typing user;
  //   - `runtime.noteText === text` short-circuits the render for the
  //     redundant modify event `finishEdit`'s own `writeText` triggers,
  //     without needing an "ignore my own write" time-window flag.
  // ---------------------------------------------------------------------

  private handleBackingFileModified(path: string): void {
    if (this.parseFailed) return
    for (const [id, node] of this.nodesById) {
      if (node.type !== 'file' || node.file !== path) continue
      if (this.editing?.nodeId === id) continue
      const runtime = this.runtimeByNodeId.get(id)
      if (!runtime?.el) continue // not currently mounted
      void this.refreshMountedNoteCard(id, runtime, path)
    }
  }

  private async refreshMountedNoteCard(
    id: NodeId,
    runtime: NodeRuntime,
    path: string,
  ): Promise<void> {
    let text: string
    try {
      text = await this.host.vault.readText(path)
    } catch (error) {
      this.reportError('readText (modify refresh)', error)
      return
    }
    // The card may have unmounted, been superseded, or entered edit mode
    // while the read above was in flight.
    if (this.runtimeByNodeId.get(id) !== runtime) return
    if (this.editing?.nodeId === id) return
    if (runtime.noteText === text) return // no real change — short-circuit
    runtime.noteText = text
    runtime.missingFile = false
    // A degraded card has no content to refresh (renderCardPreview's gate),
    // but the read above still had to happen: `noteText` is what an editor
    // opened on this card would be seeded from, and seeding it from a
    // superseded read is how the write on blur would undo someone else's
    // edit. The rendering is what D8 skips, not the freshness.
    if (this.degraded) return
    this.renderMarkdownInto(id, runtime, text, path)
  }

  private showError(issues: readonly BoardParseIssue[]): void {
    if (!this.errorEl) return
    this.errorEl.classList.add(ERROR_VISIBLE_CLASS)
    this.viewportEl?.classList.add(VIEWPORT_HIDDEN_CLASS)
    const doc = this.context.getDocument()
    this.errorEl.replaceChildren()
    const title = doc.createElement('div')
    title.className = ERROR_TITLE_CLASS
    title.textContent = this.t('error.title')
    const hint = doc.createElement('div')
    hint.className = ERROR_HINT_CLASS
    hint.textContent = this.t('error.hint')
    this.errorEl.append(title, hint)
    // Diagnostics are developer-facing, not user copy — logged for
    // support/debugging rather than shown verbatim.
    if (issues.length > 0) {
      console.warn('[YOLO Whiteboard] failed to parse .yoloboard file', issues)
    }
  }

  private showCanvas(): void {
    this.errorEl?.classList.remove(ERROR_VISIBLE_CLASS)
    this.viewportEl?.classList.remove(VIEWPORT_HIDDEN_CLASS)
  }

  private sourcePathForBoard(): string {
    return this.context.getFile()?.path ?? ''
  }

  private t(key: string, fallback?: string): string {
    return createWhiteboardTranslation(this.host.i18n.getSnapshot().locale)(
      key,
      fallback,
    )
  }

  private reportError(stage: string, error: unknown): void {
    console.error(`[YOLO Whiteboard] ${stage} failed`, error)
  }
}

function distanceBetween(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
