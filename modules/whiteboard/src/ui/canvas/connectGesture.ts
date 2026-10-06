// Connections: drag a card's connection point to another card to wire
// them up, or drag an existing edge's endpoint to re-wire it
// ("锚定边默认按两卡相对位置自动选，拖动连线端点可手动改").
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
//
// Split out of `../canvas.ts` (no behaviour change). `InteractionController`
// runs this gesture and is its only importer; this module must never import
// the canvas.

import { distanceBetween } from '../../domain/camera'
import type { ScreenPoint } from '../../domain/camera'
import {
  type PassagePlacement,
  type SideAnchor,
  anchorEdgeEnd,
  buildEdge,
  buildEdgePathD,
  computeEdgeGeometry,
  findConnectTarget,
  oppositeSide,
  rectAnchoredAt,
  resolveEdgeEnds,
} from '../../domain/edges'
import type {
  Edge,
  EdgeAnchor,
  EdgeId,
  NodeId,
  NodeSide,
  TextNode,
} from '../../domain/fileFormat'
import { addEdge, addNode, updateEdge } from '../../domain/operations'
import type { VirtualCardRect } from '../../domain/virtualization'
import {
  CONNECT_SNAP_WORLD_PX,
  DRAG_THRESHOLD_PX,
  EDGE_HIDDEN_CLASS,
  NEW_CARD_SIZE,
} from '../constants'

import type { CanvasCore } from './core'
import { isSoleSelection } from './dragGestures'
import type { EdgeLayer } from './edgeLayer'
import type { PassageSource } from './passagePoints'

const CARD_CONNECT_TARGET_CLASS = 'yolo-whiteboard-card-connect-target'

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
export type ConnectInteraction = {
  readonly kind: 'connect'
  readonly pointerId: number
  /** The end that stays put, and the side it is anchored to. */
  readonly anchor: SideAnchor
  /** The passage inside its card the end that stays put reaches, when it
   * reaches one: a connection pulled out of a passage's points, or an edge
   * re-attached by its other end. */
  readonly passage: EdgeAnchor | null
  /** Which end of the edge is following the pointer. A new edge always
   * drags its `to` end — you pull the arrow out towards where it points. */
  readonly movingEnd: 'from' | 'to'
  /** The edge being re-attached, or null when this drag is creating one. */
  readonly edgeId: EdgeId | null
  readonly startClient: ScreenPoint
  readonly candidates: readonly VirtualCardRect[]
  /** As a card press's: a connection point that is clicked rather than
   * dragged is clicking the card it belongs to. Always false for an edge. */
  readonly wasSoleSelection: boolean
  dragging: boolean
  target: SideAnchor | null
  /** The passage inside `target` the moving end would reach if let go now:
   * the paragraph under the pointer, or a passage selected there before —
   * null for the whole card. */
  targetPassage: EdgeAnchor | null
}

