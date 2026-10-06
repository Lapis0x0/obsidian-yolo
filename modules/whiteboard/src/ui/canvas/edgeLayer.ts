// The edges overlay for the `.yoloboard` canvas: a single SVG drawn into the
// world layer, redrawn wholesale on structural change and per-path on card
// position change ("世界层内单个 SVG overlay 画全部 edges...只在 edges 或端点
// 卡片位移时重绘（不进逐帧路径）"). Split out of `../canvas.ts`
// structurally (no behavior change): that file remains the single state
// owner (board data, selection, an in-progress label rename) and keeps the
// connection *gesture* (dragging a new edge out of a card, re-attaching an
// existing one) and the edge label's edit-commit logic entirely to itself;
// this class owns only the SVG/DOM side of drawing edges, reached through the
// narrow `EdgeLayerCallbacks` it is constructed with.
//
// `WhiteboardCanvas` is the only importer; this module must never import it
// back (single-direction dependency between the canvas and its
// collaborators).

import {
  EDGE_CONTROL_MAX_PX,
  type EdgeGeometry,
  type PassagePlacement,
  type Point,
  buildEdgePathD,
  computeEdgeGeometry,
  resolveEdgeEnds,
} from '../../domain/edges'
import type {
  BoardNode,
  Edge,
  EdgeAnchor,
  EdgeId,
  NodeColor,
  NodeId,
} from '../../domain/fileFormat'
import type { CardRect } from '../../domain/resize'
import type { VirtualCardRect, WorldRect } from '../../domain/virtualization'
import {
  EDGE_CULLED_CLASS,
  EDGE_HIDDEN_CLASS,
  EDGE_HIT_CLASS,
  EDGE_LABEL_CLASS,
  SVG_NS,
} from '../constants'
import { applyColorToElement } from '../selectionToolbar'

const EDGE_PATH_CLASS = 'yolo-whiteboard-edge-path'
const EDGE_SELECTED_CLASS = 'yolo-whiteboard-edge-selected'
/** The mark on an end that reaches a passage inside its card rather than
 * the whole card — drawn wherever that end is, placed or not. */
const EDGE_PASSAGE_END_CLASS = 'yolo-whiteboard-edge-passage-end'
/** The straight run on over a card, from its edge to the passage an end
 * reaches, while the card shows it (domain/edges.ts's `startInner`). */
/** A ring with nothing to say: its end runs on to the passage. Its own
 * class, apart from the one a connection drag hides the edge with. */
const EDGE_PASSAGE_END_OFF_CLASS = 'yolo-whiteboard-edge-passage-end-off'
const EDGE_PASSAGE_RUN_CLASS = 'yolo-whiteboard-edge-passage-run'
const EDGE_HOVERED_CLASS = 'yolo-whiteboard-edge-hovered'

type EdgeDomEntry = Readonly<{
  path: SVGPathElement
  /** Transparent fat stroke under `path`: a 1.5-unit curve is not something
   * a pointer can be asked to hit. */
  hit: SVGPathElement
  /** Absent until the edge has a label. An HTML element rather than SVG
   * `<text>`: it is what holds the caret while the label is typed (see
   * canvas.ts's `beginRename`), and SVG text cannot. */
  label: HTMLElement | null
  /** The marks on the ends that reach a passage (`EDGE_PASSAGE_END_CLASS`). */
  fromMark: SVGCircleElement | null
  toMark: SVGCircleElement | null
  /** The runs on over the card to those passages, drawn above the cards
   * (`passageRunsEl`) where the curve is drawn beneath them. */
  fromRun: SVGPathElement | null
  toRun: SVGPathElement | null
}>

/** Where a passage is inside its card, measured down from the card's top
 * edge in world units — or past its top or bottom — as whoever draws the
 * card can tell. */
export type CardPassagePlacement =
  | Readonly<{
      state: 'visible'
      top: number
      bottom: number
      left: number
      right: number
    }>
  | Readonly<{ state: 'above' | 'below' }>

/**
 * The narrow surface `WhiteboardCanvas` injects so edge drawing can read
 * board node positions it does not own, cancel a label rename that a rebuild
 * is about to invalidate, and delegate a label's keydown/blur to the rename
 * system — all without this class importing the canvas.
 */
