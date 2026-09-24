// Pointer input on the board: which gesture a press starts, the gestures
// that are the board's own (pan, marquee, a press on a card), the hover that
// parks the handle layer, Space-to-pan, double-click and the context menu.
// The gestures that move or size cards live in ./dragGestures.ts and the
// connection drag in ./connectGesture.ts; this class holds the one gesture in
// flight and hands each move and release to whichever of them started it.
//
// Split out of `../canvas.ts` (no behaviour change). The canvas still owns the
// board, its history and the selection, and every change goes back through
// `CanvasCore`. `WhiteboardCanvas` is the only importer; this module must
// never import it back.

import type { ScreenPoint } from '../../domain/camera'
import { NODE_SIDES, edgeAtPoint } from '../../domain/edges'
import {
  type BoardNode,
  type EdgeId,
  type NodeId,
  type NodeSide,
  isPlainText,
} from '../../domain/fileFormat'
import {
  type CardRect,
  type CardSize,
  RESIZE_HANDLES,
  type ResizeHandle,
  rectOfCard,
} from '../../domain/resize'
import {
  innermostFrameAt,
  marqueeRectFromPoints,
  nodeAtPoint,
  nodesInMarquee,
} from '../../domain/selection'
import { isSpreadTitle } from '../../domain/spread'
import type { CanvasView } from '../../domain/virtualization'
import {
  CARD_BODY_LIVE_CLASS,
  EDGE_AUTO_PAN_BAND_PX,
  EDGE_AUTO_PAN_MAX_SPEED,
  EDGE_HIT_CLASS,
  EDGE_HIT_STROKE_WORLD_PX,
  EDGE_LABEL_CLASS,
  GROUP_LABEL_CLASS,
  PAN_FLING_MAX_IDLE_MS,
  PAN_FLING_MIN_SPEED,
  PAN_FLING_SAMPLE_MS,
} from '../constants'
import { asElement } from '../eventTarget'

import type { CameraController } from './cameraController'
import type { CardGeneration } from './cardGeneration'
import { ConnectGesture, type ConnectInteraction } from './connectGesture'
import type { CanvasCore } from './core'
import {
  type CreateInteraction,
  DragGestures,
  type NodeInteraction,
  type ResizeInteraction,
  isSoleSelection,
} from './dragGestures'
import type { DropImport } from './dropImport'
import type { EdgeLayer } from './edgeLayer'
import type { EditingController } from './editingController'
import { isTypingIntoField } from './keymapController'
import type { PdfIntegration } from './pdfIntegration'
import type { SnapGuideLayer } from './snapGuideLayer'
import type { ToolbarController } from './toolbarController'

/** On the pan capture while Space is held: it takes the pointer over the whole
 * viewport and shows the grab cursor, so a left press anywhere is a pan. */
const PAN_CAPTURE_ARMED_CLASS = 'yolo-whiteboard-pan-capture-armed'
const INTERACTION_LAYER_CLASS = 'yolo-whiteboard-interaction-layer'
const INTERACTION_LAYER_HIDDEN_CLASS =
  'yolo-whiteboard-interaction-layer-hidden'
/** On the handle layer while it is parked on bare text. */
const INTERACTION_LAYER_TEXT_CLASS = 'yolo-whiteboard-interaction-layer-text'
/** On the layer while it is parked on something whose size is not the user's
 * to change — a PDF spread's title or sheet (domain/spread.ts): no resize
 * handles, only the connection points. */
const INTERACTION_LAYER_FIXED_CLASS = 'yolo-whiteboard-interaction-layer-fixed'
const RESIZER_CLASS = 'yolo-whiteboard-resizer'
const CONNECTION_POINT_CLASS = 'yolo-whiteboard-connection-point'
const MARQUEE_CLASS = 'yolo-whiteboard-marquee'
/** On the group frame the pointer is inside, when it is on nothing else there:
 * the frame is pointer-transparent (styles/cards/group.css), so this is how it
 * says it is a thing — and that its label is where it is picked up. */
const GROUP_HINTED_CLASS = 'yolo-whiteboard-group-hinted'
/** On the card the pointer is over — the same state that parks the handle
 * layer on it (`hoveredNodeId`), shown on the card itself. */
const CARD_HOVERED_CLASS = 'yolo-whiteboard-card-hovered'
/** On a card while the pointer is over something in its content a click
 * opens — a comment dot on a PDF card not entered, a link into a PDF — or a
 * press takes hold of — an annotation on a PDF card not entered
 * (PdfIntegration's `contentAffordanceAt`). */
const CARD_OVER_OPENABLE_CLASS = 'yolo-whiteboard-card-over-openable'
const CARD_OVER_GRABBABLE_CLASS = 'yolo-whiteboard-card-over-grabbable'

// -- pointer interaction state --------------------------------------------
// One of three mutually-exclusive gestures a left-button (or middle-button)
// press can start, decided at pointerdown by where it landed (`onPointerDown`
// below): panning the camera, marquee-selecting cards, or
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
  /** Where the pointer has recently been, newest last — what the fling the
   * pan ends with is measured from (`finishPan`). Trimmed to the sampling
   * window as it grows. */
  samples: { t: number; x: number; y: number }[]
}>

/**
 * Two fingers on the board: pan and zoom at once (CameraController's
 * `updatePinch`). Both pointers are the gesture's; their live positions are in
 * `touchPoints`, which every touch move keeps current, and the frame reads.
 */
