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
} from '../../domain/fileFormat'
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
  worldPointFromEvent: (e: MouseEvent) => ScreenPoint
  /** A mounted card's runtime (element, body, readers), or undefined. */
  getRuntime: (id: NodeId) => NodeRuntime | undefined
  /** Re-decides which cards are mounted after geometry changed. */
  recomputeVisibility: () => void
  /** Mounts/unmounts what the last recompute queued, now. */
  drainQueues: () => void

  // -- environment ------------------------------------------------------
  /** The board file's vault path; empty before one is loaded. */
  getSourcePath: () => string
  t: (key: string, fallback?: string) => string
  reportError: (stage: string, error: unknown) => void
}>