export type EdgeLayerCallbacks = Readonly<{
  getNode: (id: NodeId) => BoardNode | undefined
  /** An edge label being typed is about to lose the element it is typed in —
   * called before every wholesale clear, structural rebuild included. */
  cancelActiveEdgeRename: () => void
  /** The edge whose label is being typed right now, or null — canvas.ts owns
   * the rename; this class only needs to know not to hide it
   * (`edgeIsVisible`). */
  getRenamingEdgeId: () => EdgeId | null
  onLabelKeyDown: (edgeId: EdgeId, event: KeyboardEvent) => void
  onLabelBlur: (edgeId: EdgeId) => void
  /** The pointer came onto an edge, or left it (null). */
  onEdgeHover: (edgeId: EdgeId | null) => void
  /** Where a passage an end reaches is in its card right now, or null when
   * the card cannot say (not drawn, or drawn without its text). */
  placePassage: (
    nodeId: NodeId,
    anchor: EdgeAnchor,
  ) => CardPassagePlacement | null
  /** Where a page of a PDF's card is in it, as `placePassage` says where a
   * passage is. */
  placePage: (nodeId: NodeId, page: number) => CardPassagePlacement | null
  t: (key: string, fallback?: string) => string
}>

/**
 * Owns the edges SVG's child elements (`edgeElsById`, the incidence index)
 * and its own copy of the board's edges, kept in step by whoever calls
 * `rebuildEdgesSvg` after a board mutation. One instance per
 * `WhiteboardCanvas`, constructed once the edges `<svg>`'s group and the
 * label layer exist (see `ensureDom`).
 */
export class EdgeLayer {
  private edgesById = new Map<EdgeId, Edge>()
  private edgeIndexByNodeId = new Map<NodeId, Set<EdgeId>>()
  private readonly edgeElsById = new Map<EdgeId, EdgeDomEntry>()
  /**
   * Edges currently off screen (`updateVisibility`). Membership is the single
   * source of truth for both the class on the elements and `redrawEdge`'s
   * early return, so a culled edge costs nothing to keep and nothing to move
   * a card past.
   */
  private readonly culledIds = new Set<EdgeId>()
  /**
   * Culled edges that declined a redraw while they were off screen, and so owe
   * one before they can be shown again.
   *
   * Without this, coming back into view would mean recomputing and re-parsing
   * a path for every edge crossing the viewport's edge on every pan tick —
   * work the uncalled version never did, since an edge is only redrawn when a
   * node moves. Which is exactly the point: a pan moves the camera, not the
   * board, so on a pan this set stays empty and an edge comes back showing the
   * geometry it already had.
   */
  private readonly staleIds = new Set<EdgeId>()

  constructor(
    private readonly context: YoloModuleHostFileViewContextV1,
    private readonly edgesGroupEl: SVGGElement,
    /** Over the cards, where the edges' runs to their passages go. */
    private readonly passageRunsEl: SVGGElement,
    private readonly edgeLabelsEl: HTMLElement,
    private readonly arrowMarkerId: string,
    private readonly callbacks: EdgeLayerCallbacks,
  ) {}

  rebuildEdgesSvg(edges: readonly Edge[]): void {
    this.clearEdgesSvg()
    this.edgesById = new Map(edges.map((edge) => [edge.id, edge]))
    for (const edge of edges) {
      this.indexEdgeIncidence(edge)
      this.createEdgeDom(edge)
      this.redrawEdge(edge.id)
    }
  }

  clearEdgesSvg(): void {
    // An edge label being typed is about to lose the element it is typed in.
    this.callbacks.cancelActiveEdgeRename()
    this.edgesGroupEl.replaceChildren()
    this.passageRunsEl.replaceChildren()
    this.edgeLabelsEl.replaceChildren()
    this.edgeElsById.clear()
    this.culledIds.clear()
    this.staleIds.clear()
    this.edgesById = new Map()
    this.edgeIndexByNodeId = new Map()
  }