type PinchInteraction = Readonly<{
  kind: 'pinch'
  pointerId: number
  otherPointerId: number
  origin: CanvasView
  /** The viewport's top-left in client coordinates, taken once: the viewport
   * does not move under a gesture. */
  viewportOrigin: ScreenPoint
  startMid: ScreenPoint
  startDistance: number
}>

/** The band's origin is kept in world coordinates, not on screen: a marquee
 * held against the viewport's edge pans the board (auto-pan), and the corner
 * it started from has to travel with the board rather than stay pinned to the
 * glass. Only the moving corner is a screen point. */
type MarqueeInteraction = Readonly<{
  kind: 'marquee'
  pointerId: number
  originWorld: ScreenPoint
  /** Shift was held at press: the band adds to the selection rather than
   * replacing it, and `baseIds` is what it adds to. Snapshotted here because
   * the live selection is cleared as the band is drawn. */
  additive: boolean
  baseIds: readonly NodeId[]
}>

export type Interaction =
  | PanInteraction
  | PinchInteraction
  | MarqueeInteraction
  | NodeInteraction
  | ResizeInteraction
  | ConnectInteraction
  | CreateInteraction

/**
 * The shared handle layer: the eight resize handles, with the four side ones
 * carrying the connection point for that side. Built once per world layer and
 * reused, mounted last so it sits above every card, and parked (hidden) until
 * the pointer is actually on a card.
 */
export function buildInteractionLayer(doc: Document): HTMLElement {
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
  return interactionLayer
}

/** Matched on the data attribute rather than on a class, because both
 * kinds of mounted node carry it (a card and a group frame) and every
 * gesture that asks "which node is this" means either. */
/** A spread's title is as wide as its name and a sheet as big as its page:
 * neither is resized by hand. */
function isFixedSize(node: BoardNode | undefined): boolean {
  return node?.type === 'pdf-page' || isSpreadTitle(node)
}

export function nodeIdFromEventTarget(
  target: EventTarget | null,
): NodeId | null {
  const el = asElement(target)
  if (el === null) return null
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Element.closest()'s generic return type defaults to `Element` here (no type argument to infer it from); the assertion is required for `.dataset` below to type-check under tsc even though this lint rule's own type resolution disagrees.
  const nodeEl = el.closest('[data-node-id]') as HTMLElement | null
  return nodeEl?.dataset.nodeId ?? null
}

export type InteractionControllerDeps = Readonly<{
  core: CanvasCore
  viewportEl: HTMLElement
  worldEl: HTMLElement
  /** The element a pan captures the pointer on (see CameraController). */
  panCaptureEl: HTMLElement
  /** From `buildInteractionLayer`, already in the world layer. */
  interactionLayerEl: HTMLElement
  /** The connection preview path in the edges `<svg>`. */
  previewPathEl: SVGPathElement
  getNodesById: () => ReadonlyMap<NodeId, BoardNode>
  camera: Pick<
    CameraController,
    | 'beginPan'
    | 'updatePan'
    | 'finishPan'
    | 'fling'
    | 'panBy'
    | 'updatePinch'
    | 'finishPinch'
    | 'viewportPointFromEvent'
  >
  edges: Pick<EdgeLayer, 'redrawEdgesForNodes' | 'setEdgeHidden'>
  snapGuides: SnapGuideLayer
  toolbar: Pick<
    ToolbarController,
    'isOverlayTarget' | 'closePopover' | 'setToolbarSuppressed'
  >
  editing: Pick<
    EditingController,
    | 'isEditing'
    | 'isRenaming'
    | 'beginRename'
    | 'editCard'
    | 'enterEditMode'
    | 'isEditableNode'
  >
  generation: Pick<CardGeneration, 'isGenerating' | 'stop'>
  menus: Pick<
    DropImport,
    | 'createTextAt'
    | 'canvasMenuItems'
    | 'selectionMenuItems'
    | 'viewportCenterWorld'
  >
  pdf: Pick<
    PdfIntegration,
    | 'panelContains'
    | 'followPdfLinkAt'
    | 'grabAnnotationAt'
    | 'contentAffordanceAt'
    | 'hoverNoteAt'
  >
  /** Exempts a card from virtualization unmount while a gesture holds it. */
  pin: (id: NodeId) => void
  unpin: (id: NodeId) => void
  /** Owes a card a content build on a later frame. */
  queueContentSync: (id: NodeId) => void
  /** The live geometry of a drag or resize changed (see `liveNodeRects`). */
  onLiveRectsChange: () => void
  /** The card under the pointer changed (or there is none). */
  onHoverChange: (nodeId: NodeId | null) => void
  rebuildEdgesSvg: () => void
}>

export class InteractionController {
  private readonly core: CanvasCore
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
  /** Space is held on this board: a left press pans, like a middle press. */
  private spacePanArmed = false
  private marqueeEl: HTMLElement | null = null

  // Resize: one shared handle layer for the whole board, parked over
  // whichever card the pointer is on, rather than eight handles per mounted
  // card — at a few hundred mounted cards that would be thousands of nodes
  // that only ever matter for one of them. Obsidian Canvas's own
  // `.canvas-node-interaction-layer` works the same way.
  private hoveredNodeId: NodeId | null = null
  /** The card the layer is currently parked on — `interactionLayerTarget()`
   * as last applied, which is what a press on a handle resizes. */
  private layerNodeId: NodeId | null = null

