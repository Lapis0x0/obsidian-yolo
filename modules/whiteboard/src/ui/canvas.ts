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
import {
  approachScale,
  cameraFromView,
  clampScale,
  fitViewToBounds,
  scaleAfterWheel,
  screenToWorld,
  unionRect,
} from '../domain/camera'
import type { ScaleBounds, ScreenPoint } from '../domain/camera'
import { planNodeCommit } from '../domain/commit'
import { type ArrowDirection, arrowEnds } from '../domain/edges'
import {
  type Board,
  type BoardNode,
  type BoardParseIssue,
  type Edge,
  type EdgeAnchor,
  type EdgeId,
  type FileNode,
  type GroupNode,
  type NodeColor,
  type NodeId,
  type PortalView,
  type SpreadRect,
  emptyBoard,
  isPlainText,
  parseBoard,
  serializeBoard,
} from '../domain/fileFormat'
import {
  boardShape,
  collapseGroup,
  expandGroup,
  fileShape,
  isFolded,
  settleGroups,
  unfoldGroup,
} from '../domain/groupFold'
import {
  arrangeTargets,
  carryGroupMembers,
  collapsedGroupPlaces,
  collapsedGroupSize,
  createGroup,
  groupMemberCount,
  groupMemberExtent,
  groupParents,
  nodesToDragWith,
  releaseBounds,
  withCarried,
} from '../domain/groups'
import { BoardHistory } from '../domain/history'
import { mintEdgeId, mintNodeId } from '../domain/ids'
import {
  fileNodeKind,
  generateBoardFileName,
  isMarkdownPath,
  sanitizeFileName,
} from '../domain/naming'
import { behindPortal, joinNodePath, splitNodePath } from '../domain/nodePath'
import {
  boardWithPageWindow,
  boardWithReadingWindow,
  removeEdge,
  removeNode,
  setNodePositions,
  updateEdge,
  updateNode,
} from '../domain/operations'
import type { PdfAnnotation } from '../domain/pdfAnnotations'
import {
  type BoardChanges,
  type ComposedPortal,
  type Rect,
  changesBetween,
  clipThrough,
  commonPortal,
  composeBoard,
  fileNodeOf,
  invertChanges,
  isPortal,
  mergeChanges,
  moveToBoard,
  portalAt,
  portalOf,
  portalScale,
  portalWeight,
  tidy,
} from '../domain/portals'
import type { CardRect } from '../domain/resize'
import { type MissingFileNode, planFileNodeSelfHeal } from '../domain/selfHeal'
import { splitOff } from '../domain/split'
import {
  SPREAD_METRICS,
  closeSpread,
  defaultSpreadColumns,
  foldedCardOrigin,
  isSpreadTitle,
  layoutSpreadGrid,
  nodesToDelete,
  openSpread,
  pdfPageNodeId,
  reflowSpread,
  scaleSpread,
  spreadPages,
} from '../domain/spread'
import { resolveTextAnchor, textAnchorAt } from '../domain/textAnchor'
import { tidyRects } from '../domain/tidy'
import {
  VirtualizationEngine,
  type WorldRect,
  computeWorldViewportRect,
} from '../domain/virtualization'
import type { AnnotationPrefs } from '../host/annotationPrefs'
import type { AnnotationStores } from '../host/annotationStore'
import type { BoardCameras } from '../host/boardCameras'
import type { BoardDocuments } from '../host/boardDocuments'
import type { MinimapPrefs } from '../host/minimapPrefs'
import { takePendingFit } from '../host/pendingFit'
import type { PictureStores } from '../host/pictureStore'
import type { ReaderPanelPrefs } from '../host/readerPanelPrefs'
import type { RemoteImages } from '../host/remoteImages'
import { createWhiteboardTranslation } from '../i18n'
import { imageTargets, isRemoteImage } from '../typeset/images'

import { BoardSources } from './canvas/boardSources'
import { CameraController } from './canvas/cameraController'
import { nodeElementScale } from './canvas/cardContent'
import { CardGeneration } from './canvas/cardGeneration'
import {
  CardRenderer,
  type NodeExit,
  type NodeRuntime,
} from './canvas/cardRenderer'
import { ClipboardController } from './canvas/clipboardController'
import type { CanvasCore } from './canvas/core'
import { DropImport } from './canvas/dropImport'
import { type CardPassagePlacement, EdgeLayer } from './canvas/edgeLayer'
import { EditingController } from './canvas/editingController'
import { ExportController } from './canvas/exportController'
import { FindController, type FindHit } from './canvas/findController'
import { FindMarks } from './canvas/findMarks'
import { FramePace } from './canvas/framePace'
import {
  InteractionController,
  buildInteractionLayer,
  nodeIdFromEventTarget,
} from './canvas/interactionController'
import { KEY_LAYER_RANK, KeymapController } from './canvas/keymapController'
import { Minimap } from './canvas/minimap'
import { Motions } from './canvas/motions'
import {
  type Title,
  type TitleMeasure,
  createTitleMeasure,
  titleBox,
  titleOf,
  titleScale,
} from './canvas/nodeTitle'
import { OverviewLayer, type PortalLayer } from './canvas/overviewLayer'
import { PassageHandles } from './canvas/passageHandles'
import { PassagePoints } from './canvas/passagePoints'
import { PdfIntegration, isPdfNode } from './canvas/pdfIntegration'
import { SnapGuideLayer } from './canvas/snapGuideLayer'
import { SpreadFrame } from './canvas/spreadFrame'
import {
  PASSAGE_HIGHLIGHT,
  adjustTextPassage,
  blockAnchorAt,
  paintPassages,
  passageRange,
  placeTextLines,
  placeTextPassage,
  rangeContains,
  selectionAnchor,
  textPassageEnds,
} from './canvas/textPassages'
import { type GroupAction, ToolbarController } from './canvas/toolbarController'
import { CanvasControls } from './canvasControls'
import {
  ARRANGE_ANIMATION_EASING,
  ARRANGE_ANIMATION_MS,
  CAMERA_GLIDE_EPSILON_DOUBLINGS,
  CAMERA_GLIDE_TAU_MS,
  CARD_FOCUSED_CLASS,
  CARD_SELECTED_CLASS,
  CONTENT_BUILDS_PER_MOVING_FRAME,
  CONTENT_BUILD_START_CAP_PER_FRAME,
  EDGE_HIDDEN_CLASS,
  FIT_CAMERA_PADDING_PX,
  FOLD_COVER_MAX_MS,
  FRAME_ON_TIME_PERIODS,
  GRID_WORLD_STEP_PX,
  INTERACTING_TIMEOUT_MS,
  MIN_SCALE_FIT_MARGIN,
  MOUNT_QUOTA_PER_FRAME,
  NODE_ENTER_FROM_SCALE,
  OVERVIEW_RESTORE_SCALE,
  OVERVIEW_SCALE_THRESHOLD,
  PORTAL_BORDER_WORLD_PX,
  PORTAL_OPEN_MIN_PX,
  PORTAL_PAN_STEP_GAP_MS,
  RECOMPUTE_INTERVAL_MS,
  RESIZE_HANDLE_PX,
  SCALE_BOUNDS,
  SPREAD_SHEET_OF_SELECTED_CLASS,
  SVG_NS,
  UNMOUNT_QUOTA_PER_FRAME,
  VIEWPORT_BUFFER_PX,
  WHEEL_DELTA_PER_ZOOM_DOUBLING,
  WHEEL_ZOOM_MAX_DELTA_PER_EVENT,
} from './constants'
import {
  type FoldMotion,
  foldedPose,
  groupFoldMotions,
  spreadMotions,
} from './foldMotion'
import { GpuBoard } from './gpu/gpuBoard'
import { ImageSizes } from './gpu/imageSizes'
import { NearImages } from './gpu/nearImages'
import {
  canvasGlyphAdvance,
  placeDrawnLines,
  placeDrawnPassage,
} from './gpu/passages'
import { firstPage, pageOfKey } from './gpu/pdfCards'
import { checkTypeset, showTypeset } from './gpu/typesetCheck'
import { type PdfPageLabels, blockStartLine, nextOverviewState } from './lod'
import type { PageFrame } from './pdf/annotationGeometry'
import { PdfDrawQueue } from './pdf/drawQueue'
import { pageMarks, withPageMarks } from './pdf/pageMarks'
import { passageAnchorFromSelection } from './pdf/passageAnchor'
import type {
  PassageEnds,
  PdfReader,
  ReaderPassageMark,
  ReaderTextSelection,
} from './pdf/pdfReader'
import { PictureAnnotations } from './pdf/pictureAnnotations'
import { PictureActivity } from './pictures/activity'
import { cardSignature, isCardPictured } from './pictures/cardSignature'
import { IdleSlices } from './pictures/idle'
import { ImageFiles, imageRef } from './pictures/imageFiles'
import { PdfPages, pageFrame, pdfPageRef } from './pictures/pdfPages'
import {
  type PictureRef,
  type PictureSourceId,
  Pictures,
  type WantedPicture,
} from './pictures/pictures'
import {
  type CardImages,
  TypesetCards,
  cardRef,
  cardStamp,
  nodeColorFrom,
} from './pictures/typesetCards'
import { TypesetStyle } from './pictures/typesetStyle'
import { applyColorToElement } from './selectionToolbar'
import { type Pose, poseOf, scaledAboutCentre } from './tween'
import { TypesetClient, typesetWorkerSource } from './typesetting/typesetClient'

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
/** On the copy of a sheet held over the card it went back into
 * (`holdFoldedCard`). */
const FOLD_COVER_CLASS = 'yolo-whiteboard-spread-fold-cover'

/** One node's part in a fold, and the node it is of. */
/** A thing a collapsed group shows in its box, where the box on the board
 * puts it (`foldedShown`), and which box. */
type FoldedShown = Readonly<{ node: BoardNode; pose: Pose; box: NodeId }>

type FoldMove = Readonly<{ node: BoardNode; motion: FoldMotion }>

/** A group's frame going from `from` to `to` alongside a fold. */
type FrameMove = Readonly<{ id: NodeId; from: SpreadRect; to: SpreadRect }>

/**
 * A copy of a sheet's element as it stands at `transform` — its pictures
 * copied in, since a cloned canvas is blank — that is no card: nothing finds
 * it by id, points at it or lights it up with its spread.
 */