export type ConnectGestureDeps = Readonly<{
  core: CanvasCore
  viewportEl: HTMLElement
  /** The in-flight connection's curve. A sibling of the edges group rather
   * than a child, so `rebuildEdgesSvg`'s wholesale replaceChildren never
   * takes it out from under a live gesture. */
  previewPathEl: SVGPathElement
  /** The preview's runs on over a card to the passage an end reaches, over
   * the cards where the curve is under them (as EdgeLayer draws an edge's). */
  previewRunEls: Readonly<{ start: SVGPathElement; end: SVGPathElement }>
  /** The handle layer, which carries the side being pulled from while the
   * drag is on. */
  interactionLayerEl: HTMLElement
  /** The card the handle layer is parked on — what a press on a connection
   * point pulls from. */
  getLayerNodeId: () => NodeId | null
  edges: Pick<EdgeLayer, 'setEdgeHidden'>
  /** Where an end reaches inside `card` now (EdgeLayer's `endPlacement`). */
  placeEnd: (
    card: VirtualCardRect,
    anchor: EdgeAnchor | undefined,
    page: number | undefined,
  ) => PassagePlacement | null
  /** Makes this the gesture in flight. */
  begin: (interaction: ConnectInteraction) => void
  rebuildEdgesSvg: () => void
  enterEditMode: (id: NodeId) => void
  /** What a click on the card means (`DragGestures.clickCard`). */
  clickCard: (id: NodeId, wasSoleSelection: boolean, e: PointerEvent) => void
  /** An edge was made or re-attached reaching these passages — the
   * selection one was pulled from may now be marked where it was read. */
  passagesConnected: (anchors: readonly EdgeAnchor[]) => void
  /** The passage of `nodeId`'s card under a client point, as its reader
   * reads it — null at once for a card that cannot say (no reader). */
  passageAt: (
    nodeId: NodeId,
    clientX: number,
    clientY: number,
  ) => Promise<EdgeAnchor | null> | null
  /** Marks the passage a let-go would reach in `nodeId`'s card, or clears
   * the mark (null). */
  showPassageHint: (nodeId: NodeId, anchor: EdgeAnchor | null) => void
  /** Scrolls `nodeId`'s card's reader by `deltaY` layout pixels; whether it
   * moved. */
  nudgeCard: (nodeId: NodeId, deltaY: number) => boolean
  /** The card's rectangle on screen, for the edges a held connection
   * scrolls it from. */
  cardClientRect: (nodeId: NodeId) => DOMRect | null
}>

/** How deep the bands along a target card's top and bottom edges are, in
 * screen pixels, where a held connection scrolls the card — capped at a
 * fifth of the card on a small one. */
const PASSAGE_SCROLL_BAND_PX = 40
/** How far a card scrolls per frame at the very edge of the band, in its
 * layout pixels; it eases in from the band's inner edge. */
const PASSAGE_SCROLL_MAX_STEP = 18

export class ConnectGesture {
  private readonly core: CanvasCore
  private connectTargetNodeId: NodeId | null = null
  /** Bumped by every passage asked for, so an answer to an older question
   * (they arrive asynchronously) is dropped. */
  private passageTicket = 0
  /** The card the passage mark is shown in. */
  private hintedNodeId: NodeId | null = null
  /** The held connection and the pointer it was last moved to, while a
   * card is being scrolled under it (`scrollFrame`). */
  private held: Readonly<{
    interaction: ConnectInteraction
    clientX: number
    clientY: number
  }> | null = null
  private scrollFrameId: number | null = null

  constructor(private readonly deps: ConnectGestureDeps) {
    this.core = deps.core
  }

  /** False when the card the layer was parked on is gone, so the caller can
   * fall through to the gesture the press would otherwise have been. */
  start(side: NodeSide, e: PointerEvent): boolean {
    if (!this.core.canEdit()) return false
    const nodeId = this.deps.getLayerNodeId()
    if (nodeId === null || this.core.getNode(nodeId) === undefined) return false
    // Same reason as startResize: a press on the layer must not blur the
    // editor of the card it is parked on.
    e.preventDefault()
    // Pointer capture moves :hover off the dot for the rest of the drag, and
    // a connection visibly starting from nothing reads as a glitch.
    if (this.deps.interactionLayerEl)
      this.deps.interactionLayerEl.dataset.connecting = side
    this.beginConnect(
      { nodeId, side },
      null,
      'to',
      null,
      isSoleSelection(this.core.getSelectedIds(), nodeId),
      e,
    )
    return true
  }

  /** A connection pulled out of a passage's points (./passagePoints.ts):
   * the edge it makes reaches that passage. */
  startFromPassage(source: PassageSource, e: PointerEvent): boolean {
    if (!this.core.canEdit()) return false
    if (this.core.getNode(source.nodeId) === undefined) return false
    // Keeps the selection the points stand for, and the card's focus.
    e.preventDefault()
    this.beginConnect(
      { nodeId: source.nodeId, side: source.side },
      source.anchor,
      'to',
      null,
      false,
      e,
    )
    return true
  }