  // -----------------------------------------------------------------------
  // Viewport culling.
  //
  // Edges used to be the one thing on the board with no virtualization at
  // all: every edge in the file kept two paths and possibly a label in the
  // document at every zoom level, so a board with a few thousand of them paid
  // Blink's per-element compositing bill in *every* tier — the same
  // `PaintArtifactCompositor::Update` tax that card virtualization exists to
  // bound. The overview tier draws edges on a canvas
  // and is unaffected; this is what the two DOM tiers needed.
  //
  // Culling is a `display: none` rather than a teardown, unlike a card's. An
  // edge is two path elements and no content: rebuilding one costs a
  // `setAttribute`, so there is nothing to save by destroying it and a whole
  // incidence index to keep consistent if we did. What the class buys is what
  // was expensive — the element leaves layout, paint and the compositor's
  // accounting entirely.
  // -----------------------------------------------------------------------

  /**
   * Hides the edges that cannot be seen and brings back the ones that can.
   *
   * `rect` is the same buffered world viewport the card virtualization uses.
   * `pinnedNodeIds` names the nodes a gesture is holding: those edges keep
   * their DOM whatever the board says, because during a drag the board's
   * positions are the ones the card *left* and the live geometry arrives
   * through `redrawEdgesForNodes`'s overrides instead.
   *
   * An edge that comes back is redrawn only if something moved while it was
   * away (`staleIds`): a pan moves the camera, not the board, so the hundreds
   * of edges crossing the viewport's edge on every tick of one come back
   * showing the geometry they already had.
   *
   * The edge whose label is being typed is exempt whatever the viewport says —
   * the same exemption a card being interacted with gets from `pinnedNodeIds`.
   * `display: none` on the element holding the caret takes the focus with it,
   * and the rename then ends on a blur nobody asked for; panning the board
   * while renaming is not a way to lose what you were typing.
   */
  updateVisibility(rect: WorldRect, pinnedNodeIds: ReadonlySet<NodeId>): void {
    // Read once for the sweep rather than per edge: on a board of a few
    // thousand this runs every tick.
    const renamingEdgeId = this.callbacks.getRenamingEdgeId()
    for (const [edgeId, edge] of this.edgesById) {
      const culled =
        edgeId !== renamingEdgeId &&
        !this.edgeIsVisible(edge, rect, pinnedNodeIds)
      if (culled === this.culledIds.has(edgeId)) continue
      const dom = this.edgeElsById.get(edgeId)
      if (!dom) continue
      dom.path.classList.toggle(EDGE_CULLED_CLASS, culled)
      dom.hit.classList.toggle(EDGE_CULLED_CLASS, culled)
      dom.label?.classList.toggle(EDGE_CULLED_CLASS, culled)
      dom.fromMark?.classList.toggle(EDGE_CULLED_CLASS, culled)
      dom.toMark?.classList.toggle(EDGE_CULLED_CLASS, culled)
      dom.fromRun?.classList.toggle(EDGE_CULLED_CLASS, culled)
      dom.toRun?.classList.toggle(EDGE_CULLED_CLASS, culled)
      if (culled) {
        this.culledIds.add(edgeId)
        continue
      }
      this.culledIds.delete(edgeId)
      // Only if something moved while it was away — see `staleIds`.
      if (this.staleIds.has(edgeId)) this.redrawEdge(edgeId)
    }
  }

  /**
   * Brings one edge back into the document whatever the viewport last said.
   *
   * The same exemption `updateVisibility` gives the edge being renamed, for
   * the tier where that sweep does not run: below the overview threshold the
   * canvas draws the edges and the DOM sweep is skipped, so an edge culled on
   * the way in stays culled — including the label that is about to be asked to
   * hold a caret (canvas.ts's `beginRename`). Cheap and idempotent, so the DOM
   * tiers call it too rather than waiting a throttle tick for the sweep to
   * reach the same conclusion.
   */
  revealEdge(edgeId: EdgeId): void {
    if (!this.culledIds.has(edgeId)) return
    const dom = this.edgeElsById.get(edgeId)
    if (!dom) return
    dom.path.classList.remove(EDGE_CULLED_CLASS)
    dom.hit.classList.remove(EDGE_CULLED_CLASS)
    dom.label?.classList.remove(EDGE_CULLED_CLASS)
    dom.fromMark?.classList.remove(EDGE_CULLED_CLASS)
    dom.toMark?.classList.remove(EDGE_CULLED_CLASS)
    dom.fromRun?.classList.remove(EDGE_CULLED_CLASS)
    dom.toRun?.classList.remove(EDGE_CULLED_CLASS)
    this.culledIds.delete(edgeId)
    if (this.staleIds.has(edgeId)) this.redrawEdge(edgeId)
  }