  private readonly drag: DragGestures
  private readonly connect: ConnectGesture

  /** Every touch contact on the viewport, by pointer id, in client
   * coordinates — what a pinch reads its two fingers from. */
  private readonly touchPoints = new Map<number, ScreenPoint>()
  /** The group frame currently hinted (`GROUP_HINTED_CLASS`), or null. */
  private hintedGroupId: NodeId | null = null

  /**
   * Edge auto-pan's state for the gesture in flight. `lastEvent` is the
   * gesture's newest pointer event, re-applied every frame the board moves so
   * the gesture follows the camera even when the hand holds still. `armed`
   * waits for the pointer to have been clear of the band once: a gesture that
   * *starts* in it — a card pulled off the creation bar at the bottom edge, a
   * card pressed near the side — has not asked to be carried anywhere yet.
   */
  private autoPan: {
    lastEvent: PointerEvent
    armed: boolean
    lastFrameAt: number | null
  } | null = null

  constructor(private readonly deps: InteractionControllerDeps) {
    this.core = deps.core
    const begin = (interaction: Interaction) => {
      this.interaction = interaction
    }
    const getLayerNodeId = () => this.layerNodeId
    this.drag = new DragGestures({
      core: deps.core,
      viewportEl: deps.viewportEl,
      worldEl: deps.worldEl,
      camera: deps.camera,
      edges: deps.edges,
      snapGuides: deps.snapGuides,
      pin: deps.pin,
      unpin: deps.unpin,
      queueContentSync: deps.queueContentSync,
      onLiveRectsChange: deps.onLiveRectsChange,
      followPdfLinkAt: (id, e) => deps.pdf.followPdfLinkAt(id, e),
      rebuildEdgesSvg: deps.rebuildEdgesSvg,
      openOnSecondClick: (id) => {
        // Written into by a generation: the text is the stream's until it
        // settles, and a click is not asking to stop it.
        if (deps.generation.isGenerating(id)) return false
        return deps.editing.editCard(id)
      },
      viewportCenterWorld: () => deps.menus.viewportCenterWorld(),
      begin,
      getLayerNodeId,
      placeLayer: (rect) => this.placeInteractionLayer(rect),
      refreshLayer: () => this.refreshInteractionLayer(),
    })
    this.connect = new ConnectGesture({
      core: deps.core,
      viewportEl: deps.viewportEl,
      previewPathEl: deps.previewPathEl,
      interactionLayerEl: deps.interactionLayerEl,
      getLayerNodeId,
      edges: deps.edges,
      begin,
      rebuildEdgesSvg: deps.rebuildEdgesSvg,
      enterEditMode: (id) => deps.editing.enterEditMode(id),
    })
  }

  /** Starts listening. The wheel is the camera's own listener, added by the
   * canvas. */
  bind(): void {
    const win = this.core.context.getWindow()
    this.deps.viewportEl.addEventListener('pointerdown', this.onPointerDown)
    win.addEventListener('pointermove', this.onPointerMove)
    win.addEventListener('pointerup', this.onPointerUp)
    // A touch the browser takes back (the OS claimed the gesture, the window
    // lost it) ends whatever it was doing as a release would.
    win.addEventListener('pointercancel', this.onPointerUp)
    win.addEventListener('keyup', this.onKeyUp)
    win.addEventListener('blur', this.disarmSpacePan)
    this.deps.viewportEl.addEventListener('dblclick', this.onDoubleClick)
    this.deps.viewportEl.addEventListener('contextmenu', this.onContextMenu)
  }

  destroy(): void {
    const win = this.core.context.getWindow()
    this.deps.viewportEl.removeEventListener('pointerdown', this.onPointerDown)
    this.deps.viewportEl.removeEventListener('dblclick', this.onDoubleClick)
    this.deps.viewportEl.removeEventListener('contextmenu', this.onContextMenu)
    win.removeEventListener('pointermove', this.onPointerMove)
    win.removeEventListener('pointerup', this.onPointerUp)
    win.removeEventListener('pointercancel', this.onPointerUp)
    win.removeEventListener('keyup', this.onKeyUp)
    win.removeEventListener('blur', this.disarmSpacePan)
    this.disarmSpacePan()
  }

  /** Every card is going away: whatever gesture was in flight goes with
   * them. */
  reset(): void {
    this.interaction = null
    this.autoPan = null
    this.touchPoints.clear()
    this.hintedGroupId = null
    this.pendingPointerMove = null
    this.drag.setLiveNodeRects(null)
    this.deps.snapGuides.clear()
    this.marqueeEl?.remove()
    this.marqueeEl = null
  }

  /** Uncommitted geometry for the nodes a drag or a resize is moving, or
   * null (see `DragGestures`). */
  get liveNodeRects(): ReadonlyMap<NodeId, CardRect> | null {
    return this.drag.liveNodeRects
  }

  /** Which modifier waves alignment away, and how a shortcut is spelled. */
  onMacOS(): boolean {
    return this.drag.onMacOS()
  }