  /**
   * A press on an edge grabs whichever of its two ends is nearer — the same
   * press that, without movement, selects it. There is no separate endpoint
   * handle to aim at: the end you meant is the one you pressed next to.
   */
  startEdgeReattach(edgeId: EdgeId, e: PointerEvent): boolean {
    const edge = this.core.getEdge(edgeId)
    const from = edge && this.core.getNode(edge.fromNode)
    const to = edge && this.core.getNode(edge.toNode)
    if (!edge || !from || !to) return false
    const ends = this.endsOf(edge, from, to)
    const geometry = computeEdgeGeometry(
      from,
      to,
      ends.fromSide,
      ends.toSide,
      ends,
    )
    const world = this.core.worldPointFromEvent(e)
    const toFrom = distanceBetween(world, geometry.start)
    const toTo = distanceBetween(world, geometry.end)
    const movingEnd = toFrom <= toTo ? 'from' : 'to'
    const anchor: SideAnchor =
      movingEnd === 'from'
        ? { nodeId: edge.toNode, side: ends.toSide }
        : { nodeId: edge.fromNode, side: ends.fromSide }
    const passage =
      (movingEnd === 'from' ? edge.toAnchor : edge.fromAnchor) ?? null
    this.beginConnect(anchor, passage, movingEnd, edgeId, false, e)
    return true
  }

  /** Where an edge's ends are drawn, passages placed (domain/edges.ts's
   * `resolveEdgeEnds`). */
  private endsOf(
    edge: Pick<
      Edge,
      'fromSide' | 'toSide' | 'fromAnchor' | 'toAnchor' | 'fromPage' | 'toPage'
    >,
    from: VirtualCardRect,
    to: VirtualCardRect,
  ) {
    return resolveEdgeEnds(edge, from, to, {
      from: this.deps.placeEnd(from, edge.fromAnchor, edge.fromPage),
      to: this.deps.placeEnd(to, edge.toAnchor, edge.toPage),
    })
  }

  private beginConnect(
    anchor: SideAnchor,
    passage: EdgeAnchor | null,
    movingEnd: 'from' | 'to',
    edgeId: EdgeId | null,
    wasSoleSelection: boolean,
    e: PointerEvent,
  ): void {
    this.deps.begin({
      kind: 'connect',
      pointerId: e.pointerId,
      anchor,
      passage,
      movingEnd,
      edgeId,
      startClient: { x: e.clientX, y: e.clientY },
      candidates: this.core
        .getBoard()
        .nodes.filter((node) => node.id !== anchor.nodeId),
      wasSoleSelection,
      dragging: false,
      target: null,
      targetPassage: null,
    })
    this.deps.viewportEl.setPointerCapture(e.pointerId)
  }