  /**
   * Whether any part of `edge` can reach `rect`.
   *
   * Tested against the union of its two endpoint cards grown by
   * `EDGE_CONTROL_MAX_PX`, which is a bound on the curve rather than the
   * curve: a cubic lies inside the convex hull of its four control points, the
   * anchors are on the two rects, and the control points are pushed at most
   * that far out along a side normal (domain/edges.ts's `extrapolate`). So a
   * box that contains both rects and that margin contains the curve, and it
   * costs four comparisons instead of a bezier evaluation.
   */
  private edgeIsVisible(
    edge: Edge,
    rect: WorldRect,
    pinnedNodeIds: ReadonlySet<NodeId>,
  ): boolean {
    if (pinnedNodeIds.has(edge.fromNode) || pinnedNodeIds.has(edge.toNode)) {
      return true
    }
    const from = this.callbacks.getNode(edge.fromNode)
    const to = this.callbacks.getNode(edge.toNode)
    // Dangling edges are rejected at parse time; keep a stray one visible
    // rather than silently hiding something nothing else will draw.
    if (!from || !to) return true
    const margin = EDGE_CONTROL_MAX_PX
    return (
      Math.min(from.x, to.x) - margin < rect.right &&
      Math.max(from.x + from.w, to.x + to.w) + margin > rect.left &&
      Math.min(from.y, to.y) - margin < rect.bottom &&
      Math.max(from.y + from.h, to.y + to.h) + margin > rect.top
    )
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
    const doc = this.context.getDocument()
    // Hit path first so the visible one paints over it; it is transparent,
    // and the only element of the pair a pointer can land on.
    const hit = doc.createElementNS(SVG_NS, 'path')
    hit.setAttribute('class', EDGE_HIT_CLASS)
    hit.dataset.edgeId = edge.id
    hit.addEventListener('pointerenter', () => this.hover(edge.id, true))
    hit.addEventListener('pointerleave', () => this.hover(edge.id, false))
    this.edgesGroupEl.appendChild(hit)

    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', EDGE_PATH_CLASS)
    // The colour rides on the path element itself, not on the shared SVG:
    // one overlay draws every edge, so per-edge colour has to be per-element.
    // The arrowhead marker picks it up through `fill: context-stroke`.
    applyColorToElement(path, edge.color)
    this.edgesGroupEl.appendChild(path)

    const hasLabel = (edge.label?.trim().length ?? 0) > 0
    this.edgeElsById.set(edge.id, {
      path,
      hit,
      label: hasLabel ? this.createEdgeLabelEl(edge) : null,
      fromMark: reachesIn(edge, 'from') ? this.createPassageMark(edge) : null,
      toMark: reachesIn(edge, 'to') ? this.createPassageMark(edge) : null,
      fromRun: reachesIn(edge, 'from') ? this.createPassageRun(edge) : null,
      toRun: reachesIn(edge, 'to') ? this.createPassageRun(edge) : null,
    })
  }

  private createPassageRun(edge: Edge): SVGPathElement {
    const run = this.context.getDocument().createElementNS(SVG_NS, 'path')
    run.setAttribute('class', EDGE_PASSAGE_RUN_CLASS)
    applyColorToElement(run, edge.color)
    this.passageRunsEl.appendChild(run)
    return run
  }

  /** The pointer came onto an edge or left it: the runs over its cards are
   * not siblings of its hit path, so they are told rather than styled by
   * `:hover`. */
  private hover(edgeId: EdgeId, on: boolean): void {
    const dom = this.edgeElsById.get(edgeId)
    dom?.fromRun?.classList.toggle(EDGE_HOVERED_CLASS, on)
    dom?.toRun?.classList.toggle(EDGE_HOVERED_CLASS, on)
    this.callbacks.onEdgeHover(on ? edgeId : null)
  }

