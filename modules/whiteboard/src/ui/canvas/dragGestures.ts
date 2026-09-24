// The gestures that move or size a card: dragging cards (and whatever a
// group carries), resizing one from its handles, and pulling a new card off
// the creation bar — the three that snap to their neighbours, so the
// alignment policy (what is on offer, how big, and when it is waved away)
// lives here with them.
//
// Split out of `../canvas.ts` (no behaviour change). `InteractionController`
// dispatches to this class and is its only importer; this module must never
// import the canvas.

import { gridStepForScale } from '../../domain/camera'
import type { ScreenPoint } from '../../domain/camera'
import {
  boundsCenter,
  fragmentFromSelection,
  placeFragment,
} from '../../domain/clipboard'
import type { NodeId } from '../../domain/fileFormat'
import { nodesToDragWith } from '../../domain/groups'
import { moveNodes, updateNode } from '../../domain/operations'
import {
  type CardRect,
  type CardSize,
  type ResizeHandle,
  type ResizeModifiers,
  rectOfCard,
  resizeRect,
} from '../../domain/resize'
import { type SnapGuide, snapMove, snapResize } from '../../domain/snapping'
import {
  computeWorldViewportRect,
  intersectsViewport,
} from '../../domain/virtualization'
import {
  DRAG_THRESHOLD_PX,
  GRID_MIN_SCREEN_STEP_PX,
  GRID_WORLD_STEP_PX,
  MIN_CARD_SIZE,
  SNAP_SCREEN_PX,
} from '../constants'

import type { CameraController } from './cameraController'
import type { CanvasCore } from './core'
import type { EdgeLayer } from './edgeLayer'
import type { SnapGuideLayer } from './snapGuideLayer'

const CARD_DRAGGING_CLASS = 'yolo-whiteboard-card-dragging'
const CREATE_GHOST_CLASS = 'yolo-whiteboard-create-ghost'

/**
 * A press on a card that hasn't yet crossed `DRAG_THRESHOLD_PX`: still
 * ambiguous between "click to edit" (pointerup with `dragging === false`)
 * and "drag to move" (crossed the threshold, `dragging === true`). `ids`/
 * `startPositions` are populated only once dragging begins (see
 * `beginNodeDrag`) — they cover every currently-selected card (a group
 * drag), or just `nodeId` alone if it wasn't already selected.
 */
export type NodeInteraction = {
  readonly kind: 'card'
  readonly pointerId: number
  readonly nodeId: NodeId
  readonly startClient: ScreenPoint
  /** The world point under the press. A drag is measured in world units from
   * here rather than as a screen delta divided by the scale, because the
   * camera can move under a drag — held against the viewport's edge it pans
   * (InteractionController's auto-pan), and a wheel can pan or zoom it — and
   * the card has to stay under the pointer through all of it. */
  readonly startWorld: ScreenPoint
  /** Shift was held: a press that never moves toggles this card in and out of
   * the selection instead of replacing it. */
  readonly additive: boolean
  /** The card was already the one selected when pressed: a press that never
   * moves is then a second click, which opens it (`finishNode`). Read at
   * press time, because the first click of a pair is what selects it. */
  readonly wasSoleSelection: boolean
  dragging: boolean
  ids: NodeId[]
  readonly startPositions: Map<NodeId, Readonly<{ x: number; y: number }>>
  /** What this drag may line up with, frozen when it becomes a drag for the
   * same reason `ids` is (see `beginNodeDrag`). */
  snapCandidates: readonly CardRect[]
  /** Set when an Alt-drag left a copy behind: the move is pushed under the
   * same history key, so the copy and the move are one undo step. */
  historyKey?: string
}

/**
 * A press on one of the eight resize handles. Like `NodeInteraction` it stays
 * ambiguous until `DRAG_THRESHOLD_PX`: the handles straddle the card's border,
 * so their inner half sits on top of the card, and a plain click there has to
 * still mean what a click on the card means (enter edit) rather than landing
 * in a dead zone. `startRect` is the card's rect at press time — every frame
 * is computed from it, never from the previous frame (see `resizeRect`).
 */
