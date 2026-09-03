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
  ALIGN_EDGES,
  type AlignEdge,
  DISTRIBUTE_AXES,
  type DistributeAxis,
  alignRects,
  distributeRects,
} from '../domain/arrange'
import {
  cameraFromView,
  distanceBetween,
  gridStepForScale,
  screenDeltaToWorld,
  screenToWorld,
} from '../domain/camera'
import type { ScreenPoint } from '../domain/camera'
import { planNodeCommit } from '../domain/commit'
import {
  type ArrowDirection,
  NODE_SIDES,
  type SideAnchor,
  anchorPoint,
  arrowEnds,
  buildEdge,
  buildEdgePathD,
  computeEdgeGeometry,
  edgeAtPoint,
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
  type GroupNode,
  type LinkNode,
  type NodeColor,
  type NodeId,
  type NodeSide,
  type TextNode,
  emptyBoard,
  parseBoard,
  serializeBoard,
} from '../domain/fileFormat'
import {
  GROUP_SELECTION_PADDING,
  arrangeTargets,
  carryGroupMembers,
  groupRectForNodes,
  nodesToDragWith,
} from '../domain/groups'
import { BoardHistory } from '../domain/history'
import { mintEdgeId, mintNodeId } from '../domain/ids'
import {
  basenameWithoutExtension,
  cardNoteContent,
  fileNodeKind,
  folderPathOf,
  generateCardNoteFileName,
  generateDroppedHtmlFileName,
  isMarkdownPath,
} from '../domain/naming'
import {
  addEdge,
  addNode,
  boardWithReadingWindow,
  moveNodes,
  removeEdge,
  removeNode,
  replaceNode,
  setNodePositions,
  updateEdge,
  updateNode,
} from '../domain/operations'
import {
  type CardRect,
  type CardSize,
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
import { type SnapGuide, snapMove, snapResize } from '../domain/snapping'
import { tidyRects } from '../domain/tidy'
import {
  type CanvasView,
  type VirtualCardRect,
  VirtualizationEngine,
  type WorldRect,
  computeWorldViewportRect,
  intersectsViewport,
} from '../domain/virtualization'
import { takePendingFit } from '../host/pendingFit'
import { createWhiteboardTranslation } from '../i18n'

import { CameraController } from './canvas/cameraController'
import { CardRenderer, type NodeRuntime } from './canvas/cardRenderer'
import { EdgeLayer } from './canvas/edgeLayer'
import { OverviewLayer } from './canvas/overviewLayer'
import { SnapGuideLayer } from './canvas/snapGuideLayer'
import {
  ALIGN_MENU,
  DISTRIBUTE_MENU,
  ToolbarController,
} from './canvas/toolbarController'
import {
  CardMenu,
  type CardMenuAction,
  type CardMenuIconName,
} from './cardMenu'
import {
  ARRANGE_ANIMATION_EASING,
  ARRANGE_ANIMATION_MS,
  CARD_BODY_LIVE_CLASS,
  CARD_ENTERED_CLASS,
  CARD_FOCUSED_CLASS,
  CARD_SELECTED_CLASS,
  CONNECT_SNAP_WORLD_PX,
  CONTENT_BUILD_START_CAP_PER_FRAME,
  DRAG_THRESHOLD_PX,
  DROP_STAGGER_PX,
  EDGE_HIDDEN_CLASS,
  EDGE_HIT_CLASS,
  EDGE_HIT_STROKE_WORLD_PX,
  EDGE_LABEL_CLASS,
  EDIT_PERSIST_THROTTLE_MS,
  FRAME_ON_TIME_MS,
  GRID_MIN_SCREEN_STEP_PX,
  GRID_WORLD_STEP_PX,
  GROUP_LABEL_CLASS,
  GROUP_LABEL_WORLD_FONT_PX,
  MIN_CARD_SIZE,
  MOUNT_QUOTA_PER_FRAME,
  NEW_CARD_SIZE,
  NEW_EMBED_CARD_SIZE,
  OVERVIEW_GROUP_LABEL_MIN_SCREEN_PX,
  OVERVIEW_RESTORE_SCALE,
  OVERVIEW_SCALE_THRESHOLD,
  RECOMPUTE_INTERVAL_MS,
  RESIZE_HANDLE_PX,
  SNAP_SCREEN_PX,
  SVG_NS,
  UNMOUNT_QUOTA_PER_FRAME,
  VIEWPORT_BUFFER_PX,
  WEB_URL_PATTERN,
} from './constants'
import { asElement, asNode } from './eventTarget'
import { blockStartLine, nextOverviewState } from './lod'
import {
  PromptOverlay,
  type PromptOverlayOptions,
  type PromptSuggestion,
} from './promptOverlay'
import { applyColorToElement } from './selectionToolbar'

/**
 * Size of a group created around a selection is derived from that selection
 * (domain/groups.ts), so this is only the fallback a group gets when it is
 * created around nothing — which cannot happen today, but keeps the geometry
 * total.
 */
const MIN_GROUP_SIZE = Object.freeze({ w: 200, h: 160 })

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
const VIEWPORT_CLASS = 'yolo-whiteboard-viewport'
const PAN_CAPTURE_CLASS = 'yolo-whiteboard-pan-capture'
const VIEWPORT_HIDDEN_CLASS = 'yolo-whiteboard-viewport-hidden'
const VIEWPORT_DROP_ACTIVE_CLASS = 'yolo-whiteboard-viewport-drop-active'
const WORLD_CLASS = 'yolo-whiteboard-world'
/** On the world layer while the overview tier is drawing the board: what the
 * stylesheet keys "no edge DOM at all" off. A class rather than a custom
 * property, so Blink's invalidation set is the two layers the rule names
 * rather than the world's whole subtree (see CameraController's
 * applyZoomScale for what the other choice costs). */
const WORLD_OVERVIEW_CLASS = 'yolo-whiteboard-world-overview'
/** On the world layer while an edge label is being typed in the overview
 * tier — see `syncEdgeRenameChrome`. */
const WORLD_EDGE_RENAME_CLASS = 'yolo-whiteboard-world-edge-rename'
const INTERACTION_LAYER_CLASS = 'yolo-whiteboard-interaction-layer'
const INTERACTION_LAYER_HIDDEN_CLASS =
  'yolo-whiteboard-interaction-layer-hidden'
const RESIZER_CLASS = 'yolo-whiteboard-resizer'
const CONNECTION_POINT_CLASS = 'yolo-whiteboard-connection-point'
const CARD_EDITING_CLASS = 'yolo-whiteboard-card-editing'
const CARD_DRAGGING_CLASS = 'yolo-whiteboard-card-dragging'
const CARD_CONNECT_TARGET_CLASS = 'yolo-whiteboard-card-connect-target'
const MARQUEE_CLASS = 'yolo-whiteboard-marquee'
const CREATE_GHOST_CLASS = 'yolo-whiteboard-create-ghost'
const EDGES_SVG_CLASS = 'yolo-whiteboard-edges'
const EDGES_GROUP_CLASS = 'yolo-whiteboard-edges-group'
const EDGE_ARROW_MARKER_CLASS = 'yolo-whiteboard-edge-arrow-marker'
const EDGE_ARROW_CLASS = 'yolo-whiteboard-edge-arrow'
const EDGE_LABELS_CLASS = 'yolo-whiteboard-edge-labels'
const EDGE_PREVIEW_CLASS = 'yolo-whiteboard-edge-preview'
const EDITOR_HOST_CLASS = 'yolo-whiteboard-editor-host'
const ERROR_CLASS = 'yolo-whiteboard-error'
const ERROR_VISIBLE_CLASS = 'yolo-whiteboard-error-visible'
const ERROR_TITLE_CLASS = 'yolo-whiteboard-error-title'
const ERROR_HINT_CLASS = 'yolo-whiteboard-error-hint'
const PREHEAT_CLASS = 'yolo-whiteboard-preheat'

// `NodeRuntime` now lives in ./canvas/cardRenderer.ts (imported above as a
// type), which owns the mounted-card map it describes.

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
//
// Every one of them carries the `pointerId` of the press that started it, and
// every one of them captures that pointer on the viewport. Capture routes that
// pointer's events here, but it does not stop a *second* pointer from being
// reported: a touch screen or a pen reports each contact separately, and with
// the moves coalesced into one slot (`pendingPointerMove`) whichever arrived
// last would be the position the gesture is updated from — a drag that jumps to
// a second finger. So a move or an up is only the gesture's if it names the
// gesture's pointer.

type PanInteraction = Readonly<{
  kind: 'pan'
  /** The press that started this gesture; see the section comment. */
  pointerId: number
  origin: CanvasView
  startX: number
  startY: number
}>

/** Screen-space (viewport-local) coordinates — see startMarquee()'s doc
 * comment for why both `originLocal` and `originClient` are tracked. */
type MarqueeInteraction = Readonly<{
  kind: 'marquee'
  pointerId: number
  originLocal: ScreenPoint
  originClient: ScreenPoint
  /** Shift was held at press: the band adds to the selection rather than
   * replacing it, and `baseIds` is what it adds to. Snapshotted here because
   * the live selection is cleared as the band is drawn. */
  additive: boolean
  baseIds: readonly NodeId[]
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
  readonly pointerId: number
  readonly nodeId: NodeId
  readonly startClient: ScreenPoint
  /** Shift was held: a press that never moves toggles this card in and out of
   * the selection instead of replacing it. */
  readonly additive: boolean
  dragging: boolean
  ids: NodeId[]
  readonly startPositions: Map<NodeId, Readonly<{ x: number; y: number }>>
  /** What this drag may line up with, frozen when it becomes a drag for the
   * same reason `ids` is (see `beginNodeDrag`). */
  snapCandidates: readonly CardRect[]
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
  readonly pointerId: number
  readonly nodeId: NodeId
  readonly handle: ResizeHandle
  readonly startClient: ScreenPoint
  readonly startRect: CardRect
  dragging: boolean
  /** As `NodeInteraction.snapCandidates`, frozen when the press becomes a
   * drag rather than at press time — most presses on a handle are clicks. */
  snapCandidates: readonly CardRect[]
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
  readonly pointerId: number
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

/**
 * A press on one of the creation bar's buttons, which is a card being pulled
 * off the bar and has not yet decided whether it is going anywhere: below
 * `DRAG_THRESHOLD_PX` it is the click that creates in the middle of the
 * screen, past it the card is placed where the pointer lets go.
 *
 * `create` is the whole difference between the four buttons — the ghost, the
 * snapping and the drop are one gesture whatever is about to be made.
 */
type CreateInteraction = {
  readonly kind: 'create'
  readonly pointerId: number
  readonly startClient: ScreenPoint
  /** The card's size, carried so the ghost is the card: one table feeds both
   * (see `creationAction`), and they cannot disagree. */
  readonly size: CardSize
  readonly create: (at: ScreenPoint) => void
  dragging: boolean
  /** As the other drags: frozen when the press becomes one. */
  snapCandidates: readonly CardRect[]
}

type Interaction =
  | PanInteraction
  | MarqueeInteraction
  | NodeInteraction
  | ResizeInteraction
  | ConnectInteraction
  | CreateInteraction

/** Which label a rename is acting on. The two kinds are typed the same way
 * (in place, on the element itself) and differ only in where the text is
 * read from and written back to. */
type LabelTarget =
  | Readonly<{ kind: 'group'; id: NodeId }>
  | Readonly<{ kind: 'edge'; id: EdgeId }>

function sameLabelTarget(a: LabelTarget, b: LabelTarget): boolean {
  return a.kind === b.kind && a.id === b.id
}

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
  /**
   * The other half of the same split. Groups keep their DOM at every zoom
   * (P4-D2), so the two populations answer to different viewport rects in the
   * overview tier and have to be handed to the virtualization engine
   * separately — see `recomputeVisibility`.
   */
  private groupNodes: readonly BoardNode[] = []
  /** Card DOM/content lifecycle — mount/unmount, the hidden pool, per-card
   * rendering. Owns `NodeRuntime`; constructed once in `ensureDom` (see
   * ./canvas/cardRenderer.ts's own doc comment for the split's rationale). */
  private cardRenderer!: CardRenderer
  private readonly engine = new VirtualizationEngine()
  private readonly pinnedIds = new Set<NodeId>()

  /** Undo/redo over board content. Seeded on load, pushed by
   * `applyBoardChange`, and never touched by camera movement (see
   * `applyHistoryBoard`). */
  private readonly history = new BoardHistory()
  /** The off-screen card that warms the rendering pipeline; see `preheat`. */
  private preheatRenderer: ReturnType<
    YoloModuleHostApiV1['ui']['createMarkdownRenderer']
  > | null = null
  private viewKeymapDisposer: (() => void) | null = null
  private editSessionCounter = 0

  /** Camera (pan/zoom) state and its glide animation. Constructed once in
   * `ensureDom` (see ./canvas/cameraController.ts's own doc comment). Gesture
   * code reads its live position through the `view` getter and
   * `viewportPointFromEvent`/`worldPointFromEvent`; it never writes the
   * camera directly. */
  private cameraController!: CameraController
  /**
   * What the last press landed on — the only trustworthy answer to "what was
   * clicked" this canvas has.
   *
   * Every drag it starts captures the pointer on the viewport, and capture
   * retargets the mouse events synthesised afterwards: measured in a real
   * window, `click` and `dblclick` arrive naming `.yolo-whiteboard-viewport`
   * and never the element that was actually pressed. `pointerdown` is the
   * last event that still names it. (Obsidian Canvas keeps no such record
   * because it never captures — it tracks its drags on the window instead —
   * which is why its own double-click can simply ask whether `e.target` is
   * the canvas surface.)
   */
  private pressedTarget: EventTarget | null = null
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
  /**
   * The card the pointer has been let into, or null.
   *
   * Only ever the focused card — entering is asked for on a selected card and
   * `applyFocusedNode` drops it the moment focus moves on — but it is its own
   * field rather than a flag on the focus, because that is the whole
   * distinction: a card can be selected without its content being reachable,
   * which is what keeps a selected web card draggable. See
   * `enterLiveContent` and CARD_ENTERED_CLASS.
   */
  private enteredNodeId: NodeId | null = null
  private selectionScopeDisposer: (() => void) | null = null
  private marqueeEl: HTMLElement | null = null

  // Selection toolbar (P3 batch 3, surfaces ①/②): one instance per view,
  // rebuilt on selection change and re-placed whenever the camera or the
  // selection's geometry moves. It lives in the viewport (screen-space) layer,
  // so it keeps a constant size at every zoom — see ./canvas/toolbarController.ts,
  // ui/selectionToolbar.ts and domain/toolbar.ts for the placement law.
  /** Constructed once in `ensureDom`, once the viewport element exists (see
   * ./canvas/toolbarController.ts's own doc comment). */
  private toolbarController!: ToolbarController
  /** The label being typed in place, if any — see `beginRename`. It holds
   * off the selection's keymap scope for as long as it has the caret. */
  private renaming: LabelTarget | null = null

  // Creation surfaces (P3 batch 3 wave B): the bottom bar, and the panel that
  // asks which file or what URL before a card can be made.
  private cardMenu: CardMenu | null = null
  private prompt: PromptOverlay | null = null

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

  // Edges (W3-A): a single SVG overlay drawn into the world layer, redrawn
  // wholesale on structural change (rebuildEdgesSvg) and per-path on card
  // position change (redrawEdgesForNodes) — see ./canvas/edgeLayer.ts, which
  // owns the SVG's child elements and the incidence index, and its own doc
  // comment for the mount-independent, DOM-measurement-free approach.
  /** Constructed once in `ensureDom`, once the edges `<svg>` exists. */
  private edgeLayer!: EdgeLayer
  /** Drawn only while a drag or a resize is lining something up. */
  private snapGuideLayer: SnapGuideLayer | null = null
  /**
   * The overview tier's renderer (P4-1). Built in `ensureDom`; null before
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
  /**
   * Uncommitted geometry for the nodes a drag or a resize is moving, or null.
   *
   * In the DOM tiers the live feedback *is* the `transform` written on each
   * card's element, and this is only the map those writes were computed from.
   * In the overview tier there are no elements, so this is the feedback: the
   * canvas draws from it (`OverviewLayerCallbacks.getLiveRects`). Published
   * from one place either way, so the two tiers cannot disagree about where a
   * card is being dragged to.
   */
  private liveNodeRects: ReadonlyMap<NodeId, CardRect> | null = null
  /** The outline of the card a creation-bar drag is about to make. Built for
   * the gesture and removed with it — one element per drag is cheaper than a
   * permanent one to keep in step with a world layer that is rebuilt on every
   * reload. */
  private createGhostEl: HTMLElement | null = null
  /** Which key waves alignment away, which is a platform question — resolved
   * once, on first use (see `snappingWanted`). */
  private isMacOS: boolean | null = null
  /** canvas.ts's own copy of the board's edges by id, kept in step by
   * `syncBoardIndex` — the lookup every edge-*gesture* and label-editing path
   * here uses; `edgeLayer` keeps a separate copy scoped to its own drawing
   * (see that file's doc comment on why the two are not merged). */
  private boardEdgesById = new Map<EdgeId, Edge>()
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
    // Before `teardownAllCards`, whose own commit path would land the edit on
    // the board this method is about to replace. See the doc comment.
    this.endEditForIncomingBoard()
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
    this.cameraController.loadCamera(this.board.camera)
    // Cards were all torn down above: whatever the layer was parked on is
    // either gone or somewhere else now.
    this.refreshInteractionLayer()
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
   *    side effects (a note card's live text isn't part of the board at all
   *    — p1-design §1.2 — so there is nothing to fold in for that case; only
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
    this.forceCommitActiveEdit()
    const win = this.context.getWindow()
    if (this.rafId !== null) {
      win.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.cameraController.dispose()
    this.viewportEl?.removeEventListener('pointerdown', this.onPointerDown)
    this.viewportEl?.removeEventListener('wheel', this.cameraController.onWheel)
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

    this.endRename(true)
    this.prompt?.close()
    this.prompt = null
    this.cardMenu?.destroy()
    this.cardMenu = null
    this.toolbarController.destroy()
    this.overviewLayer?.destroy()
    this.overviewLayer = null
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
    this.snapGuideLayer?.destroy()
    this.snapGuideLayer = new SnapGuideLayer(doc, world)

    // The overview canvas goes in *before* the world layer, so everything the
    // world holds paints over it: the group frames and labels that stay in the
    // DOM at every tier (P4-D2), the resize handles, the snap guides, and an
    // in-flight connection's curve. See ./canvas/overviewLayer.ts.
    this.overviewLayer = new OverviewLayer(this.context, root, viewport, {
      getView: () => this.cameraController.view,
      getCardNodes: () => this.cardNodes,
      getEdges: () => this.board.edges,
      getNode: (id) => this.nodesById.get(id),
      isSelected: (id) => this.selectedIds.has(id),
      isEdgeSelected: (id) => this.selectedEdgeIds.has(id),
      getRenamingEdgeId: () => this.renamingEdgeId,
      getLiveRects: () => this.liveNodeRects,
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
    this.worldEl = world
    this.errorEl = error
    this.previewPathEl = preview
    this.interactionLayerEl = interactionLayer
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
      [interactionLayer, this.snapGuideLayer.element],
      // The two of them the overview tier takes out of the document, which is
      // why they are handed over separately — see the same method.
      [edgesSvg, edgeLabels],
      {
        isParseFailed: () => this.parseFailed,
        isEditingWheelTarget: (target) =>
          this.editing !== null &&
          this.nodeIdFromEventTarget(target) === this.editing.nodeId,
        scrollFocusedCardBy: (target, deltaX, deltaY) =>
          this.focusedNodeId !== null &&
          this.nodeIdFromEventTarget(target) === this.focusedNodeId &&
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
          this.overviewChromeHidden && this.renamingEdgeId === null,
      },
    )
    this.edgeLayer = new EdgeLayer(
      this.context,
      edgesGroup,
      edgeLabels,
      this.arrowMarkerId,
      {
        getNode: (id) => this.nodesById.get(id),
        cancelActiveEdgeRename: () => {
          if (this.renaming?.kind === 'edge') this.endRename(false)
        },
        getRenamingEdgeId: () => this.renamingEdgeId,
        onLabelKeyDown: (id, event) =>
          this.handleLabelKeyDown({ kind: 'edge', id }, event),
        onLabelBlur: (id) => this.endRename(true, { kind: 'edge', id }),
        t: (key, fallback) => this.t(key, fallback),
      },
    )
    this.cardRenderer = new CardRenderer(this.context, this.host, world, {
      getNode: (id) => this.nodesById.get(id),
      isSelected: (id) => this.selectedIds.has(id),
      isFocused: (id) => this.focusedNodeId === id,
      isEditing: (id) => this.editing?.nodeId === id,
      isRenamingGroup: (id) => this.isRenaming({ kind: 'group', id }),
      onGroupLabelKeyDown: (id, event) =>
        this.handleLabelKeyDown({ kind: 'group', id }, event),
      onGroupLabelBlur: (id) => this.endRename(true, { kind: 'group', id }),
      canBuildContent: () => this.canBuildContent,
      queueContentSync: (id) => {
        this.contentSyncQueue.add(id)
      },
      dequeueContentSync: (id) => {
        this.contentSyncQueue.delete(id)
      },
      getMountedCount: () => this.engine.mounted.size,
      purgeNode: (id) => this.purgeNodeRuntime(id),
      getSourcePath: () => this.sourcePathForBoard(),
      reportError: (stage, error) => this.reportError(stage, error),
      t: (key, fallback) => this.t(key, fallback),
    })
    // Inside the viewport rather than the world: the toolbar is chrome, and
    // chrome does not zoom. Built last so it paints over the cards.
    this.toolbarController = new ToolbarController(this.context, viewport, {
      isParseFailed: () => this.parseFailed,
      canEdit: () => this.canEdit,
      isOverview: () => this.overview,
      getBoard: () => this.board,
      getSelectedIds: () => this.selectedIds,
      getSelectedEdgeIds: () => this.selectedEdgeIds,
      getEdge: (id) => this.boardEdgesById.get(id),
      isEditableNode: (node) => this.isEditableNode(node),
      edgeAnchorPoint: (id) => this.edgeAnchorPoint(id),
      getView: () => this.cameraController.view,
      getViewportSize: () => ({
        width: this.viewportEl.clientWidth,
        height: this.viewportEl.clientHeight,
      }),
      t: (key, fallback) => this.t(key, fallback),
      deleteNodes: (ids) => this.deleteNodes(ids),
      deleteEdges: (ids) => this.deleteEdges(ids),
      zoomToSelection: () => this.cameraController.zoomToSelection(),
      createGroupFromSelection: () => this.createGroupFromSelection(),
      editCard: (id) => this.editCard(id),
      beginRename: (target) => this.beginRename(target),
      applyColorToNodes: (ids, color) => this.applyColorToNodes(ids, color),
      applyColorToEdge: (edgeId, color) => this.applyColorToEdge(edgeId, color),
      setEdgeEnds: (edgeId, direction) => this.setEdgeEnds(edgeId, direction),
      alignSelection: (edge) => this.alignSelection(edge),
      distributeSelection: (axis) => this.distributeSelection(axis),
      tidySelection: () => this.tidySelection(),
    })
    // The creation bar and the file/URL prompt live in the toolbar's overlay
    // layer, which exists for exactly this (see SelectionToolbar.overlay): one
    // `isOverlayTarget` check then keeps a press on any of this chrome from
    // also being a press on the board behind it.
    this.cardMenu = new CardMenu(doc, this.toolbarController.overlay, [
      this.creationAction(
        'cardMenu.newCard',
        'sticky-note',
        NEW_CARD_SIZE,
        (at) => this.createTextCardAt(at),
      ),
      this.creationAction(
        'cardMenu.addNote',
        'file-text',
        NEW_EMBED_CARD_SIZE,
        (at) => this.promptForNoteCard(at),
      ),
      this.creationAction(
        'cardMenu.addMedia',
        'file-image',
        NEW_EMBED_CARD_SIZE,
        (at) => this.promptForMediaCard(at),
      ),
      this.creationAction(
        'cardMenu.newWebCard',
        'globe',
        NEW_EMBED_CARD_SIZE,
        (at) => this.promptForWebCard(at),
      ),
    ])
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
    this.viewportEl.addEventListener('wheel', this.cameraController.onWheel, {
      passive: false,
    })
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
  // pinch). All three gestures only ever touch `this.cameraController.view` + per-element
  // `transform`/`left`/`top` directly (no reflow); the camera is folded
  // into `board` and persisted only once a pan/zoom gesture settles (see
  // `scheduleCameraSettle`); a card drag/marquee commits immediately on
  // pointerup instead (no settle debounce — those are already discrete,
  // single-shot gestures, unlike the continuous wheel/pointer-pan stream).
  // -----------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    // Recorded before any early return: this is the record of what was
    // pressed, not of what the press went on to do (see `pressedTarget`).
    this.pressedTarget = e.target
    // A hover move that the last frame has not consumed yet belongs to no
    // gesture, and the gesture about to start must not be updated from it: it
    // is wherever the pointer was travelling before the press, which the drag
    // threshold below would read as movement the user never made after it.
    this.pendingPointerMove = null
    if (this.parseFailed) return
    // The toolbar and the edge-label field sit above the canvas in the same
    // viewport element these listeners are on: a press on one of them is not
    // also a press on the board behind it.
    if (this.toolbarController.isOverlayTarget(e.target)) return
    // A press anywhere else dismisses the colour popover, the same way one
    // dismisses a menu.
    this.toolbarController.closePopover()
    const nodeId = this.nodeIdAtPointer(e)

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
      // don't intercept. A group whose label is being renamed owns it for the
      // same reason: that label is the only part of a group a press can
      // reach, and while it holds the caret a press in it places the caret.
      if (this.editing?.nodeId === nodeId) return
      if (this.isRenaming({ kind: 'group', id: nodeId })) return
      // Same rule for a body the content mask has been lifted from: a press
      // that reached a media element or an embedded page belongs to it, and
      // the pointer capture below would take the rest of the gesture away
      // from the transport control being dragged. (Obsidian Canvas gets there
      // differently — it never captures the pointer, tracking the drag on the
      // window instead — but arrives at the same place: content that is live
      // stays usable.) The card's title row remains its drag handle.
      if (this.isLiveContentTarget(e.target)) return
      this.interaction = {
        kind: 'card',
        pointerId: e.pointerId,
        nodeId,
        startClient: { x: e.clientX, y: e.clientY },
        additive: e.shiftKey,
        dragging: false,
        ids: [],
        startPositions: new Map(),
        snapCandidates: [],
      }
      this.viewportEl.setPointerCapture(e.pointerId)
      return
    }

    // Edges paint behind the cards, so a press only reaches one where no
    // card covers it — which is exactly where pressing it can mean the edge.
    const edgeId = this.edgeIdAtPointer(e)
    if (edgeId !== null) {
      // Its label is being typed: a press in it places the caret, the same
      // rule a group being renamed follows above.
      if (this.isRenaming({ kind: 'edge', id: edgeId })) return
      if (this.startEdgeReattach(edgeId, e)) return
    }

    if (e.altKey) {
      this.startPan(e)
      return
    }

    this.startMarquee(e)
  }

  /**
   * Double-click opens whatever was double-clicked: a card's editor, a group's
   * or an edge's label field — and only on the board's own surface, a new card.
   *
   * `dblclick` rather than a click counter read off `pointerdown`: measured
   * in a real Obsidian window, `pointerdown.detail` is 0 on both presses of
   * a double-click (only `mousedown` carries the count), while `dblclick`
   * arrives intact — the marquee's pointer capture, the reason for doubting
   * it, does not suppress it. What it does suppress is the event's own
   * `target`, so every question below is asked of `pressedTarget` instead.
   */
  private readonly onDoubleClick = (e: MouseEvent): void => {
    if (this.parseFailed) return
    const target = this.pressedTarget
    if (this.toolbarController.isOverlayTarget(target)) return
    // A group's label is the one part of a group a pointer can reach (the
    // frame itself is pointer-transparent — see style.css), and double-clicking
    // it renames the group. Obsidian Canvas puts the same gesture on the same
    // element, wiring its label's `dblclick` straight to `focusLabel`.
    const groupId = this.groupLabelIdFromEventTarget(target)
    if (groupId !== null) {
      this.beginRename({ kind: 'group', id: groupId })
      return
    }
    // An edge carries its label on the line, so the line is where one asks
    // for it — the same gesture the toolbar's "label" button performs.
    const edgeId = this.edgeIdFromEventTarget(target)
    if (edgeId !== null) {
      this.beginRename({ kind: 'edge', id: edgeId })
      return
    }
    const world = this.worldPointFromEvent(e)
    // Geometry first, DOM second: the interaction layer stands in front of
    // the card it is parked on, so a double-click over a resize handle or a
    // connection point names the layer and only the point resolves it; and a
    // card's title hangs above its frame, outside the rect geometry knows
    // about, so only the DOM resolves that.
    const nodeId =
      nodeAtPoint(this.cardNodes, world) ?? this.nodeIdFromEventTarget(target)
    if (nodeId !== null) {
      // Inside the editor this is a word selection, not a request to open
      // what is already open.
      if (this.editing?.nodeId === nodeId) return
      this.editCard(nodeId)
      return
    }
    // Creating is what a double-click on *nothing* means, so it needs the
    // press to have landed on the board itself — Obsidian Canvas's own guard
    // (`if (e.targetNode !== this.wrapperEl) return`). Without it every
    // element this method declined to handle would fall through to creating
    // a stray card.
    if (target !== this.viewportEl && target !== this.worldEl) return
    this.createTextCardAt(world)
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.parseFailed) return
    if (this.toolbarController.isOverlayTarget(e.target)) return
    const nodeId = this.nodeIdAtPointer(e)
    // The card being edited owns its own context menu (CM6's, with the text
    // actions that belong to an editor).
    if (nodeId !== null && this.editing?.nodeId === nodeId) return
    e.preventDefault()

    if (nodeId === null) {
      this.host.ui.showMenu(
        e,
        this.canvasMenuItems(this.worldPointFromEvent(e)),
      )
      return
    }

    const card = this.nodesById.get(nodeId)
    if (!card) return
    // A right-click on a card that is already part of the selection acts on
    // the whole selection; on one that is not, it takes over the selection
    // first, so what the menu will do is what the user can see is selected.
    if (!this.selectedIds.has(nodeId)) this.setSelection([nodeId])
    this.host.ui.showMenu(e, this.selectionMenuItems())
  }

  /**
   * The empty-canvas menu: everything the creation bar offers, created at the
   * point that was clicked rather than at the middle of the screen, plus the
   * board-wide action that has nowhere else to live.
   *
   * Obsidian Canvas's `showCreationMenu(menu, pos, size)` is the same list
   * (card / note / media / website).
   */
  private canvasMenuItems(point: ScreenPoint): YoloModuleHostMenuItemV1[] {
    const creation: YoloModuleHostMenuItemV1[] = this.canCreate
      ? [
          {
            title: this.t('menu.newCard'),
            icon: 'sticky-note',
            onSelect: () => this.createTextCardAt(point),
          },
          {
            title: this.t('cardMenu.addNote'),
            icon: 'file-text',
            onSelect: () => this.promptForNoteCard(point),
          },
          {
            title: this.t('cardMenu.addMedia'),
            icon: 'file-image',
            onSelect: () => this.promptForMediaCard(point),
          },
          {
            title: this.t('cardMenu.newWebCard'),
            icon: 'globe',
            onSelect: () => this.promptForWebCard(point),
          },
          {
            title: this.t('menu.newGroupHere'),
            icon: 'group',
            onSelect: () => this.createEmptyGroupAt(point),
          },
          { kind: 'separator' },
        ]
      : []
    return [
      ...creation,
      {
        title: this.t('menu.resetCamera'),
        icon: 'locate-fixed',
        onSelect: () => this.cameraController.resetCamera(),
      },
    ]
  }

  /**
   * Everything that can be done to the current node selection — the
   * right-click menu's contract, and the only place some of it lives:
   * converting a card to a note is too rare to spend a button on.
   *
   * The floating toolbar builds its own row from the same commands rather than
   * showing a slice of this list. That is deliberate: a menu is what a
   * right-click produces, and Obsidian renders it with the platform's own menu
   * where the user asked for that; a button on a canvas should not open one.
   *
   * Obsidian Canvas groups these with `setSection`; with no sections in the
   * Host API's menu model, separators do the same job.
   */
  private selectionMenuItems(): YoloModuleHostMenuItemV1[] {
    const ids = Array.from(this.selectedIds)
    if (ids.length === 0) return []
    const single = ids.length === 1 ? this.nodesById.get(ids[0]) : null
    const items: YoloModuleHostMenuItemV1[] = []

    if (this.canEdit && single?.type === 'text') {
      items.push({
        title: this.t('menu.convertToNote'),
        icon: 'file-plus',
        onSelect: () => this.convertCardToNote(single.id),
      })
    }
    if (this.canEdit && ids.length > 1) {
      items.push({
        title: this.t('menu.createGroup'),
        icon: 'group',
        onSelect: () => this.createGroupFromSelection(),
      })
    }

    // Tidying and aligning both need two things to have a gap between them;
    // distributing needs three, so there is a gap to divide (domain/tidy.ts,
    // domain/arrange.ts). Tidy leads: it is the whole answer for most
    // selections, and the eight below it are the precise instruments for
    // someone who already knows which axis they mean.
    const targets = arrangeTargets(this.board, this.selectedIds).length
    if (this.canEdit && targets > 1) {
      items.push({ kind: 'separator' })
      items.push({
        title: this.t('menu.tidy'),
        icon: 'layout-grid',
        onSelect: () => this.tidySelection(),
      })
      for (const edge of ALIGN_EDGES) {
        items.push({
          title: this.t(ALIGN_MENU[edge].key),
          icon: ALIGN_MENU[edge].icon,
          onSelect: () => this.alignSelection(edge),
        })
      }
    }
    if (this.canEdit && targets > 2) {
      items.push({ kind: 'separator' })
      for (const axis of DISTRIBUTE_AXES) {
        items.push({
          title: this.t(DISTRIBUTE_MENU[axis].key),
          icon: DISTRIBUTE_MENU[axis].icon,
          onSelect: () => this.distributeSelection(axis),
        })
      }
    }

    items.push({ kind: 'separator' })
    // Framing works on any selection and needs no write access, so it is not
    // the group's own command it used to be.
    items.push({
      title: this.t('menu.zoomToSelection'),
      icon: 'scan-search',
      onSelect: () => {
        this.cameraController.zoomToSelection()
      },
    })
    if (single?.type === 'group' && this.canEdit) {
      items.push({
        title: this.t('menu.renameGroup'),
        icon: 'pencil',
        onSelect: () => this.beginRename({ kind: 'group', id: single.id }),
      })
    }

    if (this.canEdit) {
      items.push({ kind: 'separator' })
      items.push({
        title: this.t('menu.deleteCard'),
        icon: 'trash-2',
        onSelect: () => this.deleteNodes(ids),
      })
    }
    return trimSeparators(items)
  }

  // -- drag and drop ------------------------------------------------------
  // `dragover` must preventDefault on every event for the drop to fire at
  // all; the host resolves what the drag actually carries at `drop`, because
  // during dragover the browser hides the DataTransfer contents.

  /**
   * Whether the board itself will take a drop right now.
   *
   * False while a creation prompt is open: that panel covers the board and is
   * itself asking a question a drop can answer (ui/promptOverlay.ts's drop
   * zone), so the board behind it is not a second target. It is the same rule
   * the panel's backdrop already applies to presses and to the wheel — and
   * without it the board both lights its drop outline for a drag aimed at the
   * panel and, for a drop that lands beside the panel rather than on it,
   * makes a card nobody can see.
   */
  private get acceptsDrop(): boolean {
    return this.canCreate && this.prompt === null
  }

  private readonly onDragOver = (e: DragEvent): void => {
    if (!this.acceptsDrop) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.viewportEl.classList.add(VIEWPORT_DROP_ACTIVE_CLASS)
  }

  private readonly onDragLeave = (e: DragEvent): void => {
    // Moving across a child element fires dragleave on the way out; only a
    // pointer that actually left the viewport should clear the hint.
    const related = asNode(e.relatedTarget)
    if (related !== null && this.viewportEl.contains(related)) return
    this.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
  }

  private readonly onDrop = (e: DragEvent): void => {
    this.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
    if (!this.acceptsDrop) return
    e.preventDefault()
    const at = this.worldPointFromEvent(e)
    // Two drags arrive here and they carry different things. One comes from
    // inside Obsidian and names vault files, which the host resolves; the
    // other comes from the operating system and carries bytes. The first is
    // asked about first because a vault drag can also expose a `File`, and a
    // file already in the vault is to be referenced, never copied.
    const entries = this.host.ui.resolveDropEntries(e)
    if (entries.length > 0) {
      // Every file kind that has a card of its own is droppable — the same
      // table the renderer dispatches on (domain/naming.ts's fileNodeKind), so
      // "you can drop it" and "it renders" can never disagree.
      const droppable = entries.filter(
        (entry) =>
          entry.kind === 'file' && fileNodeKind(entry.path) !== 'unsupported',
      )
      if (droppable.length === 0) {
        this.host.ui.notice(this.t('notice.dropUnsupported'))
        return
      }
      this.addFileCards(
        droppable.map((entry) => entry.path),
        at,
      )
      return
    }
    // Read out synchronously: the `DataTransfer` is neutered once this handler
    // returns, while the `File` objects taken from it stay readable.
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    void this.importDroppedFiles(files, at)
  }

  /**
   * Takes documents dropped from outside the vault and makes cards of them.
   *
   * Only HTML, for now, and by the same rule everything else on this board
   * follows: a card kind exists or it does not, and `fileNodeKind` is the one
   * table that says so. An image dropped from the desktop is a card we could
   * make too, but Obsidian already owns "import an attachment" with a
   * configurable destination folder, and duplicating that policy here is the
   * kind of second implementation this module is supposed to avoid — an HTML
   * document has no such path anywhere in Obsidian, which is why it gets one.
   *
   * The copy lands beside the board, where a card converted to a note already
   * goes: the board is what the file belongs to.
   */
  private async importDroppedFiles(
    files: readonly File[],
    at: ScreenPoint,
  ): Promise<void> {
    // Checked at both ends: the prompt's drop zone reaches this too, and a
    // board whose file failed to parse between opening that panel and
    // dropping on it should not have files written beside it for cards it
    // will refuse.
    if (!this.canCreate) return
    const importable = files.filter(
      (file) => fileNodeKind(file.name) === 'html',
    )
    if (importable.length === 0) {
      this.host.ui.notice(this.t('notice.dropUnsupported'))
      return
    }
    const paths: string[] = []
    try {
      // No ensureFolder: the board's own folder exists by definition.
      const folderPath = this.boardFolderPath()
      const taken = new Set(
        this.host.vault
          .listChildren(folderPath)
          .filter((entry) => entry.kind === 'file')
          .map((entry) => entry.name),
      )
      for (const file of importable) {
        const fileName = generateDroppedHtmlFileName(
          file.name,
          this.t('file.newHtmlBaseName'),
          taken,
        )
        // Written one at a time rather than in parallel: the names are chosen
        // against a set this loop is also adding to, so two documents dropped
        // together cannot be handed the same one.
        taken.add(fileName)
        const path = folderPath ? `${folderPath}/${fileName}` : fileName
        await this.host.vault.createBinary(path, await file.arrayBuffer())
        paths.push(path)
      }
    } catch (error) {
      this.reportError('importDroppedFiles', error)
      this.host.ui.notice(this.t('error.dropFailed'))
      // Whatever did land is still a card worth having; only the rest is lost.
      if (paths.length === 0) return
    }
    // The board may have been closed, or failed to parse, while the files
    // were written.
    if (!this.canCreate) return
    this.addFileCards(paths, at)
  }

  /**
   * Latest un-consumed pointermove of the gesture in flight, or null.
   *
   * A pointer reports at its own rate, not the display's: a 1000Hz mouse
   * emits sixteen moves per 60Hz frame, and every one of them used to run a
   * whole drag update — snapping over the on-screen candidates, a transform
   * write per moved card, an edge redraw, the handle layer. Fifteen sixteenths
   * of that work is overwritten before anything is painted.
   *
   * So a move now only records where the pointer is, and the rAF loop consumes
   * the last one once per frame (`consumePointerMove`) — the same shape the
   * camera glide already has, and the reason the glide could be driven from the
   * frame loop in the first place: what a gesture means is a position, not a
   * stream of deltas. Every `update*` method already computes its result from
   * the gesture's start and the event's *absolute* position, so dropping the
   * intermediate events changes nothing they would have produced.
   */
  private pendingPointerMove: PointerEvent | null = null

  private readonly onPointerMove = (e: PointerEvent): void => {
    // While a gesture is in flight the slot is that gesture's: a second
    // pointer (a finger, a pen) reports its own moves, and the one slot would
    // otherwise hand the drag whichever pointer moved last. With none in
    // flight every pointer is a candidate for the hover.
    const interaction = this.interaction
    if (interaction !== null && e.pointerId !== interaction.pointerId) return
    this.pendingPointerMove = e
  }

  /** Applies the latest pointer position to the gesture in flight, or — when
   * there is none — to the hover. Called once per frame, and again from
   * `onPointerUp` so the gesture's last position is never left unapplied when
   * it commits. */
  private consumePointerMove(): void {
    const e = this.pendingPointerMove
    this.pendingPointerMove = null
    if (!e) return
    const interaction = this.interaction
    if (!interaction) {
      // Hover is coalesced for the same reason a drag is, and in the overview
      // tier for one more: with no card elements to hit, resolving it is a
      // pass over the board rather than a DOM lookup.
      this.updateHover(e)
      return
    }
    // A gesture that has actually moved takes the toolbar off screen until it
    // ends. A press that never moves leaves it alone, so clicking a card that
    // is already selected does not make its toolbar blink.
    this.toolbarController.setToolbarSuppressed(true)
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
      case 'create':
        this.updateCreateDrag(interaction, e)
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
    const target = asElement(e.target)
    const onLayer =
      target !== null && target.closest(`.${INTERACTION_LAYER_CLASS}`) !== null
    this.setHoveredNode(onLayer ? this.hoveredNodeId : this.nodeIdAtPointer(e))
  }

  /**
   * Which node a pointer event landed on.
   *
   * In the DOM tiers that is the element under it. In the overview tier the
   * cards have no elements, so the same question is asked of the board data
   * the canvas drew from — a point-in-rectangle test per card, linear over the
   * board (p4-perf-overview §三: no spatial index; a pass over a few thousand
   * rectangles is not what costs anything here). Groups keep their DOM at
   * every tier, so they keep answering the first way.
   */
  private nodeIdAtPointer(e: MouseEvent): NodeId | null {
    const fromDom = this.nodeIdFromEventTarget(e.target)
    if (fromDom !== null || !this.overview) return fromDom
    return nodeAtPoint(this.cardNodes, this.worldPointFromEvent(e))
  }

  /**
   * Which edge a pointer event landed on — the same two answers, for the same
   * reason as `nodeIdAtPointer` above. In the overview tier an edge is a curve
   * on a canvas with no element to hit, so the press is measured against the
   * geometry the canvas drew from (domain/edges.ts's `edgeAtPoint`).
   *
   * The tolerance is the DOM tiers' own: half of their transparent hit
   * stroke, under the same 1/sqrt(scale) counter-scale the stylesheet gives
   * it. Aiming at a line is therefore exactly as forgiving here as it is one
   * tier up — and no more, which matters on a board of a few thousand edges,
   * where a generous tolerance would leave the empty space a marquee starts
   * in belonging to whichever line ran nearest.
   *
   * Only the press path asks this. A double-click on an edge in this tier
   * would open its label, which the tier does not draw and the stylesheet has
   * hidden: nothing to type into, and no blur to end the rename with. The
   * label is a thing you edit where you can read it.
   */
  private edgeIdAtPointer(e: MouseEvent): EdgeId | null {
    const fromDom = this.edgeIdFromEventTarget(e.target)
    if (fromDom !== null || !this.overview) return fromDom
    return edgeAtPoint(
      this.board.edges,
      this.nodesById,
      this.worldPointFromEvent(e),
      EDGE_HIT_STROKE_WORLD_PX /
        2 /
        Math.sqrt(this.cameraController.view.scale),
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
    // The frame that would have applied the gesture's last move may not have
    // run yet; every commit below reads the board's live state, so it has to.
    this.consumePointerMove()
    const interaction = this.interaction
    if (!interaction) return
    // Another pointer lifting is not this gesture ending — the one that
    // started it is the one that can finish it.
    if (e.pointerId !== interaction.pointerId) return
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
      case 'create':
        this.finishCreateDrag(interaction, e)
        break
    }
    // Whatever the gesture was, it is over: nothing is lining up any more.
    this.snapGuideLayer?.clear()
    this.toolbarController.setToolbarSuppressed(false)
  }

  // -----------------------------------------------------------------------
  // Pan gesture (middle-drag anywhere, or Alt+left-drag from empty canvas).
  // The gesture's own state machine lives here (which `Interaction` is
  // active); the camera math and DOM writes it drives are
  // `cameraController`'s (see ./canvas/cameraController.ts).
  // -----------------------------------------------------------------------

  private startPan(e: PointerEvent): void {
    this.interaction = {
      kind: 'pan',
      pointerId: e.pointerId,
      origin: { ...this.cameraController.view },
      startX: e.clientX,
      startY: e.clientY,
    }
    this.cameraController.beginPan(e.pointerId)
  }

  private updatePan(interaction: PanInteraction, e: PointerEvent): void {
    this.cameraController.updatePan(
      interaction.origin,
      { x: interaction.startX, y: interaction.startY },
      { x: e.clientX, y: e.clientY },
    )
  }

  private finishPan(): void {
    this.cameraController.finishPan()
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
      pointerId: e.pointerId,
      originLocal,
      originClient: { x: e.clientX, y: e.clientY },
      additive: e.shiftKey,
      baseIds: Array.from(this.selectedIds),
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
    const worldA = screenToWorld(
      this.cameraController.view,
      interaction.originLocal,
    )
    const worldB = screenToWorld(this.cameraController.view, current)
    // A zero-size marquee (a plain click on empty canvas, no movement)
    // naturally selects nothing here, subsuming "click empty clears
    // selection" without a separate code path. Edges are not marquee-
    // selectable (a band drawn across the canvas is about the cards it
    // covers), but a marquee still ends whatever edge selection was up.
    this.setEdgeSelection([])
    const hits = nodesInMarquee(
      this.board.nodes,
      marqueeRectFromPoints(worldA, worldB),
    )
    // Shift makes the band add rather than replace — a union, not a toggle:
    // dragging over something already selected must not deselect it, or a
    // second band drawn across the same area would undo the first.
    this.setSelection(
      interaction.additive ? [...interaction.baseIds, ...hits] : hits,
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
    const el = asElement(target)
    if (!el?.classList.contains(RESIZER_CLASS)) return null
    const handle = (el as HTMLElement).dataset.resize
    return RESIZE_HANDLES.find((candidate) => candidate === handle) ?? null
  }

  /** False when there is nothing to resize (the hovered card went away
   * between hover and press), so the caller can fall through. */
  private startResize(handle: ResizeHandle, e: PointerEvent): boolean {
    if (!this.canEdit) return false
    const nodeId = this.layerNodeId
    const card = nodeId === null ? null : this.nodesById.get(nodeId)
    if (!card || nodeId === null) return false
    // Keeps the press from moving focus. Without it, grabbing a handle on the
    // card you are writing in blurs its editor, which commits and closes it —
    // adjusting a card's width should not cost you the caret you were at.
    e.preventDefault()
    this.interaction = {
      kind: 'resize',
      pointerId: e.pointerId,
      nodeId,
      handle,
      startClient: { x: e.clientX, y: e.clientY },
      startRect: rectOfCard(card),
      dragging: false,
      snapCandidates: [],
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
      interaction.snapCandidates = this.snapCandidates(
        new Set([interaction.nodeId]),
      )
      // Exempt from virtualization unmount for the gesture's duration, the
      // same way a dragged card is: a card being resized must not vanish
      // because a corner of it wandered out of the buffer band.
      this.pinnedIds.add(interaction.nodeId)
    }
    const resized = this.resizedRect(interaction, e)
    this.snapGuideLayer?.show(resized.guides)
    this.applyResizeRect(interaction, resized.rect)
  }

  /**
   * The rectangle this resize has reached, and what it lined up with on the
   * way. The alignment correction is applied to the *delta* rather than to
   * the rectangle it produces, because that is what keeps the minimum-size
   * clamp in charge: a snapped edge that would take the card below its
   * minimum stops at the minimum like any other (domain/resize.ts).
   */
  private resizedRect(
    interaction: ResizeInteraction,
    e: PointerEvent,
  ): Readonly<{ rect: CardRect; guides: readonly SnapGuide[] }> {
    const { scale } = this.cameraController.view
    const dx = (e.clientX - interaction.startClient.x) / scale
    const dy = (e.clientY - interaction.startClient.y) / scale
    const rect = resizeRect(
      interaction.startRect,
      interaction.handle,
      dx,
      dy,
      MIN_CARD_SIZE,
    )
    if (!this.snappingWanted(e)) return { rect, guides: [] }
    const snap = snapResize(
      rect,
      interaction.handle,
      interaction.snapCandidates,
      this.snapOptions(),
    )
    return {
      rect: resizeRect(
        interaction.startRect,
        interaction.handle,
        dx + snap.dx,
        dy + snap.dy,
        MIN_CARD_SIZE,
      ),
      guides: snap.guides,
    }
  }

  /** Live (uncommitted) geometry for the card, its handles and its edges. */
  private applyResizeRect(
    interaction: ResizeInteraction,
    rect: CardRect,
  ): void {
    const el = this.cardRenderer.getRuntime(interaction.nodeId)?.el
    if (el) {
      el.style.left = `${rect.x}px`
      el.style.top = `${rect.y}px`
      el.style.width = `${rect.w}px`
      el.style.height = `${rect.h}px`
    }
    const live = new Map([[interaction.nodeId, rect]])
    // As in a drag: with no element to write to, this is what the overview
    // tier draws the card being resized from.
    this.setLiveNodeRects(live)
    this.placeInteractionLayer(rect)
    this.edgeLayer.redrawEdgesForNodes(new Set([interaction.nodeId]), live)
  }

  /** Publishes (or, with null, retires) the geometry a gesture has reached but
   * not committed. One setter because the overview layer redraws from it and
   * would otherwise have to be told separately by every caller. */
  private setLiveNodeRects(rects: ReadonlyMap<NodeId, CardRect> | null): void {
    this.liveNodeRects = rects
    this.overviewLayer?.markDirty()
  }

  private finishResize(interaction: ResizeInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      // A click, not a drag: the handle overlaps the card, so this means
      // what the same click on the card means.
      this.setSelection([interaction.nodeId])
      return
    }

    this.pinnedIds.delete(interaction.nodeId)
    const { rect } = this.resizedRect(interaction, e)
    // A group's contents deliberately stay where they are: growing a frame is
    // how more cards are taken in and shrinking it is how they are let go,
    // which is only possible if resizing moves nothing (Obsidian Canvas's
    // group resize behaves identically).
    this.applyBoardChange(updateNode(this.board, interaction.nodeId, rect))
    this.applyResizeRect(interaction, rect)
    // The board holds this rectangle now; the gesture's copy of it retires.
    this.setLiveNodeRects(null)
    // How much of a card's markdown is worth building is derived from the
    // card's height (`cardMarkdownPrefix`), so a card that just grew may have
    // room for source it was never given. Queued rather than rendered here so
    // it answers to the same frame gate as every other build; a resize that
    // does not change the prefix costs the comparison and nothing else.
    this.contentSyncQueue.add(interaction.nodeId)
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
    const el = asElement(target)
    if (!el?.classList.contains(CONNECTION_POINT_CLASS)) return null
    const side = (el as HTMLElement).dataset.side
    return NODE_SIDES.find((candidate) => candidate === side) ?? null
  }

  /** The edge a press landed on — its hit path, or the label riding on it.
   * The label is part of the edge and answers as one: pressing it selects and
   * drags that edge, double-clicking it edits the label it already shows. */
  private edgeIdFromEventTarget(target: EventTarget | null): EdgeId | null {
    const el = asElement(target)
    if (
      el === null ||
      (!el.classList.contains(EDGE_HIT_CLASS) &&
        !el.classList.contains(EDGE_LABEL_CLASS))
    ) {
      return null
    }
    return (el as SVGElement | HTMLElement).dataset.edgeId ?? null
  }

  /** False when the card the layer was parked on is gone, so the caller can
   * fall through to the gesture the press would otherwise have been. */
  private startConnect(side: NodeSide, e: PointerEvent): boolean {
    if (!this.canEdit) return false
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
      pointerId: e.pointerId,
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
        this.edgeLayer.setEdgeHidden(interaction.edgeId, true)
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
      this.cardRenderer
        .getRuntime(previous)
        ?.el?.classList.remove(CARD_CONNECT_TARGET_CLASS)
    }
    this.connectTargetNodeId = nodeId
    if (nodeId !== null) {
      this.cardRenderer
        .getRuntime(nodeId)
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
      this.edgeLayer.setEdgeHidden(interaction.edgeId, false)
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
        ? addEdge(
            this.board,
            buildEdge(
              this.nextEdgeId(),
              interaction.anchor,
              interaction.movingEnd,
              target,
            ),
          )
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

  /** The card a connection dropped on open canvas lands on, placed so the
   * incoming edge meets its facing side. Added to the board here; the edge
   * to it, and the editor on it, follow in `finishConnect`. */
  private createNodeForConnection(
    interaction: ConnectInteraction,
    drop: ScreenPoint,
  ): SideAnchor | null {
    if (!this.canEdit) return null
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

  /**
   * Freezes what this drag moves.
   *
   * Resolved once, here, rather than per frame: a group carries whatever sits
   * inside it (domain/groups.ts), and re-asking as the group travels would
   * pick up every card it passed over and drop the ones it had left behind.
   * Obsidian Canvas takes the same snapshot at the same moment.
   */
  private beginNodeDrag(interaction: NodeInteraction): void {
    interaction.dragging = true
    if (!this.selectedIds.has(interaction.nodeId)) {
      this.setSelection([interaction.nodeId])
    }
    interaction.ids = nodesToDragWith(this.selectedIds, this.board.nodes)
    interaction.snapCandidates = this.snapCandidates(new Set(interaction.ids))
    for (const id of interaction.ids) {
      const card = this.nodesById.get(id)
      if (!card) continue
      interaction.startPositions.set(id, { x: card.x, y: card.y })
      // Exempt every dragged card from virtualization unmount for the
      // duration of the drag (mirrors the existing editing-card pin).
      this.pinnedIds.add(id)
      this.cardRenderer.getRuntime(id)?.el?.classList.add(CARD_DRAGGING_CLASS)
    }
  }

  // -----------------------------------------------------------------------
  // Alignment (drag and resize). What lines up with what is
  // domain/snapping.ts's; what lives here is the gesture's side of it —
  // which rectangles are on offer, how big the offer is at this zoom, and
  // when the user has waved it away.
  // -----------------------------------------------------------------------

  /**
   * The drag's world delta with alignment folded in, and the guides to draw
   * for it.
   *
   * One method for the live frame and for the commit both, because the two
   * have to agree exactly: recomputing from the same event is a few hundred
   * comparisons, and any drift between them would move the card on release.
   */
  private draggedDelta(
    interaction: NodeInteraction,
    e: PointerEvent,
  ): Readonly<{ dx: number; dy: number; guides: readonly SnapGuide[] }> {
    const raw = screenDeltaToWorld(
      this.cameraController.view,
      e.clientX - interaction.startClient.x,
      e.clientY - interaction.startClient.y,
    )
    if (!this.snappingWanted(e)) return { ...raw, guides: [] }
    const moving: CardRect[] = []
    for (const id of interaction.ids) {
      const start = interaction.startPositions.get(id)
      const card = this.nodesById.get(id)
      if (!start || !card) continue
      moving.push({
        x: start.x + raw.dx,
        y: start.y + raw.dy,
        w: card.w,
        h: card.h,
      })
    }
    const snap = snapMove(moving, interaction.snapCandidates, {
      ...this.snapOptions(),
      movedX: raw.dx !== 0,
      movedY: raw.dy !== 0,
    })
    return { dx: raw.dx + snap.dx, dy: raw.dy + snap.dy, guides: snap.guides }
  }

  /**
   * What a gesture may line up with: what is on screen, minus what the
   * gesture is moving, minus everything of the other kind.
   *
   * Cards line up with cards and groups with groups (Obsidian Canvas draws
   * the same line): a card dragged at a group is being dropped *into* it, and
   * one that jumped to the frame's edge on the way in would be fighting the
   * drop rather than helping it.
   *
   * Off-screen cards are left out because an alignment the user cannot see is
   * not an offer — and because it keeps the comparison bounded by the
   * viewport rather than by the size of the board.
   */
  private snapCandidates(moving: ReadonlySet<NodeId>): readonly CardRect[] {
    // Nothing is on offer in the overview tier (`snappingWanted`), and at that
    // zoom "what is on screen" is most of the board — so this is also the one
    // place the gesture would have paid for it.
    if (this.overview) return []
    const groups = this.board.nodes.some(
      (node) => moving.has(node.id) && node.type === 'group',
    )
    const view = computeWorldViewportRect(
      this.viewportEl.clientWidth,
      this.viewportEl.clientHeight,
      this.cameraController.view,
      0,
    )
    return this.board.nodes
      .filter(
        (node) =>
          !moving.has(node.id) &&
          (node.type === 'group') === groups &&
          intersectsViewport(node, view),
      )
      .map(rectOfCard)
  }

  /** The offer's size and the lattice it falls back to, both of which are
   * facts about the current zoom: the tolerance is a screen distance divided
   * by the scale, and the grid is whichever lattice is currently drawn. */
  private snapOptions(): Readonly<{ tolerance: number; gridStep: number }> {
    const { scale } = this.cameraController.view
    return {
      tolerance: SNAP_SCREEN_PX / scale,
      gridStep: gridStepForScale(
        scale,
        GRID_WORLD_STEP_PX,
        GRID_MIN_SCREEN_STEP_PX,
      ),
    }
  }

  /**
   * Alignment is on unless the user holds the key that says otherwise, which
   * is Obsidian Canvas's arrangement down to the key: Ctrl on macOS — where
   * Alt already pans this canvas, as it does theirs — and Alt everywhere
   * else. Read off the event, so it can be pressed and released mid-drag.
   */
  private snappingWanted(e: PointerEvent): boolean {
    // Off below the overview threshold (P4-D1). Alignment is an offer measured
    // in screen pixels, and down there the tolerance covers a screenful of
    // board: the card would jump to a neighbour the user cannot see, and the
    // guide drawn for it would be a line across the whole viewport.
    if (this.overview) return false
    this.isMacOS ??= /Mac|iPhone|iPad/.test(
      this.context.getWindow().navigator.userAgent,
    )
    return this.isMacOS ? !e.ctrlKey : !e.altKey
  }

  private updateNodeDragPositions(
    interaction: NodeInteraction,
    e: PointerEvent,
  ): void {
    const { dx, dy, guides } = this.draggedDelta(interaction, e)
    this.snapGuideLayer?.show(guides)
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
      const el = this.cardRenderer.getRuntime(id)?.el
      if (el) el.style.transform = `translate(${dx}px, ${dy}px)`
    }
    // In the overview tier those elements do not exist and this map is the
    // drag's only feedback — see `liveNodeRects`.
    this.setLiveNodeRects(overrides)
    this.edgeLayer.redrawEdgesForNodes(new Set(interaction.ids), overrides)
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
      if (interaction.additive) this.toggleSelection(interaction.nodeId)
      else this.setSelection([interaction.nodeId])
      return
    }

    const { dx, dy } = this.draggedDelta(interaction, e)
    if (dx !== 0 || dy !== 0) {
      this.applyBoardChange(moveNodes(this.board, interaction.ids, dx, dy))
    }
    // The board holds these positions now; the drag's copy of them retires.
    this.setLiveNodeRects(null)
    for (const id of interaction.ids) {
      this.pinnedIds.delete(id)
      const el = this.cardRenderer.getRuntime(id)?.el
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
    this.edgeLayer.redrawEdgesForNodes(new Set(interaction.ids))
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
    if (line === null) return
    const next = this.boardWithSnappedWindow(this.board, id, line)
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
    this.board = { ...next, camera: cameraFromView(this.cameraController.view) }
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

  // ---- Agent edit surface -------------------------------------------------
  //
  // `edit_board` (host/boardTools.ts) edits the *open view* when the board it
  // was pointed at happens to be open, and the file only when it is not. Two
  // things follow from that, and neither is reachable by writing the file:
  //
  //   - The view is where the newest board is. Its saves are debounced, so
  //     for up to two seconds after a drag the file is stale; an edit
  //     computed from the file would silently undo that drag.
  //   - Cmd+Z gets the user back to before the agent touched anything
  //     (docs/plans/09-03-whiteboard-agent-tools D5), because the change
  //     lands as a history step like any other edit rather than as a file
  //     rewrite that resets the history.
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
    this.forceCommitActiveEdit()
    const [next, value] = edit(this.board)
    if (next && next !== this.board) {
      this.history.push(next)
      this.applyHistoryBoard(next)
    }
    return value
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
    // Obsidian Canvas's camera keys. Zoom-to-selection declines (falls
    // through to Obsidian) when nothing is selected, same as Canvas.
    const fitAll = () => {
      if (this.editing) return false
      return this.cameraController.fitCameraToNodes(this.board.nodes)
    }
    const fitSelection = () => {
      if (this.editing) return false
      return this.cameraController.zoomToSelection()
    }
    // Back to the origin at 1:1. Obsidian Canvas binds no key to its own
    // (weaker) reset — Shift+1 and Shift+2 are the only two camera keys it
    // has — so Shift+0 is ours to choose, and it belongs to the same Shift+digit
    // family as the two fits while reading as the "100%" that Mod+0 means in
    // every browser.
    const home = () => {
      if (this.editing) return false
      this.cameraController.resetCamera()
      return true
    }
    this.viewKeymapDisposer = this.context.registerKeymap([
      { modifiers: ['Mod'], key: 'Z', handler: undo },
      { modifiers: ['Mod', 'Shift'], key: 'Z', handler: redo },
      // Windows' second redo binding, which Obsidian Canvas also carries.
      { modifiers: ['Mod'], key: 'Y', handler: redo },
      { modifiers: ['Shift'], key: '1', handler: fitAll },
      { modifiers: ['Shift'], key: '2', handler: fitSelection },
      { modifiers: ['Shift'], key: '0', handler: home },
    ])
  }

  /** Whether the board can be changed at all — the single test every mutating
   * path starts with, so a new one cannot forget half of it. */
  private get canEdit(): boolean {
    return !this.parseFailed
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
        this.cardRenderer
          .getRuntime(id)
          ?.el?.classList.remove(CARD_SELECTED_CLASS)
    }
    for (const id of next) {
      if (!this.selectedIds.has(id))
        this.cardRenderer.getRuntime(id)?.el?.classList.add(CARD_SELECTED_CLASS)
    }
    this.selectedIds = next
    // The class writes above reach nothing in the overview tier; there the
    // selection ring is drawn.
    this.overviewLayer?.markDirty()
    this.applyFocusedNode()
    this.syncSelectionKeymapScope()
    // Selection is one of the two things that decides where the handles are.
    this.updateInteractionLayer()
    this.toolbarController.refreshToolbar()
  }

  /** Adds a node to the selection, or takes it out if it was already in —
   * what Shift+click on a card means. */
  private toggleSelection(id: NodeId): void {
    const next = new Set(this.selectedIds)
    if (!next.delete(id)) next.add(id)
    this.setSelection(Array.from(next))
  }

  /** Keeps `focusedNodeId` and its class in step with the selection — see the
   * field's doc comment for what the state means. */
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
    if (this.enteredNodeId !== null && this.enteredNodeId !== next) {
      this.exitLiveContent()
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
    this.syncSelectionKeymapScope()
    // A label being typed belongs to the edge that was selected when it
    // opened; deselecting that edge ends the session (committing, the same as
    // a blur would).
    const typed = this.renaming
    if (typed?.kind === 'edge' && !next.has(typed.id)) this.endRename(true)
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

  /** One scope for both kinds of selection, pushed while either is non-empty
   * and popped when both are. */
  private syncSelectionKeymapScope(): void {
    const hasSelection =
      (this.selectedIds.size > 0 || this.selectedEdgeIds.size > 0) &&
      // While a label is being typed or a creation prompt is open,
      // Backspace/Delete/Escape belong to that field, not to the selection
      // behind it — the same rule that keeps the card editor and the selection
      // scope from ever being armed at once.
      this.renaming === null &&
      this.prompt === null
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
          // Steps out one layer at a time, the way Escape does out of an
          // editor: first back out of the card's content, and only a second
          // press lets go of the card itself.
          if (this.enteredNodeId !== null) {
            this.exitLiveContent()
            return true
          }
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

  // -----------------------------------------------------------------------
  // Selection toolbar (P3 batch 3, surfaces ①/②): the `SelectionToolbar`
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

  // -- labels (edge, group) -----------------------------------------------
  // A group's label and an edge's are both HTML in the world layer, and both
  // are typed where they already are: the element takes the caret itself
  // (`contenteditable`) rather than having a field floated over it. This is
  // Obsidian Canvas's arrangement for both, and the only one under which the
  // text keeps the size, weight and position it had a moment ago — a
  // screen-space field standing in for world-scaled text can match it at one
  // zoom level and no other, which is what both of these used to do.
  //
  // One session for the two, because there is now only one mechanism. What
  // differs is which element holds the text, what the text is committed to,
  // and what an emptied label means: a group keeps its label element (it is
  // the group's only handle), an edge's goes away with its text.

  private beginRename(target: LabelTarget): void {
    if (!this.canEdit || !this.renameSubjectExists(target)) return
    if (this.isRenaming(target)) return
    this.endRename(true)
    // Whatever the viewport last said about this edge, it is about to hold a
    // caret — and a culled edge's label is `display: none`.
    if (target.kind === 'edge') this.edgeLayer.revealEdge(target.id)
    const el =
      this.labelEl(target) ??
      (target.kind === 'edge'
        ? this.edgeLayer.attachEdgeLabel(target.id)
        : null)
    if (!el) return
    this.toolbarController.closePopover()
    this.renaming = target
    // `plaintext-only` rather than plain `contenteditable` so a paste arrives
    // as the text it looked like rather than as markup a label cannot hold.
    el.setAttribute('contenteditable', 'plaintext-only')
    // Before the focus: in the overview tier this element is out of the
    // document, and a hidden element cannot take the caret.
    this.syncEdgeRenameChrome()
    el.focus()
    // Selected rather than left with a caret where the click landed: renaming
    // usually replaces the name. Obsidian Canvas selects it too.
    const range = el.ownerDocument.createRange()
    range.selectNodeContents(el)
    const selection = this.context.getWindow().getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    this.syncSelectionKeymapScope()
  }

  /** Ends a rename: committing writes what was typed, cancelling puts back
   * what the board still holds. Either way the label goes back to being a
   * label. `target` defaults to whichever one is being typed, so a caller
   * that only means "whatever is in flight" (a lock, a teardown) can say
   * that; naming one that is not being typed is a no-op. */
  private endRename(
    commit: boolean,
    target: LabelTarget | null = this.renaming,
  ): void {
    if (!target || !this.isRenaming(target)) return
    this.renaming = null
    const el = this.labelEl(target)
    if (el) {
      el.removeAttribute('contenteditable')
      el.blur()
      if (commit) this.commitLabel(target, el.textContent ?? '')
      else this.restoreLabel(target, el)
    }
    this.syncEdgeRenameChrome()
    this.syncSelectionKeymapScope()
  }

  private handleLabelKeyDown(target: LabelTarget, e: KeyboardEvent): void {
    if (!this.isRenaming(target)) return
    // `isComposing` so the Enter that accepts an IME candidate is the IME's,
    // not ours — Obsidian Canvas guards its own label the same way.
    if (e.isComposing) return
    if (e.key !== 'Enter' && e.key !== 'Escape') return
    e.preventDefault()
    // Neither key means anything else while a name is being typed: Escape in
    // particular must not travel on to whatever Obsidian would close with it.
    e.stopPropagation()
    this.endRename(e.key === 'Enter', target)
  }

  private isRenaming(target: LabelTarget): boolean {
    return this.renaming !== null && sameLabelTarget(this.renaming, target)
  }

  /** Whether an edge label is being typed right now — the one label the
   * overview canvas leaves to the DOM, since a canvas holds no caret. */
  private get renamingEdgeId(): EdgeId | null {
    return this.renaming?.kind === 'edge' ? this.renaming.id : null
  }

  /**
   * Puts the label being typed back in the drawing for the length of the
   * rename, in the tier that has taken every label out of it.
   *
   * Naming a relation is what this zoom is for (see style.css's
   * `.yolo-whiteboard-edge-label` on why a label is sized the way it is), so
   * declining the rename here was not an option, and neither was drawing it:
   * the caret lives in the element. The class the stylesheet reads brings the
   * layer back and hides every label but the editable one, which costs a
   * style recalculation over the board's labels — paid once, at the start of a
   * deliberate action the user is about to spend seconds on.
   */
  private syncEdgeRenameChrome(): void {
    const wanted = this.renamingEdgeId !== null && this.overviewChromeHidden
    if (this.worldEl.classList.contains(WORLD_EDGE_RENAME_CLASS) === wanted) {
      return
    }
    // The layer is about to be seen; it must not be seen at the counter-scale
    // it wore whenever the tier began (CameraController's applyZoomScale).
    if (wanted) this.cameraController.flushOverviewChromeZoomScale()
    this.worldEl.classList.toggle(WORLD_EDGE_RENAME_CLASS, wanted)
  }

  /** False once the thing being named has left the board, which is what makes
   * calling any of this on a stale target safe. */
  private renameSubjectExists(target: LabelTarget): boolean {
    return target.kind === 'group'
      ? this.nodesById.get(target.id)?.type === 'group'
      : this.boardEdgesById.has(target.id)
  }

  private labelEl(target: LabelTarget): HTMLElement | null {
    if (target.kind === 'edge') {
      return this.edgeLayer.getLabelEl(target.id)
    }
    return (
      this.cardRenderer
        .getRuntime(target.id)
        ?.el?.querySelector<HTMLElement>(`.${GROUP_LABEL_CLASS}`) ?? null
    )
  }

  /** Puts back what the board still holds, after a cancelled rename. An
   * edge that had no label to begin with loses the element it was given. */
  private restoreLabel(target: LabelTarget, el: HTMLElement): void {
    const stored =
      target.kind === 'group'
        ? this.groupLabelText(target.id)
        : (this.boardEdgesById.get(target.id)?.label ?? '')
    if (target.kind === 'edge' && stored.length === 0) {
      this.edgeLayer.detachEdgeLabel(target.id)
      return
    }
    el.textContent = stored
  }

  private commitLabel(target: LabelTarget, value: string): void {
    if (target.kind === 'group') this.commitGroupLabel(target.id, value)
    else this.commitEdgeLabel(target.id, value)
  }

  private groupLabelText(nodeId: NodeId): string {
    const group = this.nodesById.get(nodeId)
    return group?.type === 'group' ? (group.label ?? '') : ''
  }

  /** An empty group label removes the attribute rather than storing `""` —
   * the same rule an edge label follows. The element stays either way: it is
   * the group's only handle. */
  private commitGroupLabel(nodeId: NodeId, value: string): void {
    if (!this.canEdit) return
    const group = this.nodesById.get(nodeId)
    if (!group || group.type !== 'group') return
    const label = value.trim().length > 0 ? value : undefined
    const el = this.labelEl({ kind: 'group', id: nodeId })
    if (el) el.textContent = label ?? ''
    const board = updateNode(this.board, nodeId, { label })
    if (board === this.board) return
    this.applyBoardChange(board)
  }

  /** An empty label removes the attribute rather than storing `""` — an edge
   * with a blank label and one with no label are the same edge, and neither
   * carries an element on its curve. */
  private commitEdgeLabel(edgeId: EdgeId, value: string): void {
    if (!this.canEdit || !this.boardEdgesById.has(edgeId)) return
    const label = value.trim().length > 0 ? value : undefined
    if (label === undefined) this.edgeLayer.detachEdgeLabel(edgeId)
    else {
      const el = this.edgeLayer.attachEdgeLabel(edgeId)
      if (el) el.textContent = label
    }
    const board = updateEdge(this.board, edgeId, { label })
    if (board === this.board) return
    this.applyBoardChange(board)
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

  private deleteNodes(ids: readonly NodeId[]): void {
    if (!this.canEdit || ids.length === 0) return
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

  /**
   * The world point the creation bar's buttons place a card on: the middle of
   * what is currently on screen.
   *
   * Obsidian Canvas's own `posCenter()` for the same three buttons. Placing a
   * card somewhere precise is the canvas context menu's job — it creates at the
   * point that was right-clicked, exactly as Canvas's `showCreationMenu(menu,
   * pos, size)` does.
   */
  private viewportCenterWorld(): ScreenPoint {
    return screenToWorld(this.cameraController.view, {
      x: this.viewportEl.clientWidth / 2,
      y: this.viewportEl.clientHeight / 2,
    })
  }

  /** Whether a new card can be made at all right now — the shared gate behind
   * the creation bar, the creation menu items, and double-click-to-create. In
   * the overview tier a card has no element, so creating one there would leave
   * a rectangle on the canvas and no editor to type into. */
  private get canCreate(): boolean {
    return this.canEdit && !this.overview
  }

  private refreshCardMenu(): void {
    this.cardMenu?.setAvailable(this.canCreate)
  }

  // -- creating from the bar ----------------------------------------------
  // Obsidian Canvas's `dragTempNode`: each button is also a handle, and what
  // comes off it is a ghost of the card about to exist — the same size, in the
  // same place, lining up with the same neighbours. A drop is a placement like
  // any other, so it runs through domain/snapping.ts and draws the same
  // guides.
  //
  // Canvas also pans the board when the ghost reaches the edge of the
  // viewport. We have that nowhere — not for card drags, not for the marquee,
  // not for connections — and it is a property of dragging on a canvas rather
  // than of this gesture, so it belongs to all of them at once or to none.

  /** One entry on the bar: the same creation from the keyboard, which names
   * no place and takes the middle of the screen, and from a pointer, which
   * names one. `size` is what this entry creates, so the ghost is a ghost of
   * the card rather than of a card. */
  private creationAction(
    labelKey: string,
    icon: CardMenuIconName,
    size: CardSize,
    create: (at: ScreenPoint) => void,
  ): CardMenuAction {
    return {
      label: this.t(labelKey),
      icon,
      onSelect: () => create(this.viewportCenterWorld()),
      onPress: (event) => this.beginCreateDrag(event, size, create),
    }
  }

  private beginCreateDrag(
    e: PointerEvent,
    size: CardSize,
    create: (at: ScreenPoint) => void,
  ): void {
    if (!this.canCreate) return
    this.interaction = {
      kind: 'create',
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      size,
      create,
      dragging: false,
      snapCandidates: [],
    }
    // Captured on the viewport rather than left on the button: the ghost is
    // dragged across cards and over live content (an embedded page swallows
    // pointer events), and the button must not receive the pointerup either —
    // its click is the keyboard's alone.
    this.viewportEl.setPointerCapture(e.pointerId)
  }

  private updateCreateDrag(
    interaction: CreateInteraction,
    e: PointerEvent,
  ): void {
    if (!interaction.dragging) {
      const dx = e.clientX - interaction.startClient.x
      const dy = e.clientY - interaction.startClient.y
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      interaction.dragging = true
      // Nothing of the board is moving, so everything on screen is something
      // to line up with.
      interaction.snapCandidates = this.snapCandidates(new Set())
      this.showCreateGhost()
    }
    const { rect, guides } = this.createGhostRect(interaction, e)
    this.placeCreateGhost(rect)
    this.snapGuideLayer?.show(guides)
  }

  private finishCreateDrag(
    interaction: CreateInteraction,
    e: PointerEvent,
  ): void {
    this.hideCreateGhost()
    // Never moved: the press was a click, and a click on the bar creates in
    // the middle of the screen as it always has.
    if (!interaction.dragging) {
      interaction.create(this.viewportCenterWorld())
      return
    }
    // Let go off the board — over the sidebar, or outside the window
    // entirely. Canvas drops the gesture here too: a card placed where the
    // pointer is not would be a card the user cannot see arriving.
    const local = this.cameraController.viewportPointFromEvent(e)
    if (
      local.x < 0 ||
      local.y < 0 ||
      local.x > this.viewportEl.clientWidth ||
      local.y > this.viewportEl.clientHeight
    ) {
      return
    }
    const { rect } = this.createGhostRect(interaction, e)
    interaction.create({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
  }

  /**
   * Where the ghost is, and what it lines up with there.
   *
   * The card is centred on the pointer — every creation path already takes a
   * centre and lays the card out around it, so the ghost and what replaces it
   * are the same rectangle by construction.
   */
  private createGhostRect(
    interaction: CreateInteraction,
    e: PointerEvent,
  ): Readonly<{ rect: CardRect; guides: readonly SnapGuide[] }> {
    const center = this.worldPointFromEvent(e)
    const { w, h } = interaction.size
    const rect: CardRect = { x: center.x - w / 2, y: center.y - h / 2, w, h }
    if (!this.snappingWanted(e)) return { rect, guides: [] }
    const snap = snapMove([rect], interaction.snapCandidates, {
      ...this.snapOptions(),
      movedX: true,
      movedY: true,
    })
    return {
      rect: { ...rect, x: rect.x + snap.dx, y: rect.y + snap.dy },
      guides: snap.guides,
    }
  }

  private showCreateGhost(): void {
    if (this.createGhostEl) return
    const el = this.context.getDocument().createElement('div')
    el.className = CREATE_GHOST_CLASS
    this.worldEl.appendChild(el)
    this.createGhostEl = el
  }

  private placeCreateGhost(rect: CardRect): void {
    const el = this.createGhostEl
    if (!el) return
    el.style.left = `${rect.x}px`
    el.style.top = `${rect.y}px`
    el.style.width = `${rect.w}px`
    el.style.height = `${rect.h}px`
  }

  private hideCreateGhost(): void {
    this.createGhostEl?.remove()
    this.createGhostEl = null
  }

  // -- creation prompts ---------------------------------------------------
  // Three of the four creation entries need a value before they can act. Each
  // opens the same panel (ui/promptOverlay.ts); what differs is the list it
  // filters and what the chosen value becomes.
  //
  // Where the card goes is settled before the panel opens and carried through
  // it: a drop names its place, and by the time a note has been chosen the
  // pointer is long gone. Canvas orders it the same way — `dragTempNode`'s
  // callback opens the picker with the dropped position already captured.

  /** Opens a prompt, replacing any already open. Closing is this view's own
   * bookkeeping, so callers describe only what they are asking for. */
  private openPrompt(options: Omit<PromptOverlayOptions, 'onClose'>): void {
    if (!this.canCreate) return
    this.prompt?.close()
    this.toolbarController.closePopover()
    this.prompt = new PromptOverlay(
      this.context.getDocument(),
      this.toolbarController.overlay,
      {
        ...options,
        onClose: () => {
          this.prompt = null
          this.syncSelectionKeymapScope()
        },
      },
    )
    // While the panel has the caret, Delete/Escape/Enter belong to it — the
    // same rule that keeps the selection's bindings off an open label field.
    this.syncSelectionKeymapScope()
  }

  private promptForNoteCard(
    center: ScreenPoint = this.viewportCenterWorld(),
  ): void {
    this.openPrompt({
      title: this.t('prompt.addNoteTitle'),
      placeholder: this.t('prompt.searchPlaceholder'),
      mode: {
        kind: 'pick',
        suggestions: this.host.vault
          .listMarkdownFiles()
          .map((file) => this.suggestionForPath(file.path)),
        emptyText: this.t('prompt.noMatches'),
      },
      onSubmit: (path) => this.addFileCards([path], center),
    })
  }

  private promptForMediaCard(
    center: ScreenPoint = this.viewportCenterWorld(),
  ): void {
    this.openPrompt({
      title: this.t('prompt.addMediaTitle'),
      placeholder: this.t('prompt.searchPlaceholder'),
      mode: {
        kind: 'pick',
        suggestions: this.collectMediaPaths('').map((path) =>
          this.suggestionForPath(path),
        ),
        emptyText: this.t('prompt.noMedia'),
      },
      onSubmit: (path) => this.addFileCards([path], center),
    })
  }

  private promptForWebCard(
    center: ScreenPoint = this.viewportCenterWorld(),
  ): void {
    this.openPrompt({
      title: this.t('prompt.newWebCardTitle'),
      placeholder: this.t('prompt.urlPlaceholder'),
      mode: { kind: 'text' },
      dropZone: {
        label: this.t('prompt.webDropHint'),
        onDrop: (files) => void this.importDroppedFiles(files, center),
      },
      onSubmit: (url) => this.createLinkCardAt(url, center),
    })
  }

  private suggestionForPath(path: string): PromptSuggestion {
    const folder = folderPathOf(path)
    return {
      value: path,
      title: basenameWithoutExtension(path),
      // The containing folder, so two notes of the same name are told apart.
      ...(folder ? { detail: folder } : {}),
    }
  }

  /**
   * Every image, audio and video file in the vault, depth-first from
   * `folderPath`.
   *
   * The Host API lists markdown files directly (`listMarkdownFiles`) but has
   * nothing equivalent for media, so this walks the tree the same way
   * `host/importCanvasFile.ts` already walks it looking for `.canvas` files.
   * The kinds come from the same table the renderer dispatches on
   * (domain/naming.ts's `fileNodeKind`), so "you can pick it" and "it renders"
   * cannot disagree.
   */
  private collectMediaPaths(folderPath: string): string[] {
    const paths: string[] = []
    for (const entry of this.host.vault.listChildren(folderPath)) {
      if (entry.kind === 'folder') {
        paths.push(...this.collectMediaPaths(entry.path))
        continue
      }
      const kind = fileNodeKind(entry.path)
      if (kind === 'image' || kind === 'audio' || kind === 'video') {
        paths.push(entry.path)
      }
    }
    return paths
  }

  /**
   * Creates a web card for `url`, centred on `world`.
   *
   * A bare host ("example.com") is given `https://`, because a URL typed
   * without a scheme is still a URL the user meant — and the card only ever
   * loads http(s) anyway (WEB_URL_PATTERN), so a value that cannot be made
   * into one is refused here rather than becoming a card that says it is not a
   * web address.
   */
  private createLinkCardAt(url: string, world: ScreenPoint): void {
    if (!this.canCreate) return
    const normalized = WEB_URL_PATTERN.test(url) ? url : `https://${url}`
    if (!WEB_URL_PATTERN.test(normalized)) {
      this.host.ui.notice(this.t('notice.invalidUrl'))
      return
    }
    const node: LinkNode = {
      id: this.nextNodeId(),
      type: 'link',
      x: Math.round(world.x - NEW_EMBED_CARD_SIZE.w / 2),
      y: Math.round(world.y - NEW_EMBED_CARD_SIZE.h / 2),
      w: NEW_EMBED_CARD_SIZE.w,
      h: NEW_EMBED_CARD_SIZE.h,
      url: normalized,
      extra: {},
    }
    this.applyBoardChange(addNode(this.board, node))
    this.recomputeVisibility()
    this.drainQueues()
    this.setSelection([node.id])
  }

  /** Creates an empty text card centered on `world` and opens it for typing. */
  private createTextCardAt(world: ScreenPoint): void {
    // Below the LOD threshold enterEditMode declines, which would leave this
    // gesture producing an invisible empty card with no editor. That lives in
    // `canCreate`.
    if (!this.canCreate) return
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

  /** Adds one file card per vault path, staggered from `world`. Which kind of
   * card each becomes is decided at render time from its extension, so this
   * is one path for notes, images, audio and video alike. */
  private addFileCards(paths: readonly string[], world: ScreenPoint): void {
    if (!this.canEdit || paths.length === 0) return
    let board = this.board
    for (const [index, path] of paths.entries()) {
      const offset = index * DROP_STAGGER_PX
      board = addNode(board, {
        id: this.nextNodeId(board),
        type: 'file',
        x: Math.round(world.x - NEW_EMBED_CARD_SIZE.w / 2 + offset),
        y: Math.round(world.y - NEW_EMBED_CARD_SIZE.h / 2 + offset),
        w: NEW_EMBED_CARD_SIZE.w,
        h: NEW_EMBED_CARD_SIZE.h,
        file: path,
        extra: {},
      })
    }
    this.applyBoardChange(board)
    this.recomputeVisibility()
    this.drainQueues()
  }

  // -----------------------------------------------------------------------
  // Groups, alignment and distribution (P3 batch 3 wave B, features 3 and 5).
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

  /** An empty group centered on the clicked point, sized to hold one default
   * card with the same breathing room a selection-made group gets. Selected on
   * creation so the double-click-to-name affordance is one gesture away. */
  private createEmptyGroupAt(world: ScreenPoint): void {
    if (!this.canCreate) return
    const w = NEW_CARD_SIZE.w + GROUP_SELECTION_PADDING * 2
    const h = NEW_CARD_SIZE.h + GROUP_SELECTION_PADDING * 2
    const group: GroupNode = {
      id: this.nextNodeId(),
      type: 'group',
      x: Math.round(world.x - w / 2),
      y: Math.round(world.y - h / 2),
      w,
      h,
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

  /** Commits a batch of new positions and brings the canvas back in step with
   * them. A group among them carries what it holds, the same law a drag obeys
   * (`carryGroupMembers`). `setNodePositions` returns the same board when
   * nothing moved, so an align that changes nothing records no history step
   * and redraws nothing. */
  private applyArrangement(
    requested: ReadonlyMap<NodeId, Readonly<{ x: number; y: number }>>,
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
    this.applyBoardChange(next)
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
    this.animateArrangement(moved)
    this.edgeLayer.redrawEdgesForNodes(new Set(positions.keys()))
    this.refreshInteractionLayer()
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
    const win = this.context.getWindow()
    // A JS-driven animation, so the reduced-motion degrade is ours to make
    // (CLAUDE.md) — the global CSS fallback does not reach WAAPI.
    if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const { el, dx, dy } of moved) {
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: ARRANGE_ANIMATION_MS, easing: ARRANGE_ANIMATION_EASING },
      )
    }
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
    if (!this.canEdit) return
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

  /** Minted against `board` rather than `this.board` where a caller is
   * building up several cards before committing them — two ids drawn from
   * the same four-hex space have to see each other to stay apart. */
  private nextNodeId(board: Board = this.board): NodeId {
    return mintNodeId(board)
  }

  private nextEdgeId(): EdgeId {
    return mintEdgeId(this.board)
  }

  private nextEditSessionId(): number {
    this.editSessionCounter += 1
    return this.editSessionCounter
  }

  private worldPointFromEvent(e: MouseEvent): ScreenPoint {
    return screenToWorld(
      this.cameraController.view,
      this.cameraController.viewportPointFromEvent(e),
    )
  }

  /**
   * Whether this event landed inside content the mask is currently lifted
   * from.
   *
   * Reaching a live body at all *is* the test: a masked body has
   * `pointer-events: none`, which its whole subtree inherits, so an event
   * whose target is inside one can only have got there through the exemption
   * (style.css's content-mask block).
   */
  private isLiveContentTarget(target: EventTarget | null): boolean {
    return asElement(target)?.closest(`.${CARD_BODY_LIVE_CLASS}`) != null
  }

  /** The group whose label this event landed on, or null for anything else. */
  private groupLabelIdFromEventTarget(
    target: EventTarget | null,
  ): NodeId | null {
    const el = asElement(target)
    if (!el?.classList.contains(GROUP_LABEL_CLASS)) return null
    return this.nodeIdFromEventTarget(el)
  }

  /** Matched on the data attribute rather than on a class, because both
   * kinds of mounted node carry it (a card and a group frame) and every
   * gesture that asks "which node is this" means either. */
  private nodeIdFromEventTarget(target: EventTarget | null): NodeId | null {
    const el = asElement(target)
    if (el === null) return null
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Element.closest()'s generic return type defaults to `Element` here (no type argument to infer it from); the assertion is required for `.dataset` below to type-check under tsc even though this lint rule's own type resolution disagrees.
    const nodeEl = el.closest('[data-node-id]') as HTMLElement | null
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
    // The node is going away, so there is nothing left to rename and nothing
    // to write what was typed to; drop the session rather than commit it.
    this.endRename(false, { kind: 'group', id })
    // The runtime-map half of this teardown is cardRenderer's own state; see
    // its `destroyRuntime` doc comment for why the operation is still one
    // call from every caller but this one's point of view (`evictParkedCard`
    // reaches this same method back through the `purgeNode` callback).
    this.cardRenderer.destroyRuntime(id)
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
    this.consumePointerMove()
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
    this.settleOverviewLinger()
    // Last: it draws the camera the world layer was just given, and the
    // geometry the queues above have just finished changing.
    this.overviewLayer?.render()
    this.rafId = this.context.getWindow().requestAnimationFrame(this.frame)
  }

  private recomputeVisibility(): void {
    if (this.parseFailed || !this.viewportEl) return
    // One measurement, before anything on this tick writes to the document.
    // Reading `clientWidth` is a layout read, so a read placed after the
    // mounts and the edge class flips below forces Blink to recalculate style
    // and lay out the whole world synchronously, inside the rAF callback —
    // measured at ~13ms a tick on a three thousand card board, which is a
    // dropped frame every 70ms for a number that has not changed. Both
    // consumers below want the same size, so it is taken once here.
    const width = this.viewportEl.clientWidth
    const height = this.viewportEl.clientHeight
    const rect = computeWorldViewportRect(
      width,
      height,
      this.cameraController.view,
      VIEWPORT_BUFFER_PX,
    )
    this.overviewLayer?.setViewportSize(width, height)
    this.updateOverviewState()
    if (this.overview) {
      // Two populations, one engine: groups keep their DOM at every tier
      // (P4-D2) and are asked the ordinary question, cards are asked one they
      // cannot answer yes to.
      this.engine.recompute(this.groupNodes, rect, this.pinnedIds)
      this.engine.recompute(this.cardNodes, UNREACHABLE_RECT, NO_PINS)
    } else {
      this.engine.recompute(this.board.nodes, rect, this.pinnedIds)
    }
    // Edges answer to the same viewport, on the same tick (P4-2) — see
    // edgeLayer.ts's `updateVisibility`. Not in the overview tier: there the
    // edge DOM is out of the document altogether and the canvas is drawing
    // them, so which of them the viewport covers is not a question worth
    // asking — and asking it costs a style recalculation over three thousand
    // elements per tick, which a `display: none` ancestor does not save (only
    // layout is skipped for a hidden subtree, not style). Leaving the tier
    // runs this again on the same tick, with the real rectangle.
    if (!this.overview) this.edgeLayer.updateVisibility(rect, this.pinnedIds)
    this.syncGroupLabelScale()
  }

  /** The buffered viewport in world coordinates — what decides which cards are
   * mounted and which edges are drawn. */
  private worldViewportRect(): WorldRect {
    return computeWorldViewportRect(
      this.viewportEl.clientWidth,
      this.viewportEl.clientHeight,
      this.cameraController.view,
      VIEWPORT_BUFFER_PX,
    )
  }

  /**
   * Flips the rendering tier at this method's ~70ms throttle
   * (recomputeVisibility's caller), not per frame — p1-design §3's
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
   * The parking pool is frozen for the length of the tier (P4-D5). Entering it
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
    this.syncEdgeRenameChrome()
    this.toolbarController.refreshToolbar()
    this.refreshCardMenu()
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
    this.syncEdgeRenameChrome()
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
    for (const id of toMount) this.cardRenderer.mountNode(id)
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
    if (this.editing?.nodeId === id) return
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

  private rebuildEdgesSvg(): void {
    this.edgeLayer.rebuildEdgesSvg(this.board.edges)
    // A rebuild starts every edge visible; cull the off-screen ones now rather
    // than leaving a board's worth of them in the document until the next
    // visibility tick.
    if (this.viewportEl) {
      this.edgeLayer.updateVisibility(this.worldViewportRect(), this.pinnedIds)
    }
    this.restoreEdgeSelection()
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
    this.toolbarController.refreshToolbar()
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
   * neither does a web card, a PDF or a media file.
   */
  private isEditableNode(node: BoardNode): boolean {
    return (
      node.type === 'text' ||
      (node.type === 'file' && isMarkdownPath(node.file))
    )
  }

  /**
   * Opens a card: into its editor when it has text, into its content when
   * that content is live. False when the card is neither, so a key binding
   * can decline instead of silently swallowing the keystroke.
   *
   * One gesture, two destinations, because there is one idea: "I mean what is
   * in this card, not the card". A markdown card answers it with a caret; a
   * web, HTML or media card answers it by letting the pointer through to the
   * page or the transport. Which of the two a card gives is a property of the
   * card, not a second command for the user to know about.
   */
  private editCard(id: NodeId): boolean {
    const node = this.nodesById.get(id)
    if (!node) return false
    if (!this.isEditableNode(node)) return this.enterLiveContent(id)
    this.enterEditMode(id)
    return true
  }

  /**
   * Lets the pointer into a card's live content.
   *
   * This is the whole reason the content mask is not lifted by selection.
   * A live body that a pointer can reach is a body the card can no longer be
   * dragged by — the press lands in the page, and `onPointerDown` bails
   * (`isLiveContentTarget`) rather than steal it. Hanging that on selection
   * meant that selecting a web card, the one thing you do before moving it,
   * was also the thing that stopped you moving it. Obsidian Canvas lifts its
   * blocker on focus and pays exactly this price; every canvas that embeds
   * live content and stayed usable — Figma, tldraw, Miro — asks for the
   * enter separately instead, and so do we.
   *
   * The card keeps its selection: entering is about the pointer, not about
   * what the toolbar or a delete key is aimed at. Edit mode is the other way
   * round (a card being edited is never also selected) because there a
   * keystroke has to belong to one of them.
   */
  private enterLiveContent(id: NodeId): boolean {
    // A degraded card has no body to enter (D8), the same reason edit mode
    // declines there.
    if (this.parseFailed || this.overview) return false
    if (!this.cardRenderer.hasLiveContent(id)) return false
    if (this.enteredNodeId === id) return true
    this.exitLiveContent()
    const el = this.cardRenderer.getRuntime(id)?.el
    if (!el) return false
    el.classList.add(CARD_ENTERED_CLASS)
    this.enteredNodeId = id
    return true
  }

  /** Takes the pointer back out of a card's live content, if it was in one. */
  private exitLiveContent(): void {
    if (this.enteredNodeId === null) return
    this.cardRenderer
      .getRuntime(this.enteredNodeId)
      ?.el?.classList.remove(CARD_ENTERED_CLASS)
    this.enteredNodeId = null
  }

  private enterEditMode(id: NodeId): void {
    // Degraded cards render as a title block with the body hidden (D8), so
    // an editor mounted now would be invisible; zooming back in is the way
    // to edit.
    if (!this.canCreate) return
    const node = this.nodesById.get(id)
    if (!node || !this.isEditableNode(node)) return
    const runtime = this.cardRenderer.getRuntime(id)
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

    // Where the editor opens, read before anything below has touched the card.
    //
    // Asked of the reading surface the editor is about to go over, and only of
    // the node when there is none — a card edited straight out of a clipped
    // render has no finer position to offer. What the node carries is snapped
    // to a block start, because a clipped card cannot begin mid block; the
    // surface the user is looking at is not, and opening the editor on the
    // node's number would step the card back to the top of whatever block the
    // reader's top edge was inside.
    //
    // The node is re-read here rather than taken from `node` above: clearing
    // the selection is what commits where the card was being read, and a board
    // is structurally shared — that commit leaves a *new* node object behind,
    // so the one this method opened with still carries the window before this
    // reading.
    const current = this.nodesById.get(id)
    const nodeLine =
      current && (current.type === 'text' || current.type === 'file')
        ? (current.startLine ?? 0)
        : 0
    const startLine = this.cardRenderer.getContentScrollLine(id) ?? nodeLine

    const initialText =
      node.type === 'text' ? node.text : (runtime.noteText ?? '')
    // The reading surface stays where it is, holding the card's scroll
    // position, and the class below takes it out of the way (style.css). Only
    // a body holding something an editor cannot sit over — a placeholder, an
    // image, a web frame — is cleared first.
    if (runtime.contentView === null) {
      this.cardRenderer.destroyCardContent(runtime)
      runtime.bodyEl.replaceChildren()
    }
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
    // Open where the card was being read. Both surfaces speak the same
    // fractional source line, so nothing is mapped between them; what is left
    // is how the two lay a block out, which is bounded by that block and
    // measured, not estimated (obsidianMarkdownEditor.ts's `openAtLine`).
    if (startLine > 0) editor.openAtLine(startLine)
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
        const runtime = this.cardRenderer.getRuntime(id)
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

    // Where the editor was left is where the card is now — the other half of
    // `enterEditMode`, and the same shape as Obsidian's own embed leaving edit
    // mode: read once, carried across once, unconditionally. Read before
    // `destroy()`, which is what makes the editor unable to answer.
    const line = editing.editor.getScrollLine()
    const board = this.boardWithSnappedWindow(this.board, id, line)
    if (board !== this.board) {
      this.board = board
      this.syncBoardIndex()
    }
    editing.editor.destroy()
    this.pinnedIds.delete(id)

    const runtime = this.cardRenderer.getRuntime(id)
    runtime?.el?.classList.remove(CARD_EDITING_CLASS)
    runtime?.bodyEl?.classList.remove(EDITOR_HOST_CLASS)

    // Final flush: the throttled writes may have left the last keystrokes
    // unpersisted, and a no-op commit costs nothing. Still under the
    // session's history key — the whole session is one step to undo.
    this.commitCardText(id, text, editing.historyKey)
    void this.cardRenderer.renderCardPreview(id)
    // The reading surface comes out of hiding where the editor left off.
    runtime?.contentView?.scrollToLine(line)
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

  /**
   * Ends the active edit for a board that is about to be replaced wholesale
   * (`setViewData`) — the file was rewritten from outside, or a different one
   * is being loaded into this leaf.
   *
   * A note card's text is still written: it belongs to that *file*, and the
   * note is owed those keystrokes whether or not a card pointing at it
   * survives the incoming board.
   *
   * A text card's is dropped, because there is nowhere left to put it. The
   * ordinary commit path would `applyBoardChange` it onto `this.board` — the
   * board `setViewData` discards two statements later, which takes the
   * history entry with it and leaves a queued `requestSave` that goes on to
   * persist the *replacing* board. The edit is lost either way; committing it
   * only adds the corruption. (This is the "外部改写 board 后卡片消失" report
   * in the whiteboard plan's T6 ③, which needed the rare
   * editing-while-rewritten window to reproduce — a window the agent
   * whiteboard tools make ordinary, docs/plans/09-03-whiteboard-agent-tools.)
   */
  private endEditForIncomingBoard(): void {
    const editing = this.editing
    if (!editing) return
    // Nulled first, so the blur that `destroy()` fires reaches `finishEdit`
    // as a stale callback and takes its early return instead of committing.
    this.editing = null
    if (editing.persistTimer !== null) {
      this.context.getWindow().clearTimeout(editing.persistTimer)
    }
    editing.scopeDisposer()
    const action = planNodeCommit(
      this.board,
      editing.nodeId,
      editing.editor.getValue(),
    )
    if (action.kind === 'writeNoteFile') {
      void this.host.vault
        .writeText(action.file, action.markdown)
        .catch((error: unknown) => this.reportError('writeText', error))
    }
    editing.editor.destroy()
  }

  // -----------------------------------------------------------------------
  // Teardown / error state
  // -----------------------------------------------------------------------

  private teardownAllCards(): void {
    this.forceCommitActiveEdit()
    this.interaction = null
    this.pendingPointerMove = null
    this.setLiveNodeRects(null)
    this.snapGuideLayer?.clear()
    this.marqueeEl?.remove()
    this.marqueeEl = null
    this.popSelectionKeymapScope()
    this.selectedIds = new Set()
    this.focusedNodeId = null
    // Dropped rather than exited: every card element is about to go, so there
    // is no class left to take off one.
    this.enteredNodeId = null
    this.cardRenderer.destroyAll()
    this.pinnedIds.clear()
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
    // The overview tier draws from this index rather than from the DOM, so
    // every board change is a redraw — this is the one place they all pass
    // through.
    this.overviewLayer?.markDirty()
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
    if (this.editing?.nodeId === id) return
    if (runtime.noteText === text) return // no real change — short-circuit
    runtime.noteText = text
    runtime.missingFile = false
    this.cardRenderer.renderMarkdownInto(id, runtime, text, path)
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

/**
 * Drops separators that no longer divide anything — leading, trailing, or
 * doubled. A menu assembled from optional groups cannot know which of them
 * survived, so it writes the divider it needs and lets this settle the result.
 */
function trimSeparators(
  items: readonly YoloModuleHostMenuItemV1[],
): YoloModuleHostMenuItemV1[] {
  const trimmed: YoloModuleHostMenuItemV1[] = []
  for (const item of items) {
    if (item.kind !== 'separator') {
      trimmed.push(item)
      continue
    }
    if (trimmed[trimmed.length - 1]?.kind === 'separator') continue
    if (trimmed.length > 0) trimmed.push(item)
  }
  if (trimmed[trimmed.length - 1]?.kind === 'separator') trimmed.pop()
  return trimmed
}