  private createPassageMark(edge: Edge): SVGCircleElement {
    const mark = this.context.getDocument().createElementNS(SVG_NS, 'circle')
    mark.setAttribute('class', EDGE_PASSAGE_END_CLASS)
    applyColorToElement(mark, edge.color)
    this.edgesGroupEl.appendChild(mark)
    return mark
  }

  /**
   * Builds an edge's label element. Carries the same two listeners a group's
   * label does, for the same reason (see cardRenderer.ts's `mountNode`), and
   * the edge's colour so the ring it gets while being typed is the edge's
   * own.
   */
  private createEdgeLabelEl(edge: Edge): HTMLElement | null {
    const parent = this.edgeLabelsEl
    const el = this.context.getDocument().createElement('div')
    el.className = EDGE_LABEL_CLASS
    el.dataset.edgeId = edge.id
    el.textContent = edge.label ?? ''
    el.spellcheck = false
    // Shown by style.css while the element is empty, which it only ever is
    // between being created for an unlabelled edge and being typed into.
    el.dataset.placeholder = this.callbacks.t('edge.labelPlaceholder')
    // A label may be attached to an edge that is currently culled (see
    // `updateVisibility`); it belongs to the edge and shares its state.
    if (this.culledIds.has(edge.id)) el.classList.add(EDGE_CULLED_CLASS)
    applyColorToElement(el, edge.color)
    el.addEventListener('keydown', (event) =>
      this.callbacks.onLabelKeyDown(edge.id, event),
    )
    el.addEventListener('blur', () => this.callbacks.onLabelBlur(edge.id))
    parent.appendChild(el)
    return el
  }

  /** Gives an edge that has no label the element to type one into, and puts
   * it on the curve. */
  attachEdgeLabel(edgeId: EdgeId): HTMLElement | null {
    const edge = this.edgesById.get(edgeId)
    const dom = this.edgeElsById.get(edgeId)
    if (!edge || !dom || dom.label) return dom?.label ?? null
    const label = this.createEdgeLabelEl(edge)
    if (!label) return null
    this.edgeElsById.set(edgeId, { ...dom, label })
    this.redrawEdge(edgeId)
    return label
  }

  /** The edge's current label element, if it has one — canvas.ts's rename
   * system (`labelEl`) reads through this rather than owning `edgeElsById`
   * itself. */
  getLabelEl(edgeId: EdgeId): HTMLElement | null {
    return this.edgeElsById.get(edgeId)?.label ?? null
  }

  /** Takes it away again — an edge with a blank label is an edge with no
   * label, and nothing should be left on the curve marking it. */
  detachEdgeLabel(edgeId: EdgeId): void {
    const dom = this.edgeElsById.get(edgeId)
    if (!dom?.label) return
    dom.label.remove()
    this.edgeElsById.set(edgeId, { ...dom, label: null })
  }

  /** Takes an edge off the canvas without touching the board — the preview
   * stands in for it while its endpoint is being dragged. */
  setEdgeHidden(edgeId: EdgeId, hidden: boolean): void {
    const dom = this.edgeElsById.get(edgeId)
    if (!dom) return
    dom.path.classList.toggle(EDGE_HIDDEN_CLASS, hidden)
    dom.label?.classList.toggle(EDGE_HIDDEN_CLASS, hidden)
    dom.fromMark?.classList.toggle(EDGE_HIDDEN_CLASS, hidden)
    dom.toMark?.classList.toggle(EDGE_HIDDEN_CLASS, hidden)
    dom.fromRun?.classList.toggle(EDGE_HIDDEN_CLASS, hidden)
    dom.toRun?.classList.toggle(EDGE_HIDDEN_CLASS, hidden)
  }

  /** Toggles an edge's selected styling — the DOM half of canvas.ts's own
   * `markEdgeSelected`, now that this class owns `edgeElsById`. */
  setEdgeSelected(id: EdgeId, selected: boolean): void {
    const dom = this.edgeElsById.get(id)
    dom?.path.classList.toggle(EDGE_SELECTED_CLASS, selected)
    dom?.fromRun?.classList.toggle(EDGE_SELECTED_CLASS, selected)
    dom?.toRun?.classList.toggle(EDGE_SELECTED_CLASS, selected)
  }

