// The `.yoloboard` file view's canvas: camera pan/zoom, viewport
// virtualization, and the note/text card static-preview <-> live-editor
// lifecycle. Ported from the S2/S3 spikes' `WhiteboardFileView` (`git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/fileView.ts`) and
// translated from direct Obsidian API calls (`TextFileView`,
// `MarkdownRenderer`, `app.keymap`) to the Host API surface a module is
// actually allowed to use (Module Boundaries, CLAUDE.md) — `YoloModuleHostApiV1`
// and `YoloModuleHostFileViewContextV1`, both declared globally by
// `modules/host-sdk.d.ts`.
//
// Deliberately DOM-heavy and imperative rather than React ("画布主体建议直接
// DOM 命令式实现（spike 同款，性能路径更可控）") — a
// rAF loop driving virtualization mount/unmount at a few hundred cards a
// frame is not a good fit for a vdom diff.
//
// Popout safety: every DOM node, listener, timer, and rAF call goes through
// `this.context.getDocument()` / `this.context.getWindow()`, never the
// global `document`/`window` (Popout / Multi-window, CLAUDE.md) — this view
// must keep working when its leaf is dragged into an Obsidian popout
// BrowserWindow, which has its own realm.

import {
  type AlignEdge,
  type DistributeAxis,
  alignRects,
  distributeRects,
} from '../domain/arrange'
import { cameraFromView, screenToWorld } from '../domain/camera'
import type { ScreenPoint } from '../domain/camera'
import { planNodeCommit } from '../domain/commit'
import {
  type ArrowDirection,
  arrowEnds,
  computeEdgeGeometry,
  resolveEdgeSides,
} from '../domain/edges'
import {
  type Board,
  type BoardNode,
  type BoardParseIssue,
  type Edge,
  type EdgeId,
  type GroupNode,
  type NodeColor,
  type NodeId,
  emptyBoard,
  isPlainText,
  parseBoard,
  serializeBoard,
} from '../domain/fileFormat'
import {
  arrangeTargets,
  carryGroupMembers,
  groupRectForNodes,
} from '../domain/groups'
import { BoardHistory } from '../domain/history'
import { mintEdgeId, mintNodeId } from '../domain/ids'
import { isMarkdownPath } from '../domain/naming'
import {
  boardWithPageWindow,
  boardWithReadingWindow,
  removeEdge,
  removeNode,
  setNodePositions,
  updateEdge,
  updateNode,
} from '../domain/operations'
import type { CardRect } from '../domain/resize'
import { type MissingFileNode, planFileNodeSelfHeal } from '../domain/selfHeal'
import {
  SPREAD_METRICS,
  closeSpread,
  collapseBoard,
  defaultSpreadColumns,
  expandBoard,
  foldedCardOrigin,
  isSpreadTitle,
  layoutSpreadGrid,
  nodesToDelete,
  openSpread,
  reflowSpread,
  scaleSpread,
  spreadPages,
} from '../domain/spread'
import { tidyRects } from '../domain/tidy'
import {
  VirtualizationEngine,
  type WorldRect,
  computeWorldViewportRect,
} from '../domain/virtualization'
import type { AnnotationPrefs } from '../host/annotationPrefs'
import type { AnnotationStores } from '../host/annotationStore'
import type { PdfThumbnailStore } from '../host/pdfThumbnailStore'
import { takePendingFit } from '../host/pendingFit'
import type { ReaderPanelPrefs } from '../host/readerPanelPrefs'
import { createWhiteboardTranslation } from '../i18n'

import { CameraController } from './canvas/cameraController'
import { CardGeneration } from './canvas/cardGeneration'
import { CardRenderer, type NodeRuntime } from './canvas/cardRenderer'
import { ClipboardController } from './canvas/clipboardController'
import type { CanvasCore } from './canvas/core'
import { DropImport } from './canvas/dropImport'
import { EdgeLayer } from './canvas/edgeLayer'
import { EditingController } from './canvas/editingController'
import {
  InteractionController,
  buildInteractionLayer,
  nodeIdFromEventTarget,
} from './canvas/interactionController'
import { KEY_LAYER_RANK, KeymapController } from './canvas/keymapController'
import { OverviewLayer } from './canvas/overviewLayer'
import { PdfIntegration, isPdfNode } from './canvas/pdfIntegration'
import { SnapGuideLayer } from './canvas/snapGuideLayer'
import { SpreadFrame } from './canvas/spreadFrame'
import { ToolbarController } from './canvas/toolbarController'
import { CanvasControls } from './canvasControls'
import {
  ARRANGE_ANIMATION_EASING,
  ARRANGE_ANIMATION_MS,
  CARD_FOCUSED_CLASS,
  CARD_SELECTED_CLASS,
  CONTENT_BUILD_START_CAP_PER_FRAME,
  EDGE_HIDDEN_CLASS,
  FRAME_ON_TIME_MS,
  GRID_WORLD_STEP_PX,
  GROUP_LABEL_WORLD_FONT_PX,
  MOUNT_QUOTA_PER_FRAME,
  NODE_ENTER_WINDOW_MS,
  OVERVIEW_GROUP_LABEL_MIN_SCREEN_PX,
  OVERVIEW_RESTORE_SCALE,
  OVERVIEW_SCALE_THRESHOLD,
  RECOMPUTE_INTERVAL_MS,
  RESIZE_HANDLE_PX,
  SPREAD_DEAL_MAX_DELAY_MS,
  SPREAD_DEAL_STAGGER_MS,
  SPREAD_DEAL_WINDOW_MS,
  SPREAD_SHEET_OF_SELECTED_CLASS,
  SVG_NS,
  UNMOUNT_QUOTA_PER_FRAME,
  VIEWPORT_BUFFER_PX,
} from './constants'
import { type PdfPageLabels, blockStartLine, nextOverviewState } from './lod'
import { PdfDrawQueue } from './pdf/drawQueue'
import { PdfThumbnails, type WantedThumbnail } from './pdf/thumbnails'
import { applyColorToElement } from './selectionToolbar'

/**
 * Size of a group created around a selection is derived from that selection
 * (domain/groups.ts), so this is only the fallback a group gets when it is
 * created around nothing — which cannot happen today, but keeps the geometry
 * total.
 */
const MIN_GROUP_SIZE = Object.freeze({ w: 200, h: 160 })

/** How long an edit asked for in the overview tier waits for its card to come
 * back into the DOM before it is dropped — a glide in plus the mount queue,
 * with room to spare. */
const PENDING_EDIT_WAIT_MS = 2000

/**
 * A world rectangle nothing can intersect — what the cards are measured
 * against in the overview tier, where none of them may stay mounted.
 *
 * Asking the existing engine an ordinary question rather than giving it a
 * mode: the answer comes back as the usual unmount diff, so it drains at the
 * usual per-frame quota and entering the tier never tears down a screenful in
 * one frame.
 */
const UNREACHABLE_RECT: WorldRect = Object.freeze({
  left: Number.POSITIVE_INFINITY,
  top: Number.POSITIVE_INFINITY,
  right: Number.NEGATIVE_INFINITY,
  bottom: Number.NEGATIVE_INFINITY,
})

/** Passed with `UNREACHABLE_RECT`: in the overview tier a pinned card must
 * come down like every other one — what a gesture is moving is drawn by the
 * canvas from `liveNodeRects`, so keeping its element would only put a second
 * copy of it on screen. */
const NO_PINS: ReadonlySet<NodeId> = new Set()

const ROOT_CLASS = 'yolo-whiteboard-root'
/** On every sheet of the spread whose title is under the pointer. */
const SPREAD_SIBLING_CLASS = 'yolo-whiteboard-spread-sibling'
/** Height over width of the widest page a folded PDF card is expected to
 * show: a landscape A4's. It decides how many of its pages get thumbnails. */
const FOLDED_PAGE_MIN_ASPECT = 0.7
const VIEWPORT_CLASS = 'yolo-whiteboard-viewport'
const PAN_CAPTURE_CLASS = 'yolo-whiteboard-pan-capture'
const VIEWPORT_HIDDEN_CLASS = 'yolo-whiteboard-viewport-hidden'
const WORLD_CLASS = 'yolo-whiteboard-world'
/** On the world layer while the overview tier is drawing the board: what the
 * stylesheet keys "no edge DOM at all" off. A class rather than a custom
 * property, so Blink's invalidation set is the two layers the rule names
 * rather than the world's whole subtree (see CameraController's
 * applyZoomScale for what the other choice costs). */
const WORLD_OVERVIEW_CLASS = 'yolo-whiteboard-world-overview'
const EDGES_SVG_CLASS = 'yolo-whiteboard-edges'
const EDGES_GROUP_CLASS = 'yolo-whiteboard-edges-group'
const EDGE_ARROW_MARKER_CLASS = 'yolo-whiteboard-edge-arrow-marker'
const EDGE_ARROW_CLASS = 'yolo-whiteboard-edge-arrow'
const EDGE_LABELS_CLASS = 'yolo-whiteboard-edge-labels'
const EDGE_PREVIEW_CLASS = 'yolo-whiteboard-edge-preview'
const ERROR_CLASS = 'yolo-whiteboard-error'
const ERROR_VISIBLE_CLASS = 'yolo-whiteboard-error-visible'
const ERROR_TITLE_CLASS = 'yolo-whiteboard-error-title'
const ERROR_HINT_CLASS = 'yolo-whiteboard-error-hint'
const PREHEAT_CLASS = 'yolo-whiteboard-preheat'
const EMPTY_HINT_CLASS = 'yolo-whiteboard-empty-hint'
const EMPTY_HINT_VISIBLE_CLASS = 'yolo-whiteboard-empty-hint-visible'
const EMPTY_HINT_TITLE_CLASS = 'yolo-whiteboard-empty-hint-title'
const EMPTY_HINT_LINE_CLASS = 'yolo-whiteboard-empty-hint-line'
const EMPTY_HINT_DESKTOP_CLASS = 'yolo-whiteboard-empty-hint-desktop'
const EMPTY_HINT_TOUCH_CLASS = 'yolo-whiteboard-empty-hint-touch'

