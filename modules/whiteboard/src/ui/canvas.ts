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
  approachScale,
  approachView,
  cameraFromView,
  dragPan,
  fitViewToBounds,
  panByWheel,
  scaleAfterWheel,
  screenToWorld,
  unionRect,
  viewAnchoredAt,
  viewFromCamera,
  viewSettled,
} from '../domain/camera'
import type { ScreenPoint } from '../domain/camera'
import { COLOR_PRESETS, type ColorPreset, commonColor } from '../domain/color'
import { planNodeCommit } from '../domain/commit'
import {
  ARROW_DIRECTIONS,
  type ArrowDirection,
  NODE_SIDES,
  type SideAnchor,
  anchorPoint,
  arrowDirection,
  arrowEnds,
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
  DEFAULT_CAMERA,
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
  groupRectForNodes,
  nodesInsideGroup,
  nodesToDragWith,
} from '../domain/groups'
import { BoardHistory } from '../domain/history'
import {
  type FileNodeKind,
  basenameWithoutExtension,
  cardNoteContent,
  fileNodeKind,
  folderPathOf,
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
  setNodePositions,
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
import { type ToolbarBounds, toolbarScreenPosition } from '../domain/toolbar'
import {
  type CanvasView,
  type VirtualCardRect,
  VirtualizationEngine,
  computeWorldViewportRect,
} from '../domain/virtualization'
import { takePendingFit } from '../host/pendingFit'
import { createWhiteboardTranslation } from '../i18n'

import { CardMenu } from './cardMenu'
import {
  CAMERA_GLIDE_EPSILON_DOUBLINGS,
  CAMERA_GLIDE_EPSILON_PX,
  CAMERA_GLIDE_TAU_MS,
  CAMERA_SETTLE_MS,
  CONNECT_SNAP_WORLD_PX,
  DEGRADE_RESTORE_SCALE,
  DEGRADE_SCALE_THRESHOLD,
  DRAG_THRESHOLD_PX,
  DROP_STAGGER_PX,
  EDIT_PERSIST_THROTTLE_MS,
  FIT_CAMERA_PADDING_PX,
  GRID_MIN_SCREEN_STEP_PX,
  GRID_WORLD_STEP_PX,
  GROUP_LABEL_CENTER_OFFSET_PX,
  GROUP_LABEL_INSET_PX,
  INTERACTING_CLASS_TIMEOUT_MS,
  MIN_CARD_SIZE,
  MOUNT_QUOTA_PER_FRAME,
  NEW_CARD_SIZE,
  RECOMPUTE_INTERVAL_MS,
  RESIZE_HANDLE_PX,
  SCALE_BOUNDS,
  TOOLBAR_GAP_PX,
  TOOLBAR_MARGIN_PX,
  UNMOUNT_QUOTA_PER_FRAME,
  VIEWPORT_BUFFER_PX,
  WHEEL_DELTA_PER_ZOOM_DOUBLING,
} from './constants'
import { InlineTextInput } from './inlineTextInput'
import { degradedNodeTitle, nextDegradedState } from './lod'
import {
  PromptOverlay,
  type PromptOverlayOptions,
  type PromptSuggestion,
} from './promptOverlay'
import {
  SelectionToolbar,
  type ToolbarColorControl,
  type ToolbarIconName,
  type ToolbarItem,
  type ToolbarMenuControl,
  type ToolbarModel,
  applyColorToElement,
} from './selectionToolbar'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** i18n key per arrowhead direction (domain/edges.ts's `ArrowDirection`). */
const ARROW_MENU_KEYS: Readonly<Record<ArrowDirection, string>> = {
  none: 'menu.arrowNone',
  forward: 'menu.arrowForward',
  backward: 'menu.arrowBackward',
  both: 'menu.arrowBoth',
}

/** i18n key and icon per alignment (domain/arrange.ts's `AlignEdge`). */
/** Label and icon per arrange command, shared by the toolbar's popover and the
 * context menu — `ToolbarIconName` is a lucide name, which is also what a host
 * menu item's `icon` takes, so neither can drift from the other. */
const ALIGN_MENU: Readonly<
  Record<AlignEdge, Readonly<{ key: string; icon: ToolbarIconName }>>
> = {
  left: { key: 'menu.alignLeft', icon: 'align-start-vertical' },
  center: { key: 'menu.alignCenter', icon: 'align-center-vertical' },
  right: { key: 'menu.alignRight', icon: 'align-end-vertical' },
  top: { key: 'menu.alignTop', icon: 'align-start-horizontal' },
  middle: { key: 'menu.alignMiddle', icon: 'align-center-horizontal' },
  bottom: { key: 'menu.alignBottom', icon: 'align-end-horizontal' },
}

const DISTRIBUTE_MENU: Readonly<
  Record<DistributeAxis, Readonly<{ key: string; icon: ToolbarIconName }>>
> = {
  horizontal: {
    key: 'menu.distributeHorizontal',
    icon: 'align-horizontal-distribute-center',
  },
  vertical: {
    key: 'menu.distributeVertical',
    icon: 'align-vertical-distribute-center',
  },
}

/**
 * Size of a group created around a selection is derived from that selection
 * (domain/groups.ts), so this is only the fallback a group gets when it is
 * created around nothing — which cannot happen today, but keeps the geometry
 * total.
 */
const MIN_GROUP_SIZE = Object.freeze({ w: 200, h: 160 })

/**
 * How many web cards keep a live page while off screen (p3-canvas-parity §六's
 * D13 scope revision).
 *
 * An `<iframe>` removed from the document tree loses its browsing context, and
 * re-inserting it reloads the page from the top — every scroll position, form
 * field and session in it gone. So a web card that scrolls out of the viewport
 * is hidden rather than destroyed. Each survivor is a whole live page (its own
 * JavaScript, timers, sockets and media), which is why the pool is small: six
 * background pages is already a real cost, and a board with more than six web
 * cards in play at once is not the case this exists for. Past the cap the
 * least-recently-seen card is destroyed for real.
 */
const WEB_FRAME_POOL_CAPACITY = 6

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
/** The single-selected card, mirroring Obsidian Canvas's `is-focused`. */
const CARD_FOCUSED_CLASS = 'yolo-whiteboard-card-focused'
const CARD_DRAGGING_CLASS = 'yolo-whiteboard-card-dragging'
const CARD_BODY_CLASS = 'yolo-whiteboard-card-body'
/** Marks a body whose content is its own interaction surface — media
 * transport controls, an embedded web page — and so is exempt from the
 * content mask once its card is the single selection. See style.css. */
const CARD_BODY_LIVE_CLASS = 'yolo-whiteboard-card-body-live'
const CARD_MEDIA_CLASS = 'yolo-whiteboard-card-media'
const CARD_WEB_FRAME_CLASS = 'yolo-whiteboard-card-web-frame'
const CARD_TITLE_CLASS = 'yolo-whiteboard-card-title'
const CARD_DEGRADED_TITLE_CLASS = 'yolo-whiteboard-card-degraded-title'
const CARD_MISSING_CLASS = 'yolo-whiteboard-card-missing'
const CARD_UNSUPPORTED_PLACEHOLDER_CLASS =
  'yolo-whiteboard-card-unsupported-placeholder'
const GROUP_CLASS = 'yolo-whiteboard-group'
const GROUP_LABEL_CLASS = 'yolo-whiteboard-group-label'
/** A web card parked in the hidden pool: out of the viewport, out of sight,
 * still in the document so its page stays alive. See WEB_FRAME_POOL_CAPACITY. */
const CARD_POOLED_CLASS = 'yolo-whiteboard-card-pooled'
/** On the root while `board.locked` — what the stylesheet keys the read-only
 * treatment off, mirroring Obsidian Canvas's `mod-readonly`. */
const LOCKED_CLASS = 'yolo-whiteboard-locked'
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

/**
 * What a web card's frame is allowed to do.
 *
 * Copied verbatim from Obsidian's own non-desktop link node (`app.js`'s
 * `recreateFrame`), which is a sandboxed `<iframe>`. Its desktop branch uses
 * an Electron `<webview>` instead, and we deliberately do not: the parts that
 * make that webview safe — `app.getWebviewPartition()` plus the
 * `create-browser-session` IPC that installs the session's permission
 * allowlist (clipboard only), user-agent scrubbing and ad blocking — are host
 * internals a module cannot reach, and Electron grants every permission a page
 * asks for when no such handler is installed. `webviewTag` *is* enabled in
 * both the main window and popouts (verified against `main.js`), so this is a
 * deliberate trade, not a missing capability: an iframe grants no permissions
 * by default and behaves identically on mobile, at the cost of the sites that
 * refuse to be framed.
 */
const WEB_FRAME_SANDBOX =
  'allow-forms allow-presentation allow-same-origin allow-scripts allow-modals'

/** Obsidian's own link nodes load nothing but http(s) (`setFrameUrl`), which
 * is also what keeps `data:`/`javascript:` URLs out of the frame. */
const WEB_URL_PATTERN = /^https?:\/\//i

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
  /**
   * Teardown for a body that holds something other than a content view — a
   * media element or a web frame. Removing those from the DOM is not enough:
   * a detached `<audio>`/`<video>` keeps playing and keeps streaming, and a
   * detached frame keeps its page alive until it is collected. Null whenever
   * the body holds nothing that needs releasing.
   */
  releaseContent: (() => void) | null
  /**
   * The URL this card's live web frame was built for, or null when its body
   * holds anything else. Set only for web cards, and the flag that decides
   * whether an unmount parks the card in the hidden pool instead of tearing it
   * down (see WEB_FRAME_POOL_CAPACITY and `unmountNode`).
   */
  webFrameUrl: string | null
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
  readonly nodeId: NodeId
  readonly startClient: ScreenPoint
  /** Shift was held: a press that never moves toggles this card in and out of
   * the selection instead of replacing it. */
  readonly additive: boolean
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
   * Canvas lifts its content blocker for exactly this state (measured:
   * `.canvas-node.is-focused:not(.is-dragging) .canvas-node-content-blocker
   * { display: none }`, and its frame loop calls `node.focus()` only when the
   * new selection has size 1). We take the same rule for the cards whose
   * content has no other way in — media transport controls and web pages —
   * while D7's mask stays absolute for markdown, which has an edit mode
   * instead. See style.css's content-mask block.
   */
  private focusedNodeId: NodeId | null = null
  private selectionScopeDisposer: (() => void) | null = null
  private marqueeEl: HTMLElement | null = null

  // Selection toolbar (P3 batch 3, surfaces ①/②): one instance per view,
  // rebuilt on selection change and re-placed whenever the camera or the
  // selection's geometry moves. It lives in the viewport (screen-space) layer,
  // so it keeps a constant size at every zoom — see ui/selectionToolbar.ts and
  // domain/toolbar.ts for the placement law.
  private toolbar: SelectionToolbar | null = null
  /** Hidden for the duration of a pointer gesture (drag, resize, marquee, pan,
   * connect) — Obsidian Canvas hides its menu the same way, and a toolbar that
   * follows a card being dragged is a toolbar in the way. */
  private toolbarSuppressed = false
  /**
   * The label being typed and the field it is typed in — an edge's, or a
   * group's.
   *
   * One session rather than one per kind: only one label can be edited at a
   * time, both hang a one-line field off a point on the board, and both have
   * to hold off the selection's keymap scope while they have the caret. What
   * differs is only where the field sits and what the text is committed to,
   * which is what `target` selects.
   */
  private labelSession: Readonly<{
    target:
      | Readonly<{ kind: 'edge'; id: EdgeId }>
      | Readonly<{ kind: 'group'; id: NodeId }>
    input: InlineTextInput
  }> | null = null

  // Creation surfaces (P3 batch 3 wave B): the bottom bar, and the panel that
  // asks which file or what URL before a card can be made.
  private cardMenu: CardMenu | null = null
  private prompt: PromptOverlay | null = null

  /**
   * Web cards holding a live page while off screen, least-recently-seen
   * first: a Set iterates in insertion order, and every re-park deletes before
   * it adds, so the iteration order *is* the LRU order and the first entry is
   * always the one to evict. See WEB_FRAME_POOL_CAPACITY.
   */
  private readonly webFramePool = new Set<NodeId>()

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
    this.cameraGlide = null
    this.lastGlideTime = null
    this.applyTransform()
    this.applyLockedState()
    // Cards were all torn down above: whatever the layer was parked on is
    // either gone or somewhere else now.
    this.refreshInteractionLayer()
    this.showCanvas()
    // A board that has just been imported has never been framed against a real
    // viewport; this is the one open where its stored camera is a placeholder
    // rather than where the user left off (host/pendingFit.ts). Done after
    // showCanvas so the viewport has its real size to fit against.
    if (takePendingFit(this.sourcePathForBoard())) {
      this.fitCameraToNodes(this.board.nodes, { immediate: true })
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
    // The toolbar is clamped against the viewport's size, which just changed.
    this.positionToolbar()
    this.positionLabelInput()
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

    this.labelSession?.input.close()
    this.labelSession = null
    this.prompt?.close()
    this.prompt = null
    this.cardMenu?.destroy()
    this.cardMenu = null
    this.toolbar?.destroy()
    this.toolbar = null
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
    // Inside the viewport rather than the world: the toolbar is chrome, and
    // chrome does not zoom. Built last so it paints over the cards.
    this.toolbar = new SelectionToolbar(doc, viewport)
    // The creation bar and the file/URL prompt live in the toolbar's overlay
    // layer, which exists for exactly this (see SelectionToolbar.overlay): one
    // `isOverlayTarget` check then keeps a press on any of this chrome from
    // also being a press on the board behind it.
    this.cardMenu = new CardMenu(doc, this.toolbar.overlay, [
      {
        label: this.t('cardMenu.newCard'),
        icon: 'sticky-note',
        onSelect: () => this.createTextCardAt(this.viewportCenterWorld()),
      },
      {
        label: this.t('cardMenu.addNote'),
        icon: 'file-text',
        onSelect: () => this.promptForNoteCard(),
      },
      {
        label: this.t('cardMenu.addMedia'),
        icon: 'file-image',
        onSelect: () => this.promptForMediaCard(),
      },
      {
        label: this.t('cardMenu.newWebCard'),
        icon: 'external-link',
        onSelect: () => this.promptForWebCard(),
      },
    ])
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
    // Recorded before any early return: this is the record of what was
    // pressed, not of what the press went on to do (see `pressedTarget`).
    this.pressedTarget = e.target
    if (this.parseFailed) return
    // The toolbar and the edge-label field sit above the canvas in the same
    // viewport element these listeners are on: a press on one of them is not
    // also a press on the board behind it.
    if (this.isOverlayTarget(e.target)) return
    // A press anywhere else dismisses the colour popover, the same way one
    // dismisses a menu.
    this.toolbar?.closePopover()
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
        nodeId,
        startClient: { x: e.clientX, y: e.clientY },
        additive: e.shiftKey,
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
    if (this.isOverlayTarget(target)) return
    // A group's label is the one part of a group a pointer can reach (the
    // frame itself is pointer-transparent — see style.css), and double-clicking
    // it renames the group. Obsidian Canvas puts the same gesture on the same
    // element, wiring its label's `dblclick` straight to `focusLabel`.
    const groupId = this.groupLabelIdFromEventTarget(target)
    if (groupId !== null) {
      this.openGroupLabelEditor(groupId)
      return
    }
    // An edge carries its label on the line, so the line is where one asks
    // for it — the same gesture the toolbar's "label" button performs.
    const edgeId = this.edgeIdFromEventTarget(target)
    if (edgeId !== null) {
      this.openEdgeLabelEditor(edgeId)
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
    if (this.isOverlayTarget(e.target)) return
    const nodeId = this.nodeIdFromEventTarget(e.target)
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
   * two board-wide actions that have nowhere else to live.
   *
   * Obsidian Canvas's `showCreationMenu(menu, pos, size)` is the same list
   * (card / note / media / website), and its lock likewise appears as a
   * checked item in a menu rather than as a control of its own.
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
            onSelect: () => this.promptForNoteCard(),
          },
          {
            title: this.t('cardMenu.addMedia'),
            icon: 'file-image',
            onSelect: () => this.promptForMediaCard(),
          },
          {
            title: this.t('cardMenu.newWebCard'),
            icon: 'external-link',
            onSelect: () => this.promptForWebCard(),
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
        onSelect: () => this.resetCamera(),
      },
      {
        title: this.isLocked
          ? this.t('menu.unlockBoard')
          : this.t('menu.lockBoard'),
        icon: this.isLocked ? 'lock-open' : 'lock',
        onSelect: () => this.setLocked(!this.isLocked),
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

    // Aligning needs at least two things to agree on a line; distributing
    // needs at least three, so there is a gap to divide (domain/arrange.ts).
    const targets = this.arrangeTargets().length
    if (this.canEdit && targets > 1) {
      items.push({ kind: 'separator' })
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
        this.zoomToSelection()
      },
    })
    if (single?.type === 'group' && this.canEdit) {
      items.push({
        title: this.t('menu.renameGroup'),
        icon: 'pencil',
        onSelect: () => this.openGroupLabelEditor(single.id),
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

  private readonly onDragOver = (e: DragEvent): void => {
    if (!this.canCreate) return
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
    if (!this.canCreate) return
    e.preventDefault()
    const entries = this.host.ui.resolveDropEntries(e)
    if (entries.length === 0) return
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
      this.worldPointFromEvent(e),
    )
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const interaction = this.interaction
    if (!interaction) {
      this.updateHover(e)
      return
    }
    // A gesture that has actually moved takes the toolbar off screen until it
    // ends. A press that never moves leaves it alone, so clicking a card that
    // is already selected does not make its toolbar blink.
    this.setToolbarSuppressed(true)
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
    // Nothing on a locked board can be resized or wired up, so the layer has
    // no card to belong to — the same conclusion Obsidian Canvas reaches by
    // hiding `.canvas-node-resizer` under `.mod-readonly`.
    if (this.isLocked) return null
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
    this.setToolbarSuppressed(false)
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
      glide?.kind === 'anchored' ? glide.targetScale : this.view.scale,
      deltaY,
      WHEEL_DELTA_PER_ZOOM_DOUBLING,
      SCALE_BOUNDS,
    )
    const anchor = { screen: cursor, world: screenToWorld(this.view, cursor) }
    if (this.prefersReducedMotion()) {
      this.cameraGlide = null
      this.view = viewAnchoredAt(anchor.screen, anchor.world, targetScale)
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
  private advanceCameraGlide(now: number): void {
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
        this.view.scale,
        glide.targetScale,
        elapsed,
        CAMERA_GLIDE_TAU_MS,
      )
      const settled =
        Math.abs(Math.log2(next / glide.targetScale)) <
        CAMERA_GLIDE_EPSILON_DOUBLINGS
      this.view = viewAnchoredAt(
        glide.screen,
        glide.world,
        settled ? glide.targetScale : next,
      )
      this.finishGlideFrame(settled)
      return
    }

    const next = approachView(
      this.view,
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
    this.view = settled ? glide.target : next
    this.finishGlideFrame(settled)
  }

  /** What both glide laws do with the frame they just computed. */
  private finishGlideFrame(settled: boolean): void {
    this.applyTransform()
    this.markInteracting()
    if (!settled) return
    this.cameraGlide = null
    this.lastGlideTime = null
    this.scheduleCameraSettle()
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
    // The screen-space chrome is anchored to world positions, so it has to be
    // re-projected whenever the camera moves. Both are no-ops when nothing is
    // selected and nothing is being typed, which is the common case.
    this.positionToolbar()
    this.positionLabelInput()
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

  /**
   * Where the camera has come to rest, or is on its way to. Mid-glide the
   * live view is a frame on the way to somewhere; what the user asked for is
   * the target, and persisting an intermediate frame would reopen the board
   * half-way through a move the gesture had already finished.
   */
  private get targetView(): CanvasView {
    const glide = this.cameraGlide
    if (!glide) return this.view
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
    if (this.parseFailed) return
    const camera = cameraFromView(this.targetView)
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
    const worldA = screenToWorld(this.view, interaction.originLocal)
    const worldB = screenToWorld(this.view, current)
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
    if (!(target instanceof Element)) return null
    if (!target.classList.contains(RESIZER_CLASS)) return null
    const handle = (target as HTMLElement).dataset.resize
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
    // A group's contents deliberately stay where they are: growing a frame is
    // how more cards are taken in and shrinking it is how they are let go,
    // which is only possible if resizing moves nothing (Obsidian Canvas's
    // group resize behaves identically).
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

  /** The edge a press landed on — its hit path, or the label riding on it.
   * The label is part of the edge and answers as one: pressing it selects and
   * drags that edge, double-clicking it edits the label it already shows. */
  private edgeIdFromEventTarget(target: EventTarget | null): EdgeId | null {
    if (!(target instanceof Element)) return null
    if (
      !target.classList.contains(EDGE_HIT_CLASS) &&
      !target.classList.contains(EDGE_LABEL_CLASS)
    ) {
      return null
    }
    return (target as SVGElement).dataset.edgeId ?? null
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
    // A locked board still lets a press select (Obsidian Canvas's read-only
    // canvas does too — its selection menu keeps "zoom to selection"), it just
    // never becomes a drag.
    if (this.isLocked) return
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
      if (interaction.additive) this.toggleSelection(interaction.nodeId)
      else this.setSelection([interaction.nodeId])
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
      // A locked board has nothing to undo into: every step that could have
      // been recorded is a step the lock refused.
      if (this.editing || this.isLocked) return false
      action()
      return true
    }
    const undo = run(() => this.undo())
    const redo = run(() => this.redo())
    // Obsidian Canvas's camera keys. Zoom-to-selection declines (falls
    // through to Obsidian) when nothing is selected, same as Canvas.
    const fitAll = () => {
      if (this.editing) return false
      return this.fitCameraToNodes(this.board.nodes)
    }
    const fitSelection = () => {
      if (this.editing) return false
      return this.zoomToSelection()
    }
    // Back to the origin at 1:1. Obsidian Canvas binds no key to its own
    // (weaker) reset — Shift+1 and Shift+2 are the only two camera keys it
    // has — so Shift+0 is ours to choose, and it belongs to the same Shift+digit
    // family as the two fits while reading as the "100%" that Mod+0 means in
    // every browser.
    const home = () => {
      if (this.editing) return false
      this.resetCamera()
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

  /** Frames the current selection. The single implementation behind Shift+2,
   * the toolbar's focus button and the context menu's item, so the three can
   * never mean slightly different things. Declines an empty selection, which
   * is what lets the key fall through to Obsidian. */
  private zoomToSelection(): boolean {
    const selected = this.board.nodes.filter((node) =>
      this.selectedIds.has(node.id),
    )
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
  private fitCameraToNodes(
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
      this.view = target
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
  private resetCamera(): void {
    this.moveCameraTo(viewFromCamera(DEFAULT_CAMERA))
    this.recomputeVisibility()
    this.drainQueues()
  }

  // -----------------------------------------------------------------------
  // Read-only lock (P3 batch 3 wave B, feature 6).
  //
  // One flag gates every path that would change the board; pan, zoom, hover
  // and selection are untouched, because looking around a locked board is the
  // whole point of locking it. Obsidian Canvas draws the same line (verified
  // on 1.13.7: its `readonly` gates deleteSelection, double-click creation,
  // the creation context menu, `startEditing` and `handleSelectionDrag`, and
  // appears nowhere in its pan/zoom handlers).
  //
  // Two deliberate differences from Canvas:
  //   - it lives in the file (domain/fileFormat.ts's `locked`), not in a
  //     machine-local side store;
  //   - it hides the creation bar. Canvas leaves its card menu live on a
  //     read-only canvas, which lets a locked board still be added to; a lock
  //     that does not stop the most obvious way of changing a board is not a
  //     lock.
  //
  // Not a history step: locking is a mode, not content. It joins the camera
  // and self-heal as the things that write the board without going through
  // `applyBoardChange` — an undo that silently unlocked a board would be a
  // surprising way to lose the protection.
  // -----------------------------------------------------------------------

  private get isLocked(): boolean {
    return this.board.locked === true
  }

  /** Whether the board can be changed at all — the single test every mutating
   * path starts with, so a new one cannot forget half of it. */
  private get canEdit(): boolean {
    return !this.parseFailed && !this.isLocked
  }

  private setLocked(locked: boolean): void {
    if (this.parseFailed || this.isLocked === locked) return
    // Anything mid-flight belongs to the state being left.
    this.forceCommitActiveEdit()
    this.labelSession?.input.close()
    this.prompt?.close()
    this.board = locked
      ? { ...this.board, locked: true }
      : { ...this.board, locked: undefined }
    this.context.requestSave()
    this.applyLockedState()
  }

  /** Pushes the lock into everything that reflects it. Also called on load,
   * for a board that arrives already locked. */
  private applyLockedState(): void {
    this.rootEl?.classList.toggle(LOCKED_CLASS, this.isLocked)
    // The handles are hidden by CSS, but the layer must also stop being parked
    // on a card, or a press would still find a handle to grab.
    this.refreshInteractionLayer()
    this.refreshCardMenu()
    this.refreshToolbar()
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
    this.applyFocusedNode()
    this.syncSelectionKeymapScope()
    // Selection is one of the two things that decides where the handles are.
    this.updateInteractionLayer()
    this.refreshToolbar()
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
    if (this.focusedNodeId !== null) {
      this.runtimeByNodeId
        .get(this.focusedNodeId)
        ?.el?.classList.remove(CARD_FOCUSED_CLASS)
    }
    this.focusedNodeId = next
    if (next !== null) {
      this.runtimeByNodeId.get(next)?.el?.classList.add(CARD_FOCUSED_CLASS)
    }
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
    // A label being typed belongs to the edge that was selected when it
    // opened; deselecting that edge ends the session (committing, the same as
    // a blur would).
    const session = this.labelSession
    if (session?.target.kind === 'edge' && !next.has(session.target.id)) {
      session.input.close()
    }
    this.refreshToolbar()
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
      (this.selectedIds.size > 0 || this.selectedEdgeIds.size > 0) &&
      // While a label is being typed or a creation prompt is open,
      // Backspace/Delete/Escape belong to that field, not to the selection
      // behind it — the same rule that keeps the card editor and the selection
      // scope from ever being armed at once.
      this.labelSession === null &&
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
  // Selection toolbar (P3 batch 3, surfaces ①/②).
  //
  // Two responsibilities, kept apart because they run at very different
  // rates: `refreshToolbar` decides *what* the toolbar contains and runs on
  // discrete events (selection, degrade state, an edge appearing or going
  // away); `positionToolbar` decides *where* it is and runs on every camera
  // frame. Rebuilding the DOM at camera rate would be absurd, and re-placing
  // it only on selection change would leave it stranded mid-pan.
  //
  // Everything the buttons do goes through the same board operations the rest
  // of the canvas uses, so a colour picked here is one history step like any
  // other edit.
  // -----------------------------------------------------------------------

  /** Whether an event landed on the screen-space chrome (toolbar, colour
   * popover, edge-label field) rather than on the board. */
  private isOverlayTarget(target: EventTarget | null): boolean {
    return target instanceof Node && (this.toolbar?.contains(target) ?? false)
  }

  private setToolbarSuppressed(suppressed: boolean): void {
    if (this.toolbarSuppressed === suppressed) return
    this.toolbarSuppressed = suppressed
    this.toolbar?.setSuppressed(suppressed)
    if (!suppressed) this.positionToolbar()
  }

  private refreshToolbar(): void {
    const toolbar = this.toolbar
    if (!toolbar) return
    toolbar.setModel(this.buildToolbarModel())
    toolbar.setSuppressed(this.toolbarSuppressed)
    this.positionToolbar()
  }

  private positionToolbar(): void {
    const toolbar = this.toolbar
    if (!toolbar || this.toolbarSuppressed) return
    const bounds = this.toolbarBounds()
    if (!bounds) return
    toolbar.place(
      toolbarScreenPosition(
        bounds,
        this.view,
        {
          width: this.viewportEl.clientWidth,
          height: this.viewportEl.clientHeight,
        },
        toolbar.size(),
        TOOLBAR_GAP_PX,
        TOOLBAR_MARGIN_PX,
      ),
    )
  }

  /**
   * World rectangle the toolbar is anchored to: the union of the selected
   * nodes, or — for an edge — a zero-size rect at the point its label hangs
   * from, which is the only place on a curve that reads as "the edge itself".
   */
  private toolbarBounds(): ToolbarBounds | null {
    if (this.selectedEdgeIds.size > 0) {
      const point = this.edgeAnchorPoint(
        this.selectedEdgeIds.values().next().value,
      )
      return point ? { x: point.x, y: point.y, w: 0, h: 0 } : null
    }
    if (this.selectedIds.size === 0) return null
    return unionRect(
      this.board.nodes
        .filter((node) => this.selectedIds.has(node.id))
        .map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h })),
    )
  }

  private buildToolbarModel(): ToolbarModel | null {
    if (this.parseFailed) return null
    if (this.selectedEdgeIds.size > 0) return this.buildEdgeToolbarModel()
    if (this.selectedIds.size > 0) return this.buildNodeToolbarModel()
    return null
  }

  private buildNodeToolbarModel(): ToolbarModel | null {
    const nodes = this.board.nodes.filter((node) =>
      this.selectedIds.has(node.id),
    )
    if (nodes.length === 0) return null
    const single = nodes.length === 1 ? nodes[0] : null
    const ids = nodes.map((node) => node.id)

    // The row is Obsidian Canvas's, in its order: delete, colour, focus,
    // group, align — then the one button that is ours, editing what is
    // selected. Nothing is behind an overflow button, because everything a
    // selection can do either fits on the row or belongs to the right-click
    // menu; see `selectionMenuItems`.
    const items: ToolbarItem[] = []
    if (this.canEdit) {
      items.push({
        label: this.t('menu.deleteCard'),
        icon: 'trash',
        onSelect: () => this.deleteNodes(ids),
      })
      items.push(
        this.colorControl(
          commonColor(nodes.map((node) => node.color)),
          (color) => this.applyColorToNodes(ids, color),
        ),
      )
    }
    // Framing the selection is a camera move, not an edit — the one button a
    // locked board still gets, and Obsidian Canvas's third button too.
    items.push({
      label: this.t('menu.zoomToSelection'),
      icon: 'scan-search',
      onSelect: () => {
        this.zoomToSelection()
      },
    })
    if (this.canEdit && nodes.length > 1) {
      items.push({
        label: this.t('menu.createGroup'),
        icon: 'group',
        onSelect: () => this.createGroupFromSelection(),
      })
    }
    const arrange = this.arrangeControl()
    if (arrange) items.push(arrange)
    // Editing is the one action a degraded card cannot take (D8: its content
    // is not built at this zoom), so the button goes away rather than being
    // offered and declining. A locked board offers it for nothing either.
    if (
      single &&
      this.isEditableNode(single) &&
      !this.degraded &&
      this.canEdit
    ) {
      items.push({
        label: this.t('toolbar.edit'),
        icon: 'pencil',
        onSelect: () => this.editCard(single.id),
      })
    }
    // A group has no content to edit, so the pencil in its place renames it —
    // the same command its label's double-click carries, which is otherwise
    // the only way to find it.
    if (single?.type === 'group' && this.canEdit) {
      items.push({
        label: this.t('menu.renameGroup'),
        icon: 'pencil',
        onSelect: () => this.openGroupLabelEditor(single.id),
      })
    }

    return { items }
  }

  /**
   * The align/distribute button, or null when the selection has too little to
   * arrange. Aligning needs two things to agree on a line; distributing needs
   * three, so there is a gap to divide (domain/arrange.ts) — the second row
   * appears with the third card.
   */
  private arrangeControl(): ToolbarMenuControl | null {
    const targets = this.arrangeTargets().length
    if (!this.canEdit || targets < 2) return null
    return {
      kind: 'menu',
      label: this.t('toolbar.arrange'),
      icon: 'align-start-vertical',
      groups: [
        ALIGN_EDGES.map((edge) => ({
          label: this.t(ALIGN_MENU[edge].key),
          icon: ALIGN_MENU[edge].icon,
          onSelect: () => this.alignSelection(edge),
        })),
        targets > 2
          ? DISTRIBUTE_AXES.map((axis) => ({
              label: this.t(DISTRIBUTE_MENU[axis].key),
              icon: DISTRIBUTE_MENU[axis].icon,
              onSelect: () => this.distributeSelection(axis),
            }))
          : [],
      ],
    }
  }

  private buildEdgeToolbarModel(): ToolbarModel | null {
    const edgeId = this.selectedEdgeIds.values().next().value
    const edge =
      edgeId === undefined ? undefined : this.boardEdgesById.get(edgeId)
    if (!edge) return null

    // Same row shape as a node's: delete, colour, then what is specific to an
    // edge. Deleting was this menu's only entry, so "more" goes with it.
    if (!this.canEdit) return { items: [] }
    return {
      items: [
        {
          label: this.t('menu.deleteEdge'),
          icon: 'trash',
          onSelect: () => this.deleteEdges([edge.id]),
        },
        this.colorControl(edge.color, (color) =>
          this.applyColorToEdge(edge.id, color),
        ),
        {
          label: this.t('toolbar.arrows'),
          icon: 'arrow-right',
          onSelect: (event) => this.showEdgeArrowMenu(event, edge.id),
        },
        {
          label: this.t('toolbar.edgeLabel'),
          icon: 'tag',
          onSelect: () => this.openEdgeLabelEditor(edge.id),
        },
      ],
    }
  }

  /** The colour control shared by both toolbars — one picker, so a node and an
   * edge cannot end up offering different palettes. */
  private colorControl(
    current: NodeColor | undefined,
    onPick: (color: NodeColor | undefined) => void,
  ): ToolbarColorControl {
    return {
      kind: 'color',
      label: this.t('toolbar.color'),
      defaultLabel: this.t('color.default'),
      presetLabels: Object.fromEntries(
        COLOR_PRESETS.map((preset) => [
          preset,
          this.t(`color.preset${preset}`),
        ]),
      ) as Readonly<Record<ColorPreset, string>>,
      customLabel: this.t('color.custom'),
      current,
      onPick: (color) => {
        onPick(color)
        this.toolbar?.setCurrentColor(color)
      },
    }
  }

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
      const el = this.runtimeByNodeId.get(id)?.el
      if (el) applyColorToElement(el, color)
    }
  }

  private applyColorToEdge(edgeId: EdgeId, color: NodeColor | undefined): void {
    if (!this.canEdit) return
    const board = updateEdge(this.board, edgeId, { color })
    if (board === this.board) return
    this.applyBoardChange(board)
    this.boardEdgesById = new Map(board.edges.map((edge) => [edge.id, edge]))
    const path = this.edgeElsById.get(edgeId)?.path
    if (path) applyColorToElement(path, color)
  }

  /**
   * Arrowheads, as JSON Canvas models them: an independent `fromEnd`/`toEnd`
   * per end. Offered as four named states rather than a cycling button —
   * "which way does it point" has a direction, and a button that only cycles
   * makes reversing an edge a guessing game.
   */
  private showEdgeArrowMenu(event: MouseEvent, edgeId: EdgeId): void {
    const edge = this.boardEdgesById.get(edgeId)
    if (!edge) return
    const current = arrowDirection(edge.fromEnd, edge.toEnd)
    this.host.ui.showMenu(
      event,
      ARROW_DIRECTIONS.map((direction) => ({
        title: this.t(ARROW_MENU_KEYS[direction]),
        icon: direction === current ? 'check' : undefined,
        onSelect: () => this.setEdgeEnds(edgeId, direction),
      })),
    )
  }

  private setEdgeEnds(edgeId: EdgeId, direction: ArrowDirection): void {
    if (!this.canEdit) return
    const { fromEnd, toEnd } = arrowEnds(direction)
    const board = updateEdge(this.board, edgeId, { fromEnd, toEnd })
    if (board === this.board) return
    this.applyBoardChange(board)
    this.boardEdgesById = new Map(board.edges.map((edge) => [edge.id, edge]))
    const path = this.edgeElsById.get(edgeId)?.path
    if (!path) return
    this.setEdgeMarker(path, 'marker-start', fromEnd === 'arrow')
    this.setEdgeMarker(path, 'marker-end', toEnd === 'arrow')
  }

  private setEdgeMarker(
    path: SVGPathElement,
    attribute: 'marker-start' | 'marker-end',
    present: boolean,
  ): void {
    if (present) {
      path.setAttribute(attribute, `url(#${this.arrowMarkerId})`)
      return
    }
    path.removeAttribute(attribute)
  }

  // -- inline labels (edge, group) ----------------------------------------
  // Both hang the same one-line field (ui/inlineTextInput.ts) off a point on
  // the board and follow the camera. A group's label is edited this way rather
  // than as a `contenteditable` on the label itself (which is how Obsidian
  // Canvas does it): the board already has one way to type a label, and a
  // second one that behaves differently — world-scaled text, a different
  // commit rule — would be a second thing to learn for no gain.

  private openEdgeLabelEditor(edgeId: EdgeId): void {
    const edge = this.boardEdgesById.get(edgeId)
    if (!edge || !this.canEdit) return
    this.openLabelEditor(
      { kind: 'edge', id: edgeId },
      edge.label ?? '',
      this.t('edge.labelPlaceholder'),
      this.t('toolbar.edgeLabel'),
    )
  }

  private openGroupLabelEditor(nodeId: NodeId): void {
    const group = this.nodesById.get(nodeId)
    if (!group || group.type !== 'group' || !this.canEdit) return
    this.openLabelEditor(
      { kind: 'group', id: nodeId },
      group.label ?? '',
      this.t('group.labelPlaceholder'),
      this.t('menu.renameGroup'),
    )
  }

  private openLabelEditor(
    target: Readonly<{ kind: 'edge' | 'group'; id: string }>,
    value: string,
    placeholder: string,
    ariaLabel: string,
  ): void {
    const overlay = this.toolbar?.overlay
    if (!overlay) return
    this.labelSession?.input.close()
    this.toolbar?.closePopover()
    const input = new InlineTextInput(this.context.getDocument(), overlay, {
      value,
      placeholder,
      ariaLabel,
      onCommit: (text) =>
        target.kind === 'edge'
          ? this.commitEdgeLabel(target.id, text)
          : this.commitGroupLabel(target.id, text),
      onClose: () => {
        this.labelSession = null
        this.syncSelectionKeymapScope()
      },
    })
    this.labelSession = {
      target:
        target.kind === 'edge'
          ? { kind: 'edge', id: target.id }
          : { kind: 'group', id: target.id },
      input,
    }
    this.syncSelectionKeymapScope()
    this.positionLabelInput()
  }

  /** Re-projects the open field onto the world point it belongs to — the
   * midpoint of an edge's curve, or the top-left of a group's label row. */
  private positionLabelInput(): void {
    const session = this.labelSession
    if (!session) return
    const isEdge = session.target.kind === 'edge'
    const point = isEdge
      ? this.edgeAnchorPoint(session.target.id)
      : this.groupLabelAnchorPoint(session.target.id)
    if (!point) return
    session.input.place(
      {
        x: point.x * this.view.scale + this.view.tx,
        y: point.y * this.view.scale + this.view.ty,
      },
      // An edge label is centred on its curve; a group label starts at the
      // point below, so the field that stands in for it does too.
      isEdge ? 'center' : 'left',
    )
  }

  /** Where a group's label starts: just above its top edge, indented from its
   * left one — the two offsets style.css lays the label out with. */
  private groupLabelAnchorPoint(nodeId: NodeId): ScreenPoint | null {
    const group = this.nodesById.get(nodeId)
    if (!group) return null
    return {
      x: group.x + GROUP_LABEL_INSET_PX,
      y: group.y - GROUP_LABEL_CENTER_OFFSET_PX,
    }
  }

  /** An empty group label removes the attribute rather than storing `""` —
   * the same rule an edge label follows. */
  private commitGroupLabel(nodeId: NodeId, value: string): void {
    if (!this.canEdit) return
    const group = this.nodesById.get(nodeId)
    if (!group || group.type !== 'group') return
    const label = value.trim().length > 0 ? value : undefined
    const board = updateNode(this.board, nodeId, { label })
    if (board === this.board) return
    this.applyBoardChange(board)
    const labelEl = this.runtimeByNodeId
      .get(nodeId)
      ?.el?.querySelector(`.${GROUP_LABEL_CLASS}`)
    if (labelEl) labelEl.textContent = label ?? ''
  }

  /** An empty label removes the attribute rather than storing `""` — an edge
   * with a blank label and one with no label are the same edge. */
  private commitEdgeLabel(edgeId: EdgeId, value: string): void {
    if (!this.canEdit || !this.boardEdgesById.has(edgeId)) return
    const label = value.trim().length > 0 ? value : undefined
    const board = updateEdge(this.board, edgeId, { label })
    if (board === this.board) return
    this.applyBoardChange(board)
    // A label appearing or disappearing changes which elements the edge has,
    // not just their attributes — the one edge change that needs the SVG
    // rebuilt (which also restores the selection, and with it the toolbar).
    this.rebuildEdgesSvg()
  }

  /** World point an edge's chrome hangs from: the midpoint of its curve, the
   * same anchor its label already uses (domain/edges.ts's `EdgeGeometry`). */
  private edgeAnchorPoint(edgeId: EdgeId | undefined): ScreenPoint | null {
    const edge =
      edgeId === undefined ? undefined : this.boardEdgesById.get(edgeId)
    if (!edge) return null
    const from = this.effectiveNodeRect(edge.fromNode)
    const to = this.effectiveNodeRect(edge.toNode)
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
    return screenToWorld(this.view, {
      x: this.viewportEl.clientWidth / 2,
      y: this.viewportEl.clientHeight / 2,
    })
  }

  /** Whether a new card can be made at all right now — the shared gate behind
   * the creation bar, the creation menu items, and double-click-to-create. A
   * degraded card's content is not built (D8) and it cannot be edited, so
   * creating one there would leave an invisible empty card and no editor. */
  private get canCreate(): boolean {
    return this.canEdit && !this.degraded
  }

  private refreshCardMenu(): void {
    this.cardMenu?.setAvailable(this.canCreate)
  }

  // -- creation prompts ---------------------------------------------------
  // Three of the four creation entries need a value before they can act. Each
  // opens the same panel (ui/promptOverlay.ts); what differs is the list it
  // filters and what the chosen value becomes.

  /** Opens a prompt, replacing any already open. Closing is this view's own
   * bookkeeping, so callers describe only what they are asking for. */
  private openPrompt(options: Omit<PromptOverlayOptions, 'onClose'>): void {
    const overlay = this.toolbar?.overlay
    if (!overlay || !this.canCreate) return
    this.prompt?.close()
    this.toolbar?.closePopover()
    this.prompt = new PromptOverlay(this.context.getDocument(), overlay, {
      ...options,
      onClose: () => {
        this.prompt = null
        this.syncSelectionKeymapScope()
      },
    })
    // While the panel has the caret, Delete/Escape/Enter belong to it — the
    // same rule that keeps the selection's bindings off an open label field.
    this.syncSelectionKeymapScope()
  }

  private promptForNoteCard(): void {
    const center = this.viewportCenterWorld()
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

  private promptForMediaCard(): void {
    const center = this.viewportCenterWorld()
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

  private promptForWebCard(): void {
    const center = this.viewportCenterWorld()
    this.openPrompt({
      title: this.t('prompt.newWebCardTitle'),
      placeholder: this.t('prompt.urlPlaceholder'),
      mode: { kind: 'text' },
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
      x: Math.round(world.x - NEW_CARD_SIZE.w / 2),
      y: Math.round(world.y - NEW_CARD_SIZE.h / 2),
      w: NEW_CARD_SIZE.w,
      h: NEW_CARD_SIZE.h,
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
    // gesture producing an invisible empty card with no editor; a locked board
    // takes no new cards at all. Both live in `canCreate`.
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

  /**
   * The nodes an align or distribute acts on.
   *
   * Normally the selection. The exception is a lone selected group, where the
   * target is what the group *holds* — Obsidian Canvas does exactly this, and
   * it is what makes a group worth having: tidying a cluster becomes "select
   * its frame, align", rather than rubber-banding its members first.
   */
  private arrangeTargets(): readonly BoardNode[] {
    const selected = this.board.nodes.filter((node) =>
      this.selectedIds.has(node.id),
    )
    if (selected.length === 1 && selected[0].type === 'group') {
      const contained = new Set(nodesInsideGroup(selected[0], this.board.nodes))
      return this.board.nodes.filter((node) => contained.has(node.id))
    }
    return selected
  }

  private alignSelection(edge: AlignEdge): void {
    this.applyArrangement(alignRects(this.arrangeTargets(), edge))
  }

  private distributeSelection(axis: DistributeAxis): void {
    this.applyArrangement(distributeRects(this.arrangeTargets(), axis))
  }

  /** Commits a batch of new positions and brings the canvas back in step with
   * them. `setNodePositions` returns the same board when nothing moved, so an
   * align that changes nothing records no history step and redraws nothing. */
  private applyArrangement(
    positions: ReadonlyMap<NodeId, Readonly<{ x: number; y: number }>>,
  ): void {
    if (!this.canEdit || positions.size === 0) return
    const next = setNodePositions(this.board, positions)
    if (next === this.board) return
    this.applyBoardChange(next)
    for (const id of positions.keys()) {
      const el = this.runtimeByNodeId.get(id)?.el
      const node = this.nodesById.get(id)
      if (!el || !node) continue
      el.style.left = `${node.x}px`
      el.style.top = `${node.y}px`
    }
    this.redrawEdgesForNodes(new Set(positions.keys()))
    this.refreshInteractionLayer()
    this.positionToolbar()
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
    return (
      target instanceof Element &&
      target.closest(`.${CARD_BODY_LIVE_CLASS}`) !== null
    )
  }

  /** The group whose label this event landed on, or null for anything else. */
  private groupLabelIdFromEventTarget(
    target: EventTarget | null,
  ): NodeId | null {
    if (!(target instanceof Element)) return null
    if (!target.classList.contains(GROUP_LABEL_CLASS)) return null
    return this.nodeIdFromEventTarget(target)
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
      this.destroyCardContent(runtime)
      runtime.el?.remove()
    }
    this.runtimeByNodeId.delete(id)
    this.pinnedIds.delete(id)
    this.contentSyncQueue.delete(id)
    this.webFramePool.delete(id)
    this.engine.markUnmounted(id)
  }

  // -----------------------------------------------------------------------
  // Virtualization loop
  // -----------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    this.advanceCameraGlide(now)
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
    // A degraded card cannot be edited (see enterEditMode) and no new card can
    // be made at this zoom (see `canCreate`), so the toolbar's edit button and
    // the whole creation bar appear and disappear with this state — rather
    // than staying on screen offering what would be declined.
    this.refreshToolbar()
    this.refreshCardMenu()
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
    // A web card keeps its live page through a degrade for the same reason it
    // keeps it through an unmount (see WEB_FRAME_POOL_CAPACITY): the body is
    // already hidden by the degraded world's own CSS, and the frame stays in
    // the document, so nothing is lost and nothing is rebuilt on the way back.
    if (runtime.webFrameUrl !== null) return
    // Everything else is destroyed, not parked — the same rule an off-screen
    // card follows (p3-canvas-parity D13); the card's title block is what
    // stands in for it.
    this.destroyCardContent(runtime)
    runtime.bodyEl.replaceChildren()
  }

  // -----------------------------------------------------------------------
  // Card mount/unmount
  // -----------------------------------------------------------------------

  private mountNode(id: NodeId): void {
    const node = this.nodesById.get(id)
    const existing = this.runtimeByNodeId.get(id)
    // A web card that never really left (it was parked in the hidden pool)
    // comes back by being shown again — rebuilding it would be exactly the
    // page reload the pool exists to prevent.
    if (existing?.el && this.webFramePool.has(id)) {
      this.revealPooledCard(id)
      return
    }
    if (!node || existing?.el) return

    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = node.type === 'group' ? GROUP_CLASS : CARD_CLASS
    el.style.left = `${node.x}px`
    el.style.top = `${node.y}px`
    el.style.width = `${node.w}px`
    el.style.height = `${node.h}px`
    el.dataset.nodeId = id
    // JSON Canvas's `color` (p3-canvas-parity D5): a preset or a hex, both
    // resolved to the one custom property style.css paints from.
    applyColorToElement(el, node.color)
    // Re-apply selection state — a selected node can unmount (scrolled
    // off-screen) and remount without its selection ever changing.
    if (this.selectedIds.has(id)) el.classList.add(CARD_SELECTED_CLASS)
    if (this.focusedNodeId === id) el.classList.add(CARD_FOCUSED_CLASS)

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
        releaseContent: null,
        webFrameUrl: null,
        missingFile: false,
        noteText: null,
      })
      return
    }

    // A card whose content comes from outside the board carries its title in
    // chrome rather than in its text: a file card shows its file name
    // (Obsidian's convention is that a note's name *is* its title, so a note
    // dragged onto the board would otherwise arrive as a body with nothing
    // naming it), and a web card its URL — the only thing about a page we can
    // know without asking the page.
    //
    // Drawn *above* the card, not in it (style.css), and there through edit
    // mode. Obsidian Canvas shows the same name twice: a label above the node
    // and, inside it, the embed's own inline title — which disappears the
    // moment the embed is swapped for an editor (measured). One title that
    // never moves beats two that take turns, and outside is where it belongs,
    // because a name that came from outside the content is a label on the box
    // rather than a line of it.
    //
    // A text card gets none: its first line is its own title, and repeating
    // it above the card would be the duplication this arrangement exists to
    // avoid.
    //
    // Canvas replaces a link node's URL with the page's own title once the
    // webview reports one; a sandboxed cross-origin iframe never will, so the
    // URL is what the card says. Also a drag handle — a focused web card's
    // body belongs to the page (see the content mask) and this does not, and
    // it stays one from outside the box because hit-testing walks the DOM
    // (`nodeIdFromEventTarget`), not the geometry.
    const chromeTitle =
      node.type === 'file'
        ? basenameWithoutExtension(node.file)
        : node.type === 'link'
          ? node.url
          : null
    if (chromeTitle !== null) {
      const title = doc.createElement('div')
      title.className = CARD_TITLE_CLASS
      title.textContent = chromeTitle
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
      releaseContent: null,
      webFrameUrl: null,
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
    // A web card is hidden, not destroyed — see WEB_FRAME_POOL_CAPACITY.
    if (runtime.webFrameUrl !== null) {
      this.poolWebCard(id, runtime)
      return
    }
    // Everything else is destroyed rather than parked (p3-canvas-parity D13):
    // an off-screen card keeps nothing but its cached text, and a detach pool
    // would have to manage capacity, invalidation and content sync to earn its
    // keep. Only the web card's *state* (scroll position, form contents, a
    // login) makes that bargain worth taking.
    this.destroyCardContent(runtime)
    this.contentSyncQueue.delete(id)
    runtime.el.remove()
    runtime.el = null
    runtime.bodyEl = null
  }

  // -----------------------------------------------------------------------
  // Web-card hidden pool (p3-canvas-parity §六, D13's scope revision).
  //
  // Obsidian Canvas parks an off-screen node by detaching its content element
  // and keeping the instance. That works for a markdown embed and not for an
  // iframe: taking a frame out of the document tree destroys its browsing
  // context, and putting it back reloads the page from scratch. So a web card
  // is hidden in place instead — still in the document, so the page keeps
  // running, just not painted.
  //
  // `display: none` is enough: it stops layout, paint and hit-testing for the
  // card while leaving the frame attached, which is the only thing the
  // browsing context's survival depends on.
  // -----------------------------------------------------------------------

  private poolWebCard(id: NodeId, runtime: NodeRuntime): void {
    runtime.el?.classList.add(CARD_POOLED_CLASS)
    this.contentSyncQueue.delete(id)
    // Delete before adding so a re-parked card moves to the back of the queue:
    // insertion order is the LRU order (see `webFramePool`).
    this.webFramePool.delete(id)
    this.webFramePool.add(id)
    this.evictExcessWebCards()
  }

  private revealPooledCard(id: NodeId): void {
    const runtime = this.runtimeByNodeId.get(id)
    const node = this.nodesById.get(id)
    this.webFramePool.delete(id)
    if (!runtime?.el) return
    runtime.el.classList.remove(CARD_POOLED_CLASS)
    // The card sat out however much moved while it was hidden: an undo, an
    // align, a colour change on a multi-selection. Its geometry and its
    // selection state are re-applied from the board rather than trusted.
    if (node) {
      runtime.el.style.left = `${node.x}px`
      runtime.el.style.top = `${node.y}px`
      runtime.el.style.width = `${node.w}px`
      runtime.el.style.height = `${node.h}px`
      applyColorToElement(runtime.el, node.color)
    }
    runtime.el.classList.toggle(CARD_SELECTED_CLASS, this.selectedIds.has(id))
    runtime.el.classList.toggle(CARD_FOCUSED_CLASS, this.focusedNodeId === id)
  }

  /** Destroys the least-recently-seen pooled cards until the pool is within
   * capacity. Eviction is a real teardown: the page goes, and the card is
   * rebuilt from its URL the next time it is on screen. */
  private evictExcessWebCards(): void {
    while (this.webFramePool.size > WEB_FRAME_POOL_CAPACITY) {
      const oldest = this.webFramePool.values().next().value
      if (oldest === undefined) return
      this.webFramePool.delete(oldest)
      this.purgeNodeRuntime(oldest)
    }
  }

  /**
   * Releases whatever the card's body currently holds, whichever kind it is —
   * the single teardown every path (unmount, degrade, re-render, edit) goes
   * through, so a new content kind cannot be added and leak from one of them.
   */
  private destroyCardContent(runtime: NodeRuntime): void {
    runtime.contentView?.destroy()
    runtime.contentView = null
    runtime.contentSourcePath = null
    runtime.webFrameUrl = null
    const release = runtime.releaseContent
    runtime.releaseContent = null
    if (release) {
      try {
        release()
      } catch (error) {
        this.reportError('card content release', error)
      }
    }
    runtime.bodyEl?.classList.remove(CARD_BODY_LIVE_CLASS)
  }

  /**
   * Builds whatever a card shows below its title — rendered markdown, a media
   * element, an embedded page, or a placeholder for the cases that have none
   * of those.
   *
   * The single gate for all of it, which is why the degrade check lives here
   * rather than at the call sites: below the threshold nothing is built at all
   * (p3-canvas-parity D8) — no `<img>`, no `<video>`, no frame, and not even
   * the note card's `readText`, which at the zoom where the most cards are on
   * screen is the larger half of the cost. `updateDegradedState` queues every
   * mounted card when the camera comes back up, so a card skipped here is not
   * forgotten.
   */
  private async renderCardPreview(id: NodeId): Promise<void> {
    const node = this.nodesById.get(id)
    const runtime = this.runtimeByNodeId.get(id)
    // A group has no body: it is a frame, drawn once at mount.
    if (!node || node.type === 'group' || !runtime?.bodyEl) return
    if (this.degraded) return

    if (node.type === 'link') {
      this.renderWebFrameInto(runtime, node.url)
      return
    }

    if (node.type === 'file') {
      // A JSON Canvas file node can point at anything in the vault, and its
      // extension is the only thing that says what to build for it
      // (domain/naming.ts's fileNodeKind). Existence is checked first for
      // every kind: "this file is gone" is the more useful thing to say about
      // a missing PDF than "no card for this type yet".
      const entry = this.host.vault.getEntry(node.file)
      if (!entry || entry.kind !== 'file') {
        runtime.missingFile = true
        runtime.noteText = null
        this.renderMissingFilePlaceholder(runtime, node.file)
        return
      }
      runtime.missingFile = false
      const kind = fileNodeKind(node.file)
      if (kind !== 'markdown') {
        // Only markdown has text an editor could be seeded from; leaving the
        // cache set from a previous identity would seed one with a stale note.
        runtime.noteText = null
        if (kind === 'unsupported') {
          this.renderUnsupportedFilePlaceholder(runtime, node.file)
        } else {
          this.renderMediaInto(runtime, node.file, kind)
        }
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
      this.destroyCardContent(runtime)
      return
    }
    // New text in the same document is a `setValue`; a different document
    // needs a new view, because links resolve against what the view was
    // built for.
    if (runtime.contentView && runtime.contentSourcePath === sourcePath) {
      runtime.contentView.setValue(markdown)
      return
    }
    this.destroyCardContent(runtime)
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
    this.destroyCardContent(runtime)
    this.renderPlaceholder(
      runtime,
      CARD_MISSING_CLASS,
      this.t('card.missingFile'),
      this.t('card.missingFileHint').replace('{path}', path),
    )
  }

  /** What a file card shows while its file type has no card of its own — a
   * PDF (M2), anything else. Named after the file so the card still says
   * which one it is. */
  private renderUnsupportedFilePlaceholder(
    runtime: NodeRuntime,
    path: string,
  ): void {
    this.destroyCardContent(runtime)
    this.renderPlaceholder(
      runtime,
      CARD_UNSUPPORTED_PLACEHOLDER_CLASS,
      this.t('card.unsupportedFile'),
      this.t('card.unsupportedFileHint').replace('{path}', path),
    )
  }

  /**
   * Puts a vault image, audio or video file on a card, pointing the element at
   * the same `app://` resource URL Obsidian's own embeds use
   * (`vault.getResourceUrl`) so it streams and seeks exactly as it does in a
   * note (p3-canvas-parity D1).
   *
   * The element fills the card and keeps its aspect ratio without cropping
   * (style.css's `.yolo-whiteboard-card-media`). Obsidian Canvas instead
   * reshapes the *node* to the media's aspect ratio when its content loads,
   * and writes that back to the file — a load-time geometry mutation we
   * deliberately do not copy: our cards mount and unmount with the viewport,
   * so it would rewrite the board on every pan. Aspect-locked geometry belongs
   * with the resize interactions (P3 batch 3).
   *
   * Audio and video get a `releaseContent`: taking a media element out of the
   * DOM neither pauses it nor stops it streaming, so an off-screen or degraded
   * card would go on playing out of sight.
   */
  private renderMediaInto(
    runtime: NodeRuntime,
    path: string,
    kind: Exclude<FileNodeKind, 'markdown' | 'unsupported'>,
  ): void {
    this.destroyCardContent(runtime)
    const bodyEl = runtime.bodyEl
    if (!bodyEl) return
    const doc = this.context.getDocument()
    const url = this.host.vault.getResourceUrl(path)
    const frame = doc.createElement('div')
    frame.className = CARD_MEDIA_CLASS

    if (kind === 'image') {
      const image = doc.createElement('img')
      image.src = url
      // Obsidian Canvas sets this on its own image nodes: the card is what a
      // drag moves, and a native image drag would start a competing one.
      image.draggable = false
      frame.appendChild(image)
      bodyEl.replaceChildren(frame)
      return
    }

    // Element attributes copied from Obsidian's own media embed builder
    // (`app.js`'s audio/video embed helpers), so a card plays what a note
    // plays: `controlsList=nodownload` because the file is already in the
    // vault, `preload=metadata` because a board pans dozens of cards through
    // the viewport and only the transport bar has to be drawn until one is
    // played, and the `#t=0.001` fragment because a video with no poster
    // otherwise shows a black rectangle instead of its first frame.
    const media: HTMLMediaElement =
      kind === 'audio' ? doc.createElement('audio') : doc.createElement('video')
    media.controls = true
    media.setAttribute('controlsList', 'nodownload')
    media.preload = 'metadata'
    media.src = kind === 'video' ? `${url}#t=0.001` : url
    frame.appendChild(media)
    bodyEl.replaceChildren(frame)
    bodyEl.classList.add(CARD_BODY_LIVE_CLASS)
    runtime.releaseContent = () => {
      media.pause()
      // Dropping the source is what actually stops the download; `load()` is
      // what makes the element act on it.
      media.removeAttribute('src')
      media.load()
    }
  }

  /**
   * Puts a web page on a card.
   *
   * A sandboxed `<iframe>` — see WEB_FRAME_SANDBOX for why this and not the
   * Electron `<webview>` Obsidian Canvas uses on desktop. Only http(s) loads,
   * exactly as in Canvas's own `setFrameUrl`; anything else is a card that
   * says what it points at rather than a frame pointed somewhere it should
   * not be.
   */
  private renderWebFrameInto(runtime: NodeRuntime, url: string): void {
    // Already showing this exact page: leave it alone. Without this, coming
    // back from a degraded zoom (which re-runs the render path for every
    // mounted card) would tear down and reload every web card on screen —
    // the reload the hidden pool exists to avoid, arrived at from the other
    // direction.
    if (runtime.webFrameUrl === url) return
    this.destroyCardContent(runtime)
    const bodyEl = runtime.bodyEl
    if (!bodyEl) return
    if (!WEB_URL_PATTERN.test(url)) {
      this.renderPlaceholder(
        runtime,
        CARD_UNSUPPORTED_PLACEHOLDER_CLASS,
        this.t('card.linkNotWeb'),
        this.t('card.linkNotWebHint').replace('{url}', url),
      )
      return
    }
    const doc = this.context.getDocument()
    const frame = doc.createElement('iframe')
    frame.className = CARD_WEB_FRAME_CLASS
    frame.setAttribute('sandbox', WEB_FRAME_SANDBOX)
    frame.setAttribute('allow', 'fullscreen')
    frame.src = url
    bodyEl.replaceChildren(frame)
    bodyEl.classList.add(CARD_BODY_LIVE_CLASS)
    runtime.webFrameUrl = url
    // A detached frame keeps its page (and its timers, media and sockets)
    // running until it is collected; navigating it away first is what ends
    // them. Reached only on a real teardown now — the node was deleted, the
    // board closed, or the card was evicted from the pool — because an
    // ordinary unmount parks the card instead.
    runtime.releaseContent = () => {
      frame.src = 'about:blank'
      frame.remove()
    }
  }

  private renderPlaceholder(
    runtime: NodeRuntime,
    className: string,
    titleText: string,
    hintText: string,
  ): void {
    if (!runtime.bodyEl) return
    const doc = this.context.getDocument()
    const placeholder = doc.createElement('div')
    placeholder.className = className
    const title = doc.createElement('div')
    title.textContent = titleText
    const hint = doc.createElement('div')
    hint.className = CARD_HINT_CLASS
    hint.textContent = hintText
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
    // The colour rides on the path element itself, not on the shared SVG:
    // one overlay draws every edge, so per-edge colour has to be per-element.
    // The arrowhead marker picks it up through `fill: context-stroke`.
    applyColorToElement(path, edge.color)
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
      label.dataset.edgeId = edge.id
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
    this.refreshToolbar()
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
   * neither does a web card, a PDF or a media file.
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
    // Degraded cards render as a title block with the body hidden (D8), so
    // an editor mounted now would be invisible; zooming back in is the way
    // to edit. A locked board is not edited at all.
    if (!this.canCreate) return
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
    this.destroyCardContent(runtime)
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
    this.focusedNodeId = null
    for (const runtime of this.runtimeByNodeId.values()) {
      this.destroyCardContent(runtime)
      runtime.el?.remove()
      runtime.el = null
      runtime.bodyEl = null
    }
    this.runtimeByNodeId.clear()
    this.pinnedIds.clear()
    this.contentSyncQueue.clear()
    this.webFramePool.clear()
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
      if (isMarkdownPath(node.file)) {
        void this.refreshMountedNoteCard(id, runtime, path)
        continue
      }
      // Anything else has no text to re-read, and its resource URL carries
      // the file's mtime — so the way to show new bytes is a new element.
      void this.renderCardPreview(id)
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