  /** Board-data rect for `id`, or its live drag position from `overrides`
   * when provided (see ./dragGestures.ts's `updateNodeDragPositions`) — the single
   * lookup both `redrawEdge` call sites (live drag, and the post-commit
   * redraw against final data) go through. */
  effectiveNodeRect(
    id: NodeId,
    overrides?: ReadonlyMap<NodeId, CardRect>,
  ): VirtualCardRect | null {
    const card = this.callbacks.getNode(id)
    if (!card) return null
    const override = overrides?.get(id)
    return override ? { id: card.id, ...override } : card
  }

  private redrawEdge(
    edgeId: EdgeId,
    overrides?: ReadonlyMap<NodeId, CardRect>,
  ): void {
    // Off screen: the redraw is owed, not lost — `updateVisibility` pays it on
    // the way back in.
    if (this.culledIds.has(edgeId)) {
      this.staleIds.add(edgeId)
      return
    }
    this.staleIds.delete(edgeId)
    const edge = this.edgesById.get(edgeId)
    const dom = this.edgeElsById.get(edgeId)
    if (!edge || !dom) return
    const geometry = this.geometryOf(edge, overrides)
    if (!geometry) return // dangling edges are rejected at parse time; stay defensive
    const d = buildEdgePathD(geometry)
    dom.path.setAttribute('d', d)
    dom.hit.setAttribute('d', d)
    if (dom.label) {
      dom.label.style.left = `${geometry.label.x}px`
      dom.label.style.top = `${geometry.label.y}px`
    }
    // The ring says "a passage in there"; once the edge runs on to the
    // passage itself, the passage's own mark says it.
    placeMark(dom.fromMark, geometry.startInner ? null : geometry.start)
    placeMark(dom.toMark, geometry.endInner ? null : geometry.end)
    placeRun(dom.fromRun, geometry.start, geometry.startInner)
    placeRun(dom.toRun, geometry.end, geometry.endInner)
    // An arrowhead goes where the end is drawn to: the passage when the run
    // reaches it, the card's edge otherwise.
    const fromArrow = edge.fromEnd === 'arrow'
    const toArrow = edge.toEnd === 'arrow'
    this.setMarker(dom.path, 'marker-start', fromArrow && !geometry.startInner)
    this.setMarker(dom.path, 'marker-end', toArrow && !geometry.endInner)
    if (dom.fromRun) this.setMarker(dom.fromRun, 'marker-end', fromArrow)
    if (dom.toRun) this.setMarker(dom.toRun, 'marker-end', toArrow)
  }

  /** Where an edge is drawn now — its ends placed at the passages they
   * reach where the cards can say. What its chrome hangs from too. */
  edgeGeometry(edgeId: EdgeId): EdgeGeometry | null {
    const edge = this.edgesById.get(edgeId)
    return edge ? this.geometryOf(edge) : null
  }

  private geometryOf(
    edge: Edge,
    overrides?: ReadonlyMap<NodeId, CardRect>,
  ): EdgeGeometry | null {
    const from = this.effectiveNodeRect(edge.fromNode, overrides)
    const to = this.effectiveNodeRect(edge.toNode, overrides)
    if (!from || !to) return null
    const ends = resolveEdgeEnds(edge, from, to, {
      from: this.endPlacement(from, edge.fromAnchor, edge.fromPage),
      to: this.endPlacement(to, edge.toAnchor, edge.toPage),
    })
    return computeEdgeGeometry(from, to, ends.fromSide, ends.toSide, ends)
  }

  /** Where an end reaches inside its card, in world units: its passage, or
   * else the page it is on — null for an end on the whole card. The card's
   * report is measured from its top edge, and `card` is where the card is
   * now, mid-drag included. */
  endPlacement(
    card: VirtualCardRect,
    anchor: EdgeAnchor | undefined,
    page: number | undefined,
  ): PassagePlacement | null {
    const placement = anchor
      ? this.callbacks.placePassage(card.id, anchor)
      : page !== undefined
        ? this.callbacks.placePage(card.id, page)
        : null
    if (!placement || placement.state !== 'visible') return placement
    return {
      state: 'visible',
      top: card.y + placement.top,
      bottom: card.y + placement.bottom,
      left: card.x + placement.left,
      right: card.x + placement.right,
    }
  }

