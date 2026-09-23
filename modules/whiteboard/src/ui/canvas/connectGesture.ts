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
  type SideAnchor,
  anchorPoint,
  buildEdge,
  buildEdgePathD,
  computeEdgeGeometry,
  findConnectTarget,
  oppositeSide,
  rectAnchoredAt,
  resolveEdgeSides,
} from '../../domain/edges'
import type {
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
import type { EdgeLayer } from './edgeLayer'

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

export type ConnectGestureDeps = Readonly<{
  core: CanvasCore
  viewportEl: HTMLElement
  /** The in-flight connection's curve. A sibling of the edges group rather
   * than a child, so `rebuildEdgesSvg`'s wholesale replaceChildren never
   * takes it out from under a live gesture. */
  previewPathEl: SVGPathElement
  /** The handle layer, which carries the side being pulled from while the
   * drag is on. */
  interactionLayerEl: HTMLElement
  /** The card the handle layer is parked on — what a press on a connection
   * point pulls from. */
  getLayerNodeId: () => NodeId | null
  edges: Pick<EdgeLayer, 'setEdgeHidden'>
  /** Makes this the gesture in flight. */
  begin: (interaction: ConnectInteraction) => void
  rebuildEdgesSvg: () => void
  enterEditMode: (id: NodeId) => void
}>

export class ConnectGesture {
  private readonly core: CanvasCore
  private connectTargetNodeId: NodeId | null = null

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
    this.beginConnect({ nodeId, side }, 'to', null, e)
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
    const sides = resolveEdgeSides(from, to, edge.fromSide, edge.toSide)
    const world = this.core.worldPointFromEvent(e)
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
    this.deps.begin({
      kind: 'connect',
      pointerId: e.pointerId,
      anchor,
      movingEnd,
      edgeId,
      startClient: { x: e.clientX, y: e.clientY },
      candidates: this.core
        .getBoard()
        .nodes.filter((node) => node.id !== anchor.nodeId),
      dragging: false,
      target: null,
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
    const world = this.core.worldPointFromEvent(e)
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
      this.core
        .getRuntime(previous)
        ?.el?.classList.remove(CARD_CONNECT_TARGET_CLASS)
    }
    this.connectTargetNodeId = nodeId
    if (nodeId !== null) {
      this.core.getRuntime(nodeId)?.el?.classList.add(CARD_CONNECT_TARGET_CLASS)
    }
  }

  finish(interaction: ConnectInteraction, e: PointerEvent): void {
    this.setConnectTarget(null)
    this.deps.previewPathEl?.classList.add(EDGE_HIDDEN_CLASS)
    if (this.deps.interactionLayerEl) {
      delete this.deps.interactionLayerEl.dataset.connecting
    }
    if (interaction.edgeId !== null) {
      this.deps.edges.setEdgeHidden(interaction.edgeId, false)
    }

    if (!interaction.dragging) {
      // A press that never moved: on an edge that means selecting it, and on
      // a connection point it means nothing at all.
      if (interaction.edgeId !== null) {
        this.core.setEdgeSelection([interaction.edgeId])
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
    this.core.applyBoardChange(
      interaction.edgeId === null
        ? addEdge(
            board,
            buildEdge(
              this.core.nextEdgeId(),
              interaction.anchor,
              interaction.movingEnd,
              target,
            ),
          )
        : updateEdge(
            board,
            interaction.edgeId,
            interaction.movingEnd === 'from'
              ? { fromNode: target.nodeId, fromSide: target.side }
              : { toNode: target.nodeId, toSide: target.side },
          ),
    )
    this.deps.rebuildEdgesSvg()

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