  /** A press on one of the creation bar's buttons (see `DragGestures`). */
  beginCreateDrag(
    e: PointerEvent,
    size: CardSize,
    create: (at: ScreenPoint) => void,
  ): void {
    this.drag.beginCreate(e, size, create)
    if (this.interaction?.kind === 'create') this.watchAutoPan(e)
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
  // pinch). All three gestures only ever touch `this.core.getView()` + per-element
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
    if (this.core.isParseFailed()) return
    // The toolbar and the edge-label field sit above the canvas in the same
    // viewport element these listeners are on: a press on one of them is not
    // also a press on the board behind it.
    if (this.deps.toolbar.isOverlayTarget(e.target)) return
    if (e.pointerType === 'touch') {
      this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
      // A second finger turns whatever the first one began into a pinch —
      // as long as that has not yet become something only one finger can
      // finish (a card on the move, a resize, a connection being drawn).
      if (this.touchPoints.size === 2 && this.startPinch(e)) return
    }
    // A press anywhere else dismisses the colour popover, the same way one
    // dismisses a menu.
    this.deps.toolbar.closePopover()
    const nodeId = this.nodeIdAtPointer(e)

    if (e.button === 1 || (e.button === 0 && this.spacePanArmed)) {
      // Middle-click always pans, even starting from a card; so does a left
      // press while Space is held.
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
    if (side !== null && this.connect.start(side, e)) {
      this.watchAutoPan(e)
      return
    }
    const handle = this.resizeHandleFromEventTarget(e.target)
    if (
      handle !== null &&
      !isFixedSize(this.core.getNode(this.layerNodeId ?? '')) &&
      this.drag.startResize(handle, e)
    ) {
      this.watchAutoPan(e)
      return
    }

    if (nodeId !== null) {
      // The card currently being edited owns its own pointer handling
      // (native text selection/cursor placement inside its CM6 editor) —
      // don't intercept. A group whose label is being renamed owns it for the
      // same reason: that label is the only part of a group a press can
      // reach, and while it holds the caret a press in it places the caret.
      if (this.deps.editing.isEditing(nodeId)) return
      if (this.deps.editing.isRenaming({ kind: 'group', id: nodeId })) return
      // Same rule for a body the content mask has been lifted from: a press
      // that reached a media element or an embedded page belongs to it, and
      // the pointer capture below would take the rest of the gesture away
      // from the transport control being dragged. (Obsidian Canvas gets there
      // differently — it never captures the pointer, tracking the drag on the
      // window instead — but arrives at the same place: content that is live
      // stays usable.) The card's title row remains its drag handle.
      if (this.isLiveContentTarget(e.target)) return
      // An annotation on a PDF card not entered is taken by the press — the
      // card entered under it — rather than the card: dragged, it comes out;
      // clicked, it opens. Shift still adds the card to the selection.
      if (!e.shiftKey && this.deps.pdf.grabAnnotationAt(nodeId, e)) {
        e.preventDefault()
        return
      }
      this.interaction = {
        kind: 'card',
        pointerId: e.pointerId,
        nodeId,
        startClient: { x: e.clientX, y: e.clientY },
        startWorld: this.core.worldPointFromEvent(e),
        additive: e.shiftKey,
        wasSoleSelection: isSoleSelection(this.core.getSelectedIds(), nodeId),
        dragging: false,
        ids: [],
        startPositions: new Map(),
        snapCandidates: [],
      }
      this.deps.viewportEl.setPointerCapture(e.pointerId)
      this.watchAutoPan(e)
      return
    }

    // Edges paint behind the cards, so a press only reaches one where no
    // card covers it — which is exactly where pressing it can mean the edge.
    const edgeId = this.edgeIdAtPointer(e)
    if (edgeId !== null) {
      // Its label is being typed: a press in it places the caret, the same
      // rule a group being renamed follows above.
      if (this.deps.editing.isRenaming({ kind: 'edge', id: edgeId })) return
      if (this.connect.startEdgeReattach(edgeId, e)) {
        this.watchAutoPan(e)
        return
      }
    }

    // A finger on empty board moves the board — the one-finger gesture every
    // touch canvas has, and the only way to pan one with no keyboard. The
    // band selection it would otherwise start is what a mouse is for.
    if (e.altKey || e.pointerType === 'touch') {
      this.startPan(e)
      return
    }

    this.startMarquee(e)
  }

  /** Converts the gesture in flight into a two-finger pinch, when it is still
   * one a second finger may take over. */
  private startPinch(e: PointerEvent): boolean {
    const current = this.interaction
    const convertible =
      current === null ||
      current.kind === 'pan' ||
      current.kind === 'marquee' ||
      (current.kind === 'card' && !current.dragging)
    if (!convertible || current === null) return false
    if (current.kind === 'marquee') {
      this.marqueeEl?.remove()
      this.marqueeEl = null
    }
    const first = this.touchPoints.get(current.pointerId)
    if (!first) return false
    const second = { x: e.clientX, y: e.clientY }
    const rect = this.deps.viewportEl.getBoundingClientRect()
    const viewportOrigin = { x: rect.left, y: rect.top }
    this.interaction = {
      kind: 'pinch',
      pointerId: current.pointerId,
      otherPointerId: e.pointerId,
      origin: { ...this.core.getView() },
      viewportOrigin,
      startMid: midpoint(first, second, viewportOrigin),
      startDistance: Math.hypot(second.x - first.x, second.y - first.y),
    }
    this.autoPan = null
    this.deps.viewportEl.setPointerCapture(e.pointerId)
    return true
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
    if (this.core.isParseFailed()) return
    const target = this.pressedTarget
    if (this.deps.toolbar.isOverlayTarget(target)) return
    // A group's label is the one part of a group a pointer can reach (the
    // frame itself is pointer-transparent — see style.css), and double-clicking
    // it renames the group. Obsidian Canvas puts the same gesture on the same
    // element, wiring its label's `dblclick` straight to `focusLabel`.
    const groupId = this.groupLabelIdFromEventTarget(target)
    if (groupId !== null) {
      this.deps.editing.beginRename({ kind: 'group', id: groupId })
      return
    }
    // An edge carries its label on the line, so the line is where one asks
    // for it — the same gesture the toolbar's "label" button performs.
    const edgeId = this.edgeIdFromEventTarget(target)
    if (edgeId !== null) {
      this.deps.editing.beginRename({ kind: 'edge', id: edgeId })
      return
    }
    const world = this.core.worldPointFromEvent(e)
    // Geometry first, DOM second: the interaction layer stands in front of
    // the card it is parked on, so a double-click over a resize handle or a
    // connection point names the layer and only the point resolves it; and a
    // card's title hangs above its frame, outside the rect geometry knows
    // about, so only the DOM resolves that.
    const nodeId =
      nodeAtPoint(this.core.getCardNodes(), world) ??
      nodeIdFromEventTarget(target)
    if (nodeId !== null) {
      // Inside the editor this is a word selection, not a request to open
      // what is already open.
      if (this.deps.editing.isEditing(nodeId)) return
      // A card being generated into has its text in the DOM and its body
      // under the stream; asking to type in it is asking to stop. The
      // editor opens on what has arrived, from `endCardGeneration`.
      if (this.deps.generation.isGenerating(nodeId)) {
        this.deps.generation.stop(nodeId, { edit: true })
        return
      }
      this.deps.editing.editCard(nodeId)
      return
    }
    // Creating is what a double-click on *nothing* means, so it needs the
    // press to have landed on the board itself — Obsidian Canvas's own guard
    // (`if (e.targetNode !== this.wrapperEl) return`). Without it every
    // element this method declined to handle would fall through to creating
    // a stray card.
    if (target !== this.deps.viewportEl && target !== this.deps.worldEl) return
    this.deps.menus.createTextAt(world)
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.core.isParseFailed()) return
    if (this.deps.toolbar.isOverlayTarget(e.target)) return
    const nodeId = this.nodeIdAtPointer(e)
    // The card being edited owns its own context menu (CM6's, with the text
    // actions that belong to an editor).
    if (nodeId !== null && this.deps.editing.isEditing(nodeId)) return
    e.preventDefault()

    if (nodeId === null) {
      this.core.host.ui.showMenu(
        e,
        this.deps.menus.canvasMenuItems(this.core.worldPointFromEvent(e)),
      )
      return
    }

    const card = this.core.getNode(nodeId)
    if (!card) return
    // A right-click on a card that is already part of the selection acts on
    // the whole selection; on one that is not, it takes over the selection
    // first, so what the menu will do is what the user can see is selected.
    if (!this.core.getSelectedIds().has(nodeId))
      this.core.setSelection([nodeId])
    this.core.host.ui.showMenu(e, this.deps.menus.selectionMenuItems())
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
    if (this.touchPoints.has(e.pointerId)) {
      this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    const interaction = this.interaction
    // A pinch is both of its fingers' gesture; either one moving is a reason
    // to redraw it, from the positions just recorded above.
    if (
      interaction?.kind === 'pinch' &&
      (e.pointerId === interaction.pointerId ||
        e.pointerId === interaction.otherPointerId)
    ) {
      this.pendingPointerMove = e
      return
    }
    // While a gesture is in flight the slot is that gesture's: a second
    // pointer (a finger, a pen) reports its own moves, and the one slot would
    // otherwise hand the drag whichever pointer moved last. With none in
    // flight every pointer is a candidate for the hover.
    if (interaction !== null && e.pointerId !== interaction.pointerId) return
    this.pendingPointerMove = e
    if (interaction !== null && this.autoPan !== null) {
      this.autoPan.lastEvent = e
    }
  }

  /** Applies the latest pointer position to the gesture in flight, or — when
   * there is none — to the hover. Called once per frame, and again from
   * `onPointerUp` so the gesture's last position is never left unapplied when
   * it commits. */
  consumePointerMove(): void {
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
    this.deps.toolbar.setToolbarSuppressed(true)
    this.deps.pdf.hoverNoteAt(null, e)
    switch (interaction.kind) {
      case 'pan':
        this.updatePan(interaction, e)
        break
      case 'pinch':
        this.updatePinch(interaction)
        break
      case 'marquee':
        this.updateMarquee(interaction, e)
        break
      case 'card':
        this.drag.updateNode(interaction, e)
        break
      case 'resize':
        this.drag.updateResize(interaction, e)
        break
      case 'connect':
        this.connect.update(interaction, e)
        break
      case 'create':
        this.drag.updateCreate(interaction, e)
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
    if (this.core.isParseFailed()) return
    const target = asElement(e.target)
    // The panel covers the right of the viewport; a pointer on it is not on
    // the board behind it, whatever the overview tier's geometry says.
    if (this.deps.pdf.panelContains(target)) {
      this.setHoveredNode(null)
      return
    }
    const onLayer =
      target !== null && target.closest(`.${INTERACTION_LAYER_CLASS}`) !== null
    const nodeId = onLayer ? this.hoveredNodeId : this.nodeIdAtPointer(e)
    this.setHoveredNode(nodeId)
    if (nodeId !== null) {
      const affordance = onLayer
        ? null
        : this.deps.pdf.contentAffordanceAt(nodeId, e)
      const classes = this.core.getRuntime(nodeId)?.el?.classList
      classes?.toggle(CARD_OVER_OPENABLE_CLASS, affordance === 'open')
      classes?.toggle(CARD_OVER_GRABBABLE_CLASS, affordance === 'grab')
    }
    this.deps.pdf.hoverNoteAt(onLayer ? null : nodeId, e)
    this.setHintedGroup(
      nodeId === null && !onLayer && !this.core.isOverview()
        ? innermostFrameAt(this.groupNodes(), this.core.worldPointFromEvent(e))
        : null,
    )
  }

  /** Every group on the board — what the frame hint looks for the pointer
   * in. A pass over the node list, on a coalesced hover frame. */
  private groupNodes(): BoardNode[] {
    return this.core.getBoard().nodes.filter((node) => node.type === 'group')
  }

  private setHintedGroup(id: NodeId | null): void {
    if (id === this.hintedGroupId) return
    if (this.hintedGroupId !== null) {
      this.core
        .getRuntime(this.hintedGroupId)
        ?.el?.classList.remove(GROUP_HINTED_CLASS)
    }
    this.hintedGroupId = id
    if (id !== null) {
      this.core.getRuntime(id)?.el?.classList.add(GROUP_HINTED_CLASS)
    }
  }

  /**
   * Which node a pointer event landed on.
   *
   * In the DOM tiers that is the element under it. In the overview tier the
   * cards have no elements, so the same question is asked of the board data
   * the canvas drew from — a point-in-rectangle test per card, linear over the
   * board (no spatial index; a pass over a few thousand rectangles is not
   * what costs anything here). Groups keep their DOM at
   * every tier, so they keep answering the first way.
   */
  nodeIdAtPointer(e: MouseEvent): NodeId | null {
    const fromDom = nodeIdFromEventTarget(e.target)
    if (fromDom !== null || !this.core.isOverview()) return fromDom
    return nodeAtPoint(
      this.core.getCardNodes(),
      this.core.worldPointFromEvent(e),
    )
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
    if (fromDom !== null || !this.core.isOverview()) return fromDom
    return edgeAtPoint(
      this.core.getBoard().edges,
      this.deps.getNodesById(),
      this.core.worldPointFromEvent(e),
      EDGE_HIT_STROKE_WORLD_PX / 2 / Math.sqrt(this.core.getView().scale),
    )
  }

  setHoveredNode(nodeId: NodeId | null): void {
    if (nodeId === this.hoveredNodeId) return
    if (this.hoveredNodeId !== null) {
      this.core
        .getRuntime(this.hoveredNodeId)
        ?.el?.classList.remove(
          CARD_HOVERED_CLASS,
          CARD_OVER_OPENABLE_CLASS,
          CARD_OVER_GRABBABLE_CLASS,
        )
    }
    this.hoveredNodeId = nodeId
    if (nodeId !== null) {
      this.core.getRuntime(nodeId)?.el?.classList.add(CARD_HOVERED_CLASS)
    }
    this.updateInteractionLayer()
    this.deps.onHoverChange(nodeId)
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
      (this.core.getSelectedIds().size === 1
        ? (this.core.getSelectedIds().values().next().value ?? null)
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
  updateInteractionLayer(force = false): void {
    const id = this.interactionLayerTarget()
    const card = id === null ? null : this.core.getNode(id)
    const next = card ? id : null
    if (next === this.layerNodeId && !force) return
    this.layerNodeId = next
    const layer = this.deps.interactionLayerEl
    if (!layer) return
    layer.classList.toggle(INTERACTION_LAYER_HIDDEN_CLASS, !card)
    // Bare text is resized from its sides only (styles/cards/text.css).
    layer.classList.toggle(
      INTERACTION_LAYER_TEXT_CLASS,
      isPlainText(card ?? undefined),
    )
    layer.classList.toggle(
      INTERACTION_LAYER_FIXED_CLASS,
      isFixedSize(card ?? undefined),
    )
    if (card) this.placeInteractionLayer(rectOfCard(card))
  }

  /** Re-parks the layer after something other than hover or selection moved
   * the card it is on (a drag, a board reload, a card removal). */
  refreshInteractionLayer(): void {
    this.updateInteractionLayer(true)
  }

  private placeInteractionLayer(rect: CardRect): void {
    const layer = this.deps.interactionLayerEl
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
    this.touchPoints.delete(e.pointerId)
    const interaction = this.interaction
    if (!interaction) return
    // Either finger lifting ends a pinch; the one left down starts nothing
    // until it too is lifted and pressed again.
    if (
      interaction.kind === 'pinch' &&
      e.pointerId === interaction.otherPointerId
    ) {
      this.interaction = null
      this.endGesture()
      this.deps.camera.finishPinch()
      return
    }
    // Another pointer lifting is not this gesture ending — the one that
    // started it is the one that can finish it.
    if (e.pointerId !== interaction.pointerId) return
    this.interaction = null
    this.endGesture()
    switch (interaction.kind) {
      case 'pan':
        this.finishPan(interaction, e)
        break
      case 'pinch':
        this.deps.camera.finishPinch()
        break
      case 'marquee':
        this.finishMarquee(interaction, e)
        break
      case 'card':
        this.drag.finishNode(interaction, e)
        break
      case 'resize':
        this.drag.finishResize(interaction, e)
        break
      case 'connect':
        this.connect.finish(interaction, e)
        break
      case 'create':
        this.drag.finishCreate(interaction, e)
        break
    }
  }

  /** Whatever the gesture was, it is over: nothing is lining up any more, the
   * toolbar can come back, and the board stops being carried. */
  private endGesture(): void {
    this.autoPan = null
    this.deps.snapGuides.clear()
    this.deps.toolbar.setToolbarSuppressed(false)
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
      origin: { ...this.core.getView() },
      startX: e.clientX,
      startY: e.clientY,
      samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
    }
    this.deps.camera.beginPan(e.pointerId)
  }

  private updatePan(interaction: PanInteraction, e: PointerEvent): void {
    this.deps.camera.updatePan(
      interaction.origin,
      { x: interaction.startX, y: interaction.startY },
      { x: e.clientX, y: e.clientY },
    )
    const { samples } = interaction
    samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY })
    while (
      samples.length > 2 &&
      e.timeStamp - samples[0].t > PAN_FLING_SAMPLE_MS
    ) {
      samples.shift()
    }
  }

  /**
   * Ends a pan, and throws the board if the hand was still moving when it let
   * go: the velocity over the last stretch of the drag, handed to the camera's
   * fling. A hand that had stopped — slower than the floor, or held still
   * before lifting — puts the board down where it is.
   */
  private finishPan(interaction: PanInteraction, e: PointerEvent): void {
    this.deps.camera.finishPan()
    const { samples } = interaction
    const last = samples[samples.length - 1]
    const first = samples.find(
      (sample) => last.t - sample.t <= PAN_FLING_SAMPLE_MS,
    )
    if (!first || first === last) return
    if (e.timeStamp - last.t > PAN_FLING_MAX_IDLE_MS) return
    const dt = last.t - first.t
    if (dt <= 0) return
    const vx = (last.x - first.x) / dt
    const vy = (last.y - first.y) / dt
    if (Math.hypot(vx, vy) < PAN_FLING_MIN_SPEED) return
    this.deps.camera.fling(vx, vy)
  }

  private updatePinch(interaction: PinchInteraction): void {
    const a = this.touchPoints.get(interaction.pointerId)
    const b = this.touchPoints.get(interaction.otherPointerId)
    if (!a || !b) return
    this.deps.camera.updatePinch(
      interaction.origin,
      interaction.startMid,
      interaction.startDistance,
      midpoint(a, b, interaction.viewportOrigin),
      Math.hypot(b.x - a.x, b.y - a.y),
    )
  }

  // -----------------------------------------------------------------------
  // Edge auto-pan. A drag that reaches the viewport's edge — a card, a band,
  // a connection, a card coming off the creation bar, a resize — carries the
  // board along with it, faster the deeper into the band along the edge it
  // goes. Driven from the frame loop, not from pointer moves, because the
  // point is that the board keeps moving while the hand holds still at the
  // edge; each frame it moves, the gesture is re-applied from its newest
  // pointer event against the camera it has just moved to (every gesture
  // measures in world coordinates for exactly this).
  // -----------------------------------------------------------------------

  /** Advances the auto-pan by one frame. Called by the canvas's frame loop,
   * before the frame's pointer move is consumed. */
  advanceAutoPan(now: number): void {
    const state = this.autoPan
    const interaction = this.interaction
    if (!state || !interaction || !this.carriesBoard(interaction)) {
      if (state) state.lastFrameAt = null
      return
    }
    const local = this.deps.camera.viewportPointFromEvent(state.lastEvent)
    const width = this.deps.viewportEl.clientWidth
    const height = this.deps.viewportEl.clientHeight
    const push = (distance: number) =>
      Math.min(
        1,
        Math.max(0, (EDGE_AUTO_PAN_BAND_PX - distance) / EDGE_AUTO_PAN_BAND_PX),
      )
    const x = push(local.x) - push(width - local.x)
    const y = push(local.y) - push(height - local.y)
    if (x === 0 && y === 0) {
      state.armed = true
      state.lastFrameAt = null
      return
    }
    if (!state.armed) return
    const elapsed =
      state.lastFrameAt === null ? 16.7 : Math.min(now - state.lastFrameAt, 50)
    state.lastFrameAt = now
    const step = EDGE_AUTO_PAN_MAX_SPEED * elapsed
    this.deps.camera.panBy(x * step, y * step)
    // The hand has not moved, but what is under it has: the gesture is
    // re-applied as if it had, unless a real move is already waiting.
    this.pendingPointerMove ??= state.lastEvent
  }

  /** Whether the gesture in flight is one the board is carried along by —
   * the ones that are moving something, once they are. */
  private carriesBoard(interaction: Interaction): boolean {
    switch (interaction.kind) {
      case 'marquee':
        return true
      case 'card':
      case 'resize':
      case 'connect':
      case 'create':
        return interaction.dragging
      case 'pan':
      case 'pinch':
        return false
    }
  }

  /** Starts watching the gesture just begun for the viewport's edge. */
  private watchAutoPan(e: PointerEvent): void {
    this.autoPan = { lastEvent: e, armed: false, lastFrameAt: null }
  }

  // -----------------------------------------------------------------------
  // Marquee selection (left-drag from empty canvas). The overlay div lives
  // in the *viewport* layer (a sibling of the scaled/panned world layer),
  // so it's drawn in plain screen coordinates and never needs to account
  // for the camera transform itself — only its two corner points get
  // converted to world space, once, at pointerup (rather than a live
  // per-move highlight — repainting a dashed-rectangle overlay already gives
  // the user drag feedback, and hit-testing every card on every pointermove
  // has no payoff).
  // -----------------------------------------------------------------------

  private startMarquee(e: PointerEvent): void {
    this.interaction = {
      kind: 'marquee',
      pointerId: e.pointerId,
      originWorld: this.core.worldPointFromEvent(e),
      additive: e.shiftKey,
      baseIds: Array.from(this.core.getSelectedIds()),
    }
    this.deps.viewportEl.setPointerCapture(e.pointerId)
    const doc = this.core.context.getDocument()
    const el = doc.createElement('div')
    el.className = MARQUEE_CLASS
    this.deps.viewportEl.appendChild(el)
    this.marqueeEl = el
    const local = this.deps.camera.viewportPointFromEvent(e)
    this.applyMarqueeRect(local, local)
    this.watchAutoPan(e)
  }

  /** Where the band's fixed corner is on screen now — wherever the camera has
   * carried it since the press. */
  private marqueeOriginOnScreen(interaction: MarqueeInteraction): ScreenPoint {
    const { tx, ty, scale } = this.core.getView()
    return {
      x: interaction.originWorld.x * scale + tx,
      y: interaction.originWorld.y * scale + ty,
    }
  }

  private updateMarquee(
    interaction: MarqueeInteraction,
    e: PointerEvent,
  ): void {
    this.applyMarqueeRect(
      this.marqueeOriginOnScreen(interaction),
      this.deps.camera.viewportPointFromEvent(e),
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
    this.marqueeEl?.remove()
    this.marqueeEl = null
    const worldA = interaction.originWorld
    const worldB = this.core.worldPointFromEvent(e)
    // A zero-size marquee (a plain click on empty canvas, no movement)
    // naturally selects nothing here, subsuming "click empty clears
    // selection" without a separate code path. Edges are not marquee-
    // selectable (a band drawn across the canvas is about the cards it
    // covers), but a marquee still ends whatever edge selection was up.
    this.core.setEdgeSelection([])
    const hits = nodesInMarquee(
      this.core.getBoard().nodes,
      marqueeRectFromPoints(worldA, worldB),
    )
    // Shift makes the band add rather than replace — a union, not a toggle:
    // dragging over something already selected must not deselect it, or a
    // second band drawn across the same area would undo the first.
    this.core.setSelection(
      interaction.additive ? [...interaction.baseIds, ...hits] : hits,
    )
  }

  /** The handle a press landed on, or null if it landed anywhere else. */
  private resizeHandleFromEventTarget(
    target: EventTarget | null,
  ): ResizeHandle | null {
    const el = asElement(target)
    if (!el?.classList.contains(RESIZER_CLASS)) return null
    const handle = (el as HTMLElement).dataset.resize
    return RESIZE_HANDLES.find((candidate) => candidate === handle) ?? null
  }

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

  // -----------------------------------------------------------------------
  // Space + left drag pans, the whiteboard convention (Obsidian Canvas,
  // Figma, Excalidraw) for everyone without a middle button to spare.
  //
  // Pressing Space is a keymap binding, so it only arms on the active board
  // and in whichever window it lives in. Releasing it is not something a
  // keymap can say — Obsidian's scopes see keydown only — so the release is a
  // `keyup` on this view's own window, plus `blur` for a release that
  // happens while the window is not listening.
  // -----------------------------------------------------------------------

  readonly armSpacePan = (): boolean => {
    // A space typed into something is a space.
    if (isTypingIntoField(this.core.context.getDocument())) return false
    // Consumed even while already armed: the key auto-repeats, and each
    // repeat left through would scroll whatever Obsidian scrolls on Space.
    if (!this.spacePanArmed) {
      this.spacePanArmed = true
      this.deps.panCaptureEl.classList.add(PAN_CAPTURE_ARMED_CLASS)
    }
    return true
  }

  private readonly disarmSpacePan = (): void => {
    if (!this.spacePanArmed) return
    this.spacePanArmed = false
    this.deps.panCaptureEl.classList.remove(PAN_CAPTURE_ARMED_CLASS)
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space' || e.key === ' ') this.disarmSpacePan()
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
    return nodeIdFromEventTarget(el)
  }
}

/** The midpoint of two client points, in viewport-local coordinates. */
function midpoint(
  a: ScreenPoint,
  b: ScreenPoint,
  viewportOrigin: ScreenPoint,
): ScreenPoint {
  return {
    x: (a.x + b.x) / 2 - viewportOrigin.x,
    y: (a.y + b.y) / 2 - viewportOrigin.y,
  }
}