  /** Takes an edge as it now is on the board — its ends' passages changed,
   * nothing about its elements — and redraws it. */
  replaceEdge(edge: Edge): void {
    if (!this.edgesById.has(edge.id)) return
    this.edgesById.set(edge.id, edge)
    this.redrawEdge(edge.id)
  }

  /** Redraws the edges that reach a passage in `nodeId`: what its card shows
   * moved under them (a reader scrolled, a page loaded). */
  redrawPassageEdges(nodeId: NodeId): void {
    const incident = this.edgeIndexByNodeId.get(nodeId)
    if (!incident) return
    for (const edgeId of incident) {
      const edge = this.edgesById.get(edgeId)
      if (!edge) continue
      if (
        (edge.fromNode === nodeId && reachesIn(edge, 'from')) ||
        (edge.toNode === nodeId && reachesIn(edge, 'to'))
      ) {
        this.redrawEdge(edgeId)
      }
    }
  }

  redrawEdgesForNodes(
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

  /** Recolours an edge's path and, if it has one, its label — the label
   * carries the colour too, since that is what its ring is drawn in while
   * the label is being typed. Board-side colour persistence is
   * canvas.ts's `applyColorToEdge`; this is only the DOM half. */
  applyEdgeColor(edgeId: EdgeId, color: NodeColor | undefined): void {
    const dom = this.edgeElsById.get(edgeId)
    if (!dom) return
    applyColorToElement(dom.path, color)
    if (dom.label) applyColorToElement(dom.label, color)
    if (dom.fromMark) applyColorToElement(dom.fromMark, color)
    if (dom.toMark) applyColorToElement(dom.toMark, color)
    if (dom.fromRun) applyColorToElement(dom.fromRun, color)
    if (dom.toRun) applyColorToElement(dom.toRun, color)
  }

  /** Toggles an edge's start/end arrowhead markers to match its
   * `fromEnd`/`toEnd`. Board-side persistence is canvas.ts's
   * `setEdgeEnds`; this is only the DOM half. */
  setEdgeArrowEnds(edgeId: EdgeId, fromArrow: boolean, toArrow: boolean): void {
    const edge = this.edgesById.get(edgeId)
    if (!edge) return
    // Which element carries an arrowhead depends on where the end is drawn
    // to, which `redrawEdge` works out.
    this.edgesById.set(edgeId, {
      ...edge,
      fromEnd: fromArrow ? 'arrow' : 'none',
      toEnd: toArrow ? 'arrow' : 'none',
    })
    this.redrawEdge(edgeId)
  }

  private setMarker(
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
}

/** Whether an end reaches inside its card — a passage, or a page of a PDF —
 * rather than the whole card. */
function reachesIn(edge: Edge, end: 'from' | 'to'): boolean {
  return end === 'from'
    ? edge.fromAnchor !== undefined || edge.fromPage !== undefined
    : edge.toAnchor !== undefined || edge.toPage !== undefined
}

/** Puts a ring at a point, or takes it away (null). */
function placeMark(mark: SVGCircleElement | null, at: Point | null): void {
  if (!mark) return
  mark.classList.toggle(EDGE_PASSAGE_END_OFF_CLASS, !at)
  if (!at) return
  mark.setAttribute('cx', String(at.x))
  mark.setAttribute('cy', String(at.y))
}

/** Draws a run from the card's edge on to the passage, or none when the
 * passage is not in sight (`to` absent). Drawn edge-first, so its
 * arrowhead points in. */
function placeRun(
  run: SVGPathElement | null,
  from: Point,
  to: Point | undefined,
): void {
  if (!run) return
  if (!to) {
    run.removeAttribute('d')
    return
  }
  run.setAttribute('d', `M${from.x},${from.y} L${to.x},${to.y}`)
}