  update(interaction: ConnectInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      const dx = e.clientX - interaction.startClient.x
      const dy = e.clientY - interaction.startClient.y
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      interaction.dragging = true
      // The edge being re-attached is replaced by the preview for the
      // duration, so its old shape doesn't hang there contradicting it.
      if (interaction.edgeId !== null) {
        this.deps.edges.setEdgeHidden(interaction.edgeId, true)
      }
    }
    this.held = { interaction, clientX: e.clientX, clientY: e.clientY }
    this.retarget(interaction, e.clientX, e.clientY)
    this.syncScroll(interaction, e.clientX, e.clientY)
  }

  /**
   * What a let-go at a client point would connect to: a card, and — with the
   * pointer over its text rather than its edge band or its title — the
   * passage under the pointer, once the card's reader has said which
   * (asynchronously, the first time a page is asked about).
   */
  private retarget(
    interaction: ConnectInteraction,
    clientX: number,
    clientY: number,
  ): void {
    const world = this.core.worldPointFromEvent({ clientX, clientY })
    interaction.target = findConnectTarget(
      world,
      interaction.candidates,
      CONNECT_SNAP_WORLD_PX,
    )
    const target = interaction.target
    const card = target
      ? interaction.candidates.find((node) => node.id === target.nodeId)
      : undefined
    const inside =
      card !== undefined &&
      world.x >= card.x &&
      world.x <= card.x + card.w &&
      world.y >= card.y &&
      world.y <= card.y + card.h
    const asked =
      target && inside
        ? this.deps.passageAt(target.nodeId, clientX, clientY)
        : null
    const ticket = ++this.passageTicket
    if (!asked) {
      this.aimAt(interaction, null)
    } else {
      void asked.then(
        (passage) => {
          if (ticket !== this.passageTicket) return
          if (this.held?.interaction !== interaction) return
          this.aimAt(interaction, passage)
        },
        (error: unknown) => this.core.reportError('connect passage', error),
      )
    }
    this.drawConnectPreview(interaction, world)
  }

  /** Points the moving end at a passage of the target card, or at the
   * whole card (null): the card is lit for the whole of it, the passage
   * for a passage. */
  private aimAt(
    interaction: ConnectInteraction,
    passage: EdgeAnchor | null,
  ): void {
    interaction.targetPassage = interaction.target ? passage : null
    const nodeId = interaction.target?.nodeId ?? null
    this.setConnectTarget(passage ? null : nodeId)
    this.hint(passage && nodeId, passage)
    if (this.held?.interaction === interaction) {
      this.drawConnectPreview(
        interaction,
        this.core.worldPointFromEvent(this.held),
      )
    }
  }

  private hint(nodeId: NodeId | null, passage: EdgeAnchor | null): void {
    if (this.hintedNodeId !== null && this.hintedNodeId !== nodeId) {
      this.deps.showPassageHint(this.hintedNodeId, null)
    }
    this.hintedNodeId = nodeId
    if (nodeId !== null) this.deps.showPassageHint(nodeId, passage)
  }

  /** Starts or stops scrolling the target card under a held connection:
   * held in the band along its top or bottom edge, it scrolls that way, a
   * frame at a time, re-aiming as the text moves under the pointer. */
  private syncScroll(
    interaction: ConnectInteraction,
    clientX: number,
    clientY: number,
  ): void {
    const step = this.scrollStep(interaction, clientX, clientY)
    if (step === 0) {
      this.stopScroll()
      return
    }
    if (this.scrollFrameId !== null) return
    const win = this.core.context.getWindow()
    const tick = () => {
      this.scrollFrameId = null
      const held = this.held
      const nodeId = held?.interaction.target?.nodeId
      if (!held || !nodeId) return
      const delta = this.scrollStep(
        held.interaction,
        held.clientX,
        held.clientY,
      )
      if (delta === 0 || !this.deps.nudgeCard(nodeId, delta)) return
      this.retarget(held.interaction, held.clientX, held.clientY)
      this.scrollFrameId = win.requestAnimationFrame(tick)
    }
    this.scrollFrameId = win.requestAnimationFrame(tick)
  }

  /** How far to scroll the target card this frame — negative up — for a
   * pointer at a client point; 0 outside the bands. */
  private scrollStep(
    interaction: ConnectInteraction,
    clientX: number,
    clientY: number,
  ): number {
    const nodeId = interaction.target?.nodeId
    const rect = nodeId ? this.deps.cardClientRect(nodeId) : null
    if (!rect) return 0
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return 0
    }
    const band = Math.min(PASSAGE_SCROLL_BAND_PX, rect.height / 5)
    if (!(band > 0)) return 0
    const fromTop = clientY - rect.top
    const fromBottom = rect.bottom - clientY
    if (fromTop < band) {
      return -Math.ceil(PASSAGE_SCROLL_MAX_STEP * (1 - fromTop / band))
    }
    if (fromBottom < band) {
      return Math.ceil(PASSAGE_SCROLL_MAX_STEP * (1 - fromBottom / band))
    }
    return 0
  }

  private stopScroll(): void {
    if (this.scrollFrameId === null) return
    this.core.context.getWindow().cancelAnimationFrame(this.scrollFrameId)
    this.scrollFrameId = null
  }

  /** Lets go of everything a held connection put on screen besides its
   * curve: the passage mark, the scrolling, the pointer it follows. */
  private release(): void {
    this.passageTicket += 1
    this.held = null
    this.stopScroll()
    this.hint(null, null)
  }

  /** The in-flight curve: from the pinned end to the snapped target, or to a
   * zero-size rect at the pointer when there is nothing to snap to (whose
   * anchor point is the pointer itself, whatever side it is asked for). */
  private drawConnectPreview(
    interaction: ConnectInteraction,
    world: ScreenPoint,
  ): void {
    const preview = this.deps.previewPathEl
    const anchorCard = this.core.getNode(interaction.anchor.nodeId)
    if (!preview || !anchorCard) return
    const target = interaction.target
    const targetCard = target ? this.core.getNode(target.nodeId) : null
    const free: VirtualCardRect =
      target && targetCard
        ? targetCard
        : { id: '', x: world.x, y: world.y, w: 0, h: 0 }
    const freeSide =
      target && targetCard ? target.side : oppositeSide(interaction.anchor.side)
    const pinnedPassage = interaction.passage ?? undefined
    const freePassage =
      (target && targetCard && interaction.targetPassage) || undefined
    const pinnedIsFrom = interaction.movingEnd === 'to'
    const from = pinnedIsFrom ? anchorCard : free
    const to = pinnedIsFrom ? free : anchorCard
    const ends = this.endsOf(
      pinnedIsFrom
        ? {
            fromSide: interaction.anchor.side,
            toSide: freeSide,
            fromAnchor: pinnedPassage,
            toAnchor: freePassage,
          }
        : {
            fromSide: freeSide,
            toSide: interaction.anchor.side,
            fromAnchor: freePassage,
            toAnchor: pinnedPassage,
          },
      from,
      to,
    )
    const geometry = computeEdgeGeometry(
      from,
      to,
      ends.fromSide,
      ends.toSide,
      ends,
    )
    preview.setAttribute('d', buildEdgePathD(geometry))
    preview.classList.remove(EDGE_HIDDEN_CLASS)
    const runs = this.deps.previewRunEls
    drawPreviewRun(runs.start, geometry.start, geometry.startInner)
    drawPreviewRun(runs.end, geometry.end, geometry.endInner)
    // The arrowhead goes where the end is drawn to: on the passage when the
    // run reaches one.
    const arrow =
      preview.getAttribute('marker-end') ?? runs.end.getAttribute('marker-end')
    if (!arrow) return
    const [carrier, other] =
      geometry.endInner !== undefined
        ? [runs.end, preview]
        : [preview, runs.end]
    carrier.setAttribute('marker-end', arrow)
    other.removeAttribute('marker-end')
  }

  private hidePreview(): void {
    this.deps.previewPathEl.classList.add(EDGE_HIDDEN_CLASS)
    this.deps.previewRunEls.start.classList.add(EDGE_HIDDEN_CLASS)
    this.deps.previewRunEls.end.classList.add(EDGE_HIDDEN_CLASS)
  }

  private setConnectTarget(nodeId: NodeId | null): void {
    if (nodeId === this.connectTargetNodeId) return
    const previous = this.connectTargetNodeId
    if (previous !== null) {
      this.core
        .getRuntime(previous)
        ?.el?.classList.remove(CARD_CONNECT_TARGET_CLASS)
    }
    this.connectTargetNodeId = nodeId
    if (nodeId !== null) {
      this.core.getRuntime(nodeId)?.el?.classList.add(CARD_CONNECT_TARGET_CLASS)
    }
  }

  /** Abandons whatever connection is held, the board going away under it. */
  reset(): void {
    this.release()
    this.setConnectTarget(null)
    this.hidePreview()
  }

  finish(interaction: ConnectInteraction, e: PointerEvent): void {
    this.release()
    this.setConnectTarget(null)
    this.hidePreview()
    if (this.deps.interactionLayerEl) {
      delete this.deps.interactionLayerEl.dataset.connecting
    }
    if (interaction.edgeId !== null) {
      this.deps.edges.setEdgeHidden(interaction.edgeId, false)
    }

    if (!interaction.dragging) {
      // A press that never moved: on an edge that means selecting it, and on
      // a connection point what the same click on its card means, as on a
      // resize handle. Zoomed out, the dots are as big as a line of text and
      // sit right against it, so a click aimed at the text often lands on
      // one; meaning nothing there left the text hard to select or open.
      if (interaction.edgeId !== null) {
        this.core.setEdgeSelection([interaction.edgeId])
      } else {
        this.deps.clickCard(
          interaction.anchor.nodeId,
          interaction.wasSoleSelection,
          e,
        )
      }
      return
    }

    const created =
      interaction.target === null
        ? this.createNodeForConnection(
            interaction,
            this.core.worldPointFromEvent(e),
          )
        : null
    const target = interaction.target ?? created?.anchor
    if (!target) return

    // One history step for the whole gesture: the card
    // `createNodeForConnection` made goes onto the same board as the edge that
    // justified it, so the two are undone together.
    const board = created
      ? addNode(this.core.getBoard(), created.node)
      : this.core.getBoard()
    const typeOf = (id: NodeId) =>
      board.nodes.find((node) => node.id === id)?.type
    const landed = created
      ? undefined
      : (interaction.targetPassage ?? undefined)
    const landedPage =
      landed?.kind === 'pdf' && typeOf(target.nodeId) === 'file'
        ? landed.page
        : undefined
    this.core.applyBoardChange(
      interaction.edgeId === null
        ? addEdge(
            board,
            anchorEdgeEnd(
              anchorEdgeEnd(
                buildEdge(
                  this.core.nextEdgeId(),
                  interaction.anchor,
                  interaction.movingEnd,
                  target,
                ),
                interaction.movingEnd === 'to' ? 'from' : 'to',
                interaction.passage ?? undefined,
                typeOf(interaction.anchor.nodeId),
              ),
              interaction.movingEnd,
              landed,
              typeOf(target.nodeId),
            ),
          )
        : updateEdge(
            board,
            interaction.edgeId,
            // The page and passage the end reached belonged to where it was:
            // re-attached, it reaches what it lands on there.
            interaction.movingEnd === 'from'
              ? {
                  fromNode: target.nodeId,
                  fromSide: target.side,
                  fromPage: landedPage,
                  fromAnchor: landed,
                }
              : {
                  toNode: target.nodeId,
                  toSide: target.side,
                  toPage: landedPage,
                  toAnchor: landed,
                },
          ),
    )
    this.deps.rebuildEdgesSvg()
    this.deps.passagesConnected(
      [interaction.passage, landed].filter(
        (anchor): anchor is EdgeAnchor => !!anchor,
      ),
    )

    if (created) {
      this.core.recomputeVisibility()
      this.core.drainQueues()
      this.deps.enterEditMode(created.anchor.nodeId)
    }
  }

  /** The card a connection dropped on open canvas lands on, placed so the
   * incoming edge meets its facing side. Added to the board together with the
   * edge to it, and the editor opened on it, in `finish`. */
  private createNodeForConnection(
    interaction: ConnectInteraction,
    drop: ScreenPoint,
  ): Readonly<{ node: TextNode; anchor: SideAnchor }> | null {
    if (!this.core.canEdit()) return null
    const side = oppositeSide(interaction.anchor.side)
    const rect = rectAnchoredAt(drop, side, NEW_CARD_SIZE)
    const node: TextNode = {
      id: this.core.nextNodeId(),
      type: 'text',
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: rect.w,
      h: rect.h,
      text: '',
      extra: {},
    }
    return { node, anchor: { nodeId: node.id, side } }
  }
}

/** Draws a preview run from a card's edge on to a passage, or hides it when
 * the end reaches none in sight. */
function drawPreviewRun(
  run: SVGPathElement,
  from: Readonly<{ x: number; y: number }>,
  to: Readonly<{ x: number; y: number }> | undefined,
): void {
  run.classList.toggle(EDGE_HIDDEN_CLASS, !to)
  if (to) run.setAttribute('d', `M${from.x},${from.y} L${to.x},${to.y}`)
}