// `NodeRuntime` now lives in ./canvas/cardRenderer.ts (imported above as a
// type), which owns the mounted-card map it describes.

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
   * gesture acts on. Groups live in the same `nodes` array but sit *behind*
   * the cards, so a hit test that walked the whole array
   * would let a group swallow a double-click meant for the empty space inside
   * it. Derived in `syncBoardIndex`, never stored.
   */
  private cardNodes: readonly BoardNode[] = []
  /**
   * The other half of the same split. Groups keep their DOM at every zoom,
   * so the two populations answer to different viewport rects in the
   * overview tier and have to be handed to the virtualization engine
   * separately — see `recomputeVisibility`.
   */
  private groupNodes: readonly BoardNode[] = []
  /** Card DOM/content lifecycle — mount/unmount, the hidden pool, per-card
   * rendering. Owns `NodeRuntime`; constructed once in `ensureDom` (see
   * ./canvas/cardRenderer.ts's own doc comment for the split's rationale). */
  private cardRenderer!: CardRenderer
  /** Rung one: the empty card's chips and the generation they start
   * (./canvas/cardGeneration.ts). Constructed with the renderer in
   * `ensureDom`, and the only thing besides the editor that may own a card's
   * body. */
  private cardGeneration!: CardGeneration
  private readonly engine = new VirtualizationEngine()
  private readonly pinnedIds = new Set<NodeId>()
  /**
   * Nodes the user has just added to the board (created, pasted, dropped,
   * restored by an undo), with when they were added — what `drainQueues`
   * plays the arrival for as each one mounts. A node that mounts outside the
   * window (NODE_ENTER_WINDOW_MS) was added off screen and is not new to
   * anyone looking at it, so it mounts like any other.
   */
  private readonly entering = new Map<NodeId, number>()
  /** A card asked to be edited from the overview tier, waiting for the camera
   * to bring it back into the DOM (`zoomInToEdit`), and when to give up. */
  private pendingEdit: Readonly<{ id: NodeId; until: number }> | null = null
  /** The spread whose title the pointer is on (`syncSpreadHover`). */
  private hoveredSpreadId: NodeId | null = null
  /** The spread being dealt out of its card's corner — see `playSpreadDeal`. */
  private spreadDeal: Readonly<{
    parent: NodeId
    origin: Readonly<{ x: number; y: number }>
    startedAt: number
  }> | null = null
  /** Spreads whose sheets are being gathered back before they close. */
  private readonly spreadsFolding = new Set<NodeId>()

  /** Undo/redo over board content. Seeded on load, pushed by
   * `applyBoardChange`, and never touched by camera movement (see
   * `applyHistoryBoard`). */
  private readonly history = new BoardHistory(undefined, () =>
    this.canvasControls?.refresh(),
  )
  /** The off-screen card that warms the rendering pipeline; see `preheat`. */
  private preheatRenderer: ReturnType<
    YoloModuleHostApiV1['ui']['createMarkdownRenderer']
  > | null = null

  /** Camera (pan/zoom) state and its glide animation. Constructed once in
   * `ensureDom` (see ./canvas/cameraController.ts's own doc comment). Gesture
   * code reads its live position through the `view` getter and
   * `viewportPointFromEvent`/`worldPointFromEvent`; it never writes the
   * camera directly. */
  private cameraController!: CameraController

  // Selection: UI state, not board data — never serialized. A
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
  /**
   * The lone selected card, when exactly one is selected — Obsidian Canvas's
   * `is-focused`, derived from the selection rather than tracked beside it.
   *
   * What this state does *not* do is lift the content mask. Canvas lifts its
   * blocker here (measured: `.canvas-node.is-focused:not(.is-dragging)
   * .canvas-node-content-blocker { display: none }`, and its frame loop calls
   * `node.focus()` only when the new selection has size 1) and we did too,
   * until it turned out to mean that selecting a web card is what stops you
   * dragging it. That now takes `enteredNodeId` and a gesture of its own.
   *
   * What focus still decides is how much of a card's note is built — the
   * focused card is the one that can be scrolled — and which card a keyboard
   * command acts on. See style.css's content-mask block.
   */
  private focusedNodeId: NodeId | null = null

  // Selection toolbar: one instance per view,
  // rebuilt on selection change and re-placed whenever the camera or the
  // selection's geometry moves. It lives in the viewport (screen-space) layer,
  // so it keeps a constant size at every zoom — see ./canvas/toolbarController.ts,
  // ui/selectionToolbar.ts and domain/toolbar.ts for the placement law.
  /** Constructed once in `ensureDom`, once the viewport element exists (see
   * ./canvas/toolbarController.ts's own doc comment). */
  private toolbarController!: ToolbarController

  /** The hint a board with nothing on it shows (`syncEmptyHint`). */
  private emptyHintEl: HTMLElement | null = null
  /** The top-right zoom and history column (./canvasControls.ts). */
  private canvasControls: CanvasControls | null = null
  /** Card creation, drops and the right-click menus
   * (./canvas/dropImport.ts). Built in `ensureDom`. */
  private dropImport!: DropImport
  /** Copy, cut and paste (./canvas/clipboardController.ts). Built in
   * `ensureDom`. */
  private clipboard!: ClipboardController
  /** What is being typed: a card's editor, a label, live content
   * (./canvas/editingController.ts). Built in `ensureDom`. */
  private editing!: EditingController
  /** The board's keys and the layered Escape/Delete/undo chains
   * (./canvas/keymapController.ts). Built in `ensureDom`. */
  private keymap!: KeymapController
  /** Pointer input: which gesture a press starts, and the gestures
   * themselves (./canvas/interactionController.ts). Built in `ensureDom`. */
  private interaction!: InteractionController

  // Edges: a single SVG overlay drawn into the world layer, redrawn
  // wholesale on structural change (rebuildEdgesSvg) and per-path on card
  // position change (redrawEdgesForNodes) — see ./canvas/edgeLayer.ts, which
  // owns the SVG's child elements and the incidence index, and its own doc
  // comment for the mount-independent, DOM-measurement-free approach.
  /** Constructed once in `ensureDom`, once the edges `<svg>` exists. */
  private edgeLayer!: EdgeLayer
  /** Drawn only while a drag or a resize is lining something up. */
  private snapGuideLayer: SnapGuideLayer | null = null
  /** The frame and reflow handle around a selected PDF spread
   * (./canvas/spreadFrame.ts). */
  private spreadFrame: SpreadFrame | null = null
  /**
   * The overview tier's renderer. Built in `ensureDom`; null before
   * that, which `clear()` can reach.
   */
  private overviewLayer: OverviewLayer | null = null
  /** Whether the camera is below the overview threshold — see
   * `updateOverviewState`. Updated at recomputeVisibility's ~70ms throttle,
   * behind a hysteresis band. */
  private overview = false
  /**
   * The tier has been left and the cards it unmounted are not all back yet, so
   * the canvas is still drawing them and the edge DOM is still out of the
   * document — see `settleOverviewLinger`.
   */
  private overviewLingering = false

  /** Whether the world still carries WORLD_OVERVIEW_CLASS, which is what
   * decides whether the edge layers are part of the drawing at all. The
   * camera reads it to know whether writing their counter-scale would restyle
   * thousands of elements for nothing (CameraController's applyZoomScale). */
  private get overviewChromeHidden(): boolean {
    return this.overview || this.overviewLingering
  }
  /** canvas.ts's own copy of the board's edges by id, kept in step by
   * `syncBoardIndex` — the lookup every edge-*gesture* and label-editing path
   * here uses; `edgeLayer` keeps a separate copy scoped to its own drawing
   * (see that file's doc comment on why the two are not merged). */
  private boardEdgesById = new Map<EdgeId, Edge>()
  private readonly arrowMarkerId = `yolo-whiteboard-edge-arrow-${Math.random().toString(36).slice(2)}`

  private lastRawData = ''
  private parseFailed = false

  // Content-freshness: a vault-wide `modify` subscription, live for
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
  /** The viewport's size, read once after each resize (`onResize`) rather
   * than on every visibility tick or toolbar placement: reading it is a
   * layout read, and every one of those readers runs after something has
   * just written to the world — a drag's transforms, a frame's mounts — so
   * each read forced the whole world to be laid out there and then. */
  private viewportSize: Readonly<{ width: number; height: number }> | null =
    null
  /** Forgets `viewportSize` whenever the viewport changes size, including
   * the changes no `onResize` reports (a tab shown again, a panel opened). */
  private viewportObserver: ResizeObserver | null = null
  private worldEl!: HTMLElement
  private errorEl: HTMLElement | null = null

  private rafId: number | null = null
  private lastRecomputeTime = 0
  /** Cards whose content build ran out of a frame's budget and is owed on a
   * later one — drained a few per frame by `drainQueues` (see
   * `renderMarkdownInto`, which is what puts them here). */
  private readonly contentSyncQueue = new Set<NodeId>()

  /**
   * Whether card content may be built right now: either nothing is moving, or
   * the last frame arrived on time (FRAME_ON_TIME_MS). Re-derived once per
   * frame; read wherever a build is about to start, including the builds that
   * only reach that point after reading a file, a frame or more later.
   */
  private canBuildContent = true
  private lastFrameAt: number | null = null

  /** Whether the camera is moving (see CameraController.markInteracting).
   * While it is, building is paced by whether frames are keeping up; at rest
   * it runs at full rate. */
  private interacting = false
  /**
   * Every PDF page this board draws waits its turn here (./pdf/drawQueue.ts):
   * two at a time at rest. While the camera moves, each draw puts a slice of
   * main-thread work into every frame until it is done, so only a page that
   * shows nothing at all is drawn then, one at a time — one showing its
   * thumbnail is sharpened once the camera stops. None while a spread's
   * frame is being dragged: the pages coming into view are drawn once it is
   * let go.
   */
  private readonly pdfDraws = new PdfDrawQueue((urgent) =>
    this.spreadFrame?.dragging ? 0 : !this.interacting ? 2 : urgent ? 1 : 0,
  )
  /** Small pictures of every open spread's pages, made while the board is
   * still (./pdf/thumbnails.ts). */
  private pdfThumbnails: PdfThumbnails | null = null

  /** PDF reading on this board — the reading panel, annotations, excerpts,
   * links into its PDFs (./canvas/pdfIntegration.ts). Built in `ensureDom`. */
  private pdf!: PdfIntegration

  /** What every controller reads and commits through (./canvas/core.ts).
   * Closures over this canvas, so each read is live. */
  private readonly core: CanvasCore

  constructor(
    private readonly context: YoloModuleHostFileViewContextV1,
    private readonly host: YoloModuleHostApiV1,
    private readonly readerPanelPrefs: ReaderPanelPrefs,
    private readonly annotationStores: AnnotationStores,
    private readonly annotationPrefs: AnnotationPrefs,
    private readonly pdfThumbnailStore: PdfThumbnailStore,
  ) {
    this.core = {
      context: this.context,
      host: this.host,
      getBoard: () => this.board,
      getNode: (id) => this.nodesById.get(id),
      getEdge: (id) => this.boardEdgesById.get(id),
      getCardNodes: () => this.cardNodes,
      nextNodeId: (board) => this.nextNodeId(board),
      nextEdgeId: () => this.nextEdgeId(),
      isParseFailed: () => this.parseFailed,
      canEdit: () => this.canEdit,
      canCreate: () => this.canCreate,
      isOverview: () => this.overview,
      applyBoardChange: (next, historyKey) =>
        this.applyBoardChange(next, historyKey),
      commitWithoutHistory: (next) => this.commitWithoutHistory(next),
      getSelectedIds: () => this.selectedIds,
      getSelectedEdgeIds: () => this.selectedEdgeIds,
      getFocusedNodeId: () => this.focusedNodeId,
      setSelection: (ids) => this.setSelection(ids),
      setEdgeSelection: (ids) => this.setEdgeSelection(ids),
      clearSelection: () => this.clearSelection(),
      getView: () => this.cameraController.view,
      worldViewportRect: (buffer) => this.worldViewportRect(buffer),
      worldPointFromEvent: (e) => this.worldPointFromEvent(e),
      getRuntime: (id) => this.cardRenderer.getRuntime(id),
      recomputeVisibility: () => this.recomputeVisibility(),
      drainQueues: () => this.drainQueues(),
      getSourcePath: () => this.sourcePathForBoard(),
      t: (key, fallback) => this.t(key, fallback),
      reportError: (stage, error) => this.reportError(stage, error),
    }
  }

  // -----------------------------------------------------------------------
  // YoloModuleFileViewInstanceV1 surface (src/index.tsx wires these 1:1).
  // -----------------------------------------------------------------------

  /**
   * TextFileView-style contract: must be idempotent and safe to call
   * repeatedly (host doc: "May run before the DOM is visible and
   * repeatedly (external modify); must be idempotent"). This doesn't
   * implement a smooth incremental refresh on external modify, so both
   * `clear=true` and `clear=false` do the same full rebuild from the freshly
   * parsed board; the `clear` flag itself carries no distinct meaning yet.
   */
  setViewData(data: string, _clear: boolean): void {
    this.ensureDom()
    this.lastRawData = data
    const result = parseBoard(data)
    // Before `teardownAllCards`, whose own commit path would land the edit on
    // the board this method is about to replace. See the doc comment.
    this.editing.endEditForIncomingBoard()
    this.teardownAllCards()

    if (!result.ok) {
      this.parseFailed = true
      this.board = emptyBoard()
      this.syncBoardIndex()
      this.interaction.setHoveredNode(null)
      this.showError(result.issues)
      return
    }

    this.parseFailed = false
    // The board's own shape of the file: an open PDF spread becomes its title
    // and a node per page (domain/spread.ts). `getViewData` folds it back.
    this.board = expandBoard(result.board)
    this.syncBoardIndex()
    this.selfHealMissingFileNodes()
    // Baseline for undo, taken after self-heal so the repaired board is the
    // oldest state anyone can get back to. Reset rather than extended: this
    // is a different file, or the same file rewritten from outside, and
    // pushing the previous content over it is how an undo destroys data.
    this.history.reset(this.board)
    this.rebuildEdgesSvg()
    this.cameraController.loadCamera(this.board.camera)
    // Cards were all torn down above: whatever the layer was parked on is
    // either gone or somewhere else now.
    this.interaction.refreshInteractionLayer()
    this.showCanvas()
    // A board that has just been imported has never been framed against a real
    // viewport; this is the one open where its stored camera is a placeholder
    // rather than where the user left off (host/pendingFit.ts). Done after
    // showCanvas so the viewport has its real size to fit against.
    if (takePendingFit(this.sourcePathForBoard())) {
      this.cameraController.fitCameraToNodes(this.board.nodes, {
        immediate: true,
      })
    }
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
   *  - the focused card's reading window, for the same reason and against the
   *    same race: `commitReadingWindow` only runs when focus leaves a card,
   *    and closing a board never takes focus off one;
   *  - the active card's live editor text, via the same `planNodeCommit`
   *    decision the actual commit path uses, without performing its write
   *    side effects (a note card's live text isn't part of the board at all,
   *    so there is nothing to fold in for that case; only
   *    a text card's `updateBoard` outcome affects serialization here).
   */
  getViewData(): string {
    if (this.parseFailed) return this.lastRawData
    let board = this.board
    const camera = cameraFromView(this.cameraController.view)
    if (
      camera.x !== board.camera.x ||
      camera.y !== board.camera.y ||
      camera.scale !== board.camera.scale
    ) {
      board = { ...board, camera }
    }
    if (this.focusedNodeId !== null) {
      const line = this.cardRenderer.getContentScrollLine(this.focusedNodeId)
      if (line !== null) {
        board = this.boardWithSnappedWindow(board, this.focusedNodeId, line)
      }
      const page = this.cardRenderer.getPdfPosition(this.focusedNodeId)
      if (page !== null) {
        board = boardWithPageWindow(board, this.focusedNodeId, page)
      }
    }
    board = this.editing.foldLiveEdit(board)
    // A generation in flight holds its text in the DOM and nowhere else until
    // it settles — the same race the live editor above is folded in for.
    for (const [id, text] of this.cardGeneration.pendingTexts()) {
      const action = planNodeCommit(board, id, text)
      if (action.kind === 'updateBoard') board = action.board
    }
    return serializeBoard(collapseBoard(board))
  }

  /** About to load a different file into this leaf. */
  clear(): void {
    // The panel reads a card of the board that is leaving.
    this.pdf.closeReaderPanel()
    this.teardownAllCards()
    this.board = emptyBoard()
    this.syncBoardIndex()
    this.parseFailed = false
    this.lastRawData = ''
  }

  onResize(): void {
    this.viewportSize = null
    this.pdf.refitPanel()
    if (this.parseFailed) return
    // How far out the wheel may zoom is derived from the viewport's size.
    this.cameraController.invalidateScaleFloor()
    this.recomputeVisibility()
    this.drainQueues()
    // The toolbar is clamped against the viewport's size, which just changed.
    this.toolbarController.positionToolbar()
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
    this.editing.forceCommitActiveEdit()
    const win = this.context.getWindow()
    if (this.rafId !== null) {
      win.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.cameraController.dispose()
    this.interaction.destroy()
    this.clipboard.destroy()
    this.viewportEl?.removeEventListener('wheel', this.cameraController.onWheel)
    this.vaultSubscriptionDisposer?.()
    this.vaultSubscriptionDisposer = null
    this.keymap.destroy()
    this.pdf.destroy()

    this.editing.endRename(true)
    this.dropImport.destroy()
    this.canvasControls?.destroy()
    this.canvasControls = null
    this.toolbarController.destroy()
    this.overviewLayer?.destroy()
    this.overviewLayer = null
    this.spreadFrame?.destroy()
    this.spreadFrame = null
    this.pdfThumbnails?.destroy()
    this.pdfThumbnails = null
    this.viewportObserver?.disconnect()
    this.viewportObserver = null
    this.teardownAllCards()
    this.preheatRenderer?.unload()
    this.preheatRenderer = null
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
    // The arrowhead is counter-scaled in the stylesheet (it grows past this
    // 10x10 marker viewport when the board is zoomed out), so the marker must
    // not clip it.
    marker.setAttribute('class', EDGE_ARROW_MARKER_CLASS)
    // 10 world units long at 1:1 (and counter-scaled from there — see
    // style.css's .yolo-whiteboard-edge-arrow), which is Obsidian Canvas's
    // own 10.4. `refX` is an eighth of the length short of the tip, so the
    // head overlaps the end of the line it caps rather than floating off it.
    marker.setAttribute('markerWidth', '10')
    marker.setAttribute('markerHeight', '10')
    marker.setAttribute('refX', '8.75')
    marker.setAttribute('refY', '5')
    // auto-start-reverse: the same marker, reused for both marker-start and
    // marker-end (an edge's `arrow: 'both'`), points outward correctly at
    // each end without needing two separate marker defs.
    marker.setAttribute('orient', 'auto-start-reverse')
    marker.setAttribute('markerUnits', 'userSpaceOnUse')
    const arrowPath = doc.createElementNS(SVG_NS, 'path')
    arrowPath.setAttribute('class', EDGE_ARROW_CLASS)
    arrowPath.setAttribute('d', 'M0,0 L10,5 L0,10 Z')
    marker.appendChild(arrowPath)
    defs.appendChild(marker)
    edgesSvg.appendChild(defs)
    const edgesGroup = doc.createElementNS(SVG_NS, 'g')
    // Classed so the overview tier can take every edge out of the document
    // with one rule, without taking the connection preview below (a sibling,
    // not a child) with them.
    edgesGroup.setAttribute('class', EDGES_GROUP_CLASS)
    edgesSvg.appendChild(edgesGroup)
    const preview = doc.createElementNS(SVG_NS, 'path')
    preview.setAttribute('class', `${EDGE_PREVIEW_CLASS} ${EDGE_HIDDEN_CLASS}`)
    preview.setAttribute('marker-end', `url(#${this.arrowMarkerId})`)
    edgesSvg.appendChild(preview)
    world.appendChild(edgesSvg)

    const edgeLabels = doc.createElement('div')
    edgeLabels.className = EDGE_LABELS_CLASS
    world.appendChild(edgeLabels)

    // Mounted last so it sits above every card.
    const interactionLayer = buildInteractionLayer(doc)
    world.appendChild(interactionLayer)
    this.snapGuideLayer?.destroy()
    const snapGuides = new SnapGuideLayer(doc, world)
    this.snapGuideLayer = snapGuides
    this.spreadFrame?.destroy()
    const spreadFrame = new SpreadFrame(doc, world, {
      getBoard: () => this.board,
      getSelectedIds: () => this.selectedIds,
      getLiveRects: () => this.interaction.liveNodeRects,
      canEdit: () => this.canEdit,
      worldPointFromEvent: (e) => this.worldPointFromEvent(e),
      reflow: (id, columns, key) => this.reflowSpreadTo(id, columns, key),
      resize: (id, pageWidth, key) => this.resizeSpreadTo(id, pageWidth, key),
    })
    this.spreadFrame = spreadFrame
    this.pdfThumbnails?.destroy()
    this.pdfThumbnails = new PdfThumbnails({
      pdf: this.host.pdf,
      store: this.pdfThumbnailStore,
      queue: this.pdfDraws,
      doc,
      mtime: (path) => {
        const entry = this.host.vault.getEntry(path)
        return entry?.kind === 'file' ? entry.mtime : null
      },
      wanted: () => this.wantedThumbnails(),
      idle: () => !this.interacting && !spreadFrame.dragging,
      onChange: (path, page) => this.onThumbnailChange(path, page),
      reportError: (stage, error) => this.reportError(stage, error),
    })

    // The overview canvas goes in *before* the world layer, so everything the
    // world holds paints over it: the group frames and labels that stay in the
    // DOM at every tier, the resize handles, the snap guides, and an
    // in-flight connection's curve. See ./canvas/overviewLayer.ts.
    this.overviewLayer = new OverviewLayer(this.context, root, viewport, {
      getView: this.core.getView,
      getCardNodes: this.core.getCardNodes,
      getEdges: () => this.board.edges,
      getNode: this.core.getNode,
      isSelected: (id) => this.selectedIds.has(id),
      isEdgeSelected: (id) => this.selectedEdgeIds.has(id),
      getRenamingEdgeId: () => this.editing.renamingEdgeId,
      getLiveRects: () => this.interaction.liveNodeRects,
      pdfPageLabels: this.pdfPageLabels,
      spreadPageCountLabel: (id) => this.spreadPageCountLabel(id),
      pageThumbnail: (path, page, dark) =>
        this.pdfThumbnails?.get(path, page, dark) ?? null,
    })
    viewport.appendChild(world)
    // The empty element a pan captures the pointer on, so that the grabbing
    // cursor comes from it and the viewport's own style never changes during
    // a pan — see CameraController.beginPan.
    const panCapture = doc.createElement('div')
    panCapture.className = PAN_CAPTURE_CLASS
    viewport.appendChild(panCapture)
    root.appendChild(viewport)

    const error = doc.createElement('div')
    error.className = ERROR_CLASS
    root.appendChild(error)

    this.context.contentEl.replaceChildren(root)

    this.rootEl = root
    this.viewportEl = viewport
    this.viewportSize = null
    const win = doc.defaultView
    this.viewportObserver = win?.ResizeObserver
      ? new win.ResizeObserver(() => {
          this.viewportSize = null
        })
      : null
    this.viewportObserver?.observe(viewport)
    this.worldEl = world
    this.errorEl = error
    this.cameraController = new CameraController(
      this.context,
      viewport,
      world,
      panCapture,
      // Every world-layer overlay that is counter-scaled instead of drawn in
      // world units, and nothing else: the camera writes the counter-scale
      // variable on each of these rather than once on `world`, because a
      // custom property written on `world` restyles every card under it (see
      // CameraController's applyZoomScale).
      [interactionLayer, snapGuides.element, spreadFrame.element],
      // The two of them the overview tier takes out of the document, which is
      // why they are handed over separately — see the same method.
      [edgesSvg, edgeLabels],
      {
        isParseFailed: this.core.isParseFailed,
        isEditingWheelTarget: (target) =>
          this.editing.isEditing(nodeIdFromEventTarget(target)),
        scrollFocusedCardBy: (target, deltaX, deltaY) =>
          this.focusedNodeId !== null &&
          nodeIdFromEventTarget(target) === this.focusedNodeId &&
          this.cardRenderer.scrollCardContent(
            this.focusedNodeId,
            deltaX,
            deltaY,
          ),
        positionToolbar: () => this.toolbarController.positionToolbar(),
        setInteracting: (interacting) => {
          this.interacting = interacting
        },
        getSelectedNodes: () =>
          this.board.nodes.filter((node) => this.selectedIds.has(node.id)),
        getAllNodes: () => this.board.nodes,
        commitCamera: (camera) => {
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
        },
        afterCameraReset: () => {
          this.recomputeVisibility()
          this.drainQueues()
        },
        // The rename exemption: while a label is being typed in the tier,
        // its layer is back in the drawing (`syncEdgeRenameChrome`) and has
        // to keep its counter-scale current like any other chrome.
        isOverviewActive: () =>
          this.overviewChromeHidden && this.editing.renamingEdgeId === null,
      },
    )
    this.edgeLayer = new EdgeLayer(
      this.context,
      edgesGroup,
      edgeLabels,
      this.arrowMarkerId,
      {
        getNode: this.core.getNode,
        cancelActiveEdgeRename: () => {
          if (this.editing.renamingEdgeId !== null) {
            this.editing.endRename(false)
          }
        },
        getRenamingEdgeId: () => this.editing.renamingEdgeId,
        onLabelKeyDown: (id, event) =>
          this.editing.handleLabelKeyDown({ kind: 'edge', id }, event),
        onLabelBlur: (id) => this.editing.endRename(true, { kind: 'edge', id }),
        t: this.core.t,
      },
    )
    this.cardGeneration = new CardGeneration(this.host, {
      getBoard: this.core.getBoard,
      getNode: this.core.getNode,
      getSourcePath: this.core.getSourcePath,
      getBody: (id) => this.cardRenderer.getRuntime(id)?.bodyEl ?? null,
      isAvailable: () => this.canCreate,
      isFocused: (id) => this.focusedNodeId === id,
      editingText: (id) => this.editing.editingText(id),
      beginGeneration: (id) => this.editing.beginCardGeneration(id),
      endGeneration: (id, text, options) =>
        this.editing.endCardGeneration(id, text, options),
      reportError: this.core.reportError,
      notice: (message) => this.host.ui.notice(message),
      t: this.core.t,
    })
    this.cardRenderer = new CardRenderer(this.context, this.host, world, {
      getNode: this.core.getNode,
      isSelected: (id) => this.selectedIds.has(id),
      isFocused: (id) => this.focusedNodeId === id,
      isEditing: (id) => this.editing.isEditing(id),
      isGenerating: (id) => this.cardGeneration.isGenerating(id),
      isRenamingGroup: (id) => this.editing.isRenaming({ kind: 'group', id }),
      onGroupLabelKeyDown: (id, event) =>
        this.editing.handleLabelKeyDown({ kind: 'group', id }, event),
      onGroupLabelBlur: (id) =>
        this.editing.endRename(true, { kind: 'group', id }),
      onTextCardRendered: (id) => this.cardGeneration.syncChips(id),
      onTextMeasured: (id, size) => this.commitTextSize(id, size),
      onNoteCardRendered: (id) => this.dropImport.onNoteCardRendered(id),
      canBuildContent: () => this.canBuildContent,
      pdfDraws: this.pdfDraws,
      drawPriority: (id) => this.distanceFromViewCenter(id),
      pdfThumbnail: (path, page) => this.pdfThumbnails?.get(path, page) ?? null,
      queueContentSync: (id) => {
        this.contentSyncQueue.add(id)
      },
      dequeueContentSync: (id) => {
        this.contentSyncQueue.delete(id)
      },
      getMountedCount: () => this.engine.mounted.size,
      purgeNode: (id) => this.purgeNodeRuntime(id),
      getSourcePath: this.core.getSourcePath,
      getViewScale: () => this.cameraController.view.scale,
      getPdfStartPosition: (id) => {
        const node = this.core.getNode(id)
        return node?.type === 'file' ? node.startPage : undefined
      },
      openAnnotations: (path) => this.annotationStores.acquire(path),
      getAnnotationEvents: () => this.pdf.annotationEvents,
      spreadPageCountLabel: (id) => this.spreadPageCountLabel(id),
      pdfPageLabels: this.pdfPageLabels,
      reportError: this.core.reportError,
      t: this.core.t,
    })
    this.keymap = new KeymapController({
      core: this.core,
      isEditing: () => this.editing.isActive(),
      isRenaming: () => this.editing.isRenamingAny(),
      isPromptOpen: () => this.dropImport.isPromptOpen(),
      editCard: (id) => this.editing.editCard(id),
      fitAll: () => this.cameraController.fitCameraToNodes(this.board.nodes),
      zoomToSelection: () => this.cameraController.zoomToSelection(),
      resetCamera: () => this.cameraController.resetCamera(),
      zoomStep: (direction) => this.cameraController.zoomStep(direction),
      resetZoom: () => this.cameraController.resetZoom(),
      selectAll: () => this.selectAll(),
      duplicateSelection: () => this.clipboard.duplicateSelection(),
      nudgeSelection: (x, y) => this.nudgeSelection(x, y),
      armSpacePan: () => this.interaction.armSpacePan(),
    })
    this.registerBoardKeyLayers()
    this.editing = new EditingController({
      core: this.core,
      zoomInToEdit: (id) => this.zoomInToEdit(id),
      onEditingChange: () => this.toolbarController.refreshToolbar(),
      cards: this.cardRenderer,
      edges: this.edgeLayer,
      worldEl: world,
      pin: (id) => {
        this.pinnedIds.add(id)
      },
      unpin: (id) => {
        this.pinnedIds.delete(id)
      },
      syncChips: (id) => this.cardGeneration.syncChips(id),
      writeReadingWindow: (id, line) => {
        // Bare text shows all of itself; it has no window to remember.
        if (isPlainText(this.nodesById.get(id))) return
        const board = this.boardWithSnappedWindow(this.board, id, line)
        if (board === this.board) return
        this.board = board
        this.syncBoardIndex()
      },
      discardText: (id, historyKey) => this.discardText(id, historyKey),
      subscribeViewChange: (listener) =>
        this.cameraController.subscribeViewChange(listener),
      isOverviewChromeHidden: () => this.overviewChromeHidden,
      flushOverviewChromeZoomScale: () =>
        this.cameraController.flushOverviewChromeZoomScale(),
      closePopover: () => this.toolbarController.closePopover(),
      onRenameChange: () => this.keymap.syncSelectionScope(),
      keyLayers: this.keymap,
      focusBoard: () => viewport.focus({ preventScroll: true }),
    })
    // A PDF card draws its pages for the zoom they are seen at, so it has to
    // hear about every zoom — and redraws once one holds still (the reader's
    // own settle). Same lifetime as the camera and the renderer, so nothing
    // to unsubscribe.
    this.cameraController.subscribeViewChange(() => {
      this.cardRenderer.setViewScale(this.cameraController.view.scale)
      this.canvasControls?.refreshReadouts()
    })
    // Inside the viewport rather than the world: the toolbar is chrome, and
    // chrome does not zoom. Built last so it paints over the cards.
    this.toolbarController = new ToolbarController(this.context, viewport, {
      isParseFailed: this.core.isParseFailed,
      canEdit: this.core.canEdit,
      getBoard: this.core.getBoard,
      getSelectedIds: this.core.getSelectedIds,
      getSelectedEdgeIds: this.core.getSelectedEdgeIds,
      getEdge: this.core.getEdge,
      isPdfNode: (node) => isPdfNode(node),
      openReader: (id) => this.pdf.openReaderPanel(id),
      toggleSpread: (id) => void this.toggleSpread(id),
      edgeAnchorPoint: (id) => this.edgeAnchorPoint(id),
      getView: this.core.getView,
      getViewportSize: () => this.getViewportSize(),
      t: this.core.t,
      deleteNodes: (ids) => this.deleteNodes(ids),
      deleteEdges: (ids) => this.deleteEdges(ids),
      zoomToNodes: (nodes) => {
        this.cameraController.fitCameraToNodes(nodes)
      },
      getEditingNodeId: () => this.editing.getEditingNodeId(),
      createGroupFromSelection: () => this.createGroupFromSelection(),
      beginRename: (target) => this.editing.beginRename(target),
      applyColorToNodes: (ids, color) => this.applyColorToNodes(ids, color),
      applyColorToEdge: (edgeId, color) => this.applyColorToEdge(edgeId, color),
      setEdgeEnds: (edgeId, direction) => this.setEdgeEnds(edgeId, direction),
      alignSelection: (edge) => this.alignSelection(edge),
      distributeSelection: (axis) => this.distributeSelection(axis),
      tidySelection: () => this.tidySelection(),
    })
    this.pdf = new PdfIntegration({
      core: this.core,
      rootEl: root,
      viewportEl: viewport,
      readerPanelPrefs: this.readerPanelPrefs,
      annotationStores: this.annotationStores,
      annotationPrefs: this.annotationPrefs,
      getPdfPosition: (id) => this.cardRenderer.getPdfPosition(id),
      getEnteredNodeId: () => this.editing.getEnteredNodeId(),
      enterCard: (id) => this.editing.editCard(id),
      onResize: () => this.onResize(),
      keyLayers: this.keymap,
      runEscape: () => this.keymap.run('escape'),
      excerptDropPoint: (e) => this.dropImport.pointerDropPoint(e),
      showExcerptLanding: (rect) => this.dropImport.showLandingSlot(rect),
    })
    this.dropImport = new DropImport({
      core: this.core,
      viewportEl: viewport,
      worldEl: world,
      overlay: this.toolbarController.overlay,
      closePopover: () => this.toolbarController.closePopover(),
      onPromptChange: () => this.keymap.syncSelectionScope(),
      nodeIdAtPointer: (e) => this.interaction.nodeIdAtPointer(e),
      beginCreateDrag: (e, size, create) =>
        this.interaction.beginCreateDrag(e, size, create),
      enterEditMode: (id) => this.editing.enterEditMode(id),
      commitEditOn: (id) => this.editing.blurEditor([id]),
      purgeNodeRuntime: (id) => this.purgeNodeRuntime(id),
      isExcerptDrag: (e) => this.pdf.isExcerptDrag(e),
      previewExcerpt: (e, at) => this.pdf.previewExcerpt(e, at),
      dropExcerpt: (e, at, isOverCard) =>
        this.pdf.dropExcerpt(e, at, isOverCard),
      openReader: (id) => this.pdf.openReaderPanel(id),
      toggleSpread: (id) => void this.toggleSpread(id),
      exportAnnotatedPdfItem: (path) => this.pdf.exportAnnotatedPdfItem(path),
      createGroupFromSelection: () => this.createGroupFromSelection(),
      tidySelection: () => this.tidySelection(),
      alignSelection: (edge) => this.alignSelection(edge),
      distributeSelection: (axis) => this.distributeSelection(axis),
      beginRename: (target) => this.editing.beginRename(target),
      deleteNodes: (ids) => this.deleteNodes(ids),
      zoomToSelection: () => this.cameraController.zoomToSelection(),
      resetCamera: () => this.cameraController.resetCamera(),
    })
    this.clipboard = new ClipboardController({
      core: this.core,
      viewportEl: viewport,
      viewportCenterWorld: () => this.dropImport.viewportCenterWorld(),
      deleteNodes: (ids) => this.deleteNodes(ids),
      rebuildEdgesSvg: () => this.rebuildEdgesSvg(),
    })
    this.interaction = new InteractionController({
      core: this.core,
      viewportEl: viewport,
      worldEl: world,
      panCaptureEl: panCapture,
      interactionLayerEl: interactionLayer,
      previewPathEl: preview,
      getNodesById: () => this.nodesById,
      camera: this.cameraController,
      edges: this.edgeLayer,
      snapGuides,
      toolbar: this.toolbarController,
      editing: this.editing,
      generation: this.cardGeneration,
      menus: this.dropImport,
      pdf: this.pdf,
      pin: (id) => {
        this.pinnedIds.add(id)
      },
      unpin: (id) => {
        this.pinnedIds.delete(id)
      },
      queueContentSync: (id) => {
        this.contentSyncQueue.add(id)
      },
      onLiveRectsChange: () => {
        this.overviewLayer?.markDirty()
        this.spreadFrame?.sync()
      },
      onHoverChange: (id) => this.syncSpreadHover(id),
      overviewSpreadTitleAt: (point) =>
        this.overviewLayer?.spreadTitleAt(point) ?? null,
      rebuildEdgesSvg: () => this.rebuildEdgesSvg(),
    })
    this.emptyHintEl = this.buildEmptyHint(doc, this.toolbarController.overlay)
    // Obsidian Canvas's top-right column, in the same overlay for the same
    // reason. The buttons act on the board, so an open card edit is ended
    // first — the same as clicking anywhere else on the board would.
    const onBoard = (action: () => void) => () => {
      this.editing.forceCommitActiveEdit()
      action()
    }
    const mod = this.interaction.onMacOS() ? '⌘' : 'Ctrl'
    this.canvasControls = new CanvasControls(
      doc,
      this.toolbarController.overlay,
      [
        // Zoom in, where you are, zoom out — the two steps either side of
        // the value they change, the way every zoom control outside Canvas
        // reads. The value is the reset: 100% is what clicking it gives
        // back, so it needs no icon of its own (Canvas's reset was a
        // rotating arrow that read as "refresh").
        [
          {
            label: `${this.t('controls.zoomIn')}\n(${mod} =)`,
            icon: 'plus',
            onSelect: () => this.cameraController.zoomStep(1),
          },
          {
            label: `${this.t('controls.resetZoom')}\n(${mod} 0)`,
            readout: () =>
              `${String(Math.round(this.cameraController.view.scale * 100))}%`,
            onSelect: () => this.cameraController.resetZoom(),
          },
          {
            label: `${this.t('controls.zoomOut')}\n(${mod} -)`,
            icon: 'minus',
            onSelect: () => this.cameraController.zoomStep(-1),
          },
        ],
        [
          {
            // Canvas's own tooltip names the key, spelled the platform's way.
            label: `${this.t('controls.zoomToFit')}\n(${this.interaction.onMacOS() ? '⇧ 1' : 'Shift + 1'})`,
            icon: 'maximize',
            onSelect: () =>
              this.cameraController.fitCameraToNodes(this.board.nodes),
          },
        ],
        [
          {
            label: this.t('controls.undo'),
            icon: 'undo-2',
            onSelect: onBoard(() => this.undo()),
            isEnabled: () => this.history.canUndo(),
          },
          {
            label: this.t('controls.redo'),
            icon: 'redo-2',
            onSelect: onBoard(() => this.redo()),
            isEnabled: () => this.history.canRedo(),
          },
        ],
      ],
    )
    // A freshly built world element carries none of the old one's inline
    // custom properties, so the handle size has to be written again. It is
    // pushed from here rather than hard-coded in the stylesheet so it stays
    // next to the doc comment explaining the counter-scale law. Once, on
    // `world`, before any card is mounted — unlike the zoom multiplier, which
    // is rewritten on every zoom and therefore lives on the chrome layers
    // (see CameraController's applyZoomScale); the freshly constructed
    // `cameraController` above writes it, its counter-scale cache starting
    // unset. Everything else it drives — edge strokes, arrowheads, edge label
    // type — is computed in the stylesheet.
    world.style.setProperty(
      '--yolo-whiteboard-resizer-size',
      `${RESIZE_HANDLE_PX}px`,
    )

    this.setupInteraction()
    this.keymap.bindViewKeys()
    this.setupVaultSubscription()
    this.preheat()

    this.lastRecomputeTime = 0
    this.engine.reset()
    this.rafId = this.context.getWindow().requestAnimationFrame(this.frame)
    this.domReady = true
  }

  private setupInteraction(): void {
    this.interaction.bind()
    this.clipboard.bind()
    this.viewportEl.addEventListener('wheel', this.cameraController.onWheel, {
      passive: false,
    })
  }

  /** Content-freshness: scoped to the whole vault ('' —
   * see moduleVault.ts's `doesPathAffectScope`) because a note card's
   * backing file can live anywhere; `handleBackingFileModified` does the
   * actual per-card filtering. Set up once per leaf lifetime alongside the
   * pointer listeners; released in `dispose()`. */
  private setupVaultSubscription(): void {
    this.vaultSubscriptionDisposer = this.host.vault.subscribe('', (event) => {
      if (event.type !== 'create') {
        this.pdfThumbnails?.fileChanged(
          event.type === 'rename' ? event.oldPath : event.entry.path,
        )
      }
      if (event.type === 'delete' && this.pdf.onFileDeleted(event.entry.path)) {
        return
      }
      if (event.type !== 'modify') return
      this.handleBackingFileModified(event.entry.path)
    })
  }

  /**
   * Warms up the host's markdown rendering pipeline once per view instance
   * ("视图打开时用不可见卡预热渲染管线（首卡冷启动实测约 335ms）") — renders
   * into an off-screen (not `display:none`, so layout/measurement work isn't
   * skipped) element.
   *
   * Through the same renderer the cards use, so what is warmed is what they
   * will actually run: the markdown parse pipeline and its worker included.
   */
  private preheat(): void {
    if (!this.rootEl) return
    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = PREHEAT_CLASS
    this.rootEl.appendChild(el)
    try {
      const renderer = this.host.ui.createMarkdownRenderer()
      this.preheatRenderer = renderer
      void renderer
        .render('_', el, this.sourcePathForBoard())
        .catch((error: unknown) => {
          if (this.preheatRenderer !== renderer) return
          this.reportError('preheat render', error)
        })
    } catch (error) {
      this.reportError('preheat render', error)
    }
    // Kept for the view's lifetime rather than unloaded once it has drawn:
    // unloading is what cancels an in-flight render, and one empty off-screen
    // element costs nothing next to racing the thing it exists to warm.
    // Released in `dispose()`.
  }

  // -----------------------------------------------------------------------
  // Board mutation and history.
  //
  // Every content change goes through `applyBoardChange`: it is what keeps
  // "changed the board", "recorded a step", and "asked the host to save" from
  // ever drifting apart. Two things deliberately do not go through it — the
  // camera (a viewpoint, not content: an undo that moves the viewport is the
  // least welcome kind) and note-card self-heal (the view repairing a stale
  // reference, not something the user did).
  // -----------------------------------------------------------------------

  /**
   * Records where a card is being read, as a source line on the node itself.
   *
   * Written straight to `this.board` rather than through `applyBoardChange`,
   * the way the camera is: moving a window is not a step anyone wants to undo
   * one notch at a time. An undo still carries whatever window its snapshot
   * holds, which is the board as it was — the same deal the camera has.
   */
  private commitReadingWindow(id: NodeId): void {
    const line = this.cardRenderer.getContentScrollLine(id)
    const page = this.cardRenderer.getPdfPosition(id)
    // A PDF card's window is a page rather than a line — the same field
    // idea (fileFormat.ts's `startPage`), in the unit the document speaks.
    const next =
      line !== null
        ? this.boardWithSnappedWindow(this.board, id, line)
        : page !== null
          ? boardWithPageWindow(this.board, id, page)
          : this.board
    this.commitWithoutHistory(next)
  }

  /**
   * Bare text's measured size, written to its node (cardRenderer.ts's
   * `observeText`).
   *
   * Not a step: the size follows from the text and the width, which are what
   * was changed, and each of those is recorded where it was made. An undo
   * puts back the text, the text lays itself out, and the size follows it
   * back. Only the width of text whose width follows its content is taken
   * from the measurement; a width someone gave it is theirs.
   */
  private commitTextSize(
    id: NodeId,
    size: Readonly<{ w: number; h: number }>,
  ): void {
    const node = this.nodesById.get(id)
    if (!isPlainText(node)) return
    const w = node.autoWidth === true ? size.w : node.w
    if (w === node.w && size.h === node.h) return
    this.commitWithoutHistory(updateNode(this.board, id, { w, h: size.h }))
    this.edgeLayer.redrawEdgesForNodes(new Set([id]))
    this.interaction.refreshInteractionLayer()
    this.toolbarController.positionToolbar()
  }

  /**
   * Takes bare text that was left empty off the board.
   *
   * Text that never had anything in it was never recorded (the history's
   * present does not have it — see `createTextAt`), so it leaves no step
   * either: a double-click and a click away is nothing to undo. Text that
   * had content and was emptied is a deletion like any other, folded into
   * the editing session that emptied it.
   */
  private discardText(id: NodeId, historyKey: string): void {
    if (!this.nodesById.has(id)) return
    const next = removeNode(this.board, id)
    const recorded =
      this.history.present()?.nodes.some((node) => node.id === id) === true
    if (recorded) this.applyBoardChange(next, historyKey)
    else this.commitWithoutHistory(next)
    this.purgeNodeRuntime(id)
    this.interaction.refreshInteractionLayer()
    this.rebuildEdgesSvg()
  }

  /** The write path for board state that is not a step anyone would undo
   * (where a card is being read): written and saved, never recorded — the
   * same deal the camera has. */
  private commitWithoutHistory(next: Board): void {
    if (next === this.board) return
    this.board = next
    this.syncBoardIndex()
    this.context.requestSave()
  }

  /**
   * Puts a reading window on a card, snapped to where a block starts.
   *
   * Snapped here, at the one moment it is written, because the card's surfaces
   * cannot all honour an arbitrary line. The scrollable preview and the editor
   * can begin mid block — they have a scroll offset to hide the top of one
   * with — but a card that is not selected is a clipped one-pass render of
   * just the slice it can show, and a slice can only begin flush at a block.
   * Snapping there instead would leave that card sitting a block away from
   * what the same card shows the moment it is selected. One quantum, one
   * place: what is stored is already a block start, so every surface reads the
   * same number and lands in the same spot.
   */
  private boardWithSnappedWindow(
    board: Board,
    id: NodeId,
    line: number,
  ): Board {
    if (!Number.isFinite(line)) return board
    const markdown = this.cardMarkdown(id)
    return boardWithReadingWindow(
      board,
      id,
      markdown === null ? line : blockStartLine(markdown, line),
    )
  }

  /** The source a card is showing: a text card's lives in the board, a note
   * card's in the file, kept by whatever last read it. Null when the card has
   * no markdown behind it, or has not read it yet — in which case it cannot
   * have been scrolled either. */
  private cardMarkdown(id: NodeId): string | null {
    const node = this.nodesById.get(id)
    if (!node) return null
    if (node.type === 'text') return node.text
    if (node.type !== 'file') return null
    return this.cardRenderer.getRuntime(id)?.noteText ?? null
  }

  private applyBoardChange(next: Board, historyKey?: string): void {
    if (next === this.board) return
    const previous = this.nodesById
    this.board = next
    this.syncBoardIndex()
    this.markEntering(previous)
    this.history.push(next, historyKey)
    this.context.requestSave()
  }

  /** Records the nodes `nodesById` has and `previous` did not, as arriving. */
  private markEntering(previous: ReadonlyMap<NodeId, BoardNode>): void {
    const now = this.context.getWindow().performance.now()
    for (const id of this.nodesById.keys()) {
      if (!previous.has(id)) this.entering.set(id, now)
    }
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
    this.board = { ...next, camera: cameraFromView(this.cameraController.view) }
    this.syncBoardIndex()
    this.markEntering(previous)
    for (const [id, card] of previous) {
      if (this.nodesById.get(id) === card) continue
      // A node the snapshot no longer has at all leaves the way a deleted one
      // does; one that merely changed is rebuilt in place, which is not a
      // departure.
      this.purgeNodeRuntime(id, { exit: !this.nodesById.has(id) })
    }
    this.clearSelection()
    this.rebuildEdgesSvg()
    this.interaction.refreshInteractionLayer()
    this.recomputeVisibility()
    this.drainQueues()
    this.context.requestSave()
  }

  // ---- Agent edit surface -------------------------------------------------
  //
  // `edit_board` (host/boardTools.ts) edits the *open view* when the board it
  // was pointed at happens to be open, and the file only when it is not. Two
  // things follow from that, and neither is reachable by writing the file:
  //
  //   - The view is where the newest board is. Its saves are debounced, so
  //     for up to two seconds after a drag the file is stale; an edit
  //     computed from the file would silently undo that drag.
  //   - Cmd+Z gets the user back to before the agent touched anything,
  //     because the change lands as a history step like any other edit
  //     rather than as a file rewrite that resets the history.
  //
  // The path is the identity: a canvas is asked which board it is showing
  // rather than registered under a path, so a rename needs no bookkeeping.

  /** Vault path of the board on screen; empty before a file is loaded. */
  getBoardPath(): string {
    return this.sourcePathForBoard()
  }

  /** False when the board on screen failed to parse, in which case nothing
   * about it can be edited — the same test the interactive paths use. */
  canAcceptAgentEdit(): boolean {
    return this.canEdit
  }

  /**
   * Runs `edit` against the board on screen and puts the result back, as one
   * undoable step. `edit` returns the new board — or null to decline, which
   * is how a rejected operation leaves the view untouched — paired with
   * whatever the caller needs to know, which is handed straight back.
   *
   * The transform is passed in rather than the board handed out because the
   * two halves must not be separated: anything awaited between reading the
   * board and writing it back could let a keystroke or a drag land in
   * between, and the edit would be computed against a board that no longer
   * exists.
   */
  applyAgentEdit<T>(edit: (board: Board) => readonly [Board | null, T]): T {
    // A card whose editor is open holds its newest text in CodeMirror, not in
    // `this.board`. Committing first is what keeps the agent's edit from
    // being computed against — and then written over — what the user is in
    // the middle of typing.
    this.editing.forceCommitActiveEdit()
    // The agent reads and writes boards the way the file has them, so it is
    // handed that shape and its answer is opened back up (domain/spread.ts).
    const current = collapseBoard(this.board)
    const [edited, value] = edit(current)
    if (edited && edited !== current) {
      const next = expandBoard(edited)
      this.history.push(next)
      this.applyHistoryBoard(next)
    }
    return value
  }

  /** The board's own layer of each layered key, asked after every other:
   * Escape lets go of the selection, Delete deletes it, and undo/redo walk
   * the board's history. */
  private registerBoardKeyLayers(): void {
    const { keymap } = this
    keymap.addLayer('escape', KEY_LAYER_RANK.board, () => {
      if (this.selectedIds.size === 0 && this.selectedEdgeIds.size === 0) {
        return false
      }
      this.clearSelection()
      return true
    })
    keymap.addLayer('delete', KEY_LAYER_RANK.board, () => {
      this.deleteSelection()
      return true
    })
    keymap.addLayer('undo', KEY_LAYER_RANK.board, () => {
      this.undo()
      return true
    })
    keymap.addLayer('redo', KEY_LAYER_RANK.board, () => {
      this.redo()
      return true
    })
  }

  /** Whether the board can be changed at all — the single test every mutating
   * path starts with, so a new one cannot forget half of it. */
  private get canEdit(): boolean {
    return !this.parseFailed
  }

  // -----------------------------------------------------------------------
  // Selection. `selectedIds` is UI state only — never touches
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
        this.cardRenderer
          .getRuntime(id)
          ?.el?.classList.remove(CARD_SELECTED_CLASS)
    }
    for (const id of next) {
      if (!this.selectedIds.has(id))
        this.cardRenderer.getRuntime(id)?.el?.classList.add(CARD_SELECTED_CLASS)
    }
    // A selected spread's sheets are lit faintly, wherever they are, so the
    // document the selection names can be found on the board.
    for (const id of new Set([...this.selectedIds, ...next])) {
      const on = next.has(id)
      if (on === this.selectedIds.has(id)) continue
      if (!isSpreadTitle(this.nodesById.get(id))) continue
      for (const sheet of spreadPages(this.board, id)) {
        this.cardRenderer
          .getRuntime(sheet.id)
          ?.el?.classList.toggle(SPREAD_SHEET_OF_SELECTED_CLASS, on)
      }
    }
    this.selectedIds = next
    // The class writes above reach nothing in the overview tier; there the
    // selection ring is drawn.
    this.overviewLayer?.markDirty()
    this.spreadFrame?.sync()
    this.applyFocusedNode()
    this.keymap.syncSelectionScope()
    // Selection is one of the two things that decides where the handles are.
    this.interaction.updateInteractionLayer()
    this.toolbarController.refreshToolbar()
  }

  /** Keeps `focusedNodeId` and its class in step with the selection — see the
   * field's doc comment for what the state means. */
  /** "25 pages" for an open spread's title, in the current locale. */
  private spreadPageCountLabel(id: NodeId): string {
    return this.t('pdf.pageCount').replace(
      '{count}',
      String(spreadPages(this.board, id).length),
    )
  }

  /** What a PDF card's or a spread sheet's title says about its page
   * (ui/lod.ts's `nodeTitleText`), in the current locale. */
  private readonly pdfPageLabels: PdfPageLabels = {
    card: (name, page) =>
      this.t('pdf.pageTitle')
        .replace('{name}', name)
        .replace('{page}', String(page)),
    sheet: (page) => this.t('pdf.sheetTitle').replace('{page}', String(page)),
  }

  private applyFocusedNode(): void {
    const next =
      this.selectedIds.size === 1
        ? (this.selectedIds.values().next().value ?? null)
        : null
    if (next === this.focusedNodeId) return
    // The pointer only stays in a card for as long as that card is the one
    // selected: picking another card, or none, takes it back out. Done here
    // rather than at each call site because this is the one place focus
    // changes, and "entered" is only ever a state of the focused card.
    const entered = this.editing.getEnteredNodeId()
    if (entered !== null && entered !== next) {
      this.editing.exitLiveContent()
    }
    const previous = this.focusedNodeId
    if (previous !== null) {
      // Asked before the card is restyled, not after: reading the answer is a
      // layout read, and a layout flush is exactly what turns a class change
      // into a scroll container that no longer scrolls. This is also the path
      // a card takes into edit mode, which clears the selection before it
      // mounts the editor.
      this.commitReadingWindow(previous)
      this.cardRenderer
        .getRuntime(previous)
        ?.el?.classList.remove(CARD_FOCUSED_CLASS)
    }
    this.focusedNodeId = next
    if (next !== null) {
      this.cardRenderer.getRuntime(next)?.el?.classList.add(CARD_FOCUSED_CLASS)
    }
    // Focus decides how much of a card's note is built, because the focused
    // card is the one that can be scrolled (cardRenderer's
    // `renderMarkdownInto`). Both ends of the change are re-queued: the card
    // gaining focus needs the rest of its note, the one losing it should stop
    // paying for what it can no longer show. Queued rather than rendered here
    // so it answers to the same frame gate as every other build.
    if (previous !== null) this.contentSyncQueue.add(previous)
    if (next !== null) this.contentSyncQueue.add(next)
    // An empty card offers its AI hint only while it is the focused one.
    if (previous !== null) this.cardGeneration.syncChips(previous)
    if (next !== null) this.cardGeneration.syncChips(next)
    // A focused PDF card is a reader Mod+F can search.
    this.pdf.syncReaderKeymap()
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
    this.overviewLayer?.markDirty()
    this.keymap.syncSelectionScope()
    // A label being typed belongs to the edge that was selected when it
    // opened; deselecting that edge ends the session.
    this.editing.onEdgeSelectionChange(next)
    this.toolbarController.refreshToolbar()
  }

  private markEdgeSelected(id: EdgeId, selected: boolean): void {
    this.edgeLayer.setEdgeSelected(id, selected)
  }

  /** Clears both kinds of selection — what a click on empty canvas, or
   * entering a card's editor, means. */
  private clearSelection(): void {
    if (this.selectedIds.size > 0) this.setSelection([])
    if (this.selectedEdgeIds.size > 0) this.setEdgeSelection([])
  }

  // -----------------------------------------------------------------------
  // Selection toolbar: the `SelectionToolbar`
  // instance, its model-building, and its placement are
  // ./canvas/toolbarController.ts's job (split out structurally — see that
  // file's own doc comment). What stays here is every command whose whole
  // body is one board change plus one DOM call: the toolbar controller reads
  // this class's state to decide what to show, and calls back into these
  // when a button is pressed, so a colour picked from the toolbar is one
  // history step like any other edit.
  // -----------------------------------------------------------------------

  /** Applies (or clears) a colour across the selection. A cleared colour is
   * written as `undefined`, which `serializeBoard` simply omits — the same
   * shape a board that never had one has. */
  private applyColorToNodes(
    ids: readonly NodeId[],
    color: NodeColor | undefined,
  ): void {
    if (!this.canEdit) return
    let board = this.board
    for (const id of ids) {
      if ((this.nodesById.get(id)?.color ?? undefined) === color) continue
      board = updateNode(board, id, { color })
    }
    if (board === this.board) return
    this.applyBoardChange(board)
    for (const id of ids) {
      const el = this.cardRenderer.getRuntime(id)?.el
      if (el) applyColorToElement(el, color)
    }
  }

  private applyColorToEdge(edgeId: EdgeId, color: NodeColor | undefined): void {
    if (!this.canEdit) return
    const board = updateEdge(this.board, edgeId, { color })
    if (board === this.board) return
    this.applyBoardChange(board)
    this.edgeLayer.applyEdgeColor(edgeId, color)
  }

  /** Writes an edge's arrowhead ends — the board-side half of the toolbar
   * controller's arrow menu (`ToolbarController`'s own `showEdgeArrowMenu`
   * builds the menu; `edgeLayer.setEdgeArrowEnds` is the DOM half). */
  private setEdgeEnds(edgeId: EdgeId, direction: ArrowDirection): void {
    if (!this.canEdit) return
    const { fromEnd, toEnd } = arrowEnds(direction)
    const board = updateEdge(this.board, edgeId, { fromEnd, toEnd })
    if (board === this.board) return
    this.applyBoardChange(board)
    this.edgeLayer.setEdgeArrowEnds(
      edgeId,
      fromEnd === 'arrow',
      toEnd === 'arrow',
    )
  }

  /** World point an edge's chrome hangs from: the midpoint of its curve, the
   * same anchor its label already uses (domain/edges.ts's `EdgeGeometry`). */
  private edgeAnchorPoint(edgeId: EdgeId | undefined): ScreenPoint | null {
    const edge =
      edgeId === undefined ? undefined : this.boardEdgesById.get(edgeId)
    if (!edge) return null
    const from = this.edgeLayer.effectiveNodeRect(edge.fromNode)
    const to = this.edgeLayer.effectiveNodeRect(edge.toNode)
    if (!from || !to) return null
    const { fromSide, toSide } = resolveEdgeSides(
      from,
      to,
      edge.fromSide,
      edge.toSide,
    )
    return computeEdgeGeometry(from, to, fromSide, toSide).label
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
    if (!this.canEdit || ids.length === 0) return
    let board = this.board
    for (const id of ids) {
      if (board.edges.some((edge) => edge.id === id))
        board = removeEdge(board, id)
    }
    this.applyBoardChange(board)
    this.setEdgeSelection([])
    this.rebuildEdgesSvg()
  }

  private deleteNodes(asked: readonly NodeId[]): void {
    if (!this.canEdit) return
    // A spread's title takes its pages with it; a page on its own is part of
    // its PDF and is not deleted (domain/spread.ts's `nodesToDelete`).
    const ids = nodesToDelete(this.board.nodes, asked)
    if (ids.length === 0) return
    // Commit through the one blur path before the card stops existing,
    // rather than leaving an editor mounted on a deleted card.
    this.editing.blurEditor(ids)
    let board = this.board
    for (const id of ids) {
      if (board.nodes.some((node) => node.id === id))
        board = removeNode(board, id)
    }
    this.applyBoardChange(board)
    // Deleted on purpose, so each one is let go of visibly (cardRenderer's
    // `playExit`) rather than vanishing.
    for (const id of ids) this.purgeNodeRuntime(id, { exit: true })
    this.clearSelection()
    this.interaction.refreshInteractionLayer()
    // Deleting cards cascades edge removal (operations.ts's removeCard) —
    // the edge *set* changed, not just endpoint positions, so a full
    // rebuild (rather than redrawEdgesForNodes) is the correct response.
    this.rebuildEdgesSvg()
  }

  /** Whether a new card can be made at all right now — the shared gate behind
   * the creation bar, the creation menu items, and double-click-to-create. In
   * the overview tier a card has no element, so creating one there would leave
   * a rectangle on the canvas and no editor to type into. */
  private get canCreate(): boolean {
    return this.canEdit && !this.overview
  }

  // -----------------------------------------------------------------------
  // Groups, alignment and distribution.
  //
  // The geometry is in domain/ (groups.ts, arrange.ts) and unit-tested there;
  // what is left here is turning a selection into rectangles, handing them
  // over, and committing the answer as a single board change — one user
  // action, one undo step.
  // -----------------------------------------------------------------------

  /**
   * Wraps the current selection in a new group.
   *
   * The group is added *before* the nodes it encloses in board order, because
   * board order is paint order and a group is a frame behind its contents
   * (style.css gives groups a negative z-index for the same reason). It then
   * becomes the selection, since it is the thing that was just made.
   */
  private createGroupFromSelection(): void {
    if (!this.canEdit) return
    const nodes = this.board.nodes.filter((node) =>
      this.selectedIds.has(node.id),
    )
    const rect = groupRectForNodes(nodes)
    if (!rect) return
    const group: GroupNode = {
      id: this.nextNodeId(),
      type: 'group',
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.max(MIN_GROUP_SIZE.w, Math.round(rect.w)),
      h: Math.max(MIN_GROUP_SIZE.h, Math.round(rect.h)),
      extra: {},
    }
    this.applyBoardChange({
      ...this.board,
      nodes: [group, ...this.board.nodes],
    })
    this.recomputeVisibility()
    this.drainQueues()
    this.setSelection([group.id])
  }

  /** The nodes an align or distribute acts on — domain/groups.ts's
   * `arrangeTargets`, also what ./canvas/toolbarController.ts's arrange
   * button counts to decide whether to show at all. */
  private alignSelection(edge: AlignEdge): void {
    this.applyArrangement(
      alignRects(arrangeTargets(this.board, this.selectedIds), edge),
    )
  }

  private distributeSelection(axis: DistributeAxis): void {
    this.applyArrangement(
      distributeRects(arrangeTargets(this.board, this.selectedIds), axis),
    )
  }

  /** The one-click cleanup (domain/tidy.ts): even gaps, level edges, and the
   * order the user already has left untouched. Gaps land on the same lattice
   * a dragged card snaps to, so tidying and dragging agree about what "even"
   * means. */
  private tidySelection(): void {
    this.applyArrangement(
      tidyRects(
        arrangeTargets(this.board, this.selectedIds),
        GRID_WORLD_STEP_PX,
      ),
    )
  }

  /**
   * Spreads a PDF card's pages out on the board, or puts them away again
   * (domain/spread.ts) — one undoable step either way. Asked of a sheet, it
   * is asked of the document the sheet belongs to.
   *
   * A spread opened before comes back as it was left. The first one is laid
   * out as a grid under where the card's top-left corner was, which needs
   * every page's size and so waits for the document; the board may have
   * changed by the time it arrives, and the node is looked at again then.
   */
  private async toggleSpread(asked: NodeId): Promise<void> {
    if (!this.canEdit) return
    const target = this.nodesById.get(asked)
    const id = target?.type === 'pdf-page' ? target.parent : asked
    const node = this.nodesById.get(id)
    if (isSpreadTitle(node)) {
      await this.foldSpreadAway(id)
      return
    }
    if (!node || !isPdfNode(node)) return
    if (node.spread) {
      this.beginSpreadDeal(id, node)
      this.commitSpreadToggle(id, openSpread(this.board, id))
      this.dealOnOverview(id)
      return
    }
    let sizes: readonly Readonly<{ width: number; height: number }>[]
    try {
      sizes = await this.pdf.pageSizes(node.file)
    } catch (error) {
      this.reportError('pdf spread', error)
      this.host.ui.notice(this.t('pdf.openFailed'))
      return
    }
    const now = this.nodesById.get(id)
    if (!this.canEdit || !now || !isPdfNode(now) || isSpreadTitle(now)) return
    if (now.file !== node.file || sizes.length === 0) return
    // The sheets are as wide as the card: one document, one width. The first
    // row is where the card is, under the title (`foldedCardOrigin`).
    const metrics = { ...SPREAD_METRICS, pageWidth: now.w }
    const layout = layoutSpreadGrid(
      sizes,
      { x: now.x, y: now.y - metrics.titleHeight - metrics.titleGap },
      defaultSpreadColumns(sizes, metrics),
      metrics,
    )
    this.beginSpreadDeal(id, now)
    this.commitSpreadToggle(id, openSpread(this.board, id, layout))
    this.dealOnOverview(id)
  }

  /** The overview tier's deal: the canvas carries each sheet out of the
   * card's corner, in the same order and timing as `playSpreadDeal`. */
  private dealOnOverview(id: NodeId): void {
    const deal = this.spreadDeal
    if (!this.overview || !deal || deal.parent !== id) return
    this.spreadDeal = null
    for (const sheet of spreadPages(this.board, id)) {
      this.overviewLayer?.animate(sheet.id, {
        direction: 'in',
        offset: { x: deal.origin.x - sheet.x, y: deal.origin.y - sheet.y },
        delay: Math.min(
          (sheet.page - 1) * SPREAD_DEAL_STAGGER_MS,
          SPREAD_DEAL_MAX_DELAY_MS,
        ),
      })
    }
  }

  private prefersReducedMotion(): boolean {
    // A JS-driven animation, so the reduced-motion degrade is ours to make
    // (CLAUDE.md) — the global CSS fallback does not reach WAAPI.
    return this.context
      .getWindow()
      .matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /** Arms the deal for a spread about to open from `card`: its sheets will
   * leave the card's corner as they mount (`playSpreadDeal`), or, in the
   * overview tier where nothing mounts, as the canvas draws them
   * (`dealOnOverview`). */
  private beginSpreadDeal(id: NodeId, card: BoardNode): void {
    this.spreadDeal = this.prefersReducedMotion()
      ? null
      : {
          parent: id,
          origin: { x: card.x, y: card.y },
          startedAt: this.context.getWindow().performance.now(),
        }
  }

  /**
   * A sheet of the spread just opened, dealt from the card's corner to its
   * place: the page is seen coming out of the card it was in. Page order
   * sets when it leaves (constants.ts's SPREAD_DEAL_*). Only `transform` and
   * `opacity`, as a Web Animation, so nothing is left on the element.
   */
  private playSpreadDeal(id: NodeId): void {
    const deal = this.spreadDeal
    if (!deal) return
    const now = this.context.getWindow().performance.now()
    if (now - deal.startedAt > SPREAD_DEAL_WINDOW_MS) {
      this.spreadDeal = null
      return
    }
    const node = this.nodesById.get(id)
    if (node?.type !== 'pdf-page' || node.parent !== deal.parent) return
    const el = this.cardRenderer.getRuntime(id)?.el
    if (!el) return
    const dx = deal.origin.x - node.x
    const dy = deal.origin.y - node.y
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      {
        duration: ARRANGE_ANIMATION_MS,
        easing: ARRANGE_ANIMATION_EASING,
        delay: Math.min(
          (node.page - 1) * SPREAD_DEAL_STAGGER_MS,
          SPREAD_DEAL_MAX_DELAY_MS,
        ),
        fill: 'backwards',
      },
    )
  }

  /**
   * Closes a spread the way it opened, backwards: the sheets on screen slide
   * into the corner the card comes back to (under the title, where the first
   * page is) and fade, and only then is the spread closed and the card faded
   * in where they went. A second ask while they travel is the
   * same ask, and is let go.
   */
  private async foldSpreadAway(id: NodeId): Promise<void> {
    if (this.spreadsFolding.has(id)) return
    const title = this.nodesById.get(id)
    if (!title) return
    const corner = foldedCardOrigin(title)
    const gathering: Animation[] = []
    const onOverview = this.overview && !this.prefersReducedMotion()
    if (onOverview) {
      // No elements to animate: the canvas gathers the sheets instead, and
      // the spread closes when they have arrived.
      for (const sheet of spreadPages(this.board, id)) {
        this.overviewLayer?.animate(sheet.id, {
          direction: 'out',
          offset: { x: corner.x - sheet.x, y: corner.y - sheet.y },
          delay: 0,
        })
      }
      this.spreadsFolding.add(id)
      await new Promise((resolve) =>
        this.context.getWindow().setTimeout(resolve, ARRANGE_ANIMATION_MS),
      )
      this.spreadsFolding.delete(id)
      if (!isSpreadTitle(this.nodesById.get(id))) {
        this.overviewLayer?.stopAnimating(
          spreadPages(this.board, id).map((sheet) => sheet.id),
        )
        return
      }
      this.commitSpreadToggle(id, closeSpread(this.board, id))
      this.overviewLayer?.animate(id, {
        direction: 'in',
        offset: { x: 0, y: 0 },
        delay: 0,
      })
      return
    }
    if (!this.prefersReducedMotion()) {
      for (const sheet of spreadPages(this.board, id)) {
        const el = this.cardRenderer.getRuntime(sheet.id)?.el
        if (!el) continue
        const dx = corner.x - sheet.x
        const dy = corner.y - sheet.y
        gathering.push(
          el.animate(
            [
              { transform: 'none', opacity: 1 },
              { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
            ],
            {
              duration: ARRANGE_ANIMATION_MS,
              easing: ARRANGE_ANIMATION_EASING,
              fill: 'forwards',
            },
          ),
        )
      }
    }
    if (gathering.length > 0) {
      this.spreadsFolding.add(id)
      // A sheet torn down mid-flight cancels its animation; that is not a
      // reason to leave the spread open.
      await Promise.allSettled(gathering.map((animation) => animation.finished))
      this.spreadsFolding.delete(id)
    }
    if (!isSpreadTitle(this.nodesById.get(id))) {
      // Closed or undone some other way meanwhile: the sheets that are still
      // there are shown again, not left gathered and invisible.
      for (const animation of gathering) animation.cancel()
      return
    }
    this.commitSpreadToggle(id, closeSpread(this.board, id))
    if (gathering.length === 0) return
    this.cardRenderer
      .getRuntime(id)
      ?.el?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: ARRANGE_ANIMATION_MS,
        easing: ARRANGE_ANIMATION_EASING,
      })
  }

  /**
   * The pointer on a spread's title lights up every one of its sheets, so
   * the pieces of paper that are one document read as one — wherever on the
   * board they have been put.
   */
  private syncSpreadHover(id: NodeId | null): void {
    const title = id === null ? null : this.nodesById.get(id)
    const next = isSpreadTitle(title ?? undefined) ? id : null
    if (next === this.hoveredSpreadId) return
    const mark = (titleId: NodeId, on: boolean) => {
      for (const node of spreadPages(this.board, titleId)) {
        this.cardRenderer
          .getRuntime(node.id)
          ?.el?.classList.toggle(SPREAD_SIBLING_CLASS, on)
      }
    }
    if (this.hoveredSpreadId !== null) mark(this.hoveredSpreadId, false)
    this.hoveredSpreadId = next
    if (next !== null) mark(next, true)
  }

  /** The spread frame's handle: every sheet laid out again at `columns`
   * across, animated there like any arrangement, and one undo step for the
   * whole drag (`historyKey`). */
  private reflowSpreadTo(
    id: NodeId,
    columns: number,
    historyKey: string,
  ): void {
    const next = reflowSpread(this.board, id, columns)
    if (next === this.board) return
    const requested = new Map<NodeId, Readonly<{ x: number; y: number }>>()
    for (const node of spreadPages(next, id)) {
      requested.set(node.id, { x: node.x, y: node.y })
    }
    this.applyArrangement(requested, { historyKey })
  }

  /** Makes an open spread's sheets `pageWidth` wide, the whole document
   * scaled about its title's corner (domain/spread.ts's `scaleSpread`), as
   * part of the step `historyKey` names. The elements are resized in place;
   * a sheet's reader follows its element's size on its own. */
  private resizeSpreadTo(
    id: NodeId,
    pageWidth: number,
    historyKey: string,
  ): void {
    if (!this.canEdit) return
    const next = scaleSpread(this.board, id, pageWidth)
    if (next === this.board) return
    this.applyBoardChange(next, historyKey)
    const changed = new Set<NodeId>([
      id,
      ...spreadPages(next, id).map((sheet) => sheet.id),
    ])
    for (const nodeId of changed) {
      const el = this.cardRenderer.getRuntime(nodeId)?.el
      const node = this.nodesById.get(nodeId)
      if (!el || !node) continue
      el.style.left = `${node.x}px`
      el.style.top = `${node.y}px`
      el.style.width = `${node.w}px`
      el.style.height = `${node.h}px`
    }
    this.edgeLayer.redrawEdgesForNodes(changed)
    this.interaction.refreshInteractionLayer()
    this.toolbarController.positionToolbar()
    this.recomputeVisibility()
    this.drainQueues()
  }

  /** Puts a spread opened or put away on screen: the node's element was a
   * card and is now a title, or the other way round, so it is built again,
   * and the sheets come and go with the ordinary mount and purge. */
  private commitSpreadToggle(id: NodeId, next: Board): void {
    if (next === this.board) return
    const before = this.nodesById
    this.editing.blurEditor([id])
    this.applyBoardChange(next)
    this.purgeNodeRuntime(id)
    for (const [nodeId, node] of before) {
      if (node.type === 'pdf-page' && !this.nodesById.has(nodeId)) {
        this.purgeNodeRuntime(nodeId)
      }
    }
    // What was just spread out is new to the board, not arriving from off
    // screen: its sheets are the same paper the card held.
    for (const nodeId of this.nodesById.keys()) this.entering.delete(nodeId)
    this.setSelection([id])
    this.rebuildEdgesSvg()
    this.interaction.refreshInteractionLayer()
    this.recomputeVisibility()
    this.drainQueues()
  }

  /**
   * Edit, asked for in the overview tier: the camera glides in to the card —
   * to 1:1, or to whatever fits it if it is bigger than the viewport — and
   * the editor opens once the card has an element again (`openPendingEdit`).
   * The zoom is never below what leaves the tier, or the card would never
   * come back to open.
   */
  private zoomInToEdit(id: NodeId): void {
    const node = this.nodesById.get(id)
    if (!node) return
    // A quarter above where the tier ends, so a card bigger than the
    // viewport still lands clear of the hysteresis band.
    this.cameraController.focusNode(node, OVERVIEW_RESTORE_SCALE * 1.25)
    this.pendingEdit = {
      id,
      until: this.context.getWindow().performance.now() + PENDING_EDIT_WAIT_MS,
    }
  }

  /** Opens the card `zoomInToEdit` is waiting on, once it can be — or drops
   * the wait, if it has taken too long or the card has gone. */
  private openPendingEdit(now: number): void {
    const pending = this.pendingEdit
    if (!pending) return
    if (now > pending.until || !this.nodesById.has(pending.id)) {
      this.pendingEdit = null
      return
    }
    if (this.overview) return
    const runtime = this.cardRenderer.getRuntime(pending.id)
    if (!runtime?.el) return
    // A note card's editor needs the file's text first (enterEditMode).
    const node = this.nodesById.get(pending.id)
    if (node?.type === 'file' && isMarkdownPath(node.file)) {
      if (runtime.noteText === null) return
    }
    this.pendingEdit = null
    this.editing.editCard(pending.id)
  }

  /** Mod+A: every node on the board. Declined on an empty board, so the key
   * travels on to Obsidian rather than being swallowed for nothing. */
  private selectAll(): boolean {
    if (this.board.nodes.length === 0) return false
    this.setSelection(this.board.nodes.map((node) => node.id))
    return true
  }

  /**
   * Arrow keys: the selection moves by whole grid steps, so a nudged card
   * stays on the lattice the rest were snapped to. A run of nudges is one
   * undo step — held down, an arrow repeats thirty times a second, and nobody
   * wants to undo it thirty times — which is what the shared history key
   * does until anything else is recorded.
   */
  private nudgeSelection(stepsX: number, stepsY: number): boolean {
    if (!this.canEdit || this.selectedIds.size === 0) return false
    const dx = stepsX * GRID_WORLD_STEP_PX
    const dy = stepsY * GRID_WORLD_STEP_PX
    const requested = new Map<NodeId, Readonly<{ x: number; y: number }>>()
    for (const id of this.selectedIds) {
      const node = this.nodesById.get(id)
      if (node) requested.set(id, { x: node.x + dx, y: node.y + dy })
    }
    this.applyArrangement(requested, { animate: false, historyKey: 'nudge' })
    return true
  }

  /** Commits a batch of new positions and brings the canvas back in step with
   * them. A group among them carries what it holds, the same law a drag obeys
   * (`carryGroupMembers`). `setNodePositions` returns the same board when
   * nothing moved, so an align that changes nothing records no history step
   * and redraws nothing. */
  private applyArrangement(
    requested: ReadonlyMap<NodeId, Readonly<{ x: number; y: number }>>,
    options?: Readonly<{ animate?: boolean; historyKey?: string }>,
  ): void {
    if (!this.canEdit || requested.size === 0) return
    const positions = carryGroupMembers(this.board.nodes, requested)
    const before = new Map<NodeId, Readonly<{ x: number; y: number }>>()
    for (const id of positions.keys()) {
      const node = this.nodesById.get(id)
      if (node) before.set(id, { x: node.x, y: node.y })
    }
    const next = setNodePositions(this.board, positions)
    if (next === this.board) return
    this.applyBoardChange(next, options?.historyKey)
    const moved: { el: HTMLElement; dx: number; dy: number }[] = []
    for (const id of positions.keys()) {
      const el = this.cardRenderer.getRuntime(id)?.el
      const node = this.nodesById.get(id)
      if (!el || !node) continue
      el.style.left = `${node.x}px`
      el.style.top = `${node.y}px`
      const from = before.get(id)
      if (!from) continue
      const dx = from.x - node.x
      const dy = from.y - node.y
      if (dx !== 0 || dy !== 0) moved.push({ el, dx, dy })
    }
    if (options?.animate !== false) this.animateArrangement(moved)
    this.edgeLayer.redrawEdgesForNodes(new Set(positions.keys()))
    this.interaction.refreshInteractionLayer()
    this.toolbarController.positionToolbar()
    this.recomputeVisibility()
    this.drainQueues()
  }

  /**
   * FLIP for an arrangement: the cards already carry their new `left`/`top`,
   * so each is offset back to where it came from and animated to zero.
   *
   * Not decoration. These commands move several cards at once and the user
   * pointed at none of them — with no travel there is nothing on screen saying
   * what happened or which cards it happened to, and the command reads as "I
   * pressed something, and maybe nothing occurred". Only `transform` is
   * animated (CLAUDE.md), and as a Web Animation rather than a transition
   * class, so nothing is left behind on the element for the next drag to
   * inherit.
   */
  private animateArrangement(
    moved: readonly { el: HTMLElement; dx: number; dy: number }[],
  ): void {
    if (moved.length === 0) return
    if (this.prefersReducedMotion()) return
    for (const { el, dx, dy } of moved) {
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: ARRANGE_ANIMATION_MS, easing: ARRANGE_ANIMATION_EASING },
      )
    }
  }

  /** Minted against `board` rather than `this.board` where a caller is
   * building up several cards before committing them — two ids drawn from
   * the same four-hex space have to see each other to stay apart. */
  private nextNodeId(board: Board = this.board): NodeId {
    return mintNodeId(board)
  }

  private nextEdgeId(): EdgeId {
    return mintEdgeId(this.board)
  }

  private worldPointFromEvent(e: MouseEvent): ScreenPoint {
    return screenToWorld(
      this.cameraController.view,
      this.cameraController.viewportPointFromEvent(e),
    )
  }

  /** Fully removes a card no longer present in `board` (as opposed to
   * `unmountNode`, which keeps its runtime entry around — minus the DOM —
   * for a card that's merely scrolled off-screen but still valid). Keeps
   * the virtualization engine's bookkeeping in sync via `markUnmounted`
   * since a removed card is absent from the `cards` array `recompute()`
   * iterates, so it would otherwise never be queued for unmount on its
   * own. */
  private purgeNodeRuntime(
    id: NodeId,
    options?: Readonly<{ exit?: boolean }>,
  ): void {
    this.entering.delete(id)
    // A run writing into a card that is going away has nowhere to land: the
    // stop settles it, and `planNodeCommit` finds no node to commit to.
    this.cardGeneration.stop(id)
    // The node is going away, so there is nothing left to rename and nothing
    // to write what was typed to; drop the session rather than commit it.
    this.editing.endRename(false, { kind: 'group', id })
    // The runtime-map half of this teardown is cardRenderer's own state; see
    // its `destroyRuntime` doc comment for why the operation is still one
    // call from every caller but this one's point of view (`evictParkedCard`
    // reaches this same method back through the `purgeNode` callback).
    this.cardRenderer.destroyRuntime(id, options)
    this.pinnedIds.delete(id)
    this.contentSyncQueue.delete(id)
    this.engine.markUnmounted(id)
  }

  // -----------------------------------------------------------------------
  // Virtualization loop
  // -----------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    // Before the camera glide: a drag reads the live camera to convert its
    // screen delta, and the position the pointer reported belongs to the
    // camera the user was looking at when they reported it.
    // First of all: a drag held at the viewport's edge moves the camera, and
    // everything after reads the camera it moved to.
    this.interaction.advanceAutoPan(now)
    this.interaction.consumePointerMove()
    this.cameraController.advanceCameraGlide(now)
    if (now - this.lastRecomputeTime > RECOMPUTE_INTERVAL_MS) {
      this.recomputeVisibility()
      this.lastRecomputeTime = now
    }
    // Whether this frame builds card content. While the camera moves, only
    // frames that follow an on-time one do: the work is priced by its effect
    // on the frame it lands in, and that is the only place it can be read.
    const sinceLastFrame =
      this.lastFrameAt === null ? 0 : now - this.lastFrameAt
    this.lastFrameAt = now
    this.canBuildContent =
      !this.interacting || sinceLastFrame <= FRAME_ON_TIME_MS
    this.drainQueues()
    this.pdfDraws.pump()
    this.pdfThumbnails?.pump()
    this.settleOverviewLinger()
    this.openPendingEdit(now)
    // Last: it draws the camera the world layer was just given, and the
    // geometry the queues above have just finished changing.
    this.overviewLayer?.render()
    this.rafId = this.context.getWindow().requestAnimationFrame(this.frame)
  }

  private recomputeVisibility(): void {
    if (this.parseFailed || !this.viewportEl) return
    const { width, height } = this.getViewportSize()
    const rect = computeWorldViewportRect(
      width,
      height,
      this.cameraController.view,
      VIEWPORT_BUFFER_PX,
    )
    this.overviewLayer?.setViewportSize(width, height)
    this.updateOverviewState()
    const moved = this.interaction.liveNodeRects
    if (this.overview) {
      // Two populations, one engine: groups keep their DOM at every tier
      // and are asked the ordinary question, cards are asked one they
      // cannot answer yes to.
      this.engine.recompute(this.groupNodes, rect, this.pinnedIds, moved)
      this.engine.recompute(this.cardNodes, UNREACHABLE_RECT, NO_PINS)
    } else {
      this.engine.recompute(this.board.nodes, rect, this.pinnedIds, moved)
    }
    // Edges answer to the same viewport, on the same tick — see
    // edgeLayer.ts's `updateVisibility`. Not in the overview tier: there the
    // edge DOM is out of the document altogether and the canvas is drawing
    // them, so which of them the viewport covers is not a question worth
    // asking — and asking it costs a style recalculation over three thousand
    // elements per tick, which a `display: none` ancestor does not save (only
    // layout is skipped for a hidden subtree, not style). Leaving the tier
    // runs this again on the same tick, with the real rectangle.
    if (!this.overview) {
      this.edgeLayer.updateVisibility(rect, this.edgePinnedIds(moved))
    }
    this.syncGroupLabelScale()
  }

  /** Every page of every open spread, and the pages a folded PDF card shows
   * from where it was left, with how far each is from the middle of the
   * viewport — what thumbnails are made for, nearest first. */
  private *wantedThumbnails(): Iterable<WantedThumbnail> {
    const view = this.worldViewportRect(0)
    const cx = (view.left + view.right) / 2
    const cy = (view.top + view.bottom) / 2
    for (const node of this.cardNodes) {
      const distance = Math.hypot(
        node.x + node.w / 2 - cx,
        node.y + node.h / 2 - cy,
      )
      if (node.type === 'pdf-page') {
        yield { path: node.file, page: node.page, distance }
        continue
      }
      if (!isPdfNode(node) || isSpreadTitle(node)) continue
      // As many as the card holds at the widest page shape a document is
      // likely to have, and the one cut off at the bottom.
      const first = Math.floor(node.startPage ?? 1)
      const shown = Math.ceil(node.h / (node.w * FOLDED_PAGE_MIN_ASPECT)) + 1
      for (let page = first; page < first + shown; page += 1) {
        yield { path: node.file, page, distance }
      }
    }
  }

  /** A thumbnail was made (`page`), or a file's were dropped (null): the
   * overview redraws, and the sheet showing that page takes it if it has
   * nothing better yet. */
  private onThumbnailChange(path: string, page: number | null): void {
    this.overviewLayer?.markDirty()
    if (page === null) return
    for (const node of this.cardNodes) {
      if (node.type !== 'pdf-page' || node.page !== page) continue
      if (node.file !== path) continue
      this.cardRenderer.getRuntime(node.id)?.pdfReader?.placeholderReady()
    }
  }

  /** How far a card's middle is from the viewport's, in world units — the
   * order PDF pages are drawn in. */
  private distanceFromViewCenter(id: NodeId): number {
    const node = this.nodesById.get(id)
    if (!node) return Number.POSITIVE_INFINITY
    const view = this.worldViewportRect(0)
    return Math.hypot(
      node.x + node.w / 2 - (view.left + view.right) / 2,
      node.y + node.h / 2 - (view.top + view.bottom) / 2,
    )
  }

  /** Whose edges stay drawn wherever the viewport is: the pinned cards',
   * and those of the cards a gesture is carrying, which are drawn where the
   * gesture has them rather than where the viewport test would look. */
  private edgePinnedIds(
    moved: ReadonlyMap<NodeId, CardRect> | null,
  ): ReadonlySet<NodeId> {
    if (!moved || moved.size === 0) return this.pinnedIds
    return new Set([...this.pinnedIds, ...moved.keys()])
  }

  /** The viewport in world coordinates, grown by `buffer` screen pixels —
   * by default the virtualization buffer, which is what decides which cards
   * are mounted and which edges are drawn. */
  private worldViewportRect(buffer = VIEWPORT_BUFFER_PX): WorldRect {
    const { width, height } = this.getViewportSize()
    return computeWorldViewportRect(
      width,
      height,
      this.cameraController.view,
      buffer,
    )
  }

  /** See `viewportSize`. A size of nothing is not kept: the view measured
   * before it was laid out, and the next reader should look again. */
  private getViewportSize(): Readonly<{ width: number; height: number }> {
    if (this.viewportSize) return this.viewportSize
    const size = {
      width: this.viewportEl.clientWidth,
      height: this.viewportEl.clientHeight,
    }
    if (size.width > 0 && size.height > 0) this.viewportSize = size
    return size
  }

  /**
   * Flips the rendering tier at this method's ~70ms throttle
   * (recomputeVisibility's caller), not per frame —
   * "阈值切换时机放在相机 settle 或节流点，不逐帧判断切换". This throttle point
   * (rather than only the longer 300ms camera-settle debounce) keeps a
   * deliberate zoom-out gesture feeling responsive.
   *
   * Below the threshold no card is mounted at all: the board is drawn by
   * `overviewLayer` on one canvas, because what a card costs at this zoom is
   * not what it contains but that it exists (see that module's doc comment).
   * The world layer stays — it still holds the groups, the resize handles and
   * the snap guides — and gets a class so the stylesheet can take the edge DOM
   * out of the document, which the canvas is now drawing too.
   *
   * The parking pool is frozen for the length of the tier. Entering it
   * unmounts every card, which the pool's ordinary rule reads as "nothing is
   * mounted, so nothing should be parked" and answers by destroying exactly
   * the cards the user is about to zoom back into. Zooming out to find a
   * region and back in to work in it is one action, not two, and the far end
   * of it must not be a screen rebuilding itself.
   *
   * Editing a card and creating one both need an element (`canCreate`), so the
   * toolbar's edit button and the whole creation bar appear and disappear with
   * this state rather than staying on screen offering what would be declined.
   */
  private updateOverviewState(): void {
    const next = nextOverviewState(
      this.cameraController.view.scale,
      this.overview,
      {
        enter: OVERVIEW_SCALE_THRESHOLD,
        restore: OVERVIEW_RESTORE_SCALE,
      },
    )
    if (next === this.overview) return
    this.overview = next
    if (next) {
      this.overviewLingering = false
      this.worldEl.classList.add(WORLD_OVERVIEW_CLASS)
      this.overviewLayer?.setActive(true)
      this.cardRenderer.freezeParkedCapacity()
    } else {
      // Neither the class nor `setActive(false)` here: which layer *renders*
      // and which population is virtualized are two different switches, and
      // the second one is not instant. The cards this tier unmounted come back
      // a few per frame (MOUNT_QUOTA_PER_FRAME) — ending the tier on the tick
      // the threshold is crossed leaves the board blank and then hatches it
      // card by card. So the canvas keeps drawing, and the edge DOM stays out
      // of the document, until they are all back (`settleOverviewLinger`).
      this.overviewLingering = true
      this.cardRenderer.unfreezeParkedCapacity()
    }
    this.editing.syncEdgeRenameChrome()
    this.toolbarController.refreshToolbar()
    this.dropImport.refreshCardMenu()
  }

  /**
   * Ends the tier once the mount queue its exit filled has drained: the canvas
   * stops drawing and the edge DOM comes back, in that one frame.
   *
   * Both, together, or neither. The canvas sits *behind* the world layer, so
   * while it is drawing the board, anything the world holds paints over its
   * drawing — the edges included. Putting the edges back before the cards are
   * there would hang every line on the board over the cards the canvas is
   * still drawing, for as long as the mount queue takes to drain, which at a
   * screenful of cards is long enough to read as a bug rather than a flicker.
   * Held to the same frame, the handoff is invisible: every card that mounts
   * covers its own drawing, and the last frame of the tier is one where the
   * canvas has nothing left to show that the DOM is not already showing.
   *
   * Runs after `drainQueues` and before the canvas draws, so the frame that
   * mounts the last card is the frame the tier ends on: both land in one
   * paint, and there is no moment where the board is showing neither.
   */
  private settleOverviewLinger(): void {
    if (!this.overviewLingering) return
    if (this.engine.pendingMountCount > 0) return
    this.overviewLingering = false
    // Before the class comes off: the edges are counter-scaled by a variable
    // the camera stops writing to them while they are out of the drawing (see
    // CameraController's applyZoomScale), and they must not be put back still
    // carrying the weight they had on the way in.
    this.cameraController.flushOverviewChromeZoomScale()
    this.worldEl.classList.remove(WORLD_OVERVIEW_CLASS)
    this.overviewLayer?.setActive(false)
    this.editing.syncEdgeRenameChrome()
  }

  /**
   * Keeps a group's label readable in the overview tier.
   *
   * The label is drawn in world units like everything else in the world layer,
   * so at 0.05 it is a third of a pixel of type — and the frames are the only
   * landmarks left down there, which unreadable ones are not. Counter-scaled
   * to a floor of ~12 screen pixels while the tier lasts, and handed back to
   * the stylesheet on the way out, where the label is part of the drawing
   * again.
   *
   * Not the world layer's `--yolo-whiteboard-zoom-multiplier` treatment: that
   * law (1/sqrt) is for chrome that should still grow with the zoom, and this
   * is a floor. Written on the few dozen label elements rather than as a
   * custom property — see cardRenderer's `setGroupLabelFontSize`.
   */
  private syncGroupLabelScale(): void {
    const { scale } = this.cameraController.view
    this.cardRenderer.setGroupLabelFontSize(
      this.overview
        ? Math.max(
            GROUP_LABEL_WORLD_FONT_PX,
            OVERVIEW_GROUP_LABEL_MIN_SCREEN_PX / scale,
          )
        : null,
    )
  }

  private drainQueues(): void {
    const { toMount, toUnmount } = this.engine.drain(
      MOUNT_QUOTA_PER_FRAME,
      UNMOUNT_QUOTA_PER_FRAME,
    )
    const now =
      this.entering.size > 0 ? this.context.getWindow().performance.now() : 0
    for (const id of toMount) {
      this.cardRenderer.mountNode(id)
      this.interaction.adoptMountedCard(id)
      this.playSpreadDeal(id)
      const addedAt = this.entering.get(id)
      if (addedAt === undefined) continue
      this.entering.delete(id)
      if (now - addedAt <= NODE_ENTER_WINDOW_MS) this.cardRenderer.playEnter(id)
    }
    for (const id of toUnmount) this.cardRenderer.unmountNode(id)
    this.drainContentSync()
  }

  /**
   * Builds the content a card is owed, on the frames this one is allowed to
   * build on. A Set iterates in insertion order and tolerates deletion
   * mid-iteration, so it serves as both the queue and the membership test.
   *
   * The frame gate decides *whether* to build; the start cap
   * (CONTENT_BUILD_START_CAP_PER_FRAME) bounds how many builds one frame may
   * begin. A note card reads its file before it can render, and the read is
   * nearly free — without the cap one qualifying frame would start a hundred
   * reads and then be handed a hundred renders. Each of those still checks the
   * gate when it lands (`renderMarkdownInto`), so the cap does not have to be
   * tight; it only has to be finite, and small enough that a frame cannot
   * spend its whole budget here.
   */
  private drainContentSync(): void {
    let started = 0
    for (const id of this.contentSyncQueue) {
      if (!this.canBuildContent) return
      if (started >= CONTENT_BUILD_START_CAP_PER_FRAME) return
      this.contentSyncQueue.delete(id)
      started += 1
      this.syncNodeContent(id)
    }
  }

  private syncNodeContent(id: NodeId): void {
    const runtime = this.cardRenderer.getRuntime(id)
    if (!runtime?.el || !runtime.bodyEl) return
    // Entered edit mode after being queued: the editor owns the body now.
    if (this.editing.isEditing(id)) return
    void this.cardRenderer.renderCardPreview(id)
  }

  // -----------------------------------------------------------------------
  // Edges: drawing is ./canvas/edgeLayer.ts's job (see that file's doc
  // comment for the two redraw paths and why endpoint coordinates always
  // come from board data, never the DOM). What stays here is board-edge
  // bookkeeping (`boardEdgesById`) and re-applying the *selection* after a
  // rebuild has replaced every path element — a concern of `selectedEdgeIds`,
  // which this class owns, not of edge drawing.
  // -----------------------------------------------------------------------

  /**
   * Every mounted card's chips, re-asked. Which chips an empty card offers
   * depends on what points into it (`cardInstructions`), so the one place
   * that answer can change without the card itself being re-rendered is an
   * edge appearing or disappearing.
   */
  private syncAllChips(): void {
    for (const id of this.engine.mounted) this.cardGeneration.syncChips(id)
  }

  private rebuildEdgesSvg(): void {
    this.edgeLayer.rebuildEdgesSvg(this.board.edges)
    // A rebuild starts every edge visible; cull the off-screen ones now rather
    // than leaving a board's worth of them in the document until the next
    // visibility tick.
    if (this.viewportEl) {
      this.edgeLayer.updateVisibility(this.worldViewportRect(), this.pinnedIds)
    }
    this.restoreEdgeSelection()
    this.syncAllChips()
  }

  /** Drops selected ids whose edge is gone and re-applies the class to the
   * rest, after a rebuild has replaced every path element. */
  private restoreEdgeSelection(): void {
    const surviving = Array.from(this.selectedEdgeIds).filter((id) =>
      this.boardEdgesById.has(id),
    )
    this.selectedEdgeIds = new Set(surviving)
    for (const id of surviving) this.markEdgeSelected(id, true)
    this.keymap.syncSelectionScope()
    this.toolbarController.refreshToolbar()
  }

  // -----------------------------------------------------------------------
  // Teardown / error state
  // -----------------------------------------------------------------------

  private teardownAllCards(): void {
    this.editing.forceCommitActiveEdit()
    // Every card is about to be destroyed, and a run's text belongs to the
    // board that is going away — committing it here would land it on the one
    // arriving (the reason `endEditForIncomingBoard` exists). What streamed is
    // already in `getViewData`'s snapshot, so nothing typed or generated is
    // lost by dropping it.
    this.cardGeneration.abandonAll()
    this.interaction.reset()
    this.keymap.popSelectionScope()
    this.selectedIds = new Set()
    this.focusedNodeId = null
    // Dropped rather than exited: every card element is about to go, so there
    // is no class left to take off one.
    this.editing.forgetEntered()
    this.cardRenderer.destroyAll()
    this.pinnedIds.clear()
    this.entering.clear()
    this.contentSyncQueue.clear()
    this.engine.reset()
    this.edgeLayer.clearEdgesSvg()
  }

  private syncBoardIndex(): void {
    this.nodesById = new Map(this.board.nodes.map((node) => [node.id, node]))
    this.cardNodes = this.board.nodes.filter((node) => node.type !== 'group')
    this.groupNodes = this.board.nodes.filter((node) => node.type === 'group')
    this.boardEdgesById = new Map(
      this.board.edges.map((edge) => [edge.id, edge]),
    )
    this.syncEmptyHint()
    this.spreadFrame?.sync()
    this.pdfThumbnails?.retain()
    // The overview tier draws from this index rather than from the DOM, so
    // every board change is a redraw — this is the one place they all pass
    // through.
    this.overviewLayer?.markDirty()
    // And the one place the panel can learn its card was deleted, undone
    // away, or pointed at another file.
    this.pdf.syncWithBoard()
  }

  // ---------------------------------------------------------------------
  // Self-heal ("自愈层"): run once per setViewData, right
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
  // Content-freshness ("内容时效"): a mounted note card's
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
      if (this.editing.isEditing(id)) continue
      const runtime = this.cardRenderer.getRuntime(id)
      if (!runtime?.el) continue // not currently mounted
      if (isMarkdownPath(node.file)) {
        void this.refreshMountedNoteCard(id, runtime, path)
        continue
      }
      // Anything else has no text to re-read, and its resource URL carries
      // the file's mtime — so the way to show new bytes is a new element.
      void this.cardRenderer.renderCardPreview(id)
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
    if (this.cardRenderer.getRuntime(id) !== runtime) return
    if (this.editing.isEditing(id)) return
    if (runtime.noteText === text) return // no real change — short-circuit
    runtime.noteText = text
    runtime.missingFile = false
    this.cardRenderer.renderMarkdownInto(id, runtime, text, path)
  }

  /**
   * What a brand-new board says: how to put the first thing on it. A blank
   * dot grid tells someone who has never used one nothing — not that a
   * double-click makes a card, not that files can be dropped in, not how to
   * move around — and Canvas's own empty board has the same silence.
   *
   * Screen-space chrome in the toolbar's overlay, pointer-transparent so the
   * double-click it describes lands on the board behind it. The two second
   * lines are both built and the stylesheet shows the one for the device
   * (`.is-mobile`), so nothing here has to know what it is running on.
   */
  private buildEmptyHint(doc: Document, parent: HTMLElement): HTMLElement {
    const el = doc.createElement('div')
    el.className = EMPTY_HINT_CLASS
    const title = doc.createElement('div')
    title.className = EMPTY_HINT_TITLE_CLASS
    title.textContent = this.t('emptyBoard.title')
    const desktop = doc.createElement('div')
    desktop.className = `${EMPTY_HINT_LINE_CLASS} ${EMPTY_HINT_DESKTOP_CLASS}`
    desktop.textContent = this.t('emptyBoard.desktopHint')
    const touch = doc.createElement('div')
    touch.className = `${EMPTY_HINT_LINE_CLASS} ${EMPTY_HINT_TOUCH_CLASS}`
    touch.textContent = this.t('emptyBoard.touchHint')
    el.append(title, desktop, touch)
    parent.appendChild(el)
    return el
  }

  /** Shown exactly while the board parsed and holds nothing. Faded out by the
   * stylesheet as the first card arrives, so the card is what the eye follows. */
  private syncEmptyHint(): void {
    this.emptyHintEl?.classList.toggle(
      EMPTY_HINT_VISIBLE_CLASS,
      !this.parseFailed && this.board.nodes.length === 0,
    )
    // An emptied board brings the creation bar back out for good.
    this.dropImport?.refreshCardMenu()
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