function foldCoverOf(el: HTMLElement, transform: string): HTMLElement {
  const cover = el.cloneNode(true) as HTMLElement
  const sources = el.querySelectorAll('canvas')
  cover.querySelectorAll('canvas').forEach((copy, index) => {
    const source = sources[index]
    if (!source || source.width === 0 || source.height === 0) return
    copy.width = source.width
    copy.height = source.height
    copy.getContext('2d')?.drawImage(source, 0, 0)
  })
  cover.removeAttribute('data-node-id')
  cover.querySelectorAll('[data-node-id]').forEach((inner) => {
    inner.removeAttribute('data-node-id')
  })
  cover.classList.remove(
    CARD_SELECTED_CLASS,
    SPREAD_SIBLING_CLASS,
    SPREAD_SHEET_OF_SELECTED_CLASS,
  )
  cover.classList.add(FOLD_COVER_CLASS)
  cover.style.transform = transform
  return cover
}
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
const PASSAGE_RUNS_CLASS = 'yolo-whiteboard-edge-passage-runs'
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
  /** The files `board` is made from, and where edits to it go
   * (./canvas/boardSources.ts). */
  private readonly sources: BoardSources
  /**
   * Changes written without a step of their own (`commitWithoutHistory`):
   * the next step takes them in, and an undo takes them back first — the
   * board as the last step left it is what an undo starts from.
   */
  private unrecorded: BoardChanges | null = null
  /** Nodes made by unrecorded changes, which no step has ever had. */
  private readonly unrecordedCreations = new Set<NodeId>()
  /** The portals on the board, whether open or not. */
  private portalNodes: FileNode[] = []
  /** Every node a visibility pass may mount: a node behind a portal only
   * while some of it shows through. */
  private visibilityNodes: readonly BoardNode[] = []
  private sourceRefreshPending = false
  /** The cards and edges of the board's own file, and what is behind each
   * open portal, for the canvas tiers that draw them separately. */
  private ownCardNodes: readonly BoardNode[] = []
  private ownEdges: readonly Edge[] = []
  /**
   * The open portals that show what is behind them smaller than the overview
   * tier's threshold — the camera's scale times theirs. The cards behind
   * them are not built: the canvas draws them under the world layer as it
   * draws any card with no element (overviewLayer.ts's `renderUnmounted`),
   * which is the tier, inside one frame. Decided with the tier's two
   * thresholds, at its throttle (`updateDrawnPortals`).
   */
  private drawnPortals: ReadonlySet<NodeId> = new Set()
  private portalLayers: readonly (PortalLayer & {
    portal: ComposedPortal
    /** Behind it but outside its frame: not drawn until a gesture moves
     * the frame over them (`livePortalLayers`). */
    hidden: readonly BoardNode[]
  })[] = []
  /** The edges' SVG definitions, and in them the frame each open portal
   * cuts its edges to (`edgeClipPath`), by portal. */
  private edgeDefsEl: SVGDefsElement | null = null
  private readonly portalClipEls = new Map<NodeId, SVGClipPathElement>()
  /** The edges' arrowhead (`arrowMarkerId`), and a copy of it per open
   * portal weighted for the scale the portal shows its board at — a marker
   * takes its style from where it is defined, not from the line using it
   * (`edgePortalWeight`). */
  private arrowMarkerEl: SVGMarkerElement | null = null
  private readonly portalMarkerEls = new Map<NodeId, SVGMarkerElement>()
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
  /** The group each node is directly in (domain/groups.ts's
   * `groupParents`). */
  private parentGroups: ReadonlyMap<NodeId, NodeId> = new Map()
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
  /** Bumped whenever `pinnedIds` changes: one of the visibility pass's
   * inputs (`visibilityInputs`). */
  private pinsRevision = 0
  /** What the last visibility pass was asked about, to tell whether the
   * next one would answer the same (`frame`). */
  private visibilityInputs: readonly unknown[] = []
  /**
   * Where every node in motion is shown (./canvas/motions.ts): what every
   * hand that draws the board asks, so a node moves the same whichever
   * draws it.
   */
  /** What the collapsed groups on the board show in their boxes, where
   * (`foldedShown`); kept with the board's index. */
  private folded: readonly FoldedShown[] = []
  private readonly motions = new Motions({
    window: () => this.context.getWindow(),
    rectOf: (id) => this.nodesById.get(id) ?? null,
    liveRectOf: (id) => this.interaction.liveNodeRects?.get(id) ?? null,
    elementOf: (id) =>
      this.shownByElement(id)
        ? (this.cardRenderer.getRuntime(id)?.el ?? null)
        : null,
    scaleOf: (id) => this.scaleOf(id),
  })
  /** A card asked to be edited from the overview tier, waiting for the camera
   * to bring it back into the DOM (`zoomInToEdit`), and when to give up. */
  private pendingEdit: Readonly<{ id: NodeId; until: number }> | null = null
  /** The spread whose title the pointer is on (`syncSpreadHover`). */
  private hoveredSpreadId: NodeId | null = null
  /** Spreads and groups whose things are being gathered into their fold
   * before it closes (`gather`). */
  private readonly folding = new Set<NodeId>()
  /** A sheet's sharp picture of its page, copied from the card it is being
   * dealt out of, for its reader to show until it has drawn its own — so the
   * page the card was showing does not go soft as it becomes a sheet. */
  private readonly spreadHandoffPictures = new Map<NodeId, HTMLCanvasElement>()
  /** A copy of the sheet that just became a folded card, laid over the card
   * until its reader has drawn (`holdFoldedCard`) — so the page does not go
   * blank, then soft, as the card mounts and opens its file. */
  private readonly foldCovers = new Map<
    NodeId,
    Readonly<{ cover: HTMLElement; timer: number }>
  >()

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
  /** Whether the camera is where the board is being looked at — false while
   * a board is being loaded, before its camera is (`wantsPortalOpen`). */
  private cameraPlaced = true
  /** The portal the wheel last panned or zoomed, how, and when: a pause, or
   * the other gesture, ends the step (`portalStepKey`). */
  private portalStep: Readonly<{
    id: NodeId
    kind: 'pan' | 'zoom'
    at: number
  }> | null = null
  private portalStepSerial = 0
  /** Where a wheel zoom in a portal is heading: what it shows eases toward
   * `targetScale` screen pixels to a unit, about `cursor`, frame by frame —
   * the board's own wheel zoom's glide (CameraController's `cameraGlide`),
   * applied to the portal's view. Null at rest. */
  private portalZoomGlide: Readonly<{
    id: NodeId
    targetScale: number
    cursor: ScreenPoint
    historyKey: string
  }> | null = null
  private lastPortalZoomAt: number | null = null

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
  /** The board's find (./canvas/findController.ts), what it found and the
   * hit stepped to, and their marks on the cards. */
  private find: FindController | null = null
  private findMarks: FindMarks | null = null
  /** Annotated PDF pages' pictures with their annotations painted in, for
   * the GPU scene, by the picture they are painted on. */
  private readonly markedPages = new WeakMap<
    ImageBitmap,
    Readonly<{
      annotations: readonly PdfAnnotation[]
      colors: Readonly<Record<string, string>>
      picture: ImageBitmap
    }>
  >()
  /** Where a drawn card's glyphs are, for placing a passage among them. */
  private readonly glyphAdvance = canvasGlyphAdvance()
  /** The whole board in the viewport's corner (./canvas/minimap.ts). */
  private minimap: Minimap | null = null
  /** Keeps this board's minimap switch in step with a change made from
   * another board (MinimapPrefs is shared by all of them). */
  private readonly unsubscribeMinimapPrefs: () => void
  /** Waiting for this device's cameras to be read, to open the board where
   * it was last looked at here (`setViewData`). */
  private stopWaitingForCamera: () => void = () => undefined
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

  // Edges: a single SVG overlay drawn into the world layer, brought in step
  // with the board's edges after a change to them (syncEdgesSvg) and redrawn
  // per path on card position change (redrawEdgesForNodes) — see ./canvas/edgeLayer.ts, which
  // owns the SVG's child elements and the incidence index, and its own doc
  // comment for the mount-independent, DOM-measurement-free approach.
  /** Constructed once in `ensureDom`, once the edges `<svg>` exists. */
  private edgeLayer!: EdgeLayer
  /** Drawn only while a drag or a resize is lining something up. */
  private snapGuideLayer: SnapGuideLayer | null = null
  /** The frame and reflow handle around a selected PDF spread
   * (./canvas/spreadFrame.ts). */
  private spreadFrame: SpreadFrame | null = null
  /** The edge the pointer is on, whose passages are marked strongly. */
  private hoveredEdgeId: EdgeId | null = null
  /** The handles of the selected edge's passages. */
  private passageHandles: PassageHandles | null = null
  /** The connection points of text selected in a PDF card. */
  private passagePoints: PassagePoints | null = null
  /** Bumped by every selection reported, so a passage made for an older one
   * (it is made asynchronously) is dropped. */
  private passageSelection = 0
  /** The passage points stand for text selected in a text or note card
   * (`syncTextSelection`), not a PDF's. */
  private textPassageSelected = false
  /** The passage points stand for a highlight opened in a PDF card
   * (`selectHighlight`), which no text selection backs. */
  private highlightSelected = false
  /** The text last selected in a PDF card that the passage points stood
   * for, kept so a connection pulled from it can mark it where it was read
   * — past the selection itself, which a press on a point may take away.
   * Matched by the very anchor the connection carries, so it marks nothing
   * but that passage. */
  private pdfPassage: Readonly<{
    reader: PdfReader
    selection: ReaderTextSelection
    anchor: EdgeAnchor
  }> | null = null
  /** The card whose editor was open at the last editing change. */
  private lastEditingId: NodeId | null = null
  private selectionFrame: number | null = null
  /**
   * The overview tier's renderer. Built in `ensureDom`; null before
   * that, which `clear()` can reach.
   */
  private overviewLayer: OverviewLayer | null = null
  /** Whether the camera is below the overview threshold — see
   * `updateOverviewState`. Updated at recomputeVisibility's ~70ms throttle,
   * behind a hysteresis band. */
  private overview = false
  /** The camera scale titles were last sized for. */
  private titlesScaledAt = 0
  /** How wide titles lay out (`titleMeasure`), once the font is known. */
  private titleMeasureOf: TitleMeasure | null = null
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
  /** When an export last moved the camera: the board has caught up with it
   * once a visibility pass has run since (`ExportController`'s `isSettled`). */
  private exportCameraMovedAt = 0
  private exporter: ExportController | null = null
  /** Cards whose content build ran out of a frame's budget and is owed on a
   * later one — drained a few per frame by `drainQueues` (see
   * `renderMarkdownInto`, which is what puts them here). */
  private readonly contentSyncQueue = new Set<NodeId>()

  /**
   * How many cards may still have their content built this frame
   * (`takeContentBuild`): any number while nothing moves; while the camera
   * does, CONTENT_BUILDS_PER_MOVING_FRAME after a frame that arrived on time
   * (FRAME_ON_TIME_PERIODS) and none after one that did not. Re-derived once
   * per frame; taken wherever a build is about to start, including the
   * builds that only reach that point after reading a file, a frame or more
   * later.
   */
  private contentBuildsLeft = Infinity
  private lastFrameAt: number | null = null
  private readonly framePace = new FramePace(FRAME_ON_TIME_PERIODS)
  /** The zoom the last frame drew, and when the zoom last changed: while it
   * is changing no card content is built (`frame`). */
  private lastFrameScale = 0
  private zoomChangedAt = -Infinity

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
  /** Small pictures of what the board shows — every open spread's pages —
   * made while the board is still (./pictures/pictures.ts). */
  private pictures: Pictures | null = null
  /** The idle time pictures are made in (./pictures/idle.ts). */
  private pictureSlices: IdleSlices | null = null
  /** How a card looks, as the typesetter that draws card pictures reads
   * it (./pictures/typesetStyle.ts). */
  private typesetStyle: TypesetStyle | null = null
  /** The board's typesetting worker, for cards' pictures and the GPU
   * scene (./typesetting/typesetClient.ts). */
  private typesetClient: TypesetClient | null = null
  /** The GPU scene (./gpu/gpuBoard.ts). */
  private gpuBoard: GpuBoard | null = null
  /** The own sizes of the images cards embed (./gpu/imageSizes.ts). */
  private imageSizes: ImageSizes | null = null
  private unsubscribeRemoteImages: (() => void) | null = null
  /** The images GPU cards show near to, decoded at that size. */
  private nearImages: NearImages | null = null
  /** The board's line in the host's activity list while it makes pictures
   * (./pictures/activity.ts). */
  private pictureActivity: PictureActivity | null = null
  /** The annotations of the PDFs whose pages have pictures, which the
   * overview draws over them (./pdf/pictureAnnotations.ts). */
  private pictureAnnotations: PictureAnnotations | null = null

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
    private readonly pictureStores: PictureStores,
    private readonly minimapPrefs: MinimapPrefs,
    private readonly boardCameras: BoardCameras,
    documents: BoardDocuments,
    private readonly remoteImages: RemoteImages,
  ) {
    this.sources = new BoardSources({
      documents,
      ownPath: () => this.sourcePathForBoard(),
      wantsOpen: (portal, _id, open) => this.wantsPortalOpen(portal, open),
      onSourceChange: () => this.scheduleSourceRefresh(),
      owner: { requestSave: () => this.context.requestSave() },
    })
    this.unsubscribeMinimapPrefs = minimapPrefs.subscribe(() =>
      this.canvasControls?.refresh(),
    )
    this.core = {
      context: this.context,
      host: this.host,
      motions: this.motions,
      getBoard: () => this.board,
      getNode: (id) => this.nodesById.get(id),
      getEdge: (id) => this.boardEdgesById.get(id),
      getCardNodes: () => this.cardNodes,
      nextNodeId: (board) => this.nextNodeId(board),
      nextEdgeId: () => this.nextEdgeId(),
      isParseFailed: () => this.parseFailed,
      canEdit: () => this.canEdit,
      isOverview: () => this.overview,
      portalTierOf: (id) => this.portalTierOf(id),
      drawnCardAt: (point) => {
        if (this.drawnPortals.size === 0 && !this.gpuBoard) return null
        const id = this.cardAtPoint(point, false)
        if (id === null) return null
        const node = this.nodesById.get(id)
        return node && this.isDrawn(node) ? id : null
      },
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
      scaleOf: (id) => this.scaleOf(id),
      recomputeVisibility: () => this.recomputeVisibility(),
      drainQueues: () => this.drainQueues(),
      getSourcePath: () => this.sourcePathForBoard(),
      sourcePathOf: (id) => this.sourcePathOf(id),
      portalViewOf: (id) => this.portalViewOf(id),
      portalAtPoint: (point) =>
        portalAt(point, this.sources.composition.portals, () => false)?.id ??
        null,
      lookThroughPortal: (id, view, historyKey) => {
        // A drag or a pinch takes the portal from a wheel zoom still easing.
        this.portalZoomGlide = null
        this.lookThroughPortal(id, view, historyKey)
      },
      zoomablePortalAt: (point) => this.zoomablePortalAt(point),
      portalViewAnchored: (id, looking, from, to, toScale) =>
        this.portalViewAnchored(id, looking, from, to, toScale),
      cardAtPoint: (point, portals) => this.cardAtPoint(point, portals),
      commitMove: (next, ids, point, historyKey) =>
        this.commitMove(next, ids, point, historyKey),
      clipOf: (id) => this.clipOf(id),
      t: (key, fallback) => this.t(key, fallback),
      reportError: (stage, error) => this.reportError(stage, error),
    }
  }

  private commitMove(
    next: Board,
    ids: readonly NodeId[],
    point: ScreenPoint,
    historyKey?: string,
  ): void {
    const composition = this.sources.composition
    if (composition.portals.size === 0) {
      this.flyIntoBoxes(next, ids)
      this.applyBoardChange(next, historyKey)
      return
    }
    // What is behind a dragged portal goes where the portal goes.
    const dragged = new Set(ids)
    const rides = (id: NodeId) => {
      const parts = splitNodePath(id)
      for (let end = 1; end < parts.length; end += 1) {
        if (dragged.has(joinNodePath(parts.slice(0, end)))) return true
      }
      return false
    }
    const to = portalAt(
      point,
      composition.portals,
      (id) => dragged.has(id) || rides(id),
    )
    const { board, renamed } = moveToBoard(
      next,
      composition,
      this.sourcePathForBoard(),
      ids.filter((id) => !rides(id)),
      to,
      point,
    )
    this.applyBoardChange(board, historyKey)
    if (renamed.size === 0) return
    // The same cards under new names: what was built for the old ones goes,
    // and the new ones are not arriving.
    for (const [from, name] of renamed) {
      this.purgeNodeRuntime(from)
      this.motions.stop([name])
    }
    this.setSelection([...this.selectedIds].map((id) => renamed.get(id) ?? id))
  }

  /**
   * Cards a drop puts away into a collapsed group (dragGestures.ts's
   * `withDropMembership`), shown going into the box: each — with what it
   * carries — shrinking from where it was let go to its cell, where the box
   * draws its picture of it once it gets there. They leave the
   * board with the drop: each goes as an element being let go of
   * (cardRenderer.ts's `playExit`), or, drawn, as a node departing
   * (./canvas/motions.ts's `depart`).
   */
  private flyIntoBoxes(next: Board, ids: readonly NodeId[]): void {
    if (this.prefersReducedMotion()) return
    const settled = this.fitFrames(next)
    const staying = new Set(settled.nodes.map((node) => node.id))
    const gone = new Set(
      ids.filter((id) => this.nodesById.has(id) && !staying.has(id)),
    )
    if (gone.size === 0) return
    const live = this.interaction.liveNodeRects
    for (const box of settled.nodes) {
      if (!isFolded(box)) continue
      const stash = box.stash.nodes
      const byId = new Map(stash.map((node) => [node.id, node]))
      const members = box.members.flatMap((id) => {
        const node = byId.get(id)
        return node ? [node] : []
      })
      if (!members.some((member) => gone.has(member.id))) continue
      const places = collapsedGroupPlaces(
        box,
        members.map((member) => ({
          id: member.id,
          extent: groupMemberExtent(member, stash),
        })),
        this.scaleOf(box.id),
      )
      const moves = groupFoldMotions(places, (id) => {
        const member = byId.get(id)
        return member ? withCarried(member, stash) : []
      })
      for (const { node, motion } of moves) {
        const was = this.nodesById.get(node.id)
        const held = live?.get(node.id) ?? was
        if (!gone.has(node.id) || !was || !held) continue
        const into = foldedPose(node, motion)
        const el = this.shownByElement(node.id)
          ? this.cardRenderer.getRuntime(node.id)?.el
          : null
        // Its cell stays empty until it arrives (`folded`); the canvas
        // draws it on the way, under its element if it has one — from where
        // it is shown, picked up as it still is.
        this.motions.depart(
          was,
          this.motions.pose(node.id) ?? poseOf(held),
          into,
        )
        if (!el) {
          // Parked under the drawing while it was dragged: it goes now.
          this.purgeNodeRuntime(node.id)
          continue
        }
        // From where it stands on screen — its drag's `translate` and all —
        // to its cell.
        const unit = nodeElementScale(el)
        const transform = `translate(${(into.x - held.x) / unit}px, ${(into.y - held.y) / unit}px) scale(${into.w / held.w})`
        this.purgeNodeRuntime(node.id, {
          exit: {
            keyframes: [
              { transformOrigin: '0 0', transform: 'none' },
              { transformOrigin: '0 0', transform },
            ],
          },
        })
      }
    }
  }

  private cardAtPoint(point: ScreenPoint, portals: boolean): NodeId | null {
    const inside = (rect: Rect) =>
      point.x >= rect.x &&
      point.x <= rect.x + rect.w &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.h
    const nodes = this.cardNodes
    let portal: NodeId | null = null
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]
      if (!inside(node)) continue
      const clip = this.clipOf(node.id)
      if (clip && !inside(clip)) continue
      if (!isPortal(node)) return node.id
      if (portals) portal ??= node.id
    }
    return portal
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
    // Read back empty after this view has read it with content: caught
    // mid-write by something outside that empties a file before writing it
    // (`cp`, `git checkout`). Taken as the empty board it parses to, the next
    // save would write that over the file — measured, a 3000-card board was
    // lost this way. The board stays as it is until the file is read with
    // content again; a file new and empty still opens as an empty board.
    if (!data.trim() && this.lastRawData.trim()) return
    this.ensureDom()
    this.lastRawData = data
    // Before `teardownAllCards`, whose own commit path would land the edit on
    // the board this method is about to replace. See the doc comment.
    this.editing.endEditForIncomingBoard()
    this.teardownAllCards()
    // The file, as the document every view of it shares has it — in the
    // board's own shape: an open PDF spread becomes its title and a node per
    // page (domain/spread.ts). `getViewData` folds it back.
    const own = this.sources.load(data)

    if (!own) {
      const result = parseBoard(data)
      this.parseFailed = true
      this.board = emptyBoard()
      this.syncBoardIndex()
      this.interaction.setHoveredNode(null)
      this.showError(result.ok ? [] : result.issues)
      return
    }

    this.parseFailed = false
    // Shut until the camera is where the board opens: what is behind a portal
    // is read when it is on screen, and nothing is yet.
    this.cameraPlaced = false
    this.board = this.sources.compose()
    this.syncBoardIndex()
    this.selfHealMissingFileNodes()
    this.unrecorded = null
    this.unrecordedCreations.clear()
    // Baseline for undo, taken after self-heal so the repaired board is the
    // oldest state anyone can get back to. Reset rather than extended: this
    // is a different file, or the same file rewritten from outside, and
    // pushing the previous content over it is how an undo destroys data.
    this.history.reset()
    this.syncEdgesSvg()
    this.cameraController.loadCamera(this.board.camera)
    this.openWhereLastLooked()
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
    this.cameraPlaced = true
    this.recomputeVisibility()
    this.drainQueues()
  }

  /** Sorts the board's cards and edges into its own and each open
   * portal's (`portalLayers`). */
  private splitPortalLayers(
    portals: ReadonlyMap<NodeId, ComposedPortal>,
  ): void {
    const cards = this.board.nodes.filter((node) => node.type !== 'group')
    if (portals.size === 0) {
      this.ownCardNodes = cards
      this.ownEdges = this.board.edges
      this.portalLayers = []
      return
    }
    const own: BoardNode[] = []
    const layers = new Map<
      NodeId,
      {
        portal: ComposedPortal
        clip: Rect
        scale: number
        nodes: BoardNode[]
        hidden: BoardNode[]
        edges: Edge[]
      }
    >()
    const layerOf = (portal: ComposedPortal) => {
      let layer = layers.get(portal.id)
      if (!layer) {
        layer = {
          portal,
          clip: portal.clip,
          scale: portal.scale,
          nodes: [],
          hidden: [],
          edges: [],
        }
        layers.set(portal.id, layer)
      }
      return layer
    }
    for (const node of cards) {
      const portal = portalOf(node.id, portals)
      if (!portal) own.push(node)
      // What its frame hides is not drawn at all.
      else if (overlaps(node, portal.clip)) layerOf(portal).nodes.push(node)
      else layerOf(portal).hidden.push(node)
    }
    const ownEdges: Edge[] = []
    for (const edge of this.board.edges) {
      const portal = commonPortal(edge.fromNode, edge.toNode, portals)
      if (portal) layerOf(portal).edges.push(edge)
      else ownEdges.push(edge)
    }
    this.ownCardNodes = own
    this.ownEdges = ownEdges
    this.portalLayers = [...layers.values()]
    this.syncPortalClipPaths(portals)
  }

  /** What is behind each open portal as a gesture has it: cut to the frame
   * where the gesture holds it (`portalClip`), as the DOM tiers cut it — so
   * what a frame being made larger comes over shows as it does — and with
   * the cards picked up out of it on their own, uncut and over everything:
   * in the hand rather than behind the frame (`clipOf`), and still the size
   * they were picked up at, so drawn at its scale. */
  private livePortalLayers(): readonly PortalLayer[] {
    const live = this.interaction.liveNodeRects
    if (!live) return this.portalLayers
    const lifted: PortalLayer[] = []
    const layers = this.portalLayers.map((layer) => {
      const clip = this.portalClip(layer.portal)
      const carried = live.has(layer.portal.id)
      const nodes = carried
        ? layer.nodes
        : layer.nodes.filter((node) => !live.has(node.id))
      const shown = layer.hidden.filter((node) =>
        overlaps(live.get(node.id) ?? node, clip),
      )
      if (!carried) {
        const inHand = layer.nodes.filter((node) => live.has(node.id))
        if (inHand.length > 0) {
          lifted.push({
            clip: null,
            scale: layer.scale,
            nodes: inHand,
            edges: [],
          })
        }
      }
      return {
        clip,
        scale: layer.scale,
        nodes: shown.length > 0 ? [...nodes, ...shown] : nodes,
        edges: layer.edges,
      }
    })
    return lifted.length === 0 ? layers : [...layers, ...lifted]
  }

  /** One `<clipPath>` per open portal, its frame on the board. */
  private syncPortalClipPaths(
    portals: ReadonlyMap<NodeId, ComposedPortal>,
  ): void {
    const defs = this.edgeDefsEl
    if (!defs) return
    for (const [id, el] of this.portalClipEls) {
      if (portals.has(id)) continue
      el.remove()
      this.portalClipEls.delete(id)
      this.portalMarkerEls.get(id)?.remove()
      this.portalMarkerEls.delete(id)
    }
    const doc = this.context.getDocument()
    for (const [id, portal] of portals) {
      let el = this.portalClipEls.get(id)
      if (!el) {
        el = doc.createElementNS(SVG_NS, 'clipPath')
        el.setAttribute(
          'id',
          `${this.arrowMarkerId}-portal-${this.portalClipEls.size}-${Math.random().toString(36).slice(2, 8)}`,
        )
        el.setAttribute('clipPathUnits', 'userSpaceOnUse')
        el.appendChild(doc.createElementNS(SVG_NS, 'rect'))
        defs.appendChild(el)
        this.portalClipEls.set(id, el)
      }
      let marker = this.portalMarkerEls.get(id)
      if (!marker && this.arrowMarkerEl) {
        marker = this.arrowMarkerEl.cloneNode(true) as SVGMarkerElement
        marker.setAttribute('id', `${el.id}-arrow`)
        defs.appendChild(marker)
        this.portalMarkerEls.set(id, marker)
      }
      marker?.style.setProperty(
        '--yolo-whiteboard-portal-weight',
        String(portalWeight(portal.scale)),
      )
      const rect = el.firstElementChild
      const clip = this.portalClip(portal)
      rect?.setAttribute('x', String(clip.x))
      rect?.setAttribute('y', String(clip.y))
      rect?.setAttribute('width', String(clip.w))
      rect?.setAttribute('height', String(clip.h))
    }
  }

  private edgeClipPath(edge: Edge): string | null {
    const portals = this.sources.composition.portals
    if (portals.size === 0) return null
    const portal = commonPortal(edge.fromNode, edge.toNode, portals)
    const el = portal ? this.portalClipEls.get(portal.id) : undefined
    return el ? `url(#${el.id})` : null
  }

  /** How heavily an edge behind a portal is drawn, and with which
   * arrowhead (edgeLayer.ts's `portalWeightOf`); null for the board's own. */
  private edgePortalWeight(
    edge: Edge,
  ): Readonly<{ weight: number; markerId: string }> | null {
    const portals = this.sources.composition.portals
    if (portals.size === 0) return null
    const portal = commonPortal(edge.fromNode, edge.toNode, portals)
    const marker = portal ? this.portalMarkerEls.get(portal.id) : undefined
    if (!portal || !marker) return null
    return { weight: portalWeight(portal.scale), markerId: marker.id }
  }

  /** Where a card behind a portal shows through it; null for the board's
   * own. */
  private clipOf(id: NodeId): Rect | null {
    const portals = this.sources.composition.portals
    if (portals.size === 0) return null
    const portal = portalOf(id, portals)
    if (!portal) return null
    // Picked up without its portal: in the hand, not behind the frame — so
    // it can be carried out through it.
    const live = this.interaction.liveNodeRects
    if (live?.has(id) && !live.has(portal.id)) return null
    return this.portalClip(portal)
  }

  /** Where what is behind `portal` shows now: inside every frame on the way
   * in — inside its border, which is drawn over what it frames, not under
   * it — with the frames a drag or a resize is holding where they are held. */
  private portalClip(portal: ComposedPortal): Rect {
    const live = this.interaction.liveNodeRects
    const inset = PORTAL_BORDER_WORLD_PX
    return clipThrough(portal, this.sources.composition.portals, (id) => {
      const rect = live?.get(id) ?? this.nodesById.get(id)
      return rect
        ? {
            x: rect.x + inset,
            y: rect.y + inset,
            w: Math.max(0, rect.w - inset * 2),
            h: Math.max(0, rect.h - inset * 2),
          }
        : { x: 0, y: 0, w: 0, h: 0 }
    })
  }

  /** What a portal says in place of the board behind it, when it is not
   * showing it. */
  private portalNotice(
    id: NodeId,
  ): Readonly<{ title: string; hint: string }> | null {
    const node = this.nodesById.get(id)
    if (!isPortal(node)) return null
    const path = node.file
    switch (this.sources.portalState(id)) {
      case 'loading':
        return { title: this.t('card.portalLoading'), hint: '' }
      case 'missing':
        return {
          title: this.t('card.portalMissing'),
          hint: this.t('card.portalMissingHint').replace('{path}', path),
        }
      case 'invalid':
        return {
          title: this.t('card.portalInvalid'),
          hint: this.t('card.portalInvalidHint').replace('{path}', path),
        }
      case 'cycle':
        return {
          title: this.t('card.portalCycle'),
          hint: this.t('card.portalCycleHint'),
        }
      default:
        return null
    }
  }

  /**
   * Opens the board behind a portal in a new tab, looking at what the portal
   * showed of it, where the portal showed it — the selection toolbar's
   * button for a portal.
   */
  /**
   * Points a portal at everything on the board behind it, centred in its
   * frame, as the board's own fit frames a board: never larger than the
   * board behind is drawn at by a portal of scale 1. A board with nothing on
   * it is looked at from its origin. One step to undo.
   */
  private fitPortal(id: NodeId): void {
    const node = this.nodesById.get(id)
    const portal = this.sources.composition.portals.get(id)
    const looking = this.portalViewOf(id)
    if (!isPortal(node) || !portal || !looking) return
    const bounds = unionRect(portal.source.nodes)
    // The frame, measured in what one unit behind a portal of scale 1 is.
    const outer = looking.unit / looking.scale
    const fit = bounds
      ? fitViewToBounds(
          bounds,
          { width: node.w / outer, height: node.h / outer },
          FIT_CAMERA_PADDING_PX,
          SCALE_BOUNDS,
        )
      : { tx: 0, ty: 0, scale: 1 }
    this.portalZoomGlide = null
    this.lookThroughPortal(
      id,
      {
        x: tidy(-fit.tx / fit.scale),
        y: tidy(-fit.ty / fit.scale),
        scale: tidy(fit.scale),
      },
      `portal-fit:${id}:${this.context.getWindow().performance.now()}`,
    )
  }

  private openPortal(id: NodeId): void {
    const node = this.nodesById.get(id)
    if (!isPortal(node)) return
    const portal = this.sources.composition.portals.get(id)
    const view = this.cameraController.view
    if (portal) {
      this.boardCameras.set(node.file, {
        x: view.tx + portal.dx * view.scale,
        y: view.ty + portal.dy * view.scale,
        scale: view.scale * portal.scale,
      })
    }
    void this.host.ui.openFileAt({ path: node.file, newLeaf: true })
  }

  /**
   * The wheel over the selected portal, or over a card seen through it, moves
   * what the portal shows — its `view` — the way the selected note card
   * scrolls its text. A run of wheel events is one step to undo. False when
   * the focused card is not a portal showing its board, which leaves the
   * wheel to the board.
   */
  private panPortalBy(
    target: EventTarget | null,
    deltaX: number,
    deltaY: number,
  ): boolean {
    const id = this.focusedNodeId
    const node = id === null ? undefined : this.nodesById.get(id)
    if (id === null || !isPortal(node)) return false
    const over = nodeIdFromEventTarget(target)
    if (
      over === null ||
      !(over === id || over.startsWith(behindPortal(id, '')))
    )
      return false
    const looking = this.portalViewOf(id)
    if (!looking) return false
    const scale = this.cameraController.view.scale * looking.unit
    const view = {
      x: looking.x + deltaX / scale,
      y: looking.y + deltaY / scale,
      scale: looking.scale,
    }
    this.lookThroughPortal(id, view, this.portalStepKey(id, 'pan'))
    return true
  }

  /**
   * The wheel over the card being read, which the GPU scene draws and so has
   * no DOM to be the event's target: found by where the cursor is, under any
   * card that has DOM over it. False when it is not over it, or all of it
   * shows.
   */
  private scrollReadCardBy(
    target: EventTarget | null,
    deltaY: number,
    cursor: ScreenPoint,
  ): boolean {
    const id = this.focusedNodeId
    const node = id === null ? undefined : this.nodesById.get(id)
    if (id === null || !node || !this.gpuBoard) return false
    const over = nodeIdFromEventTarget(target)
    if (over !== null && over !== id) return false
    const point = screenToWorld(this.cameraController.view, cursor)
    if (
      point.x < node.x ||
      point.y < node.y ||
      point.x > node.x + node.w ||
      point.y > node.y + node.h
    ) {
      return false
    }
    return this.gpuBoard.scrollBy(id, deltaY)
  }

  /**
   * Ctrl+wheel, or a trackpad pinch, over the selected portal's frame zooms
   * what it shows about the cursor, as the same gesture zooms the board
   * anywhere else — within the board's bounds, as seen on screen. A run of
   * it is one step to undo. False when the focused card is not a portal
   * showing its board, or the cursor is outside its frame.
   */
  private zoomPortalBy(deltaY: number, cursor: ScreenPoint): boolean {
    const point = screenToWorld(this.cameraController.view, cursor)
    const id = this.zoomablePortalAt(point)
    const looking = id === null ? null : this.portalViewOf(id)
    if (id === null || !looking) return false
    const step = Math.max(
      -WHEEL_ZOOM_MAX_DELTA_PER_EVENT,
      Math.min(WHEEL_ZOOM_MAX_DELTA_PER_EVENT, deltaY),
    )
    // Aimed from where the glide is heading, not from where it has got to,
    // as the board's own zoom is (CameraController's `zoomBy`).
    const glide = this.portalZoomGlide
    const targetScale = scaleAfterWheel(
      glide?.id === id
        ? glide.targetScale
        : this.cameraController.view.scale * looking.unit,
      step,
      WHEEL_DELTA_PER_ZOOM_DOUBLING,
      this.portalZoomBounds(id),
    )
    const historyKey = this.portalStepKey(id, 'zoom')
    if (this.prefersReducedMotion()) {
      const view = this.portalViewAnchored(
        id,
        looking,
        point,
        point,
        () => targetScale,
      )
      if (view) this.lookThroughPortal(id, view, historyKey)
      return true
    }
    if (glide?.id !== id) this.lastPortalZoomAt = null
    this.portalZoomGlide = { id, targetScale, cursor, historyKey }
    return true
  }

  /** Moves a portal's wheel zoom one frame closer to where it was aimed, on
   * the board's own glide law (domain/camera.ts's `approachScale`). */
  private advancePortalZoom(now: number): void {
    const glide = this.portalZoomGlide
    if (!glide) return
    const elapsed =
      this.lastPortalZoomAt === null
        ? 16.7
        : Math.min(now - this.lastPortalZoomAt, 100)
    this.lastPortalZoomAt = now
    const looking = this.portalViewOf(glide.id)
    if (!looking) {
      this.portalZoomGlide = null
      return
    }
    const seen = this.cameraController.view.scale * looking.unit
    const next = approachScale(
      seen,
      glide.targetScale,
      elapsed,
      CAMERA_GLIDE_TAU_MS,
    )
    const settled =
      Math.abs(Math.log2(next / glide.targetScale)) <
      CAMERA_GLIDE_EPSILON_DOUBLINGS
    const point = screenToWorld(this.cameraController.view, glide.cursor)
    const view = this.portalViewAnchored(glide.id, looking, point, point, () =>
      settled ? glide.targetScale : next,
    )
    if (settled) this.portalZoomGlide = null
    if (view) this.lookThroughPortal(glide.id, view, glide.historyKey)
  }

  /**
   * The range a zoom inside portal `id` keeps what it shows to, as seen on
   * screen: the board's own (CameraController's `zoomScaleBounds`), with the
   * floor lowered for a board behind it too wide to fit in its frame above
   * it — so it can always be zoomed out to be seen whole in the frame, as
   * the board can be in the window.
   */
  private portalZoomBounds(id: NodeId): ScaleBounds {
    const node = this.nodesById.get(id)
    const portal = this.sources.composition.portals.get(id)
    const bounds = portal ? unionRect(portal.source.nodes) : null
    if (!node || !bounds) return SCALE_BOUNDS
    const { scale } = this.cameraController.view
    const fit = fitViewToBounds(
      bounds,
      { width: node.w * scale, height: node.h * scale },
      FIT_CAMERA_PADDING_PX,
      SCALE_BOUNDS,
    )
    const min = Math.min(SCALE_BOUNDS.min, fit.scale * MIN_SCALE_FIT_MARGIN)
    return min < SCALE_BOUNDS.min
      ? { min, max: SCALE_BOUNDS.max }
      : SCALE_BOUNDS
  }

  /** The portal a zoom at a world point zooms the inside of: the selected
   * one, when it shows its board and the point is in its frame (core.ts's
   * `zoomablePortalAt`). */
  private zoomablePortalAt(point: ScreenPoint): NodeId | null {
    const id = this.focusedNodeId
    const portal =
      id === null ? undefined : this.sources.composition.portals.get(id)
    if (id === null || !portal) return null
    const clip = this.portalClip(portal)
    return point.x >= clip.x &&
      point.y >= clip.y &&
      point.x <= clip.x + clip.w &&
      point.y <= clip.y + clip.h
      ? id
      : null
  }

  /**
   * Where portal `id` looks once what it shows is seen at `toScale(seen)`
   * screen pixels to a unit rather than the `seen` it had when it looked at
   * `looking`, with what was at world point `from` then now at `to` (core.ts's
   * `portalViewAnchored`). Null when it is not a portal on this board.
   */
  private portalViewAnchored(
    id: NodeId,
    looking: Readonly<{ x: number; y: number; scale: number; unit: number }>,
    from: ScreenPoint,
    to: ScreenPoint,
    toScale: (seen: number) => number,
  ): PortalView | null {
    const node = this.nodesById.get(id)
    if (!isPortal(node)) return null
    const seen = this.cameraController.view.scale * looking.unit
    const factor = clampScale(toScale(seen), this.portalZoomBounds(id)) / seen
    const unit = looking.unit * factor
    // `from`, in the board behind as the portal showed it: it is what ends
    // up under `to`.
    const behindX = looking.x + (from.x - node.x) / looking.unit
    const behindY = looking.y + (from.y - node.y) / looking.unit
    return {
      x: tidy(behindX - (to.x - node.x) / unit),
      y: tidy(behindY - (to.y - node.y) / unit),
      scale: tidy(looking.scale * factor),
    }
  }

  /** The history key a wheel gesture on a portal records under: one per run
   * of the same gesture on the same portal, a pause of
   * PORTAL_PAN_STEP_GAP_MS starting the next. */
  private portalStepKey(id: NodeId, kind: 'pan' | 'zoom'): string {
    const now = this.context.getWindow().performance.now()
    const last = this.portalStep
    if (
      last?.id !== id ||
      last.kind !== kind ||
      now - last.at > PORTAL_PAN_STEP_GAP_MS
    ) {
      this.portalStepSerial += 1
    }
    this.portalStep = { id, kind, at: now }
    return `portal-${kind}:${id}:${this.portalStepSerial}`
  }

  /** Points an open portal at `view`: what it shows moves, the cards
   * behind it in place (`takeComposedBoard`'s `onlyMoved`). */
  private lookThroughPortal(
    id: NodeId,
    view: PortalView,
    historyKey: string,
  ): void {
    this.applyBoardChange(updateNode(this.board, id, { view }), historyKey)
  }

  /**
   * How large a card is on screen: the camera's scale times the portals' it
   * is behind (`scaleOf`). The one answer to that question, for everything
   * that asks it about a card — how sharp its pages are drawn, whether the
   * cards around it are built or drawn (`portalTierOf`, by the same product
   * for what is behind a portal), how its group's label is held. Chrome
   * weighted for it follows domain/portals.ts's `portalWeight`.
   */
  private seenScaleOf(id: NodeId): number {
    return this.cameraController.view.scale * this.scaleOf(id)
  }

  /** What a card is drawn at: the scale of the portals it is behind, 1 for
   * the board's own (domain/portals.ts's `ComposedPortal`). */
  private scaleOf(id: NodeId): number {
    const portals = this.sources.composition.portals
    if (portals.size === 0) return 1
    return portalOf(id, portals)?.scale ?? 1
  }

  /** Where an open portal looks, at what scale, and what a unit behind it
   * measures here (core.ts's `portalViewOf`). */
  private portalViewOf(
    id: NodeId,
  ): Readonly<{ x: number; y: number; scale: number; unit: number }> | null {
    const portal = this.sources.composition.portals.get(id)
    const node = this.nodesById.get(id)
    if (!portal || !isPortal(node)) return null
    return {
      x: tidy((node.x - portal.dx) / portal.scale),
      y: tidy((node.y - portal.dy) / portal.scale),
      scale: portalScale(node),
      unit: portal.scale,
    }
  }

  /**
   * Whether a portal should show what is behind it: when it is on screen, or
   * near it, and large enough there to show anything. An open one stays open
   * a little farther and a little smaller than one opens, so a camera
   * resting on the line does not open and shut it on alternate passes.
   */
  private wantsPortalOpen(portal: FileNode, open: boolean): boolean {
    if (!this.cameraPlaced) return false
    const scale = this.cameraController.view.scale
    const width = Math.min(portal.w, portal.h) * scale
    if (width < (open ? PORTAL_OPEN_MIN_PX / 2 : PORTAL_OPEN_MIN_PX)) {
      return false
    }
    const { width: vw, height: vh } = this.getViewportSize()
    const margin = open ? Math.max(vw, vh) : VIEWPORT_BUFFER_PX
    const view = this.worldViewportRect(margin)
    return (
      portal.x < view.right &&
      portal.x + portal.w > view.left &&
      portal.y < view.bottom &&
      portal.y + portal.h > view.top
    )
  }

  /**
   * Moves the camera to where this board was last looked at on this device
   * (host/boardCameras.ts), over the file's own camera. Once what the device
   * keeps has been read: until then the board shows the file's, and moves
   * when it arrives only if nobody has moved it since.
   */
  private openWhereLastLooked(): void {
    this.stopWaitingForCamera()
    const path = this.sourcePathForBoard()
    if (path === '') return
    const opened = this.cameraController.view
    this.stopWaitingForCamera = this.boardCameras.whenLoaded(() => {
      this.stopWaitingForCamera = () => undefined
      const kept = this.boardCameras.get(path)
      if (!kept || this.cameraController.view !== opened) return
      this.cameraController.loadCamera(kept)
      this.recomputeVisibility()
    })
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
      const read = this.readingWindowOf(this.focusedNodeId)
      if (read !== null) {
        board = boardWithReadingWindow(
          board,
          this.focusedNodeId,
          read.line,
          read.offset,
        )
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
    // This file's part of it: what is behind a portal is another file's.
    const own = this.sources.ownFileBoard(board)
    if (!own) return this.lastRawData
    return serializeBoard({ ...own, camera: board.camera })
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

  /**
   * The view was made the one being worked in (opened, or its tab gone back
   * to): the viewport takes the focus, as a press on the board gives it, so
   * the board's keys and Mod+V's `paste` (./canvas/clipboardController.ts)
   * reach it straight away. Focus already inside the board is left where it
   * is.
   */
  focus(): void {
    const viewport = this.viewportEl as HTMLElement | undefined
    if (!viewport?.isConnected) return
    if (viewport.contains(viewport.ownerDocument.activeElement)) return
    viewport.focus({ preventScroll: true })
  }

  onResize(): void {
    this.viewportSize = null
    this.pdf.refitPanel()
    if (this.parseFailed) return
    // How far out the wheel may zoom is derived from the viewport's size.
    this.cameraController.invalidateScaleFloor()
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
    this.editing.forceCommitActiveEdit()
    this.sources.dispose()
    const win = this.context.getWindow()
    if (this.rafId !== null) {
      win.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.cameraController.dispose()
    this.interaction.destroy()
    this.clipboard.destroy()
    this.viewportEl?.removeEventListener('wheel', this.cameraController.onWheel)
    this.viewportEl?.removeEventListener('scroll', this.onCardScroll, true)
    this.context
      .getDocument()
      .removeEventListener('selectionchange', this.onSelectionChange)
    if (this.selectionFrame !== null) {
      win.cancelAnimationFrame(this.selectionFrame)
      this.selectionFrame = null
    }
    this.vaultSubscriptionDisposer?.()
    this.vaultSubscriptionDisposer = null
    this.keymap.destroy()
    this.pdf.destroy()

    this.editing.endRename(true)
    this.dropImport.destroy()
    this.canvasControls?.destroy()
    this.find?.destroy()
    this.find = null
    this.findMarks?.destroy()
    this.findMarks = null
    this.canvasControls = null
    this.minimap?.destroy()
    this.minimap = null
    this.unsubscribeMinimapPrefs()
    this.stopWaitingForCamera()
    this.toolbarController.destroy()
    this.overviewLayer?.destroy()
    this.overviewLayer = null
    this.unsubscribeRemoteImages?.()
    this.unsubscribeRemoteImages = null
    this.gpuBoard?.destroy()
    this.gpuBoard = null
    this.nearImages?.destroy()
    this.nearImages = null
    this.spreadFrame?.destroy()
    this.spreadFrame = null
    this.spreadHandoffPictures.clear()
    for (const id of [...this.foldCovers.keys()])
      this.releaseFoldedCard(id, true)
    this.passagePoints?.destroy()
    this.passagePoints = null
    this.passageHandles?.destroy()
    this.passageHandles = null
    this.pictures?.destroy()
    this.pictures = null
    this.pictureSlices?.destroy()
    this.pictureSlices = null
    this.typesetStyle?.destroy()
    this.typesetStyle = null
    this.typesetClient?.destroy()
    this.typesetClient = null
    this.pictureActivity?.destroy()
    this.pictureActivity = null
    this.pictureAnnotations?.destroy()
    this.pictureAnnotations = null
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
    this.edgeDefsEl = defs
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
    this.arrowMarkerEl = marker
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

    // The runs edges make on over a card to the passage they reach: over
    // the cards, where the curves are under them (styles/edges.css).
    const passageRunsSvg = doc.createElementNS(SVG_NS, 'svg')
    passageRunsSvg.setAttribute(
      'class',
      `${EDGES_SVG_CLASS} ${PASSAGE_RUNS_CLASS}`,
    )
    const passageRuns = doc.createElementNS(SVG_NS, 'g')
    passageRuns.setAttribute('class', EDGES_GROUP_CLASS)
    passageRunsSvg.appendChild(passageRuns)
    // The in-flight connection's runs, beside the group rather than in it,
    // like the curve's preview beside the edges group.
    const [previewStartRun, previewEndRun] = [0, 1].map(() => {
      const run = doc.createElementNS(SVG_NS, 'path')
      run.setAttribute('class', `${EDGE_PREVIEW_CLASS} ${EDGE_HIDDEN_CLASS}`)
      passageRunsSvg.appendChild(run)
      return run
    })
    world.appendChild(passageRunsSvg)

    const edgeLabels = doc.createElement('div')
    edgeLabels.className = EDGE_LABELS_CLASS
    world.appendChild(edgeLabels)

    // Mounted last so it sits above every card.
    const interactionLayer = buildInteractionLayer(doc)
    world.appendChild(interactionLayer)
    this.passageHandles?.destroy()
    const passageHandles = new PassageHandles(doc, world, {
      getSelectedEdge: () => {
        if (this.selectedEdgeIds.size !== 1) return null
        const [id] = this.selectedEdgeIds
        return this.boardEdgesById.get(id) ?? null
      },
      canEdit: () => this.canEdit,
      passageEnds: (id, anchor) => this.passageEnds(id, anchor),
      adjust: (id, anchor, moving, x, y) =>
        this.adjustPassage(id, anchor, moving, x, y),
      setAnchor: (edgeId, end, anchor, key) =>
        this.setEdgeAnchor(edgeId, end, anchor, key),
      worldPoint: (point) => this.worldPointFromEvent(point),
    })
    this.passageHandles = passageHandles
    this.passagePoints?.destroy()
    const passagePoints = new PassagePoints(doc, world, {
      getNodeRect: (id) => this.nodesById.get(id) ?? null,
      placePassage: (id, anchor) => this.placePassage(id, anchor),
    })
    this.passagePoints = passagePoints
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
    this.pictures?.destroy()
    this.pictureSlices?.destroy()
    const pictureWin = this.context.getWindow()
    /** Whether a picture may be made now: the board still — nothing moving
     * the camera, a spread's frame or a card — and shown, in a window that
     * is — a window in the background makes one many times slower. */
    const pictureReady = () =>
      !this.interacting &&
      !spreadFrame.dragging &&
      this.interaction.liveNodeRects === null &&
      doc.visibilityState === 'visible' &&
      this.getViewportSize().width > 0
    const pictureSlices = new IdleSlices(pictureWin, pictureReady)
    this.pictureSlices = pictureSlices
    this.typesetStyle?.destroy()
    const typesetStyle = new TypesetStyle({
      host: this.host,
      root,
      boardStyle: styleEl,
      slices: pictureSlices,
      sourcePath: () => this.sourcePathForBoard(),
      onChange: () => {
        // Every card picture's stamp names the look: what is wanted changed.
        this.pictures?.retain()
        this.pictures?.invalidate()
      },
      reportError: (stage, error) => this.reportError(stage, error),
    })
    this.typesetStyle = typesetStyle
    this.typesetClient?.destroy()
    const typesetClient = new TypesetClient({
      doc,
      start: () => this.host.workers.create(typesetWorkerSource()),
      reportError: (stage, error) => this.reportError(stage, error),
    })
    this.typesetClient = typesetClient
    this.pictureActivity?.destroy()
    const pictureActivity = new PictureActivity({
      win: pictureWin,
      background: this.host.background,
      board: () => {
        const file = this.context.getFile()
        return file ? { path: file.path, name: file.basename } : null
      },
      title: () => this.t('pictureCache.activity'),
      reportError: (stage, error) => this.reportError(stage, error),
    })
    this.pictureActivity = pictureActivity
    this.pictures = new Pictures({
      doc,
      sources: [
        new PdfPages({
          pdf: this.host.pdf,
          store: this.pictureStores.pdf,
          queue: this.pdfDraws,
          doc,
          mtime: (path) => this.fileMtime(path),
          onStale: (path) => this.pictures?.fileChanged(path),
        }),
        new ImageFiles({
          read: (path) => this.readImage(path),
          store: this.pictureStores.image,
          doc,
          slices: pictureSlices,
          mtime: (path) => this.imageVersion(path),
          ready: pictureReady,
        }),
        new TypesetCards({
          doc,
          typesetter: typesetClient,
          style: typesetStyle,
          // After the cards on screen: none is waiting to be mounted or
          // built.
          ready: () =>
            pictureReady() &&
            this.engine.pendingMountCount === 0 &&
            this.contentSyncQueue.size === 0,
          // As its file has it: a picture is of the card, kept for its own
          // board too, and made at its own size.
          getNode: (id) => {
            const node = this.nodesById.get(id)
            return node && fileNodeOf(node)
          },
          idOf: (want) => this.pictureNodeId(want.group, want.key),
          readNote: async (path) => {
            try {
              return await this.host.vault.readText(path)
            } catch {
              return null
            }
          },
          colorOf: nodeColorFrom(root),
          imagesOf: (markdown, widthPx) => this.cardImages(markdown, widthPx),
        }),
      ],
      wanted: () => this.wantedPictures(),
      resolution: () =>
        this.cameraController.view.scale *
        (this.context.getWindow().devicePixelRatio || 1),
      idle: () => !this.interacting && !spreadFrame.dragging,
      onChange: (source, group, key) =>
        this.onPictureChange(source, group, key),
      onBusy: (busy) => pictureActivity.setBusy(busy),
      reportError: (stage, error) => this.reportError(stage, error),
    })
    this.pictureAnnotations?.destroy()
    this.pictureAnnotations = new PictureAnnotations(
      this.annotationStores,
      () => this.overviewLayer?.markDirty(),
    )

    // The overview canvas goes in *before* the world layer, so everything the
    // world holds paints over it: the group frames and labels that stay in the
    // DOM at every tier, the resize handles, the snap guides, and an
    // in-flight connection's curve. See ./canvas/overviewLayer.ts.
    this.overviewLayer = new OverviewLayer(this.context, root, viewport, {
      getView: this.core.getView,
      getCardNodes: () => this.ownCardNodes,
      titleOf: (node) => this.titleOf(node),
      titleScale: (id) => this.titleScaleOf(id),
      titleMeasure: () => this.titleMeasure(),
      getGroupNodes: () => this.groupNodes,
      portalClipOf: (id) =>
        portalOf(id, this.sources.composition.portals)?.clip ?? null,
      litGroup: () => this.interaction.litGroup,
      getEdges: () => this.ownEdges,
      getPortalLayers: () => this.livePortalLayers(),
      getNode: this.core.getNode,
      isSelected: (id) => this.selectedIds.has(id),
      isEdgeSelected: (id) => this.selectedEdgeIds.has(id),
      getRenamingEdgeId: () => this.editing.renamingEdgeId,
      isMounted: (id) => this.shownByDom(id),
      getLiveRects: () => this.interaction.liveNodeRects,
      poseOf: (id) => this.motions.pose(id),
      departures: () => this.motions.departures(),
      folded: () => this.foldedNow(),
      pdfPageLabels: this.pdfPageLabels,
      picture: (node, dark, page) => this.pictureOf(node, dark, page),
      contentLayer: () => this.gpuBoard,
      pageAnnotations: (path, page) => this.pageAnnotationsOf(path, page),
    })
    this.gpuBoard?.destroy()
    this.nearImages?.destroy()
    const imageSizes = new ImageSizes({
      vault: this.host.vault,
      sourcePath: () => this.sourcePathForBoard(),
      remote: this.remoteImages,
    })
    this.imageSizes = imageSizes
    const nearImages = new NearImages({
      win: this.context.getWindow(),
      read: (path) => this.readImage(path),
      ownWidth: (path) => imageSizes.get(path)?.w ?? null,
      picture: (path) => this.pictures?.get(imageRef(path), false) ?? null,
      onDecoded: () => this.gpuBoard?.markDirty(),
    })
    this.nearImages = nearImages
    // Draws what it can typeset; where WebGL2 or its worker is not there,
    // nothing, and every card shows as it would without it.
    this.gpuBoard = new GpuBoard({
      parent: viewport,
      root,
      style: typesetStyle,
      view: this.core.getView,
      viewportSize: () => this.getViewportSize(),
      isMounted: (id) => this.shownByDom(id),
      isSelected: (id) => this.selectedIds.has(id),
      cache: {
        store: this.pictureStores.typeset,
        group: () => this.sourcePathForBoard(),
      },
      onTypeset: (ids) => {
        for (const id of ids) {
          this.edgeLayer.redrawPassageEdges(id)
          // Where a hit of the find is in it is known now.
          this.findMarks?.cardMoved(id)
        }
        // The images in them are wanted now.
        this.pictures?.invalidate()
      },
      redrawOverview: () => this.overviewLayer?.markDirty(),
      readNote: async (path) => {
        try {
          return await this.host.vault.readText(path)
        } catch {
          return null
        }
      },
      typesetter: typesetClient,
      imagePicture: (path, devicePx) => {
        const page = pageOfKey(path)
        return page
          ? this.scenePagePicture(page.file, page.page)
          : nearImages.get(path, devicePx)
      },
      pagePicture: (file, page) => {
        const palette = this.overviewLayer?.pagePalette()
        if (!palette) return null
        return this.pictures?.get(pdfPageRef(file, page), palette.dark) ?? null
      },
      images: imageSizes,
      layoutMath: (formulas) => this.host.math.layout(formulas),
      reportError: (stage, error) => this.reportError(stage, error),
      onScroll: (id) => {
        this.passagesMoved(id)
        this.findMarks?.cardMoved(id)
      },
    })
    this.gpuBoard?.setNodes(this.drawableNodes())
    this.unsubscribeRemoteImages?.()
    this.unsubscribeRemoteImages = this.remoteImages.subscribe((key) => {
      // Its cards are typeset again — drawn, or left to the DOM, by whether
      // its bytes are kept — and their pictures made again.
      this.gpuBoard?.imageLearned(key)
      this.nearImages?.fileChanged(key)
      this.pictures?.invalidate()
    })
    // The typesetter checked against the browser, from the console of a
    // development build (./gpu/typesetCheck.ts); a release has none of it.
    if (process.env.NODE_ENV === 'development') {
      const board = this.gpuBoard
      Object.assign(board.canvas, {
        gpuBoard: board,
        pictures: () => this.pictures,
        find: () => this.find,
      })
      const checkDeps = () => ({
        host: this.host,
        root,
        sourcePath: this.sourcePathForBoard(),
        nodes: this.ownCardNodes,
        drawnText: (id: string) => board.drawnText(id),
        drawable: (id: string) => board.drawable(id),
        typesetter: typesetClient,
        style: typesetStyle,
      })
      Object.assign(board.canvas, {
        checkTypeset: (ids?: readonly string[]) =>
          checkTypeset(checkDeps(), ids),
        showTypeset: (id: string | null, scale?: number) =>
          showTypeset(checkDeps(), id, scale),
      })
    }
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
      // Every world-layer overlay that is counter-scaled instead of drawn in
      // world units, and nothing else: the camera writes the counter-scale
      // variable on each of these rather than once on `world`, because a
      // custom property written on `world` restyles every card under it (see
      // CameraController's applyZoomScale).
      [
        interactionLayer,
        snapGuides.element,
        spreadFrame.element,
        passagePoints.element,
        passageHandles.element,
      ],
      // The ones the overview tier takes out of the document, which is why
      // they are handed over separately — see the same method.
      [edgesSvg, passageRunsSvg, edgeLabels],
      {
        isParseFailed: this.core.isParseFailed,
        isEditingWheelTarget: (target) =>
          this.editing.isEditing(nodeIdFromEventTarget(target)),
        scrollFocusedCardBy: (target, deltaX, deltaY, cursor) =>
          this.focusedNodeId !== null &&
          (this.panPortalBy(target, deltaX, deltaY) ||
            this.scrollReadCardBy(target, deltaY, cursor) ||
            (nodeIdFromEventTarget(target) === this.focusedNodeId &&
              this.cardRenderer.scrollCardContent(
                this.focusedNodeId,
                deltaX,
                deltaY,
              ))),
        zoomFocusedPortalBy: (deltaY, cursor) =>
          this.zoomPortalBy(deltaY, cursor),
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
          // Kept, not saved: where the board is looked at goes to the file
          // with the next save that something written asks for, and when the
          // board closes (`getViewData` reads the live camera either way).
          // Saving for it rewrote the whole file at the end of every pan — on
          // a board of thousands of cards, a megabyte and a vault-wide modify
          // event each time, for nothing anyone wrote.
          this.board = { ...this.board, camera }
          const path = this.sourcePathForBoard()
          if (path !== '') this.boardCameras.set(path, camera)
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
      passageRuns,
      edgeLabels,
      this.arrowMarkerId,
      {
        getNode: this.core.getNode,
        clipPathOf: (edge) => this.edgeClipPath(edge),
        portalWeightOf: (edge) => this.edgePortalWeight(edge),
        endClipOf: (edge, end) => {
          const portals = this.sources.composition.portals
          if (portals.size === 0) return null
          const id = end === 'from' ? edge.fromNode : edge.toNode
          const portal = portalOf(id, portals)
          if (!portal) return null
          const home = commonPortal(edge.fromNode, edge.toNode, portals)
          return portal === home ? null : this.portalClip(portal)
        },
        clipOf: (edge) => {
          const portals = this.sources.composition.portals
          if (portals.size === 0) return null
          const portal = commonPortal(edge.fromNode, edge.toNode, portals)
          return portal ? this.portalClip(portal) : null
        },
        cancelActiveEdgeRename: () => {
          if (this.editing.renamingEdgeId !== null) {
            this.editing.endRename(false)
          }
        },
        getRenamingEdgeId: () => this.editing.renamingEdgeId,
        onLabelKeyDown: (id, event) =>
          this.editing.handleLabelKeyDown({ kind: 'edge', id }, event),
        onLabelBlur: (id) => this.editing.endRename(true, { kind: 'edge', id }),
        placePassage: (id, anchor) => this.placePassage(id, anchor),
        placePage: (id, page) => this.placePage(id, page),
        onEdgeHover: (id) => {
          if (id === this.hoveredEdgeId) return
          // Only an edge reaching a passage has marks to strengthen.
          const marked =
            this.reachesPassage(this.hoveredEdgeId) || this.reachesPassage(id)
          this.hoveredEdgeId = id
          if (marked) this.refreshPassageMarks()
        },
        t: this.core.t,
      },
    )
    this.cardGeneration = new CardGeneration(this.host, {
      getBoard: this.core.getBoard,
      getNode: this.core.getNode,
      getSourcePath: this.core.getSourcePath,
      getBody: (id) => this.cardRenderer.getRuntime(id)?.bodyEl ?? null,
      isAvailable: () => this.canEdit && !this.overview,
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
      portalNotice: (id) => this.portalNotice(id),
      getLiveRects: () => this.interaction.liveNodeRects,
      clipOf: (id) => this.clipOf(id),
      sourcePathOf: (id) => this.sourcePathOf(id),
      scaleOf: (id) => this.scaleOf(id),
      titleOf: (node) => this.titleOf(node),
      titleScale: (id) => this.titleScaleOf(id),
      groupMemberCount: (id) => this.memberCountOf(id),
      expandGroup: (id) => this.runGroupAction(id, 'expand'),
      passageMarks: (id) => this.passageMarks(id),
      onPassagesMove: (id) => {
        this.edgeLayer.redrawPassageEdges(id)
        if (this.passagePoints?.isOn(id)) this.passagePoints.sync()
      },
      isSelected: (id) => this.selectedIds.has(id),
      isFocused: (id) => this.focusedNodeId === id,
      isEditing: (id) => this.editing.isEditing(id),
      isGenerating: (id) => this.cardGeneration.isGenerating(id),
      isRenamingGroup: (id) => this.editing.isRenaming({ kind: 'group', id }),
      onGroupLabelKeyDown: (id, event) =>
        this.editing.handleLabelKeyDown({ kind: 'group', id }, event),
      onGroupLabelBlur: (id) =>
        this.editing.endRename(true, { kind: 'group', id }),
      onTextCardRendered: (id) => {
        this.cardGeneration.syncChips(id)
        this.passagesRedrawn(id)
      },
      onTextMeasured: (id, size) => this.commitTextSize(id, size),
      onNoteCardRendered: (id) => {
        this.dropImport.onNoteCardRendered(id)
        this.passagesRedrawn(id)
      },
      // A card showing its content is one a picture can be taken of.
      onContentRendered: () => this.pictures?.invalidate(),
      // The GPU scene goes on drawing a card it draws until its DOM shows
      // it, so that one built to be edited never shows its body empty.
      drawnUnder: (id) => this.gpuBoard?.drawable(id) ?? false,
      onShown: () => this.overviewLayer?.markDirty(),
      // An image on the web a card shows: remembered once the browser has
      // shown it, and its bytes fetched (../host/remoteImages.ts).
      onImageLoaded: (img) => {
        const src = img.currentSrc || img.src
        if (!isRemoteImage(src)) return
        this.remoteImages.shown(src, {
          w: img.naturalWidth,
          h: img.naturalHeight,
        })
      },
      canBuildContent: () => this.contentBuildsLeft > 0,
      takeContentBuild: () => this.takeContentBuild(),
      pdfDraws: this.pdfDraws,
      drawPriority: (id) => this.distanceFromViewCenter(id),
      picture: (id, page) => {
        const handed = this.spreadHandoffPictures.get(id)
        if (handed) return handed
        const node = this.nodesById.get(id)
        return node ? this.pictureOf(node, false, page) : null
      },
      onPdfDrawn: (id) => {
        // Shown in its own picture now: what was held for it can go.
        this.spreadHandoffPictures.delete(id)
        this.releaseFoldedCard(id)
      },
      queueContentSync: (id) => {
        this.contentSyncQueue.add(id)
      },
      dequeueContentSync: (id) => {
        this.contentSyncQueue.delete(id)
      },
      getMountedCount: () => this.engine.mounted.size,
      purgeNode: (id) => this.purgeNodeRuntime(id),
      seenScaleOf: (id) => this.seenScaleOf(id),
      getPdfStartPosition: (id) => {
        const node = this.core.getNode(id)
        return node?.type === 'file' ? node.startPage : undefined
      },
      openAnnotations: (path) => this.annotationStores.acquire(path),
      getAnnotationEvents: () => this.pdf.annotationEvents,
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
      openFind: () => this.pdf.openReaderSearch() || this.openFind(),
    })
    this.registerBoardKeyLayers()
    this.editing = new EditingController({
      core: this.core,
      zoomInToEdit: (id) => this.zoomInToEdit(id),
      editWhenBuilt: (id) => this.editWhenBuilt(id),
      readByGpu: (id) => this.gpuBoard?.drawable(id) ?? false,
      onEditingChange: () => {
        this.toolbarController.refreshToolbar()
        // A card opened for typing, or closed: its text is drawn by an editor
        // now, or by its rendering again, and the passages in it with it —
        // a frame later, once the new one is in.
        const ids = [this.lastEditingId, this.editing.editingNodeId()]
        this.lastEditingId = ids[1]
        this.context.getWindow().requestAnimationFrame(() => {
          for (const id of ids) if (id !== null) this.passagesMoved(id)
          this.refreshPassageMarks()
        })
        this.revalidatePassagePoints()
      },
      cards: this.cardRenderer,
      edges: this.edgeLayer,
      worldEl: world,
      pin: (id) => {
        this.pinnedIds.add(id)
        this.pinsRevision += 1
      },
      unpin: (id) => {
        this.pinnedIds.delete(id)
        this.pinsRevision += 1
      },
      syncChips: (id) => this.cardGeneration.syncChips(id),
      writeReadingWindow: (id, line, offset) => {
        // Bare text shows all of itself; it has no window to remember.
        if (isPlainText(this.nodesById.get(id))) return
        const board = boardWithReadingWindow(this.board, id, line, offset)
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
      this.cardRenderer.syncPdfViewScales()
      this.canvasControls?.refreshReadouts()
      // Which pictures are nearest moved with it — the ones held past the
      // budget are the nearest ones.
      this.pictures?.invalidate()
      // A title stops shrinking at a size on screen, and comes to it on the
      // frame the zoom does, not the next visibility pass.
      const { scale } = this.cameraController.view
      if (scale !== this.titlesScaledAt) {
        this.titlesScaledAt = scale
        this.cardRenderer.syncTitleScales()
      }
    })
    // Inside the viewport rather than the world: the toolbar is chrome, and
    // chrome does not zoom. Built last so it paints over the cards.
    this.toolbarController = new ToolbarController(this.context, viewport, {
      isParseFailed: this.core.isParseFailed,
      canEdit: this.core.canEdit,
      getBoard: this.core.getBoard,
      getNode: this.core.getNode,
      getLiveRects: () => this.interaction.liveNodeRects,
      titleRectOf: (id, rect) => this.titleRectOf(id, rect),
      groupAction: (id, action) => this.runGroupAction(id, action),
      getSelectedIds: this.core.getSelectedIds,
      getSelectedEdgeIds: this.core.getSelectedEdgeIds,
      getEdge: this.core.getEdge,
      isPdfNode: (node) => isPdfNode(node),
      openReader: (id) => this.pdf.openReaderPanel(id),
      openPortal: (id) => this.openPortal(id),
      fitPortal: (id) => this.fitPortal(id),
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
      releaseEdgePassages: (edgeId, ends) =>
        this.releaseEdgePassages(edgeId, ends),
      jumpToEdgeEnd: (edgeId) => this.jumpToEdgeEnd(edgeId),
      alignSelection: (edge) => this.alignSelection(edge),
      distributeSelection: (axis) => this.distributeSelection(axis),
      tidySelection: () => this.tidySelection(),
    })
    // Screen-space chrome in the toolbar's overlay, like the creation bar:
    // a press on it is chrome, never the board. See ./canvas/minimap.ts.
    this.minimap?.destroy()
    this.minimap = new Minimap(doc, this.toolbarController.overlay, {
      isEnabled: () => this.minimapPrefs.isVisible(),
      getView: () => this.cameraController.view,
      getViewportSize: () => this.getViewportSize(),
      getNodes: () => this.board.nodes,
      isOverview: () => this.overview,
      getRevision: () => this.overviewLayer?.revision ?? 0,
      paintBoard: (ctx, view, size) =>
        this.overviewLayer?.paintBoard(ctx, view, size),
      centerOn: (world, options) =>
        this.cameraController.centerOn(world, this.getViewportSize(), options),
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
      onPassageSelection: (id, reader, selection) =>
        this.selectPassage(id, reader, selection),
      onPassageHighlight: (id, anchor) => this.selectHighlight(id, anchor),
      isPassagePoint: (target) => this.passagePoints?.contains(target) ?? false,
      passagePointsRect: () => this.passagePoints?.clientRect() ?? null,
      onAnnotationToolbar: (shown) =>
        this.toolbarController.setContentToolbarShown(shown),
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
      exportItem: (scope) => this.exporter?.menuItem(scope) ?? null,
      createGroupFromSelection: () => this.createGroupFromSelection(),
      moveSelectionToNewBoard: () => void this.moveSelectionToNewBoard(),
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
      syncEdgesSvg: () => this.syncEdgesSvg(),
    })
    this.interaction = new InteractionController({
      core: this.core,
      viewportEl: viewport,
      worldEl: world,
      panCaptureEl: panCapture,
      interactionLayerEl: interactionLayer,
      shownByElement: (id) => this.shownByElement(id),
      previewPathEl: preview,
      previewRunEls: { start: previewStartRun, end: previewEndRun },
      getNodesById: () => this.nodesById,
      camera: this.cameraController,
      edges: this.edgeLayer,
      passagePoints: {
        sourceAt: (target) => this.passagePoints?.sourceAt(target) ?? null,
      },
      passageTargets: {
        passageAt: (id, x, y) => this.passageAt(id, x, y),
        showPassageHint: (id, anchor) => this.showPassageHint(id, anchor),
        nudgeCard: (id, deltaY) =>
          this.cardRenderer.getRuntime(id)?.pdfReader?.nudge(deltaY) ?? false,
        cardClientRect: (id) =>
          this.cardRenderer.getRuntime(id)?.el?.getBoundingClientRect() ?? null,
        passagesConnected: (anchors) => this.passagesConnected(anchors),
      },
      snapGuides,
      toolbar: this.toolbarController,
      editing: this.editing,
      generation: this.cardGeneration,
      menus: this.dropImport,
      pdf: this.pdf,
      pin: (id) => {
        this.pinnedIds.add(id)
        this.pinsRevision += 1
      },
      unpin: (id) => {
        this.pinnedIds.delete(id)
        this.pinsRevision += 1
      },
      queueContentSync: (id) => {
        this.contentSyncQueue.add(id)
      },
      onLiveRectsChange: () => {
        this.overviewLayer?.markDirty()
        this.spreadFrame?.sync()
        // What shows through a portal follows its frame, and a card behind
        // one, as they are dragged.
        const portals = this.sources.composition.portals
        if (portals.size > 0) {
          this.cardRenderer.syncClips()
          this.syncPortalClipPaths(portals)
        }
      },
      onHoverChange: (id) => this.syncSpreadHover(id),
      overviewTitleLineAt: (point) =>
        this.overviewLayer?.titleLineAt(point) ?? null,
      syncEdgesSvg: () => this.syncEdgesSvg(),
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
          {
            label: `${this.t('find.open')}\n(${mod} F)`,
            icon: 'search',
            onSelect: () => this.openFind(),
          },
          {
            // The other way to see where you are; its switch sits with it.
            // The icon says which way it is set, struck through when off;
            // the tooltip says what a click will do.
            label: () =>
              this.t(
                this.minimapPrefs.isVisible()
                  ? 'controls.hideMinimap'
                  : 'controls.showMinimap',
              ),
            icon: () => (this.minimapPrefs.isVisible() ? 'map' : 'map-off'),
            onSelect: () =>
              this.minimapPrefs.setVisible(!this.minimapPrefs.isVisible()),
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
    this.find = new FindController({
      overlay: this.toolbarController.overlay,
      t: (key) => this.t(key),
      nodes: () => this.board.nodes,
      readNote: async (path) => {
        try {
          return await this.host.vault.readText(path)
        } catch {
          return null
        }
      },
      viewCenter: () => {
        const view = this.worldViewportRect(0)
        return {
          x: (view.left + view.right) / 2,
          y: (view.top + view.bottom) / 2,
        }
      },
      reveal: (hit, source) => this.revealFindHit(hit, source),
      showHits: (hits, current) => this.findMarks?.show(hits, current),
    })
    this.findMarks = new FindMarks(world, {
      place: (hit, source) => {
        const node = this.nodesById.get(hit.id)
        const placed = node ? this.placeFindHit(hit, source) : null
        if (!node || placed?.state !== 'visible') return null
        return placed.lines.map((line) => ({
          x: node.x + line.left,
          y: node.y + line.top,
          w: line.right - line.left,
          h: line.bottom - line.top,
        }))
      },
      requestFrame: (callback) =>
        this.context.getWindow().requestAnimationFrame(callback),
    })
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

    this.exporter = new ExportController({
      core: this.core,
      rootEl: root,
      viewportEl: viewport,
      worldEl: world,
      camera: this.cameraController,
      edges: this.edgeLayer,
      isSettled: () =>
        !this.overview &&
        this.lastRecomputeTime >= this.exportCameraMovedAt &&
        this.engine.pendingMountCount === 0 &&
        this.contentSyncQueue.size === 0 &&
        // A portal still reading its board has nothing to show yet.
        !this.sources.loading &&
        !this.sourceRefreshPending,
      cameraMoved: () => {
        this.exportCameraMovedAt = this.context.getWindow().performance.now()
      },
      commitEdit: () => this.editing.forceCommitActiveEdit(),
    })

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
    this.context
      .getDocument()
      .addEventListener('selectionchange', this.onSelectionChange)
    // A card's own scroll does not bubble; caught on the way down instead.
    this.viewportEl.addEventListener('scroll', this.onCardScroll, true)
  }

  private readonly onCardScroll = (event: Event): void => {
    const target = event.target as Element | null
    const id = (target?.closest?.('[data-node-id]') as HTMLElement | null)
      ?.dataset.nodeId
    if (id === undefined) return
    this.passagesMoved(id)
    this.findMarks?.cardMoved(id)
  }

  /** Content-freshness: scoped to the whole vault ('' —
   * see moduleVault.ts's `doesPathAffectScope`) because a note card's
   * backing file can live anywhere; `handleBackingFileModified` does the
   * actual per-card filtering. Set up once per leaf lifetime alongside the
   * pointer listeners; released in `dispose()`. */
  private setupVaultSubscription(): void {
    this.vaultSubscriptionDisposer = this.host.vault.subscribe('', (event) => {
      if (event.type !== 'create') {
        const path = event.type === 'rename' ? event.oldPath : event.entry.path
        this.pictures?.fileChanged(path)
        this.gpuBoard?.fileChanged(path)
        this.find?.fileChanged(path)
        this.nearImages?.fileChanged(path)
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
   * Records where a card is being read on the node itself: the block its top
   * edge is in and how far down it, as the one surface reading it has it
   * (`readingWindowOf`) — what the card is drawn from when it is not
   * focused, so it shows the same.
   *
   * Written straight to `this.board` rather than through `applyBoardChange`,
   * the way the camera is: moving a window is not a step anyone wants to undo
   * one notch at a time. An undo still carries whatever window its snapshot
   * holds, which is the board as it was — the same deal the camera has.
   */
  private commitReadingWindow(id: NodeId): void {
    const read = this.readingWindowOf(id)
    const page = this.cardRenderer.getPdfPosition(id)
    // A PDF card's window is a page rather than a line — the same field
    // idea (fileFormat.ts's `startPage`), in the unit the document speaks.
    const next =
      read !== null
        ? boardWithReadingWindow(this.board, id, read.line, read.offset)
        : page !== null
          ? boardWithPageWindow(this.board, id, page)
          : this.board
    this.commitWithoutHistory(next)
  }

  /** Where a card is being read: as the GPU scene has it for one it draws,
   * as its preview has it for one built. */
  private readingWindowOf(
    id: NodeId,
  ): Readonly<{ line: number; offset: number }> | null {
    if (this.gpuDraws(id)) return this.gpuBoard?.readingPosition(id) ?? null
    return this.cardRenderer.getContentReadingPosition(id)
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
    const recorded = !this.unrecordedCreations.has(id)
    if (recorded) this.applyBoardChange(next, historyKey)
    else this.commitWithoutHistory(next)
    this.purgeNodeRuntime(id)
    this.interaction.refreshInteractionLayer()
    this.syncEdgesSvg()
  }

  /** The write path for board state that is not a step anyone would undo
   * (where a card is being read): written and saved, never recorded — the
   * same deal the camera has. */
  private commitWithoutHistory(proposed: Board): void {
    const next = this.fitFrames(proposed)
    if (next === this.board) return
    const before = this.nodesById
    const changes = this.sources.commit(next)
    this.unrecorded = this.unrecorded
      ? mergeChanges(this.unrecorded, changes)
      : changes
    for (const node of next.nodes) {
      if (!before.has(node.id)) this.unrecordedCreations.add(node.id)
    }
    this.takeComposedBoard(next)
    this.refreshChangedGroups(before)
  }

  /** Puts every mounted group that changed since `previous` in step with its
   * node: a frame follows what it holds, so an edit to one card can change
   * it (./canvas/cardRenderer.ts's `refreshGroup`). */
  private refreshChangedGroups(previous: ReadonlyMap<NodeId, BoardNode>): void {
    for (const node of this.groupNodes) {
      const was = previous.get(node.id)
      if (was && was !== node) this.cardRenderer.refreshGroup(node.id)
    }
  }

  /**
   * The board made again from its files, after `next` was sent to them —
   * which, for every node `next` has, is the very object `next` has
   * (domain/portals.ts). What it does not have is what is behind a portal
   * that was just removed or shut, or a card that has gone to another file:
   * that leaves the screen here, since the edit that caused it did not
   * know.
   */
  private takeComposedBoard(next: Board): void {
    const composed = this.sources.compose()
    this.board = { ...composed, camera: this.board.camera }
    this.syncBoardIndex()
    this.cardRenderer.syncPortals()
    const nextById = new Map(next.nodes.map((node) => [node.id, node]))
    // Cards behind a portal that was moved through (its `view` changed) are
    // the same cards somewhere else: moved, not rebuilt.
    let moved = false
    for (const [id, node] of nextById) {
      const now = this.nodesById.get(id)
      if (now === node) continue
      if (now && onlyMoved(node, now)) {
        this.cardRenderer.moveNode(id)
        moved = true
        continue
      }
      this.purgeNodeRuntime(id, { exit: !now })
    }
    if (
      moved ||
      composed.edges.length !== next.edges.length ||
      composed.edges.some((edge, index) => edge !== next.edges[index])
    ) {
      this.syncEdgesSvg()
    }
  }

  /**
   * Puts a reading window on a card at the block `line` is in, from the text
   * alone (../lod.ts's `blockStartLine`): for a window moved where no surface
   * reading the card can say where its blocks start. A card is drawn from
   * where a block starts, so a window begins at one.
   */
  private boardWithSnappedWindow(
    board: Board,
    id: NodeId,
    line: number,
    markdown = this.cardMarkdown(id),
  ): Board {
    if (!Number.isFinite(line)) return board
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

  /** `board` with every group's frame on what it holds now (domain/
   * groups.ts's `fitGroups`), and every group just collapsed folded
   * (domain/groupFold.ts): what every write of the board goes through, so
   * no caller has to remember that moving a card can move a frame. */
  private fitFrames(board: Board): Board {
    return settleGroups(board, (id) => this.scaleOf(id))
  }

  private applyBoardChange(proposed: Board, historyKey?: string): void {
    const next = this.fitFrames(proposed)
    if (next === this.board) return
    const previous = this.nodesById
    const changes = this.sources.commit(next)
    const step = this.unrecorded
      ? mergeChanges(this.unrecorded, changes)
      : changes
    this.unrecorded = null
    this.unrecordedCreations.clear()
    this.history.push(step, historyKey)
    this.takeComposedBoard(next)
    this.refreshChangedGroups(previous)
    // A group folded on the way in drew the edges to what it put away to
    // its box instead: an edit that did not know it changed them.
    if (next.edges !== proposed.edges) this.syncEdgesSvg()
    this.markEntering(previous)
  }

  /** The nodes `nodesById` has and `previous` did not, shown arriving: each
   * grows into its place out of a slightly smaller, transparent version of
   * itself (NODE_ENTER_FROM_SCALE) — whatever draws it, and when its element
   * mounts later, from where the arrival has got to. The scale is small on
   * purpose: the motion only has to say "this is new", not travel. */
  private markEntering(previous: ReadonlyMap<NodeId, BoardNode>): void {
    for (const [id, node] of this.nodesById) {
      if (previous.has(id) || node.type === 'group') continue
      this.motions.settle(id, {
        from: scaledAboutCentre(node, NODE_ENTER_FROM_SCALE, 0),
      })
    }
  }

  private undo(): void {
    this.applyHistoryChanges(this.history.undo())
  }

  private redo(): void {
    this.applyHistoryChanges(this.history.redo())
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
  private applyHistoryChanges(changes: BoardChanges | null): void {
    if (!changes || this.parseFailed) return
    // What was written since the last step goes back first: an undo starts
    // from the board as that step left it.
    const all = this.unrecorded
      ? mergeChanges(invertChanges(this.unrecorded), changes)
      : changes
    this.unrecorded = null
    this.unrecordedCreations.clear()
    this.sources.apply(all)
    this.refreshFromSources({ clearSelection: true })
  }

  /** A change to a file this board is made from, made somewhere else — or
   * a portal's board, read. Once per task, however many arrive. */
  private scheduleSourceRefresh(): void {
    if (this.sourceRefreshPending) return
    this.sourceRefreshPending = true
    queueMicrotask(() => {
      this.sourceRefreshPending = false
      if (!this.domReady || this.parseFailed) return
      this.refreshFromSources({ clearSelection: false })
    })
  }

  /**
   * Makes the board again from its files and puts it on screen.
   *
   * Structural sharing does the diffing for us: a card the change never
   * touched is the very same object, so it keeps the DOM and the rendered
   * Markdown it already has, and only what actually differs is dropped and
   * re-mounted by the normal virtualization path. Undoing one card's move on
   * a 300-card board therefore re-renders one card.
   */
  private refreshFromSources(
    options: Readonly<{ clearSelection: boolean }>,
  ): void {
    const previous = this.nodesById
    // The camera is the live one: a viewport that jumps away is the least
    // welcome thing an undo can do.
    this.board = {
      ...this.sources.compose(),
      camera: cameraFromView(this.cameraController.view),
    }
    this.syncBoardIndex()
    this.cardRenderer.syncPortals()
    this.markEntering(previous)
    for (const [id, card] of previous) {
      const now = this.nodesById.get(id)
      if (now === card) continue
      if (now && onlyMoved(card, now)) {
        this.cardRenderer.moveNode(id)
        continue
      }
      // A node the board no longer has at all leaves the way a deleted one
      // does; one that merely changed is rebuilt in place, which is not a
      // departure.
      this.purgeNodeRuntime(id, { exit: !now })
    }
    if (options.clearSelection) {
      this.clearSelection()
    } else {
      const kept = [...this.selectedIds].filter((id) => this.nodesById.has(id))
      if (kept.length !== this.selectedIds.size) this.setSelection(kept)
    }
    this.syncEdgesSvg()
    this.interaction.refreshInteractionLayer()
    this.recomputeVisibility()
    this.drainQueues()
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

  /** Opens the export menu under the board's top-right corner — asked from
   * outside the board, by a command or the tab's own menu. Exports the
   * selection when there is one, as the board's own menus do. */
  showExportMenu(): void {
    this.exporter?.showMenu('selection', 'corner')
  }

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
    const own = this.sources.ownBoard
    if (!own) return edit(fileShape(this.board))[1]
    const current = fileShape(own)
    const [edited, value] = edit(current)
    if (edited && edited !== current) {
      const path = this.sourcePathForBoard()
      const changes = changesBetween(
        composeBoard(own, path, () => null),
        boardShape(edited),
        path,
      )
      this.sources.apply(changes)
      this.history.push(changes)
      this.refreshFromSources({ clearSelection: true })
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
    // A card let go may have taken its selected text down with its editor or
    // its reader's text layer.
    this.revalidatePassagePoints()
  }

  /** Keeps `focusedNodeId` and its class in step with the selection — see the
   * field's doc comment for what the state means. */
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
    // The card selected is read where the GPU scene draws it: scrolled
    // there, its whole note typeset.
    this.gpuBoard?.setReading(
      next !== null && this.gpuDraws(next) ? next : null,
    )
    if (next !== null) {
      this.cardRenderer.getRuntime(next)?.el?.classList.add(CARD_FOCUSED_CLASS)
      // A preview kept from an earlier reading is still where it was left;
      // the card has been drawn from its window since. Back to that, before
      // it is seen.
      const node = this.nodesById.get(next)
      if (node?.type === 'text' || node?.type === 'file') {
        this.cardRenderer.alignContent(
          next,
          node.startLine ?? 0,
          node.startOffset ?? 0,
        )
      }
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
    this.refreshPassageMarks()
    this.passageHandles?.sync()
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

  /** The given ends of an edge reach their whole cards again, the page a
   * PDF end was on kept (domain/edges.ts's `anchorEdgeEnd`). */
  private releaseEdgePassages(
    edgeId: EdgeId,
    ends: readonly ('from' | 'to')[],
  ): void {
    if (!this.canEdit) return
    const patch = Object.fromEntries(
      ends.map((end) => [`${end}Anchor`, undefined]),
    )
    const board = updateEdge(this.board, edgeId, patch)
    if (board === this.board) return
    this.applyBoardChange(board)
    this.syncEdgesSvg()
  }

  /**
   * The edge toolbar's "go to other end": the camera glides to whichever end
   * of the edge is farther from the middle of the view — the one not being
   * looked at — and that end's card is turned to the passage or page it
   * reaches (`turnToEnd`). The edge stays selected, so the same button
   * brings the camera back: one button for both ways, rather than a "start"
   * and an "end" the user would have to tell apart.
   *
   * The zoom is kept, so the jump reads as a move along the board; only from
   * the overview tier, where no card shows its text, does it close in as far
   * as `zoomInToEdit` does.
   */
  private jumpToEdgeEnd(edgeId: EdgeId): void {
    const edge = this.core.getEdge(edgeId)
    const fromNode = edge && this.nodesById.get(edge.fromNode)
    const toNode = edge && this.nodesById.get(edge.toNode)
    if (!edge || !fromNode || !toNode) return
    const size = this.getViewportSize()
    const view = this.cameraController.view
    const middle = screenToWorld(view, {
      x: size.width / 2,
      y: size.height / 2,
    })
    const geometry = this.edgeLayer.edgeGeometry(edgeId)
    const centerOf = (node: BoardNode): ScreenPoint => ({
      x: node.x + node.w / 2,
      y: node.y + node.h / 2,
    })
    const from = geometry?.start ?? centerOf(fromNode)
    const to = geometry?.end ?? centerOf(toNode)
    const toFrom =
      Math.hypot(from.x - middle.x, from.y - middle.y) >=
      Math.hypot(to.x - middle.x, to.y - middle.y)
    const node = toFrom ? fromNode : toNode
    this.turnToEnd(
      node,
      toFrom ? edge.fromAnchor : edge.toAnchor,
      toFrom ? edge.fromPage : edge.toPage,
    )
    if (this.overview) {
      this.cameraController.focusNode(node, OVERVIEW_RESTORE_SCALE * 1.25)
      return
    }
    // A card taller than the view is met at its top, where `turnToEnd` has
    // just put the passage, rather than at a middle that may be past it.
    const half = size.height / 2 / view.scale
    this.cameraController.centerOn(
      {
        x: node.x + node.w / 2,
        y: node.y + Math.min(node.h / 2, half),
      },
      size,
      { glide: true },
    )
  }

  /**
   * Brings what an edge end reaches into its card's view, when it is not in
   * it already. A text passage is turned to (`turnTextTo`); a PDF passage or page is gone to by the card's reader, or —
   * with no reader drawn yet — becomes the page the reader will open at.
   * Moving a window is reading, not editing: no history step, as scrolling
   * a card is none (`commitReadingWindow`).
   */
  private turnToEnd(
    node: BoardNode,
    anchor: EdgeAnchor | undefined,
    page: number | undefined,
  ): void {
    if (anchor?.kind === 'text') {
      if (this.placePassage(node.id, anchor)?.state === 'visible') return
      const source = this.passageSource(node.id)
      const span = source === null ? null : resolveTextAnchor(source, anchor)
      if (source !== null && span) this.turnTextTo(node.id, source, span)
      return
    }
    const target = anchor?.kind === 'pdf' ? anchor.page : page
    if (target === undefined) return
    const placement =
      anchor?.kind === 'pdf'
        ? this.placePassage(node.id, anchor)
        : this.placePage(node.id, target)
    if (placement?.state === 'visible') return
    const reader = this.cardRenderer.getRuntime(node.id)?.pdfReader
    if (reader) {
      if (anchor?.kind === 'pdf') {
        reader.revealPassage(anchor.page, anchor.quadPoints)
      } else {
        reader.revealLocation(target, null)
      }
      return
    }
    this.commitWithoutHistory(boardWithPageWindow(this.board, node.id, target))
  }

  /**
   * Turns a card to `span` of its `source`. One the GPU scene draws is
   * opened to read (selected) and scrolled there: its whole note shows where
   * the span is, to the line. Any other has its reading window moved to the
   * block the span starts in, and a preview it has already follows.
   */
  private turnTextTo(
    id: NodeId,
    source: string,
    span: readonly [number, number],
  ): void {
    if (this.gpuBoard?.drawable(id)) {
      if (this.focusedNodeId !== id) this.setSelection([id])
      const anchor = textAnchorAt(source, span)
      const located = this.gpuBoard.readAt(id, (drawn) => {
        const placed = placeDrawnLines(drawn, source, anchor, this.glyphAdvance)
        return placed?.state === 'visible'
          ? Math.min(...placed.lines.map((line) => line.top))
          : null
      })
      if (located) return
    }
    const line = source.slice(0, span[0]).split('\n').length - 1
    this.commitWithoutHistory(
      this.boardWithSnappedWindow(this.board, id, line, source),
    )
    // A preview it already has stays where it was otherwise: its text is
    // the same, so the window moving builds nothing anew.
    this.cardRenderer.alignContent(id, line, 0)
    this.contentSyncQueue.add(id)
  }

  /** World point an edge's chrome hangs from: the midpoint of its curve, the
   * same anchor its label already uses (domain/edges.ts's `EdgeGeometry`). */
  private edgeAnchorPoint(edgeId: EdgeId | undefined): ScreenPoint | null {
    if (edgeId === undefined) return null
    return this.edgeLayer.edgeGeometry(edgeId)?.label ?? null
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
    this.syncEdgesSvg()
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
    // A collapsed group deleted is its frame gone, as an open one's is: what
    // it put away comes back out first, and stays.
    for (const id of ids) {
      if (isFolded(board.nodes.find((node) => node.id === id))) {
        board = unfoldGroup(board, id)
      }
    }
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
    // the edge *set* changed, not just endpoint positions, so a sync
    // (rather than redrawEdgesForNodes) is the correct response.
    this.syncEdgesSvg()
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
    const id = this.nextNodeId()
    const next = createGroup(
      this.board,
      { id, type: 'group', extra: {} },
      this.selectedIds,
      (node) => this.scaleOf(node),
    )
    if (!next) return
    this.applyBoardChange(next)
    this.recomputeVisibility()
    this.drainQueues()
    this.setSelection([id])
  }

  /**
   * How much `id`'s title is scaled up to be read on screen
   * (./canvas/nodeTitle.ts's `titleScale`), at its level: how many groups it
   * is in, a size down for each (constants.ts's TITLE_MIN_SCREEN_PX).
   */
  private titleScaleOf(id: NodeId): number {
    let depth = 0
    for (
      let at = this.parentGroups.get(id);
      at;
      at = this.parentGroups.get(at)
    ) {
      depth += 1
    }
    return titleScale(this.seenScaleOf(id), depth)
  }

  /** The title `node` wears, as everything that draws or places one is
   * told (./canvas/nodeTitle.ts). */
  private titleOf(node: BoardNode): Title | null {
    return titleOf(node, {
      t: this.core.t,
      memberCount: (id) => this.memberCountOf(id),
    })
  }

  private memberCountOf(id: NodeId): number {
    const group = this.nodesById.get(id)
    return group?.type === 'group'
      ? groupMemberCount(group, this.board.nodes)
      : 0
  }

  /** How wide titles lay out, in the font the DOM sets them in — read once,
   * as the first is asked about. */
  private titleMeasure(): TitleMeasure {
    if (!this.titleMeasureOf) {
      const style = this.context
        .getWindow()
        .getComputedStyle(this.context.contentEl)
      const family =
        style.getPropertyValue('--font-interface').trim() ||
        style.fontFamily ||
        'sans-serif'
      this.titleMeasureOf = createTitleMeasure(family)
    }
    return this.titleMeasureOf
  }

  /**
   * Where the toolbar stands over `id`'s title, world units, its node shown
   * at `rect`: the title as it is with its node folded (./canvas/nodeTitle.ts's
   * `titleBox`) — a group's over its box, a PDF's over its card — so the
   * toolbar is in the same place folded or open. A title that fits its node
   * folded is the same title open, and is stood over exactly; a longer one,
   * cut short folded and whole open, is stood over its start. Null for a node
   * that wears none.
   */
  private titleRectOf(id: NodeId, rect: CardRect): CardRect | null {
    const node = this.nodesById.get(id)
    const title = node ? this.titleOf(node) : null
    if (!node || !title) return null
    const unit = this.scaleOf(id)
    // A PDF's card and its open spread's title node are already one page
    // wide; a group open is its frame, and folded the width of its box.
    const folded =
      node.type === 'group'
        ? { ...rect, w: collapsedGroupSize(1, unit).w }
        : rect
    return titleBox(
      node,
      folded,
      this.titleMeasure().width(title),
      this.titleScaleOf(id),
      unit,
    )
  }

  /** What the toolbar asks of a group, or a click on its collapsed box.
   * "Fit to content" lets go of the size the frame was given by hand, and the
   * frame is its members' again. */
  private runGroupAction(id: NodeId, action: GroupAction): void {
    if (!this.canEdit) return
    switch (action) {
      case 'fit':
        this.applyBoardChange(releaseBounds(this.board, id))
        break
      case 'collapse':
        // Gathered into the box first, and only then collapsed
        // (`foldGroupAway`), which brings the board up to date itself.
        void this.foldGroupAway(id)
        return
      case 'expand':
        this.openGroup(id)
        return
    }
    this.recomputeVisibility()
    this.drainQueues()
    this.interaction.refreshInteractionLayer()
  }

  /**
   * What every collapsed group on the board shows in its box, and where:
   * each thing it holds — with what it carries — at the place the fold
   * carried it to (domain/groups.ts's `collapsedGroupPlaces`), drawn by the
   * board as it draws any card (`folded`). So the end of a group folding
   * away is the box it leaves, not a picture of it swapped in; and what is
   * in a box is typeset as sharp as the card it is, at any zoom. Not what
   * the last cell stands in for, and not a group behind a portal.
   */
  private foldedShown(): readonly FoldedShown[] {
    const portals = this.sources.composition.portals
    const shown: FoldedShown[] = []
    for (const box of this.board.nodes) {
      if (!isFolded(box) || portalOf(box.id, portals)) continue
      const stash = box.stash.nodes
      const byId = new Map(stash.map((node) => [node.id, node]))
      const members = box.members.flatMap((id) => {
        const node = byId.get(id)
        return node ? [node] : []
      })
      const places = collapsedGroupPlaces(
        box,
        members.map((member) => ({
          id: member.id,
          extent: groupMemberExtent(member, stash),
        })),
        this.scaleOf(box.id),
      )
      const moves = groupFoldMotions(places, (id) => {
        const member = byId.get(id)
        return member ? withCarried(member, stash) : []
      })
      for (const { node, motion } of moves) {
        if (!motion.fade) {
          shown.push({ node, pose: foldedPose(node, motion), box: box.id })
        }
      }
    }
    return shown
  }

  /**
   * What the collapsed groups show in their boxes (`folded`), where each box
   * is shown now: carried with it while a drag holds it somewhere the board
   * does not have it yet, or a motion is taking it there — at the box's
   * place on the board, it stayed behind as the box moved off without it.
   * Not what is flying out of a box.
   */
  private foldedNow(): readonly Readonly<{ node: BoardNode; pose: Pose }>[] {
    const live = this.interaction.liveNodeRects
    return this.folded.flatMap((shown) => {
      if (this.motions.isDeparting(shown.node.id)) return []
      const box = this.nodesById.get(shown.box)
      const at = this.motions.pose(shown.box) ?? live?.get(shown.box)
      if (!box || !at || box.w === 0) return [shown]
      const k = at.w / box.w
      const { pose } = shown
      return [
        {
          node: shown.node,
          pose: {
            ...pose,
            x: at.x + (pose.x - box.x) * k,
            y: at.y + (pose.y - box.y) * k,
            w: pose.w * k,
            h: pose.h * k,
          },
        },
      ]
    })
  }

  /**
   * Moves the selection — a group with what it holds — to a new board beside
   * this one, leaving a portal onto it where it was (domain/split.ts). Named
   * the way a card converted to a note is: after the group, when one group
   * is what is selected, and the default board name otherwise. Undoing it
   * puts the cards back and leaves the file.
   */
  private async moveSelectionToNewBoard(): Promise<void> {
    if (!this.canEdit || this.selectedIds.size === 0) return
    const ids = nodesToDragWith(this.selectedIds, this.board.nodes)
    const single =
      this.selectedIds.size === 1
        ? this.nodesById.get(this.selectedIds.values().next().value ?? '')
        : undefined
    const baseName =
      sanitizeFileName(single?.type === 'group' ? (single.label ?? '') : '') ||
      this.t('file.newWhiteboardBaseName')
    const ownPath = this.sourcePathForBoard()
    const folder = ownPath.includes('/')
      ? ownPath.slice(0, ownPath.lastIndexOf('/'))
      : ''
    const taken = new Set(
      this.host.vault
        .listChildren(folder)
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.name),
    )
    const fileName = generateBoardFileName(baseName, taken)
    const path = folder ? `${folder}/${fileName}` : fileName
    const portalName = mintNodeId(this.board)
    const plan = () =>
      splitOff(
        this.board,
        this.sources.composition,
        ownPath,
        ids,
        path,
        portalName,
      )
    const first = plan()
    if (!first) return
    const before = this.board
    try {
      await this.host.vault.createText(path, serializeBoard(first.content))
    } catch (error) {
      this.reportError('move to new board', error)
      this.host.ui.notice(this.t('error.createFailed'))
      return
    }
    // The board may have moved on while the file was written.
    const split = this.board === before ? first : plan()
    if (!split || this.parseFailed) return
    const previous = this.nodesById
    this.applyBoardChange(split.board)
    for (const id of previous.keys()) {
      if (!this.nodesById.has(id)) this.purgeNodeRuntime(id)
    }
    this.recomputeVisibility()
    this.drainQueues()
    this.setSelection([split.portal])
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
    const [only] = this.selectedIds
    const single =
      this.selectedIds.size === 1 ? this.nodesById.get(only) : undefined
    if (isFolded(single)) {
      this.tidyFolded(single.id)
      return
    }
    this.applyArrangement(
      tidyRects(
        arrangeTargets(this.board, this.selectedIds),
        GRID_WORLD_STEP_PX,
      ),
    )
  }

  /**
   * Tidies what a collapsed group holds where it is put away: the group is
   * opened on the board, what it holds tidied, and put away again, in one
   * step. What it holds is the same things shown otherwise — in its box —
   * so tidying it does what it does to the group open, and is undone alike.
   */
  private tidyFolded(id: NodeId): void {
    if (!this.canEdit) return
    const open = expandGroup(this.board, id)
    const positions = carryGroupMembers(
      open.nodes,
      tidyRects(arrangeTargets(open, new Set([id])), GRID_WORLD_STEP_PX),
    )
    if (positions.size === 0) return
    this.applyBoardChange(collapseGroup(setNodePositions(open, positions), id))
    this.recomputeVisibility()
    this.drainQueues()
    this.interaction.refreshInteractionLayer()
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
    // Opened again before its card had drawn: the copy over it is not of
    // anything there any more.
    this.releaseFoldedCard(id, true)
    if (node.spread) {
      const lead = this.handOffLeadPage(id, node)
      this.commitSpreadToggle(id, openSpread(this.board, id))
      this.dealOut(spreadMotions(spreadPages(this.board, id), node, lead, 'in'))
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
    const lead = this.handOffLeadPage(id, now)
    this.commitSpreadToggle(id, openSpread(this.board, id, layout))
    this.dealOut(spreadMotions(spreadPages(this.board, id), now, lead, 'in'))
  }

  private prefersReducedMotion(): boolean {
    // A JS-driven animation, so the reduced-motion degrade is ours to make
    // (CLAUDE.md) — the global CSS fallback does not reach WAAPI.
    return this.context
      .getWindow()
      .matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /** The cards the GPU scene may be asked to draw: the board's own, and
   * everything the collapsed groups hold — not only what their boxes show
   * (`folded`): what a group put away keeps its typesetting, so it comes
   * back out drawn, not set again card by card while it moves. */
  private drawableNodes(): readonly BoardNode[] {
    const portals = this.sources.composition.portals
    const held = this.board.nodes.flatMap((box) =>
      isFolded(box) && !portalOf(box.id, portals)
        ? box.stash.nodes.filter((node) => node.type !== 'group')
        : [],
    )
    return held.length === 0
      ? this.ownCardNodes
      : [...this.ownCardNodes, ...held]
  }

  /** Whether `id` is on screen as an element of its own, rather than drawn
   * by the overview canvas or not shown at all. */
  private shownByElement(id: NodeId): boolean {
    return (
      this.cardRenderer.getRuntime(id)?.el != null &&
      !this.cardRenderer.isParked(id)
    )
  }

  /** Once a frame while anything is in motion (./canvas/motions.ts): the
   * canvas draws it where it is shown, and its edges are drawn to it there —
   * to where it rests, for one that has just stopped. */
  private showMotions(): void {
    // Picked up over a few frames, and drawn as it is each one — the
    // elements by their own animations.
    if (this.motions.lifting) this.overviewLayer?.markDirty()
    if (this.motions.size === 0) return
    const changed = this.motions.tick()
    if (changed.size === 0) return
    this.overviewLayer?.markDirty()
    // In the overview tier the canvas draws the edges, to where things are
    // shown; their DOM is out of the drawing, and writing to it would still
    // cost a style recalculation over every edge on the board — paid, as it
    // happens, by the next thing that asks for style (the canvas setting a
    // font), every frame. The DOM was given where they end when the board
    // changed.
    if (this.overview) return
    const shown = new Map<NodeId, CardRect>()
    for (const { id, pose } of this.motions.moving()) shown.set(id, pose)
    this.edgeLayer.redrawEdgesForNodes(changed, shown)
  }

  // -----------------------------------------------------------------------
  // Folds: a PDF spread into its card, a group into its box.
  //
  // How each node moves is ./foldMotion.ts's, and showing it, on whichever
  // hand draws the node, ./canvas/motions.ts's. What is here is the order of
  // events around the board change: a fold opened is committed first, and
  // what it opened is shown coming out of the fold (`dealOut`); a fold
  // closed is gathered first (`gather`), and committed once everything has
  // arrived.
  // -----------------------------------------------------------------------

  /** What a fold just opened, shown coming out of it: each node from where
   * its motion folds it to where the board now has it. */
  private dealOut(moves: readonly FoldMove[]): void {
    for (const { node, motion } of moves) {
      this.motions.settle(node.id, {
        from: foldedPose(node, motion),
        delay: motion.delay,
        onTop: motion.onTop,
      })
    }
    this.overviewLayer?.markDirty()
  }

  /**
   * Gathers `moves` into their fold, and `frames` to their new rectangles
   * alongside, each held where it arrives. True once everything has arrived;
   * false, at once, for a fold of `key` already being gathered — a second
   * ask while they travel is the same ask, and is let go.
   */
  private async gather(
    key: NodeId,
    moves: readonly FoldMove[],
    frames: readonly FrameMove[] = [],
  ): Promise<boolean> {
    if (this.folding.has(key)) return false
    for (const { node, motion } of moves) {
      this.motions.move(node.id, foldedPose(node, motion), {
        hold: true,
        delay: motion.delay,
        onTop: motion.onTop,
      })
    }
    for (const frame of frames) {
      this.motions.move(frame.id, poseOf(frame.to), {
        hold: true,
        reshape: true,
      })
    }
    this.overviewLayer?.markDirty()
    this.folding.add(key)
    await this.motions.arrived([
      ...moves.map((move) => move.node.id),
      ...frames.map((frame) => frame.id),
    ])
    this.folding.delete(key)
    return true
  }

  /** A gather called off — what it folded was closed, opened or removed
   * some other way meanwhile: everything still there goes back to where the
   * board has it. */
  private ungather(
    moves: readonly FoldMove[],
    frames: readonly FrameMove[] = [],
  ): void {
    for (const { node } of moves) this.motions.settle(node.id)
    for (const frame of frames) this.motions.settle(frame.id, { reshape: true })
  }

  /** The page a spread about to open from `card` comes out of it on — its
   * sheet is the card. That sheet is handed the card's sharp picture of it,
   * so it does not go soft for the moment between the card going and the
   * sheet drawing its own, with or without the motion. */
  private handOffLeadPage(id: NodeId, card: BoardNode): number {
    const lead = firstPage(card)?.page ?? 1
    const sharp = this.cardRenderer.copyPdfPicture(id, lead)
    if (sharp) this.spreadHandoffPictures.set(pdfPageNodeId(id, lead), sharp)
    return lead
  }

  /**
   * Closes a spread the way it opened, backwards: the sheets go back to
   * where the card comes back to (under the title) by their motions
   * (./foldMotion.ts) — the page the card will show whole and on top,
   * wherever it was put. Only then is the spread closed — and where that
   * sheet was an element, a copy of it is held over the card until its
   * reader has drawn (`holdFoldedCard`), so the page stays the same piece of
   * paper from start to end.
   */
  private async foldSpreadAway(id: NodeId): Promise<void> {
    const title = this.nodesById.get(id)
    if (!title) return
    const corner = foldedCardOrigin(title)
    const reader = title.type === 'file' ? title.readerRect : undefined
    const card: SpreadRect = {
      ...corner,
      w: reader?.w ?? title.w,
      h: reader?.h ?? title.h,
    }
    const lead = firstPage(title)?.page ?? 1
    const moves = spreadMotions(spreadPages(this.board, id), card, lead, 'out')
    const top = moves.find((move) => move.motion.onTop)?.node.id
    if (!(await this.gather(id, moves))) return
    if (!isSpreadTitle(this.nodesById.get(id))) {
      this.ungather(moves)
      return
    }
    // Copied, and put beside it in the world, while the sheet is still there:
    // it goes with the spread.
    const leadEl =
      top !== undefined && this.shownByElement(top)
        ? this.cardRenderer.getRuntime(top)?.el
        : undefined
    const transform = top === undefined ? null : this.motions.transformOf(top)
    const cover =
      leadEl?.isConnected && transform ? foldCoverOf(leadEl, transform) : null
    if (cover) leadEl?.after(cover)
    this.commitSpreadToggle(id, closeSpread(this.board, id))
    if (cover) {
      this.holdFoldedCard(id, cover)
      return
    }
    // The sheet that came back whole, drawn, is where the card is drawn now,
    // at its width: the card simply takes its place. With none, the card
    // fades in where the others went.
    if (top !== undefined || moves.length === 0) return
    this.motions.settle(id, { from: poseOf(card, 0) })
  }

  /**
   * Collapses group `id` the way it will look collapsed: each thing it holds
   * goes, whole and with what it carries, into its cell of the box — where
   * the box will draw its picture of it (./foldMotion.ts) — while the frame,
   * and every frame round it, closes onto the box. Only then is the group
   * collapsed. What arrived on screen as elements is let go of where it
   * stands, fading over the pictures the box now draws in the same places —
   * all but what went into the last cell, which arrived faded.
   */
  private async foldGroupAway(id: NodeId): Promise<void> {
    const group = this.nodesById.get(id)
    if (group?.type !== 'group' || isFolded(group)) return
    const settled = this.fitFrames(collapseGroup(this.board, id))
    const box = settled.nodes.find((node) => node.id === id)
    if (!box) return
    const moves = this.groupFoldMoves(group, box, this.board.nodes)
    const frames = this.frameMoves(this.board, settled)
    if (!(await this.gather(id, moves, frames))) return
    const now = this.nodesById.get(id)
    if (now?.type !== 'group' || isFolded(now)) {
      this.ungather(moves, frames)
      return
    }
    // What went into the last cell faded on the way and is not there to see:
    // fading it out again would start it back at whole, over the count.
    for (const { node, motion } of moves) {
      if (this.shownByElement(node.id))
        this.purgeNodeRuntime(node.id, { exit: motion.fade ? false : 'fade' })
    }
    this.applyBoardChange(collapseGroup(this.board, id))
    this.recomputeVisibility()
    this.drainQueues()
    this.interaction.refreshInteractionLayer()
  }

  /** Expands group `id` out of its box the way it collapsed, backwards: what
   * it holds comes out of its cells to where it was, as the frame — and
   * every frame round it — opens back out. */
  private openGroup(id: NodeId): void {
    const box = this.nodesById.get(id)
    if (!isFolded(box)) return
    const next = expandGroup(this.board, id)
    const settled = this.fitFrames(next)
    const group = settled.nodes.find((node) => node.id === id)
    if (group?.type !== 'group') return
    const moves = this.groupFoldMoves(group, box, settled.nodes)
    const frames = this.frameMoves(this.board, settled)
    this.applyBoardChange(next)
    // What it put away is back, and the edges drawn to its box reach it.
    this.syncEdgesSvg()
    this.dealOut(moves)
    for (const frame of frames) {
      this.motions.settle(frame.id, {
        from: poseOf(frame.from),
        reshape: true,
      })
    }
    this.recomputeVisibility()
    this.drainQueues()
    this.interaction.refreshInteractionLayer()
  }

  /**
   * How `group`'s things move between where they are in `nodes` and its box
   * at `box`: each by the map its box draws its picture by
   * (domain/groups.ts's `collapsedGroupPlaces`), with everything it carries.
   */
  private groupFoldMoves(
    group: GroupNode,
    box: SpreadRect,
    nodes: readonly BoardNode[],
  ): FoldMove[] {
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const members = group.members.flatMap((member) => {
      const node = byId.get(member)
      return node ? [node] : []
    })
    const places = collapsedGroupPlaces(
      { x: box.x, y: box.y, w: box.w, h: box.h },
      members.map((member) => ({
        id: member.id,
        extent: groupMemberExtent(member, nodes),
      })),
      this.scaleOf(group.id),
    )
    return [
      ...groupFoldMotions(places, (member) => {
        const node = byId.get(member)
        return node ? withCarried(node, nodes) : []
      }),
    ]
  }

  /** Every group's frame that is somewhere else in `after` than in
   * `before`. */
  private frameMoves(before: Board, after: Board): FrameMove[] {
    const was = new Map(
      before.nodes
        .filter((node) => node.type === 'group')
        .map((node) => [node.id, node]),
    )
    return after.nodes.flatMap((node): FrameMove[] => {
      const from = node.type === 'group' ? was.get(node.id) : undefined
      if (!from) return []
      if (
        from.x === node.x &&
        from.y === node.y &&
        from.w === node.w &&
        from.h === node.h
      ) {
        return []
      }
      return [{ id: node.id, from, to: node }]
    })
  }

  /**
   * Keeps `cover` — a copy of the sheet that just went back into its card,
   * already in the world where the sheet ended — over the folded card until
   * the card's reader shows the pages it opens on in its own pictures
   * (`releaseFoldedCard`, from the reader's `onDrawn`). A card mounting is a body with nothing in it, then a file
   * being opened, then pages standing in for themselves until they are
   * drawn; under the copy none of that is seen. Given up on after
   * FOLD_COVER_MAX_MS, so a card that cannot draw is never hidden for long.
   */
  private holdFoldedCard(id: NodeId, cover: HTMLElement): void {
    this.releaseFoldedCard(id, true)
    const timer = this.context
      .getWindow()
      .setTimeout(() => this.releaseFoldedCard(id), FOLD_COVER_MAX_MS)
    this.foldCovers.set(id, { cover, timer })
    if (this.cardRenderer.pdfDrawn(id)) this.releaseFoldedCard(id)
  }

  /** Takes the copy held over a folded card away (`holdFoldedCard`): faded
   * out, since the card under it may show its page from a little further
   * down than the sheet did, or `now` when there is nothing left to show it
   * over. */
  private releaseFoldedCard(id: NodeId, now = false): void {
    const held = this.foldCovers.get(id)
    if (!held) return
    this.foldCovers.delete(id)
    this.context.getWindow().clearTimeout(held.timer)
    const { cover } = held
    if (now || this.prefersReducedMotion()) {
      cover.remove()
      return
    }
    const remove = () => cover.remove()
    void cover
      .animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: ARRANGE_ANIMATION_MS,
        easing: ARRANGE_ANIMATION_EASING,
        fill: 'forwards',
      })
      .finished.then(remove, remove)
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
      const scale = nodeElementScale(el)
      el.style.left = `${node.x}px`
      el.style.top = `${node.y}px`
      el.style.width = `${node.w / scale}px`
      el.style.height = `${node.h / scale}px`
    }
    this.edgeLayer.redrawEdgesForNodes(changed)
    this.interaction.refreshInteractionLayer()
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
    this.setSelection([id])
    this.syncEdgesSvg()
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

  /**
   * Edit, asked of a card the GPU scene draws: it is built (or unparked), and the editor
   * opens once it is (`openPendingEdit`). It leaves the selection first, as
   * any card opened to edit does — which writes where it was read, so it is
   * built from there.
   */
  private editWhenBuilt(id: NodeId): void {
    this.setSelection([])
    this.pendingEdit = {
      id,
      until: this.context.getWindow().performance.now() + PENDING_EDIT_WAIT_MS,
    }
    this.recomputeVisibility()
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
    if (!runtime?.el || this.cardRenderer.isParked(pending.id)) return
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
    for (const id of positions.keys()) {
      const el = this.cardRenderer.getRuntime(id)?.el
      const node = this.nodesById.get(id)
      if (!node) continue
      if (el) {
        el.style.left = `${node.x}px`
        el.style.top = `${node.y}px`
      }
      // Not decoration: these commands move several cards at once and the
      // user pointed at none of them — with no travel there is nothing on
      // screen saying what happened or which cards it happened to.
      const from = before.get(id)
      if (!from || options?.animate === false) continue
      if (from.x === node.x && from.y === node.y) continue
      this.motions.settle(id, { from: poseOf({ ...node, ...from }) })
    }
    this.edgeLayer.redrawEdgesForNodes(new Set(positions.keys()))
    this.interaction.refreshInteractionLayer()
    this.recomputeVisibility()
    this.drainQueues()
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

  private worldPointFromEvent(
    e: Readonly<{ clientX: number; clientY: number }>,
  ): ScreenPoint {
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
    options?: Readonly<{ exit?: NodeExit }>,
  ): void {
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
    this.pinsRevision += 1
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
    this.advancePortalZoom(now)
    if (now - this.lastRecomputeTime > RECOMPUTE_INTERVAL_MS) {
      // Asked again only if something it is asked about has changed: on a
      // still board of thousands of cards, every card and every edge was
      // tested against the viewport fourteen times a second, for the same
      // answer.
      if (!sameInputs(this.visibilityInputs, this.currentVisibilityInputs())) {
        this.recomputeVisibility()
      }
      this.lastRecomputeTime = now
    }
    // How much card content this frame builds. While the camera moves, only
    // frames that follow an on-time one do, one card each: the work is priced
    // by its effect on the frame it lands in, and that is the only place it
    // can be read. While it zooms, none do: where a zoom lands is not known
    // until it does — what it brings on screen on the way it mostly takes
    // off again (measured 2026-11-08: four of seven cards shown again during
    // a zoom were parked again within 100ms) — and the cards built here
    // cost a frame each (CONTENT_BUILDS_PER_MOVING_FRAME). The board's
    // drawing stands in for them until it stops.
    const sinceLastFrame =
      this.lastFrameAt === null ? 0 : now - this.lastFrameAt
    this.lastFrameAt = now
    const onTime = this.framePace.onTime(sinceLastFrame)
    const scale = this.cameraController.view.scale
    if (scale !== this.lastFrameScale) {
      this.lastFrameScale = scale
      this.zoomChangedAt = now
    }
    const zooming = now - this.zoomChangedAt < INTERACTING_TIMEOUT_MS
    this.contentBuildsLeft = !this.interacting
      ? Infinity
      : onTime && !zooming
        ? CONTENT_BUILDS_PER_MOVING_FRAME
        : 0
    this.drainQueues()
    this.pdfDraws.pump()
    this.pictures?.pump()
    this.settleOverviewLinger()
    this.openPendingEdit(now)
    this.showMotions()
    // It draws the camera the world layer was just given, and the geometry
    // the queues above have just finished changing.
    this.overviewLayer?.render()
    this.gpuBoard?.render(now)
    this.minimap?.render(now)
    // Over the cards as this frame draws them, the overview's titles
    // included — see ToolbarController.
    this.toolbarController.syncPosition()
    this.rafId = this.context.getWindow().requestAnimationFrame(this.frame)
  }

  /** Everything a visibility pass's answer depends on. A gesture's live
   * geometry is never the same twice: a pass is always owed while one is
   * under way. */
  private currentVisibilityInputs(): readonly unknown[] {
    const view = this.cameraController.view
    return [
      view.tx,
      view.ty,
      view.scale,
      this.getViewportSize(),
      this.board,
      this.pinsRevision,
      this.engine.revision,
      // What the GPU scene can draw, and the card a selection opens.
      this.gpuBoard?.revision ?? 0,
      this.gpuBoard ? this.selectedIds : null,
      // A new object each time: equal to nothing.
      this.interaction.liveNodeRects ? {} : null,
    ]
  }

  private recomputeVisibility(): void {
    this.visibilityInputs = this.currentVisibilityInputs()
    if (this.parseFailed || !this.viewportEl) return
    // A portal come on screen opens, one gone off it shuts — and the board is
    // made again with or without what is behind it.
    if (
      this.portalNodes.length > 0 &&
      this.sources.wouldChange(this.portalNodes)
    ) {
      this.refreshFromSources({ clearSelection: false })
      return
    }
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
    this.updateDrawnPortals()
    if (this.sources.composition.portals.size === 0 && !this.gpuBoard) {
      if (this.overview) {
        // Two populations, one engine: groups keep their DOM at every tier
        // and are asked the ordinary question, cards are asked one they
        // cannot answer yes to.
        this.engine.recompute(this.groupNodes, rect, this.pinnedIds, moved)
        this.engine.recompute(this.cardNodes, UNREACHABLE_RECT, NO_PINS)
      } else {
        this.engine.recompute(this.visibilityNodes, rect, this.pinnedIds, moved)
      }
    } else {
      // The same two populations, sorted card by card: a card is drawn
      // rather than built at the size it is seen at — the camera's for the
      // board's own, times the portal's for one behind a portal — so a
      // portal zoomed in on a board zoomed out shows what is behind it
      // built, and one zoomed out on a board zoomed in, drawn.
      const built: BoardNode[] = []
      const drawn: BoardNode[] = []
      for (const node of this.visibilityNodes) {
        if (!this.isDrawn(node)) built.push(node)
      }
      for (const node of this.cardNodes) {
        if (this.isDrawn(node)) drawn.push(node)
      }
      this.engine.recompute(built, rect, this.pinnedIds, moved)
      this.engine.recompute(drawn, UNREACHABLE_RECT, NO_PINS)
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
    // Portals zoom on their own: what is behind one is seen at a new scale
    // without the camera's changing.
    this.cardRenderer.syncTitleScales()
  }

  /** Which open portals show what is behind them at a size the overview
   * tier would draw rather than build (`drawnPortals`). */
  private updateDrawnPortals(): void {
    const { scale } = this.cameraController.view
    const next = new Set<NodeId>()
    // A picture copies elements: what a portal draws rather than builds
    // would be missing from it.
    const portals = this.exporter?.isRunning
      ? new Map<NodeId, ComposedPortal>()
      : this.sources.composition.portals
    for (const [id, portal] of portals) {
      const drawn = nextOverviewState(
        scale * portal.scale,
        this.drawnPortals.has(id),
        { enter: OVERVIEW_SCALE_THRESHOLD, restore: OVERVIEW_RESTORE_SCALE },
      )
      if (drawn) next.add(id)
    }
    const same =
      next.size === this.drawnPortals.size &&
      [...next].every((id) => this.drawnPortals.has(id))
    if (same) return
    this.drawnPortals = next
    this.overviewLayer?.markDirty()
  }

  /** Where a card is, as far as the tiers go: behind a portal that draws
   * what is behind it (`drawnPortals`), behind one that builds it, or on the
   * board's own (null) — the innermost portal it is behind, whose scale is
   * the one it is seen at. */
  private portalTierOf(id: NodeId): 'drawn' | 'built' | null {
    const portals = this.sources.composition.portals
    if (portals.size === 0) return null
    const portal = portalOf(id, portals)
    if (!portal) return null
    return this.drawnPortals.has(portal.id) ? 'drawn' : 'built'
  }

  /** Whether a card's DOM shows it: mounted, and not waiting for its
   * content with the GPU scene's drawing standing in for it
   * (./canvas/cardRenderer.ts's `showsItself`). Until then the overview and
   * the GPU scene draw it as one that is not mounted. */
  private shownByDom(id: NodeId): boolean {
    return this.engine.mounted.has(id) && this.cardRenderer.showsItself(id)
  }

  /** Mod+F, or the controls' find: the board's find, over whatever is
   * being edited. */
  private openFind(): boolean {
    this.find?.open()
    return this.find !== null
  }

  /** Brings a hit of the board's find to view: its card at a size it can
   * be read at, and the hit in the middle of the viewport where the card
   * shows it. A hit past what a long card shows opens the card to read
   * (selects it) where the hit is, as an edge's end is turned to
   * (`turnTextTo`) — and the card keeps that as where it is read from. */
  private revealFindHit(hit: FindHit, source: string): void {
    const node = this.nodesById.get(hit.id)
    if (!node) return
    const readable = OVERVIEW_RESTORE_SCALE * 1.25
    if (this.cameraController.view.scale < readable) {
      this.cameraController.focusNode(node, readable)
      return
    }
    const placed = this.placeFindHit(hit, source)
    if (placed && placed.state !== 'visible') {
      this.setSelection([hit.id])
      this.turnTextTo(hit.id, source, [hit.start, hit.end])
      // Met at its top, where the hit's block now is.
      const size = this.getViewportSize()
      const half = size.height / 2 / this.cameraController.view.scale
      this.cameraController.centerOn(
        { x: node.x + node.w / 2, y: node.y + Math.min(node.h / 2, half) },
        size,
        { glide: true },
      )
      return
    }
    const box =
      placed?.state === 'visible'
        ? {
            x: Math.min(...placed.lines.map((line) => line.left)),
            y: Math.min(...placed.lines.map((line) => line.top)),
            right: Math.max(...placed.lines.map((line) => line.right)),
            bottom: Math.max(...placed.lines.map((line) => line.bottom)),
          }
        : { x: 0, y: 0, right: node.w, bottom: node.h }
    this.cameraController.centerOn(
      {
        x: node.x + (box.x + box.right) / 2,
        y: node.y + (box.y + box.bottom) / 2,
      },
      this.getViewportSize(),
      { glide: true },
    )
  }

  /** Where a hit of the find is on its card, line by line, in board units
   * from the card's top left: from its DOM when it is built, else from what
   * the GPU scene drew of it. */
  private placeFindHit(
    hit: FindHit,
    source: string,
  ):
    | Readonly<{
        state: 'visible'
        lines: readonly Readonly<{
          top: number
          bottom: number
          left: number
          right: number
        }>[]
      }>
    | Readonly<{ state: 'above' | 'below' }>
    | null {
    const anchor = textAnchorAt(source, [hit.start, hit.end])
    const runtime = this.cardRenderer.getRuntime(hit.id)
    if (runtime?.el && runtime.bodyEl && this.engine.mounted.has(hit.id)) {
      const placed = placeTextLines(runtime.el, runtime.bodyEl, source, anchor)
      if (placed?.state !== 'visible') return placed
      const scale = nodeElementScale(runtime.el)
      return {
        state: 'visible',
        lines: placed.lines.map((line) => ({
          top: line.top * scale,
          bottom: line.bottom * scale,
          left: line.left * scale,
          right: line.right * scale,
        })),
      }
    }
    const drawn = this.gpuBoard?.drawnText(hit.id) ?? null
    return drawn
      ? placeDrawnLines(drawn, source, anchor, this.glyphAdvance)
      : null
  }

  /** Whether a card is drawn by the canvas rather than built, at the size
   * it is seen at (`recomputeVisibility`). Groups keep their DOM at every
   * tier. */
  private isDrawn(node: BoardNode): boolean {
    if (node.type === 'group') return false
    const tier = this.portalTierOf(node.id)
    if (tier !== null) return tier === 'drawn'
    return this.overview || this.gpuDraws(node.id)
  }

  /**
   * Whether the GPU scene draws a card near to as well as far away, rather
   * than its DOM being built: a card it can typeset whole (./gpu/gpuBoard.ts's
   * `drawable`) that nothing needs the DOM of — not being typed or generated
   * in, not under a gesture (pinned), not offering the chips an empty card
   * selected does. The card selected is read there too (`setReading`).
   */
  private gpuDraws(id: NodeId): boolean {
    if (!this.gpuBoard?.drawable(id)) return false
    if (this.pinnedIds.has(id)) return false
    if (this.cardGeneration.wantsChips(id)) return false
    if (this.editing.isEditing(id) || this.pendingEdit?.id === id) return false
    return !this.cardGeneration.isGenerating(id)
  }

  /** Every page of every open spread, the pages a folded PDF card shows
   * from where it was left, every image card's file, and every text and
   * note card, with how far each is from the middle of the viewport — what
   * pictures are made for, nearest first. */
  private *wantedPictures(): Iterable<WantedPicture> {
    const view = this.worldViewportRect(0)
    const cx = (view.left + view.right) / 2
    const cy = (view.top + view.bottom) / 2
    const boardPath = this.sourcePathForBoard()
    const look = this.typesetStyle?.hash ?? null
    // What can show: a card behind a portal that its frame hides has nothing
    // to picture.
    for (const node of this.visibilityNodes) {
      const distance = Math.hypot(
        node.x + node.w / 2 - cx,
        node.y + node.h / 2 - cy,
      )
      if (isCardPictured(node)) {
        // Not before the look it would be of is known, and never a card
        // being written in: what it shows is not on the board yet.
        if (look === null || boardPath === '') continue
        if (this.editing.isEditing(node.id)) continue
        if (this.cardGeneration.isGenerating(node.id)) continue
        // One the GPU scene draws itself, at every zoom, needs none.
        if (this.gpuBoard?.drawsItself(node.id)) continue
        const signature = cardSignature(
          fileNodeOf(node),
          node.type === 'file' ? this.fileMtime(node.file) : null,
        )
        if (signature === null) continue
        yield {
          ...this.pictureKeyOf(node.id),
          width: node.w,
          distance,
          stamp: cardStamp(signature, look, this.remoteImages.revision),
        }
        continue
      }
      if (node.type === 'pdf-page') {
        const ref = pdfPageRef(node.file, node.page)
        yield { ...ref, width: node.w, distance, stamp: '' }
        continue
      }
      if (node.type === 'file' && fileNodeKind(node.file) === 'image') {
        yield { ...imageRef(node.file), width: node.w, distance, stamp: '' }
        continue
      }
      if (!isPdfNode(node) || isSpreadTitle(node)) continue
      // As many as the card holds at the widest page shape a document is
      // likely to have, and the one cut off at the bottom.
      const first = Math.floor(node.startPage ?? 1)
      const shown = Math.ceil(node.h / (node.w * FOLDED_PAGE_MIN_ASPECT)) + 1
      for (let page = first; page < first + shown; page += 1) {
        const ref = pdfPageRef(node.file, page)
        yield { ...ref, width: node.w, distance, stamp: '' }
      }
    }
    // The images in the cards the GPU scene draws: textures there, made
    // from these pictures.
    if (this.gpuBoard) {
      for (const image of this.gpuBoard.shownImages()) {
        const node = this.nodesById.get(image.id)
        if (!node) continue
        yield {
          ...imageRef(image.path),
          width: image.width,
          distance: Math.hypot(
            node.x + node.w / 2 - cx,
            node.y + node.h / 2 - cy,
          ),
          stamp: '',
        }
      }
    }
  }

  /** A picture arrived (`key`), or a group's were dropped (null): the
   * overview redraws, and the sheet showing a page that has one takes it if
   * it has nothing better yet. */
  private onPictureChange(
    source: PictureSourceId,
    group: string,
    key: string | null,
  ): void {
    this.overviewLayer?.markDirty()
    if (source === 'image' || source === 'pdf') this.gpuBoard?.markDirty()
    if (key === null || source !== 'pdf') return
    const page = Number(key)
    for (const node of this.cardNodes) {
      if (node.type !== 'pdf-page' || node.page !== page) continue
      if (node.file !== group) continue
      this.cardRenderer.getRuntime(node.id)?.pdfReader?.placeholderReady()
    }
  }

  /** A PDF page's annotations and where its PDF points land on its
   * picture; null for a page with none, or no picture to land them on. */
  private pageAnnotationsOf(
    path: string,
    page: number,
  ): Readonly<{
    frame: PageFrame
    annotations: readonly PdfAnnotation[]
  }> | null {
    const annotations = this.pictureAnnotations?.forPage(path, page)
    if (!annotations?.length) return null
    const frame = pageFrame(this.pictures?.meta(pdfPageRef(path, page)))
    return frame ? { frame, annotations } : null
  }

  /** A PDF page's picture as the GPU scene draws it (./gpu/pdfCards.ts):
   * as the theme shows it, its annotations painted in — once for each
   * picture and list of them. */
  private scenePagePicture(file: string, page: number): ImageBitmap | null {
    const palette = this.overviewLayer?.pagePalette()
    const picture = palette
      ? (this.pictures?.get(pdfPageRef(file, page), palette.dark) ?? null)
      : null
    if (!palette || !picture) return null
    const shown = this.pageAnnotationsOf(file, page)
    if (!shown) return picture
    const kept = this.markedPages.get(picture)
    if (
      kept?.annotations === shown.annotations &&
      kept.colors === palette.annotations
    ) {
      return kept.picture
    }
    kept?.picture.close()
    const win = this.context.getWindow() as Window & typeof globalThis
    const marked = withPageMarks(
      picture,
      pageMarks(shown.annotations, shown.frame, win.Path2D),
      palette.annotations,
      palette.dark,
    )
    this.markedPages.set(picture, {
      annotations: shown.annotations,
      colors: palette.annotations,
      picture: marked,
    })
    return marked
  }

  /** The picture standing for `node` (./pictures), as the theme shows it —
   * for a PDF, the one of its page `page` — or null while it has none. The
   * one way the overview and the cards ask for a picture. */
  private pictureOf(
    node: BoardNode,
    dark: boolean,
    page?: number,
  ): ImageBitmap | null {
    const ref = this.pictureRefOf(node, page)
    return ref ? (this.pictures?.get(ref, dark) ?? null) : null
  }

  /**
   * Where a card's picture is kept: under the board file it is in, by its id
   * there. A card behind a portal is that board's — so its picture is the
   * one its own board takes and keeps, and this board letting go of its own
   * cards' pictures does not touch it.
   */
  private pictureKeyOf(id: NodeId): PictureRef {
    const portals = this.sources.composition.portals
    const portal = portals.size === 0 ? null : portalOf(id, portals)
    return portal
      ? cardRef(portal.file, id.slice(portal.id.length + 1))
      : cardRef(this.sourcePathForBoard(), id)
  }

  /** The card on the board a picture kept under `group` is of. */
  private pictureNodeId(group: string, key: string): NodeId | null {
    if (group === this.sourcePathForBoard()) return key
    for (const portal of this.sources.composition.portals.values()) {
      if (portal.file !== group) continue
      const id = behindPortal(portal.id, key)
      if (this.nodesById.has(id)) return id
    }
    return null
  }

  /** The images a card's picture lays out and draws
   * (./pictures/typesetCards.ts): each one's own size, and those that can
   * be drawn decoded no wider than `widthPx` — or than they are. */
  private async cardImages(
    markdown: string,
    widthPx: number,
  ): Promise<CardImages> {
    const out: CardImages = { sizes: {}, bitmaps: {} }
    const sizes = this.imageSizes
    const win = this.context.getWindow()
    if (!sizes) return out
    for (const target of imageTargets(markdown)) {
      const path = sizes.resolve(target)
      const size = path === null ? null : await sizes.sizeOf(path)
      if (!path || !size) continue
      out.sizes[target] = size
      if (!sizes.drawable(path) || target in out.bitmaps) continue
      try {
        const data = await this.readImage(path)
        out.bitmaps[target] = await win.createImageBitmap(new Blob([data]), {
          resizeWidth: Math.max(1, Math.min(size.w, widthPx)),
          resizeQuality: 'medium',
        })
      } catch {
        // Not one this WebView decodes (an SVG among them): its place.
      }
    }
    return out
  }

  /** An image's bytes: a file's, or those kept of an image on the web
   * (../host/remoteImages.ts). */
  private readImage(path: string): Promise<ArrayBuffer> {
    return isRemoteImage(path)
      ? this.remoteImages.bytes(path)
      : this.host.vault.readBinary(path)
  }

  /** The version of an image's bytes: a file's modification time; for an
   * image on the web, whether they are kept — once kept they never change.
   * Null when there are none. */
  private imageVersion(path: string): number | null {
    if (!isRemoteImage(path)) return this.fileMtime(path)
    return this.remoteImages.kept(path) ? 1 : null
  }

  private pictureRefOf(node: BoardNode, page?: number): PictureRef | null {
    if (isCardPictured(node)) return this.pictureKeyOf(node.id)
    if (node.type === 'pdf-page') return pdfPageRef(node.file, node.page)
    if (node.type === 'file' && fileNodeKind(node.file) === 'image') {
      return imageRef(node.file)
    }
    if (page !== undefined && isPdfNode(node)) {
      return pdfPageRef(node.file, page)
    }
    return null
  }

  /** When the file at `path` was last modified; null when it is not a
   * file now. */
  private fileMtime(path: string): number | null {
    const entry = this.host.vault.getEntry(path)
    return entry?.kind === 'file' ? entry.mtime : null
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
   * Creating and editing are not gated on it: a card made or opened down
   * here is gone to first (`zoomInToEdit`), so the creation bar and the menus
   * stay as they are at every zoom. Only a generation, which writes into a
   * card's element as it streams, waits for the DOM tiers.
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

  /** One of this frame's content builds, if any is left (`contentBuildsLeft`). */
  private takeContentBuild(): boolean {
    if (this.contentBuildsLeft <= 0) return false
    this.contentBuildsLeft -= 1
    return true
  }

  private drainQueues(): void {
    // A parked card shown again pays for its content's style and layout at
    // once, so it waits for a build of its own; until then the board's
    // drawing goes on standing in for it.
    const { toMount, toUnmount } = this.engine.drain(
      MOUNT_QUOTA_PER_FRAME,
      UNMOUNT_QUOTA_PER_FRAME,
      (id) => !this.cardRenderer.isParked(id) || this.takeContentBuild(),
    )
    for (const id of toMount) {
      this.cardRenderer.mountNode(id)
      this.interaction.adoptMountedCard(id)
      // Mounted partway through a motion: shown where it has got to.
      this.motions.attach(id)
    }
    for (const id of toUnmount) this.cardRenderer.unmountNode(id)
    if (toMount.length > 0 || toUnmount.length > 0) {
      this.overviewLayer?.markMountsChanged()
      this.pictures?.invalidate()
    }
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
      if (this.contentBuildsLeft <= 0) return
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
  // sync has given a changed edge new elements — a concern of `selectedEdgeIds`,
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

  private syncEdgesSvg(): void {
    this.edgeLayer.syncEdges(this.board.edges)
    // A new edge starts visible; cull the off-screen ones now rather than
    // leaving them in the document until the next visibility tick.
    if (this.viewportEl) {
      this.edgeLayer.updateVisibility(this.worldViewportRect(), this.pinnedIds)
    }
    this.restoreEdgeSelection()
    this.syncAllChips()
    // The passages edges reach may have come or gone with them.
    this.refreshPassageMarks()
  }

  /** Drops selected ids whose edge is gone and re-applies the class to the
   * rest, after a sync has given changed edges new elements. */
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
    this.pinsRevision += 1
    this.motions.destroy()
    this.contentSyncQueue.clear()
    this.engine.reset()
    this.edgeLayer.clearEdgesSvg()
  }

  private reachesPassage(id: EdgeId | null): boolean {
    const edge = id === null ? undefined : this.boardEdgesById.get(id)
    return edge?.fromAnchor !== undefined || edge?.toAnchor !== undefined
  }

  /** The passages the edge pointed at or selected reaches in `id`'s card,
   * marked on its pages. */
  private passageMarks(id: NodeId): ReaderPassageMark[] {
    const marks: ReaderPassageMark[] = []
    for (const edge of this.markedEdges()) {
      for (const [node, anchor] of [
        [edge.fromNode, edge.fromAnchor],
        [edge.toNode, edge.toAnchor],
      ] as const) {
        if (node !== id || anchor?.kind !== 'pdf') continue
        marks.push({ page: anchor.page, quadPoints: anchor.quadPoints })
      }
    }
    return marks
  }

  /** The edges whose passages are marked: the one pointed at, and those
   * selected. At rest an edge marks nothing — it runs on to its passage. */
  private markedEdges(): Edge[] {
    return this.board.edges.filter(
      (edge) =>
        edge.id === this.hoveredEdgeId || this.selectedEdgeIds.has(edge.id),
    )
  }

  /** The passage of `id`'s card under a client point: the paragraph there,
   * or the passage selected in it beforehand when the point is on that. */
  private passageAt(
    id: NodeId,
    clientX: number,
    clientY: number,
  ): Promise<EdgeAnchor | null> | null {
    const runtime = this.cardRenderer.getRuntime(id)
    const preferred = this.passagePoints?.sourceIn(id) ?? null
    if (runtime?.pdfReader) {
      return runtime.pdfReader.passageAt(clientX, clientY, preferred)
    }
    const source = this.passageSource(id)
    const body = runtime?.bodyEl
    if (source === null || !body) return null
    if (preferred?.kind === 'text') {
      const range = passageRange(body, source, preferred)
      if (range && rangeContains(range, clientX, clientY)) {
        return Promise.resolve(preferred)
      }
    }
    return Promise.resolve(blockAnchorAt(body, clientX, clientY, source))
  }

  /** Marks the passage a connection let go would reach, or clears it. */
  private showPassageHint(id: NodeId, anchor: EdgeAnchor | null): void {
    const runtime = this.cardRenderer.getRuntime(id)
    if (runtime?.pdfReader) {
      runtime.pdfReader.showPassageHint(anchor)
      return
    }
    const source = this.passageSource(id)
    const range =
      anchor?.kind === 'text' && runtime?.bodyEl && source !== null
        ? passageRange(runtime.bodyEl, source, anchor)
        : null
    paintPassages(
      this.context.getDocument(),
      PASSAGE_HIGHLIGHT.hint,
      range ? [range] : [],
    )
  }

  /** Marks again the passages of the edge pointed at or selected: in PDF
   * cards on their pages, in text and note cards as highlights over their
   * text. */
  private refreshPassageMarks(): void {
    this.cardRenderer.refreshPassageMarks()
    const strong: Range[] = []
    for (const edge of this.markedEdges()) {
      for (const [id, anchor] of [
        [edge.fromNode, edge.fromAnchor],
        [edge.toNode, edge.toAnchor],
      ] as const) {
        if (anchor?.kind !== 'text') continue
        const body = this.cardRenderer.getRuntime(id)?.bodyEl
        const source = this.passageSource(id)
        if (!body || source === null) continue
        const range = passageRange(body, source, anchor)
        if (range) strong.push(range)
      }
    }
    paintPassages(this.context.getDocument(), PASSAGE_HIGHLIGHT.strong, strong)
  }

  /** A card's Markdown as the passages in it are found in: what its open
   * editor holds while it is being typed into, ahead of the board. */
  private passageSource(id: NodeId): string | null {
    return this.editing.editingText(id) ?? this.cardMarkdown(id)
  }

  /** What a card shows moved under the passages in it — it was drawn
   * again, or scrolled. */
  private passagesMoved(id: NodeId): void {
    this.edgeLayer.redrawPassageEdges(id)
    if (this.passagePoints?.isOn(id)) this.passagePoints.sync()
    this.passageHandles?.sync()
  }

  /** A card drew its text again: the passages in it are placed and marked
   * anew — a frame later, once what it drew has been laid out. */
  private passagesRedrawn(id: NodeId): void {
    this.context.getWindow().requestAnimationFrame(() => {
      this.passagesMoved(id)
      this.refreshPassageMarks()
    })
    this.findMarks?.cardMoved(id)
  }

  /** Where a passage's ends are on screen in `id`'s card, while the card
   * shows it. */
  private passageEnds(id: NodeId, anchor: EdgeAnchor): PassageEnds | null {
    if (this.placePassage(id, anchor)?.state !== 'visible') return null
    const runtime = this.cardRenderer.getRuntime(id)
    if (anchor.kind === 'pdf') {
      return runtime?.pdfReader?.passageEnds(anchor) ?? null
    }
    const source = this.passageSource(id)
    if (!runtime?.bodyEl || source === null) return null
    return textPassageEnds(runtime.bodyEl, source, anchor)
  }

  /** A passage of `id`'s card with one end moved to a client point. */
  private adjustPassage(
    id: NodeId,
    anchor: EdgeAnchor,
    moving: 'start' | 'end',
    clientX: number,
    clientY: number,
  ): Promise<EdgeAnchor | null> {
    const runtime = this.cardRenderer.getRuntime(id)
    if (anchor.kind === 'pdf') {
      return (
        runtime?.pdfReader?.adjustPassage(anchor, moving, clientX, clientY) ??
        Promise.resolve(null)
      )
    }
    const source = this.passageSource(id)
    if (!runtime?.bodyEl || source === null) return Promise.resolve(null)
    return Promise.resolve(
      adjustTextPassage(
        runtime.bodyEl,
        source,
        anchor,
        moving,
        clientX,
        clientY,
      ),
    )
  }

  /** An edge end reaches `anchor`, as part of the step `historyKey` names —
   * a handle's whole drag one undo step. */
  private setEdgeAnchor(
    edgeId: EdgeId,
    end: 'from' | 'to',
    anchor: EdgeAnchor,
    historyKey: string,
  ): void {
    if (!this.canEdit) return
    const board = updateEdge(this.board, edgeId, { [`${end}Anchor`]: anchor })
    if (board === this.board) return
    this.applyBoardChange(board, historyKey)
    const edge = this.boardEdgesById.get(edgeId)
    if (edge) this.edgeLayer.replaceEdge(edge)
    this.refreshPassageMarks()
  }

  /** Text selected in a text or note card, or the selection gone from one:
   * the passage of its source it names is what the passage's connection
   * points pull an edge from. A PDF card's selection is its reader's to
   * report (`selectPassage`) — but no selection at all, however it went,
   * is this one's to see: the points stand for selected text, and with none
   * there they go. */
  private readonly onSelectionChange = (): void => {
    if (this.selectionFrame !== null) return
    this.selectionFrame = this.context.getWindow().requestAnimationFrame(() => {
      this.selectionFrame = null
      this.syncTextSelection()
    })
  }

  /** Asks again, a frame on, whether the text the passage points stand for
   * is still selected: something just changed that can take a selection
   * away without a word (an editor closed, a card let go). */
  private revalidatePassagePoints(): void {
    this.onSelectionChange()
  }

  private syncTextSelection(): void {
    const selection = this.context.getDocument().getSelection()
    // Text is selected only while the selection holds some and is still in
    // the page: an editor closed or a reader's text layer taken down takes
    // its selection with it, and tells nobody (no `selectionchange`) — the
    // range is left on nodes no longer there. Hence also the calls from the
    // editing and selection changes that do that (`revalidatePassagePoints`).
    if (
      !selection ||
      selection.isCollapsed ||
      !selection.anchorNode?.isConnected ||
      selection.toString().trim() === ''
    ) {
      // An open highlight is not text selected: it stands until let go.
      if (this.highlightSelected) return
      this.passageSelection += 1
      this.textPassageSelected = false
      this.passagePoints?.setSource(null)
      return
    }
    const node = selection?.anchorNode ?? null
    const el = node
      ? node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
      : null
    const id =
      (el?.closest('[data-node-id]') as HTMLElement | null)?.dataset.nodeId ??
      null
    const body = id === null ? null : this.cardRenderer.getRuntime(id)?.bodyEl
    const source = id === null ? null : this.passageSource(id)
    const anchor =
      selection && body && source !== null
        ? selectionAnchor(body, selection, source)
        : null
    if (id !== null && anchor) {
      this.passageSelection += 1
      this.textPassageSelected = true
      this.highlightSelected = false
      this.pdfPassage = null
      this.passagePoints?.setSource({ nodeId: id, anchor })
      return
    }
    if (!this.textPassageSelected) return
    this.textPassageSelected = false
    this.passagePoints?.setSource(null)
  }

  /** A connection was made reaching `anchors`. Text selected in a PDF and
   * connected — pulled from, or let go on — stays marked where it was read,
   * as a selection dropped as an excerpt does: what was taken from the
   * passage leaves the same trace whichever it became. A passage the board
   * found under the pointer is not marked: only what the reader chose. */
  private passagesConnected(anchors: readonly EdgeAnchor[]): void {
    const passage = this.pdfPassage
    if (!passage || !anchors.includes(passage.anchor)) return
    this.pdfPassage = null
    this.pdf.markPassage(passage.reader, passage.selection)
  }

  /** An annotation opened in a PDF card — a highlight or a framed area — or
   * the one opened let go: what it marks is what the connection points pull
   * an edge from, as a selection's passage is, the annotation already
   * marking it. */
  private selectHighlight(id: NodeId, anchor: EdgeAnchor | null): void {
    if (!anchor) {
      if (!this.highlightSelected) return
      this.highlightSelected = false
      this.passageSelection += 1
      this.passagePoints?.setSource(null)
      return
    }
    this.passageSelection += 1
    this.textPassageSelected = false
    this.highlightSelected = true
    this.passagePoints?.setSource({ nodeId: id, anchor })
  }

  /** Text selected in a PDF card, or the selection gone: the passage it
   * names is what its connection points pull an edge from. */
  private selectPassage(
    id: NodeId,
    reader: PdfReader,
    selection: ReaderTextSelection | null,
  ): void {
    const ticket = ++this.passageSelection
    this.textPassageSelected = false
    this.highlightSelected = false
    if (!selection) {
      this.passagePoints?.setSource(null)
      return
    }
    passageAnchorFromSelection(reader, selection)
      .then((anchor) => {
        if (ticket !== this.passageSelection) return
        // Made while the page's text was read: the selection may have gone
        // in the meantime by a way that told nobody. Points stand only for
        // text selected now.
        if (!selection.getRect()) return
        this.pdfPassage = anchor && { reader, selection, anchor }
        this.passagePoints?.setSource(anchor && { nodeId: id, anchor })
      })
      .catch((error: unknown) =>
        this.core.reportError('passage selection', error),
      )
  }

  /**
   * Where a passage an edge end reaches is in its card, measured down from
   * the card's top edge: asked of the card's reader for a PDF passage. Null
   * when the card cannot say — it is not drawn, or not as a reader, or the
   * passage is of a kind its card does not hold.
   */
  private placePassage(
    id: NodeId,
    anchor: EdgeAnchor,
  ): CardPassagePlacement | null {
    if (anchor.kind === 'text') {
      const runtime = this.cardRenderer.getRuntime(id)
      const source = this.passageSource(id)
      if (source === null) return null
      if (!runtime?.el || !runtime.bodyEl) {
        // Drawn by the GPU scene rather than built: placed in what it laid
        // out.
        const drawn = this.gpuBoard?.drawnText(id)
        return drawn
          ? placeDrawnPassage(drawn, source, anchor, this.glyphAdvance)
          : null
      }
      return inBoardUnits(
        placeTextPassage(runtime.el, runtime.bodyEl, source, anchor),
        runtime.el,
      )
    }
    return this.placeInReader(id, (reader) =>
      reader.placePassage(anchor.page, anchor.quadPoints),
    )
  }

  /** Where a page of a PDF's card is in the card, as `placePassage` says
   * where a passage is: an edge end on the page (`fromPage` / `toPage`)
   * reaches it as a whole. */
  private placePage(id: NodeId, page: number): CardPassagePlacement | null {
    return this.placeInReader(id, (reader) => reader.placePage(page))
  }

  /** What `place` says of the card's reader, measured from the card's top
   * edge rather than the reader's. */
  private placeInReader(
    id: NodeId,
    place: (reader: PdfReader) => CardPassagePlacement | null,
  ): CardPassagePlacement | null {
    const runtime = this.cardRenderer.getRuntime(id)
    const reader = runtime?.pdfReader
    if (!runtime?.el || !reader) return null
    const placement = place(reader)
    if (!placement || placement.state !== 'visible') return placement
    // The reader measures from its own top edge; the card's is above it by
    // whatever the card puts first (its border).
    let offsetTop = 0
    let offsetLeft = 0
    let el: HTMLElement | null = reader.root
    while (el && el !== runtime.el) {
      offsetTop += el.offsetTop
      offsetLeft += el.offsetLeft
      el = el.offsetParent as HTMLElement | null
    }
    if (el !== runtime.el) return null
    return inBoardUnits(
      {
        state: 'visible',
        top: placement.top + offsetTop,
        bottom: placement.bottom + offsetTop,
        left: placement.left + offsetLeft,
        right: placement.right + offsetLeft,
      },
      runtime.el,
    )
  }

  private syncBoardIndex(): void {
    this.nodesById = new Map(this.board.nodes.map((node) => [node.id, node]))
    this.portalNodes = this.board.nodes.filter(isPortal)
    const portals = this.sources.composition.portals
    this.splitPortalLayers(portals)
    this.visibilityNodes =
      portals.size === 0
        ? this.board.nodes
        : this.board.nodes.filter((node) => {
            const clip = portalOf(node.id, portals)?.clip
            return !clip || overlaps(node, clip)
          })
    this.cardNodes = this.board.nodes.filter((node) => node.type !== 'group')
    this.folded = this.foldedShown()
    this.gpuBoard?.setNodes(this.drawableNodes())
    this.find?.boardChanged()
    this.groupNodes = this.board.nodes.filter((node) => node.type === 'group')
    this.parentGroups = groupParents(this.board.nodes)
    this.boardEdgesById = new Map(
      this.board.edges.map((edge) => [edge.id, edge]),
    )
    this.syncEmptyHint()
    this.spreadFrame?.sync()
    this.passagePoints?.sync()
    this.passageHandles?.sync()
    this.pictures?.retain()
    const pdfs = new Set<string>()
    for (const wanted of this.wantedPictures()) {
      if (wanted.source === 'pdf') pdfs.add(wanted.group)
    }
    this.pictureAnnotations?.retain(pdfs)
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
    // something the user did, and it runs before the history starts (see
    // setViewData).
    this.commitWithoutHistory(board)
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
      // Anything else has no text kept to compare, and what it shows is
      // keyed by the file's mtime (a resource URL, an HTML page's
      // `livePage`) — so a re-render shows the new bytes.
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

  private sourcePathOf(id: NodeId): string {
    const portals = this.sources.composition.portals
    const portal = portals.size === 0 ? null : portalOf(id, portals)
    return portal ? portal.file : this.sourcePathForBoard()
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

/** Whether two lists hold the same things, one for one. */
function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

/** Whether a node shows at all through `clip`. */
function overlaps(node: Rect, clip: Rect): boolean {
  return (
    node.x < clip.x + clip.w &&
    node.x + node.w > clip.x &&
    node.y < clip.y + clip.h &&
    node.y + node.h > clip.y
  )
}

/** Whether `after` is `before` somewhere else, and nothing more. */
/** A placement measured in a card's element (`placePassage`) as the board
 * has it: behind a portal at another scale, the element is drawn larger or
 * smaller than it measures. */
function inBoardUnits(
  placement: CardPassagePlacement | null,
  el: HTMLElement,
): CardPassagePlacement | null {
  const scale = nodeElementScale(el)
  if (!placement || placement.state !== 'visible' || scale === 1) {
    return placement
  }
  return {
    state: 'visible',
    top: placement.top * scale,
    bottom: placement.bottom * scale,
    left: placement.left * scale,
    right: placement.right * scale,
  }
}

function onlyMoved(before: BoardNode, after: BoardNode): boolean {
  // Made of the same node of its file: the same card, seen from where a
  // portal moved or zoomed to.
  const file = fileNodeOf(before)
  if (file !== before && file === fileNodeOf(after)) return true
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (key === 'x' || key === 'y') continue
    if (
      (before as Record<string, unknown>)[key] !==
      (after as Record<string, unknown>)[key]
    ) {
      return false
    }
  }
  return true
}