export type ResizeInteraction = {
  readonly kind: 'resize'
  readonly pointerId: number
  readonly nodeId: NodeId
  readonly handle: ResizeHandle
  readonly startClient: ScreenPoint
  /** As `NodeInteraction.startWorld`. */
  readonly startWorld: ScreenPoint
  readonly startRect: CardRect
  /** As `NodeInteraction.wasSoleSelection`: the handles' inner half lies on
   * the card, and a click there means what a click on the card means. */
  readonly wasSoleSelection: boolean
  dragging: boolean
  /** As `NodeInteraction.snapCandidates`, frozen when the press becomes a
   * drag rather than at press time — most presses on a handle are clicks. */
  snapCandidates: readonly CardRect[]
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
export type CreateInteraction = {
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

export type DragGesturesDeps = Readonly<{
  core: CanvasCore
  viewportEl: HTMLElement
  worldEl: HTMLElement
  camera: Pick<CameraController, 'viewportPointFromEvent'>
  edges: Pick<EdgeLayer, 'redrawEdgesForNodes'>
  snapGuides: SnapGuideLayer
  /** Exempts a card from virtualization unmount while a gesture holds it. */
  pin: (id: NodeId) => void
  unpin: (id: NodeId) => void
  /** Owes a card a content build on a later frame. */
  queueContentSync: (id: NodeId) => void
  /** `liveNodeRects` changed: the overview tier redraws from it. */
  onLiveRectsChange: () => void
  /** A plain click on a card may land on a link into one of the board's
   * PDFs. */
  followPdfLinkAt: (id: NodeId, e: PointerEvent) => void
  /** A click on a PDF card may land on one of its annotations, which opens
   * the card and the annotation together; whether it did. */
  openPdfAnnotationAt: (id: NodeId, e: PointerEvent) => boolean
  /**
   * A click on the card that was already the lone selection: open it the
   * way a double-click does — for typing, or into its live content (a PDF
   * to select text in) — and answer whether it did. Declined for a card with
   * neither, where the click stays a click on it.
   */
  openOnSecondClick: (id: NodeId) => boolean
  /** The edge set changed (an Alt-drag copied edges along with its cards). */
  rebuildEdgesSvg: () => void
  viewportCenterWorld: () => ScreenPoint
  /** Makes this the gesture in flight. */
  begin: (interaction: ResizeInteraction | CreateInteraction) => void
  /** The card the handle layer is parked on — what a press on a handle
   * resizes. */
  getLayerNodeId: () => NodeId | null
  placeLayer: (rect: CardRect) => void
  refreshLayer: () => void
}>

export class DragGestures {
  private readonly core: CanvasCore
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
  private liveRects: ReadonlyMap<NodeId, CardRect> | null = null
  /** The outline of the card a creation-bar drag is about to make. Built for
   * the gesture and removed with it — one element per drag is cheaper than a
   * permanent one to keep in step with a world layer that is rebuilt on every
   * reload. */
  private createGhostEl: HTMLElement | null = null
  /** Resolved once, on first use (see `onMacOS`). */
  private isMacOS: boolean | null = null
  /** Makes each Alt-drag's history key its own. */
  private duplicateDrags = 0

  constructor(private readonly deps: DragGesturesDeps) {
    this.core = deps.core
  }

  /** What the overview tier draws a moving card from; see the field. */
  get liveNodeRects(): ReadonlyMap<NodeId, CardRect> | null {
    return this.liveRects
  }

  // -----------------------------------------------------------------------
  // Card press: click-to-select vs. drag-to-move, disambiguated by
  // DRAG_THRESHOLD_PX. A plain click (never crosses the threshold) selects
  // the card; editing is a second, deliberate step — a second click on the
  // selected card, a double-click (which is the same two clicks, quickly),
  // or Enter on the selection. The second click is Miro's and Figma's, and
  // the one a touch screen can do: a double-tap is nobody's instinct there. Selecting first is
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
  // Resize: eight handles on one shared layer that follows the
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

  /** False when there is nothing to resize (the hovered card went away
   * between hover and press), so the caller can fall through. */
  startResize(handle: ResizeHandle, e: PointerEvent): boolean {
    if (!this.core.canEdit()) return false
    const nodeId = this.deps.getLayerNodeId()
    const card = nodeId === null ? null : this.core.getNode(nodeId)
    if (!card || nodeId === null) return false
    // Keeps the press from moving focus. Without it, grabbing a handle on the
    // card you are writing in blurs its editor, which commits and closes it —
    // adjusting a card's width should not cost you the caret you were at.
    e.preventDefault()
    this.deps.begin({
      kind: 'resize',
      pointerId: e.pointerId,
      nodeId,
      handle,
      startClient: { x: e.clientX, y: e.clientY },
      startWorld: this.core.worldPointFromEvent(e),
      startRect: rectOfCard(card),
      wasSoleSelection: isSoleSelection(this.core.getSelectedIds(), nodeId),
      dragging: false,
      snapCandidates: [],
    })
    this.deps.viewportEl.setPointerCapture(e.pointerId)
    return true
  }

  updateResize(interaction: ResizeInteraction, e: PointerEvent): void {
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
      this.deps.pin(interaction.nodeId)
    }
    const resized = this.resizedRect(interaction, e)
    this.deps.snapGuides.show(resized.guides)
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
    const world = this.core.worldPointFromEvent(e)
    const dx = world.x - interaction.startWorld.x
    const dy = world.y - interaction.startWorld.y
    // Read off the event, like the snapping key, so either can be pressed or
    // let go mid-resize.
    const modifiers: ResizeModifiers = {
      keepAspect: e.shiftKey,
      fromCenter: e.altKey,
    }
    const rect = resizeRect(
      interaction.startRect,
      interaction.handle,
      dx,
      dy,
      MIN_CARD_SIZE,
      modifiers,
    )
    // Alignment corrects the one edge a handle moves (domain/snapping.ts's
    // `snapResize`); a proportional or centred resize moves more than that,
    // and correcting one of its edges would undo the law the modifier asked
    // for. Either modifier therefore waves alignment away for as long as it is
    // held.
    if (e.shiftKey || e.altKey || !this.snappingWanted(e)) {
      return { rect, guides: [] }
    }
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
    const el = this.core.getRuntime(interaction.nodeId)?.el
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
    this.deps.placeLayer(rect)
    this.deps.edges.redrawEdgesForNodes(new Set([interaction.nodeId]), live)
  }

  /** Publishes (or, with null, retires) the geometry a gesture has reached but
   * not committed. One setter because the overview layer redraws from it and
   * would otherwise have to be told separately by every caller. */
  setLiveNodeRects(rects: ReadonlyMap<NodeId, CardRect> | null): void {
    this.liveRects = rects
    this.deps.onLiveRectsChange()
  }

  finishResize(interaction: ResizeInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      // A click, not a drag: the handle overlaps the card, so this means
      // what the same click on the card means.
      if (
        interaction.wasSoleSelection &&
        this.deps.openOnSecondClick(interaction.nodeId)
      ) {
        return
      }
      this.core.setSelection([interaction.nodeId])
      return
    }

    this.deps.unpin(interaction.nodeId)
    const { rect } = this.resizedRect(interaction, e)
    // A group's contents deliberately stay where they are: growing a frame is
    // how more cards are taken in and shrinking it is how they are let go,
    // which is only possible if resizing moves nothing (Obsidian Canvas's
    // group resize behaves identically).
    this.core.applyBoardChange(
      updateNode(this.core.getBoard(), interaction.nodeId, rect),
    )
    this.applyResizeRect(interaction, rect)
    // The board holds this rectangle now; the gesture's copy of it retires.
    this.setLiveNodeRects(null)
    // How much of a card's markdown is worth building is derived from the
    // card's height (`cardMarkdownPrefix`), so a card that just grew may have
    // room for source it was never given. Queued rather than rendered here so
    // it answers to the same frame gate as every other build; a resize that
    // does not change the prefix costs the comparison and nothing else.
    this.deps.queueContentSync(interaction.nodeId)
    // The card's footprint changed, so its mount state may have too.
    this.core.recomputeVisibility()
  }

  updateNode(interaction: NodeInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      const dx = e.clientX - interaction.startClient.x
      const dy = e.clientY - interaction.startClient.y
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      this.beginNodeDrag(interaction, e.altKey)
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
  private beginNodeDrag(
    interaction: NodeInteraction,
    duplicate: boolean,
  ): void {
    interaction.dragging = true
    if (!this.core.getSelectedIds().has(interaction.nodeId)) {
      this.core.setSelection([interaction.nodeId])
    }
    interaction.ids = nodesToDragWith(
      this.core.getSelectedIds(),
      this.core.getBoard().nodes,
    )
    if (duplicate) this.leaveCopyBehind(interaction)
    interaction.snapCandidates = this.snapCandidates(new Set(interaction.ids))
    for (const id of interaction.ids) {
      const card = this.core.getNode(id)
      if (!card) continue
      interaction.startPositions.set(id, { x: card.x, y: card.y })
      // Exempt every dragged card from virtualization unmount for the
      // duration of the drag (mirrors the existing editing-card pin).
      this.deps.pin(id)
      this.core.getRuntime(id)?.el?.classList.add(CARD_DRAGGING_CLASS)
    }
  }

  /**
   * Alt held as a drag begins: a copy of what is being dragged stays where it
   * was, and the drag carries on with the originals — Figma's and Miro's
   * gesture. The copies are the selection's fragment placed back on itself
   * (domain/clipboard.ts, the same code paste uses), so a duplicated group
   * brings its contents and the edges between copied cards come along.
   *
   * The copies go in as a history step keyed to this drag, and the move that
   * ends it is pushed under the same key: one gesture, one undo, which takes
   * back both the copy and the move. The originals keep their identity — and
   * so every edge that reaches them from outside the selection — because they
   * are what the hand is holding.
   */
  private leaveCopyBehind(interaction: NodeInteraction): void {
    if (!this.core.canCreate()) return
    const board = this.core.getBoard()
    const fragment = fragmentFromSelection(board, new Set(interaction.ids))
    if (fragment.nodes.length === 0) return
    const { board: next } = placeFragment(
      board,
      fragment,
      boundsCenter(fragment.nodes),
    )
    interaction.historyKey = `duplicate-drag-${String(++this.duplicateDrags)}`
    this.core.applyBoardChange(next, interaction.historyKey)
    this.core.recomputeVisibility()
    this.core.drainQueues()
    if (fragment.edges.length > 0) this.deps.rebuildEdgesSvg()
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
    const world = this.core.worldPointFromEvent(e)
    const raw = {
      dx: world.x - interaction.startWorld.x,
      dy: world.y - interaction.startWorld.y,
    }
    if (!this.snappingWanted(e)) return { ...raw, guides: [] }
    const moving: CardRect[] = []
    for (const id of interaction.ids) {
      const start = interaction.startPositions.get(id)
      const card = this.core.getNode(id)
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
    if (this.core.isOverview()) return []
    const groups = this.core
      .getBoard()
      .nodes.some((node) => moving.has(node.id) && node.type === 'group')
    const view = computeWorldViewportRect(
      this.deps.viewportEl.clientWidth,
      this.deps.viewportEl.clientHeight,
      this.core.getView(),
      0,
    )
    return this.core
      .getBoard()
      .nodes.filter(
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
    const { scale } = this.core.getView()
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
    // Off below the overview threshold. Alignment is an offer measured
    // in screen pixels, and down there the tolerance covers a screenful of
    // board: the card would jump to a neighbour the user cannot see, and the
    // guide drawn for it would be a line across the whole viewport.
    if (this.core.isOverview()) return false
    return this.onMacOS() ? !e.ctrlKey : !e.altKey
  }

  /** Which modifier waves alignment away, and how a shortcut is spelled. */
  onMacOS(): boolean {
    this.isMacOS ??= /Mac|iPhone|iPad/.test(
      this.core.context.getWindow().navigator.userAgent,
    )
    return this.isMacOS
  }

  private updateNodeDragPositions(
    interaction: NodeInteraction,
    e: PointerEvent,
  ): void {
    const { dx, dy, guides } = this.draggedDelta(interaction, e)
    this.deps.snapGuides.show(guides)
    const overrides = new Map<NodeId, CardRect>()
    for (const id of interaction.ids) {
      const start = interaction.startPositions.get(id)
      const card = this.core.getNode(id)
      if (!start || !card) continue
      overrides.set(id, {
        x: start.x + dx,
        y: start.y + dy,
        w: card.w,
        h: card.h,
      })
      const el = this.core.getRuntime(id)?.el
      if (el) el.style.transform = `translate(${dx}px, ${dy}px)`
    }
    // In the overview tier those elements do not exist and this map is the
    // drag's only feedback — see `liveNodeRects`.
    this.setLiveNodeRects(overrides)
    this.deps.edges.redrawEdgesForNodes(new Set(interaction.ids), overrides)
    // The handle layer sits in the same world space as the cards but is not
    // one of them, so a drag has to carry it along explicitly.
    const dragged = overrides.get(this.deps.getLayerNodeId() ?? '')
    if (dragged) this.deps.placeLayer(dragged)
  }

  finishNode(interaction: NodeInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      if (interaction.additive) {
        this.toggleSelection(interaction.nodeId)
      } else if (this.deps.openPdfAnnotationAt(interaction.nodeId, e)) {
        return
      } else if (
        interaction.wasSoleSelection &&
        this.deps.openOnSecondClick(interaction.nodeId)
      ) {
        return
      } else {
        this.core.setSelection([interaction.nodeId])
        this.deps.followPdfLinkAt(interaction.nodeId, e)
      }
      return
    }

    const { dx, dy } = this.draggedDelta(interaction, e)
    if (dx !== 0 || dy !== 0) {
      this.core.applyBoardChange(
        moveNodes(this.core.getBoard(), interaction.ids, dx, dy),
        interaction.historyKey,
      )
    }
    // The board holds these positions now; the drag's copy of them retires.
    this.setLiveNodeRects(null)
    for (const id of interaction.ids) {
      this.deps.unpin(id)
      const el = this.core.getRuntime(id)?.el
      if (!el) continue
      el.classList.remove(CARD_DRAGGING_CLASS)
      // A literal-string style assignment is disallowed (obsidianmd/
      // no-static-styles-assignment) even for a reset; setCssProps is the
      // sanctioned escape hatch (Obsidian and Style Constraints, CLAUDE.md).
      el.setCssProps({ transform: '' })
      const card = this.core.getNode(id)
      if (card) {
        el.style.left = `${card.x}px`
        el.style.top = `${card.y}px`
      }
    }
    this.deps.edges.redrawEdgesForNodes(new Set(interaction.ids))
    this.deps.refreshLayer()
    // Dragged cards may have moved on/off screen — re-evaluate mount state
    // immediately rather than waiting for the next throttled recompute
    // (mirrors onResize()'s direct call).
    this.core.recomputeVisibility()
    this.core.drainQueues()
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

  beginCreate(
    e: PointerEvent,
    size: CardSize,
    create: (at: ScreenPoint) => void,
  ): void {
    if (!this.core.canCreate()) return
    this.deps.begin({
      kind: 'create',
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      size,
      create,
      dragging: false,
      snapCandidates: [],
    })
    // Captured on the viewport rather than left on the button: the ghost is
    // dragged across cards and over live content (an embedded page swallows
    // pointer events), and the button must not receive the pointerup either —
    // its click is the keyboard's alone.
    this.deps.viewportEl.setPointerCapture(e.pointerId)
  }

  updateCreate(interaction: CreateInteraction, e: PointerEvent): void {
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
    this.deps.snapGuides.show(guides)
  }

  finishCreate(interaction: CreateInteraction, e: PointerEvent): void {
    this.hideCreateGhost()
    // Never moved: the press was a click, and a click on the bar creates in
    // the middle of the screen as it always has.
    if (!interaction.dragging) {
      interaction.create(this.deps.viewportCenterWorld())
      return
    }
    // Let go off the board — over the sidebar, or outside the window
    // entirely. Canvas drops the gesture here too: a card placed where the
    // pointer is not would be a card the user cannot see arriving.
    const local = this.deps.camera.viewportPointFromEvent(e)
    if (
      local.x < 0 ||
      local.y < 0 ||
      local.x > this.deps.viewportEl.clientWidth ||
      local.y > this.deps.viewportEl.clientHeight
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
    const center = this.core.worldPointFromEvent(e)
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
    const el = this.core.context.getDocument().createElement('div')
    el.className = CREATE_GHOST_CLASS
    this.deps.worldEl.appendChild(el)
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

  /** Adds a node to the selection, or takes it out if it was already in —
   * what Shift+click on a card means. */
  private toggleSelection(id: NodeId): void {
    const next = new Set(this.core.getSelectedIds())
    if (!next.delete(id)) next.add(id)
    this.core.setSelection(Array.from(next))
  }
}

/** Whether `id` is the one and only selected node. */
export function isSoleSelection(
  selected: ReadonlySet<NodeId>,
  id: NodeId,
): boolean {
  return selected.size === 1 && selected.has(id)
}
