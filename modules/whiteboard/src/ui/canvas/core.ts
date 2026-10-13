// The shared face `WhiteboardCanvas` shows its controllers: the reads and the
// commits almost every one of them needs, gathered once instead of being
// hand-written into each controller's callback object.
//
// The canvas stays the only owner of board, history and selection. Nothing
// here hands that state out to be kept: every read is a getter asked at use
// time, and every change goes back through the canvas's own commit paths
// (`applyBoardChange`, `commitWithoutHistory`, the selection setters), so
// "changed the board", "recorded a step" and "asked the host to save" cannot
// drift apart whichever controller asked for the change.
//
// A controller takes `core` plus the few callbacks only it needs, and never
// imports the canvas (single-direction dependency, as for every controller in
// this directory).

import type { ScreenPoint } from '../../domain/camera'
import type {
  Board,
  BoardNode,
  Edge,
  EdgeId,
  NodeId,
  PortalView,
} from '../../domain/fileFormat'
import type { Rect } from '../../domain/portals'
import type { CanvasView, WorldRect } from '../../domain/virtualization'

import type { NodeRuntime } from './cardRenderer'

export type CanvasCore = Readonly<{
  context: YoloModuleHostFileViewContextV1
  host: YoloModuleHostApiV1

  // -- board ------------------------------------------------------------
  getBoard: () => Board
  getNode: (id: NodeId) => BoardNode | undefined
  getEdge: (id: EdgeId) => Edge | undefined
  /** Every node that is not a group, in board order — what a card gesture
   * acts on. */
  getCardNodes: () => readonly BoardNode[]
  /** Mints a node id against `board` (default: the live one), so several
   * cards built up before one commit stay apart. */
  nextNodeId: (board?: Board) => NodeId
  nextEdgeId: () => EdgeId

  // -- what may be done right now ---------------------------------------
  /** The board failed to parse: nothing about it can be shown or edited. */
  isParseFailed: () => boolean
  /** Whether the board can be changed at all. */
  canEdit: () => boolean
  /** Whether the camera is in the overview tier (no card DOM). */
  isOverview: () => boolean
  /** Whether a card is behind a portal that shows it smaller than the
   * overview tier's threshold ('drawn': by the canvas, not built — selected
   * and moved, not opened), behind one that shows it larger ('built', at
   * whatever tier the board is in), or the board's own (null) (canvas.ts's
   * `drawnPortals`). */
  portalTierOf: (id: NodeId) => 'drawn' | 'built' | null
  /** The topmost such card at a world point — a press there is on it,
   * though it has no element — or null. */
  drawnCardAt: (point: ScreenPoint) => NodeId | null

  // -- committing -------------------------------------------------------
  /** A content change: one undo step, and a save. */
  applyBoardChange: (next: Board, historyKey?: string) => void
  /** A change nobody would undo one notch at a time (where a card is being
   * read): written and saved, not recorded. */
  commitWithoutHistory: (next: Board) => void

  // -- selection --------------------------------------------------------
  getSelectedIds: () => ReadonlySet<NodeId>
  getSelectedEdgeIds: () => ReadonlySet<EdgeId>
  /** The lone selected card, or null. */
  getFocusedNodeId: () => NodeId | null
  setSelection: (ids: readonly NodeId[]) => void
  setEdgeSelection: (ids: readonly EdgeId[]) => void
  clearSelection: () => void

  // -- the view ---------------------------------------------------------
  getView: () => CanvasView
  /** The viewport in world coordinates, grown by `buffer` screen pixels on
   * every side (default: the virtualization buffer). */
  worldViewportRect: (buffer?: number) => WorldRect
  /** Where a pointer event — or any client point — is on the board. */
  worldPointFromEvent: (
    e: Readonly<{ clientX: number; clientY: number }>,
  ) => ScreenPoint
  /** A mounted card's runtime (element, body, readers), or undefined. */
  getRuntime: (id: NodeId) => NodeRuntime | undefined
  /** Re-decides which cards are mounted after geometry changed. */
  recomputeVisibility: () => void
  /** Mounts/unmounts what the last recompute queued, now. */
  drainQueues: () => void

  /** Where an open portal is looking and at what scale (domain/portals.ts's
   * `view`, or the default it stands for), and `unit`: what one world unit
   * behind it measures on this board — its scale times every portal's it is
   * behind. Null for anything else. */
  portalViewOf: (
    id: NodeId,
  ) => Readonly<{ x: number; y: number; scale: number; unit: number }> | null
  /** The open portal a world point is seen through — the innermost one —
   * or null where it is on the board's own. */
  portalAtPoint: (point: ScreenPoint) => NodeId | null
  /** Points an open portal at `view` (its board's own coordinates), as one
   * step of the history `historyKey` names. */
  lookThroughPortal: (id: NodeId, view: PortalView, historyKey: string) => void
  /** The portal a zoom at a world point zooms the inside of — the selected
   * one, when the point is in its frame — or null, where the board zooms. */
  zoomablePortalAt: (point: ScreenPoint) => NodeId | null
  /** Where portal `id` looks once what it showed at `looking` (a
   * `portalViewOf`) is seen at `toScale(seen)` screen pixels to a unit —
   * kept to the range a zoom in it has — with what was at world point
   * `from` now at `to`. */
  portalViewAnchored: (
    id: NodeId,
    looking: Readonly<{ x: number; y: number; scale: number; unit: number }>,
    from: ScreenPoint,
    to: ScreenPoint,
    toScale: (seen: number) => number,
  ) => PortalView | null
  /** The topmost card at a world point, for a question the DOM cannot
   * answer — the cards behind a portal only where they show through it. A
   * portal is the board under its inside, not a thing there: it answers only
   * when `portals` asks, and only where nothing above it does. */
  cardAtPoint: (point: ScreenPoint, portals: boolean) => NodeId | null
  /** Where a card behind a portal shows through it; null for the board's
   * own. */
  clipOf: (id: NodeId) => Rect | null
  /**
   * Commits a drag of `ids` that ended at `point`: `next` is the board with
   * them moved there. A card put down inside an open portal goes to the board
   * behind it, and one put down outside every portal to this board's own
   * (domain/portals.ts's `moveToBoard`).
   */
  commitMove: (
    next: Board,
    ids: readonly NodeId[],
    point: ScreenPoint,
    historyKey?: string,
  ) => void

  // -- environment ------------------------------------------------------
  /** The board file's vault path; empty before one is loaded. */
  getSourcePath: () => string
  /** The board file a node is in: this board's, or the one behind the
   * portal it is seen through — what a card's links resolve against. */
  sourcePathOf: (id: NodeId) => string
  t: (key: string, fallback?: string) => string
  reportError: (stage: string, error: unknown) => void
}>
