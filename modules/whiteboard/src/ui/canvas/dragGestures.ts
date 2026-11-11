// The gestures that move or size a card: dragging cards (and whatever a
// group carries), resizing one from its handles, and pulling a new card off
// the creation bar — the three that snap to their neighbours, so the
// alignment policy (what is on offer, how big, and when it is waved away)
// lives here with them.
//
// Split out of `../canvas.ts` (no behaviour change). `InteractionController`
// dispatches to this class and is its only importer; this module must never
// import the canvas.

import { gridStepForScale, unionRect } from '../../domain/camera'
import type { ScreenPoint } from '../../domain/camera'
import {
  boundsCenter,
  fragmentFromSelection,
  placeFragment,
} from '../../domain/clipboard'
import { type Board, type NodeId, isPlainText } from '../../domain/fileFormat'
import { isFolded, unfoldGroup } from '../../domain/groupFold'
import {
  GROUP_PADDING,
  type GroupDrop,
  boardBlocks,
  draggedRoots,
  fitGroups,
  groupDropDecision,
  groupParents,
  nodesToDragWith,
  setMembership,
  sizeGroup,
} from '../../domain/groups'
import { joinNodePath, splitNodePath } from '../../domain/nodePath'
import { moveNodes, updateNode } from '../../domain/operations'
import {
  type CardRect,
  type CardSize,
  type ResizeHandle,
  type ResizeModifiers,
  rectOfCard,
  resizeRect,
} from '../../domain/resize'
import {
  type SnapGuide,
  type SnapOptions,
  snapMove,
  snapResize,
} from '../../domain/snapping'
import {
  computeWorldViewportRect,
  intersectsViewport,
} from '../../domain/virtualization'
import {
  DRAG_THRESHOLD_PX,
  GRID_MIN_SCREEN_STEP_PX,
  GRID_WORLD_STEP_PX,
  MIN_CARD_SIZE,
  PLAIN_TEXT_AUTO_CLASS,
  SNAP_AIM_LEAVE_SPEED,
  SNAP_AIM_SETTLE_MS,
  SNAP_AIM_SPEED,
  SNAP_SCREEN_PX,
} from '../constants'

import type { CameraController } from './cameraController'
import { nodeElementScale } from './cardContent'
import type { CanvasCore } from './core'
import type { EdgeLayer } from './edgeLayer'
import { GroupDropFeedback, type GroupDropTag } from './groupDropFeedback'
import { type HoldPointer, resizeCursor } from './pointerHold'
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
   * PDFs, which it follows — selecting what it leaves being read; whether it
   * did. */
  followPdfLinkAt: (id: NodeId, e: PointerEvent) => boolean
  /**
   * A click on the card that was already the lone selection: open it the
   * way a double-click does — for typing, or into its live content (a PDF
   * to select text in) — and answer whether it did. Declined for a card with
   * neither, where the click stays a click on it.
   */
  openOnSecondClick: (id: NodeId) => boolean
  /** The edge set changed (an Alt-drag copied edges along with its cards). */
  syncEdgesSvg: () => void
  viewportCenterWorld: () => ScreenPoint
  /** Makes this the gesture in flight. */
  begin: (interaction: ResizeInteraction | CreateInteraction) => void
  /** The card the handle layer is parked on — what a press on a handle
   * resizes. */
  getLayerNodeId: () => NodeId | null
  placeLayer: (rect: CardRect) => void
  refreshLayer: () => void
  /** What a gesture holds the pointer on, and the cursor it shows. */
  holdPointer: HoldPointer
}>

export class DragGestures {
  private readonly core: CanvasCore
  /**
   * Uncommitted geometry for the nodes a drag or a resize is moving, or null.
   *
   * In the DOM tiers the live feedback *is* the `translate` written on each
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
  /** The drag whose cards are being carried, from its first move to its
   * drop — what `adoptMountedCard` dresses a card mounted meanwhile for. */
  private carried: NodeInteraction | null = null
  /** Resolved once, on first use (see `onMacOS`). */
  private isMacOS: boolean | null = null
  /** Makes each Alt-drag's history key its own. */
  private duplicateDrags = 0
  /** How the pointer is moving in a drag: where it last was, when, how fast
   * it has been going (screen px per ms, smoothed), and whether it is
   * looking for a place to put what it carries (`aiming`). */
  private pace: {
    x: number
    y: number
    t: number
    speed: number
    aiming: boolean
  } | null = null
  /** Lines a drag up once the pointer has been still long enough. */
  private aimTimer: number | null = null
  /** The group a drag in progress was last shown joining, which holds on to
   * it until it is taken clearly away (domain/groups.ts's
   * `groupDropDecision`). */
  private reaching: NodeId | null = null

  /** What a drag shows about the groups it would change (`groupPreview`). */
  private readonly groupFeedback: GroupDropFeedback

  constructor(private readonly deps: DragGesturesDeps) {
    this.core = deps.core
    this.groupFeedback = new GroupDropFeedback(deps.core, deps.worldEl)
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
  // `translate` on the affected card elements (compositor-friendly, no
  // layout write; the property rather than `transform`, which a card behind
  // a portal at another scale is drawn larger or smaller under — cardContent.ts's
  // `scaleNodeElement` — and which animations write) — `left`/`top` are reconciled to the final board values
  // once on drop, matching how a freshly-mounted card is positioned.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Resize: eight handles on one shared layer that follows the
  // pointer's card. A press on a handle is ambiguous exactly the way a press
  // on a card is — the handles straddle the border, so their inner half
  // overlaps the card, and a click there that never moves must still open
  // the editor rather than do nothing. Once it does move, every frame writes
  // `left`/`top`/`width`/`height` on the one card being resized: unlike a
  // drag (which can ride on `translate`), a resize changes layout by
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
    // Bare text is as tall as its content: only its width is someone's to
    // set. Its other handles are not offered (styles/cards/text.css).
    if (isPlainText(card) && handle !== 'left' && handle !== 'right') {
      return false
    }
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
    this.deps.holdPointer(e.pointerId, resizeCursor(handle))
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
    // Bare text has no proportions to keep — its height is not a dimension
    // anyone sets — and no minimum height either.
    const plain = isPlainText(this.core.getNode(interaction.nodeId))
    const modifiers: ResizeModifiers = {
      keepAspect: e.shiftKey && !plain,
      fromCenter: e.altKey,
    }
    const min = plain ? { w: MIN_CARD_SIZE.w, h: 0 } : MIN_CARD_SIZE
    const rect = resizeRect(
      interaction.startRect,
      interaction.handle,
      dx,
      dy,
      min,
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
      this.snapOptions(homePortalOf(interaction.nodeId)),
    )
    return {
      rect: resizeRect(
        interaction.startRect,
        interaction.handle,
        dx + snap.dx,
        dy + snap.dy,
        min,
      ),
      guides: snap.guides,
    }
  }

  /** Live (uncommitted) geometry for the card, its handles and its edges. */
  private applyResizeRect(
    interaction: ResizeInteraction,
    resized: CardRect,
  ): CardRect {
    const el = this.core.getRuntime(interaction.nodeId)?.el
    let rect = resized
    // A group is given a range by hand, and its frame is that range and what
    // it holds together: shown as it will be, never smaller than what it
    // holds — and the groups round it following.
    const frames = this.groupResizeFrames(interaction.nodeId, resized)
    if (frames) rect = frames.get(interaction.nodeId) ?? rect
    // Its own size, which a portal at another scale draws larger or
    // smaller (cardContent.ts's `scaleNodeElement`).
    const scale = el ? nodeElementScale(el) : 1
    if (el && isPlainText(this.core.getNode(interaction.nodeId))) {
      // Bare text is given a width and wraps to it; how tall that makes it
      // is read back off the text, once, for the handles and the edges to
      // follow. The width is its own from here on, so the rule that sizes it
      // to its longest line stands aside.
      el.classList.remove(PLAIN_TEXT_AUTO_CLASS)
      el.style.left = `${rect.x}px`
      el.style.top = `${rect.y}px`
      el.style.width = `${rect.w / scale}px`
      el.style.removeProperty('height')
      rect = { ...rect, h: el.offsetHeight * scale }
    } else if (el) {
      el.style.left = `${rect.x}px`
      el.style.top = `${rect.y}px`
      el.style.width = `${rect.w / scale}px`
      el.style.height = `${rect.h / scale}px`
    }
    const live = new Map(frames ?? [])
    live.set(interaction.nodeId, rect)
    // As in a drag: with no element to write to, this is what the overview
    // tier draws the card being resized from.
    this.setLiveNodeRects(live)
    if (frames) {
      const others = new Map(frames)
      others.delete(interaction.nodeId)
      this.groupFeedback.show(others, null, null)
    }
    this.deps.placeLayer(rect)
    this.deps.edges.redrawEdgesForNodes(new Set(live.keys()), live)
    return rect
  }

  /** Publishes (or, with null, retires) the geometry a gesture has reached but
   * not committed. One setter because the overview layer redraws from it and
   * would otherwise have to be told separately by every caller. */
  setLiveNodeRects(rects: ReadonlyMap<NodeId, CardRect> | null): void {
    this.liveRects = rects
    if (!rects) {
      this.carried = null
      this.groupFeedback.clear()
      this.reaching = null
      this.pace = null
      if (this.aimTimer !== null) {
        this.core.context.getWindow().clearTimeout(this.aimTimer)
        this.aimTimer = null
      }
    }
    this.deps.onLiveRectsChange()
  }

  finishResize(interaction: ResizeInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      // A click, not a drag: the handle overlaps the card, so this means
      // what the same click on the card means — a text's citation runs along
      // its bottom edge, under the handle there.
      this.clickCard(interaction.nodeId, interaction.wasSoleSelection, e)
      return
    }

    this.deps.unpin(interaction.nodeId)
    const rect = this.applyResizeRect(
      interaction,
      this.resizedRect(interaction, e).rect,
    )
    // A group's contents stay where they are: what is resized is the range
    // the frame keeps by hand (fileFormat.ts's `GroupNode.bounds`), and the
    // frame is that and its members together — never smaller than what it
    // holds.
    //
    // Bare text given a width keeps it: its width no longer follows its
    // longest line.
    //
    // A portal is a window: moving its frame's edge shows more or less of
    // the board behind it, which stays where it is — so where it looks moves
    // with its corner.
    const node = this.core.getNode(interaction.nodeId)
    const plain = isPlainText(node)
    const view = node ? this.core.portalViewOf(node.id) : null
    // What was asked for, not the frame shown: that is the range kept.
    const asked = this.resizedRect(interaction, e).rect
    const portalPatch =
      node && view && (rect.x !== node.x || rect.y !== node.y)
        ? {
            view: {
              x: view.x + (rect.x - node.x) / view.unit,
              y: view.y + (rect.y - node.y) / view.unit,
              scale: view.scale,
            },
          }
        : {}
    this.core.applyBoardChange(
      node?.type === 'group'
        ? sizeGroup(
            this.core.getBoard(),
            interaction.nodeId,
            asked,
            this.core.scaleOf,
          )
        : updateNode(
            this.core.getBoard(),
            interaction.nodeId,
            plain
              ? { ...rect, autoWidth: undefined }
              : { ...rect, ...portalPatch },
          ),
    )
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
    // Not pinned: what a drag carries is mounted where it is carried to
    // (`liveNodeRects`, which virtualization reads), so a title dragging
    // three hundred PDF pages mounts the few in view, not all of them. The
    // ones that come into view on the way are dressed by `adoptMountedCard`.
    for (const id of interaction.ids) {
      const card = this.core.getNode(id)
      if (!card) continue
      interaction.startPositions.set(id, { x: card.x, y: card.y })
      this.core.getRuntime(id)?.el?.classList.add(CARD_DRAGGING_CLASS)
    }
    this.carried = interaction
    // Picked up, as one thing — and one card alone tilted in the hand
    // (constants.ts's LIFT_TILT_RAD).
    const [only, ...more] = interaction.ids
    this.core.motions.lift(
      interaction.ids,
      this.core.getView().scale,
      more.length === 0 && this.core.getNode(only)?.type !== 'group',
    )
  }

  /**
   * A card that a drag in progress carries has just been mounted: it comes
   * in where the board has it, and is put where the drag has it — the same
   * transform and class the cards mounted from the start were given.
   */
  adoptMountedCard(id: NodeId): void {
    const interaction = this.carried
    const start = interaction?.startPositions.get(id)
    const live = this.liveRects?.get(id)
    const el = this.core.getRuntime(id)?.el
    if (!start || !live || !el) return
    el.classList.add(CARD_DRAGGING_CLASS)
    el.style.translate = `${live.x - start.x}px ${live.y - start.y}px`
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
    if (!this.core.canEdit()) return
    const board = this.core.getBoard()
    const fragment = fragmentFromSelection(board, new Set(interaction.ids))
    if (fragment.nodes.length === 0) return
    const { board: placed, copies } = placeFragment(
      board,
      fragment,
      boundsCenter(fragment.nodes),
    )
    // A copy stays where its original was, and so in the group it was in:
    // what leaves with the drag is the original.
    const parents = groupParents(board.nodes)
    let next = placed
    for (const [original, copy] of copies) {
      const parent = parents.get(original)
      if (parent !== undefined && !copies.has(parent)) {
        next = setMembership(next, [copy], parent)
      }
    }
    interaction.historyKey = `duplicate-drag-${String(++this.duplicateDrags)}`
    this.core.applyBoardChange(next, interaction.historyKey)
    this.core.recomputeVisibility()
    this.core.drainQueues()
    if (fragment.edges.length > 0) this.deps.syncEdgesSvg()
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
  /** Where a drag would put what it carries: lined up with what it nears,
   * and — `grid` — any axis lined up with nothing on the grid. */
  private draggedDelta(
    interaction: NodeInteraction,
    e: PointerEvent,
    grid = true,
  ): Readonly<{ dx: number; dy: number; guides: readonly SnapGuide[] }> {
    const world = this.core.worldPointFromEvent(e)
    const raw = this.rawDelta(interaction, e)
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
    // From far away the selection lines up as one block, against the
    // board's blocks (`snapCandidates`): a spread's three hundred sheets are
    // one box there, not three hundred corners.
    const whole = this.core.isOverview() ? unionRect(moving) : null
    const snap = snapMove(
      whole ? [whole] : moving,
      interaction.snapCandidates,
      {
        // The board the cards would land on, put down here (canvas.ts's
        // `commitMove`).
        ...this.snapOptions(this.core.portalAtPoint(world)),
        ...(grid ? {} : { gridStep: 0 }),
        movedX: raw.dx !== 0,
        movedY: raw.dy !== 0,
      },
    )
    return { dx: raw.dx + snap.dx, dy: raw.dy + snap.dy, guides: snap.guides }
  }

  /**
   * What a gesture may line up with: what is on screen, minus what the
   * gesture is moving, minus everything of the other kind — or, in the
   * overview tier, the blocks on screen the board is arranged by
   * (domain/groups.ts's `boardBlocks`), whatever their kind.
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
    const view = computeWorldViewportRect(
      this.deps.viewportEl.clientWidth,
      this.deps.viewportEl.clientHeight,
      this.core.getView(),
      0,
    )
    // At this zoom a card dragged at a group is arranging, not dropping in,
    // so a frame is as good a neighbour as any.
    if (this.core.isOverview()) {
      return boardBlocks(this.core.getBoard().nodes, moving).filter((block) =>
        intersectsViewport(block, view),
      )
    }
    const groups = this.core
      .getBoard()
      .nodes.some((node) => moving.has(node.id) && node.type === 'group')
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
  /**
   * How near alignment reaches — a screen distance, the same at every zoom —
   * and the lattice a free axis falls onto: the grid of the board being
   * worked in, behind portal `portal` when one is given — its lines where
   * that board has them, spaced for the scale it is seen at — so a card put
   * down behind a portal lands on its own board's grid.
   */
  private snapOptions(portal: NodeId | null): SnapOptions {
    const { scale } = this.core.getView()
    const looking = portal === null ? null : this.core.portalViewOf(portal)
    const node = portal === null ? undefined : this.core.getNode(portal)
    const unit = looking && node ? looking.unit : 1
    return {
      tolerance: SNAP_SCREEN_PX / scale,
      gridStep:
        gridStepForScale(
          scale * unit,
          GRID_WORLD_STEP_PX,
          GRID_MIN_SCREEN_STEP_PX,
        ) * unit,
      gridOrigin:
        looking && node
          ? { x: node.x - looking.x * unit, y: node.y - looking.y * unit }
          : undefined,
    }
  }

  /**
   * Alignment is on unless the user holds the key that says otherwise, which
   * is Obsidian Canvas's arrangement down to the key: Ctrl on macOS — where
   * Alt already pans this canvas, as it does theirs — and Alt everywhere
   * else. Read off the event, so it can be pressed and released mid-drag.
   */
  private snappingWanted(e: PointerEvent): boolean {
    return this.onMacOS() ? !e.ctrlKey : !e.altKey
  }

  /** Which modifier waves alignment away, and how a shortcut is spelled. */
  onMacOS(): boolean {
    this.isMacOS ??= /Mac|iPhone|iPad/.test(
      this.core.context.getWindow().navigator.userAgent,
    )
    return this.isMacOS
  }

  /**
   * Moves what a drag carries with the pointer — exactly while the pointer
   * is travelling, lined up with what it nears once it is looking for a
   * place (`aiming`, SNAP_AIM_SPEED). Never onto the grid on the way: that
   * would step it from line to line for no reason the user can see, and the
   * grid is only the board keeping tidy — the drop puts it there
   * (`finishNode`), and setting it down from where it was held covers the
   * few pixels between.
   */
  private updateNodeDragPositions(
    interaction: NodeInteraction,
    e: PointerEvent,
    still = false,
  ): void {
    const { dx, dy, guides } = this.aiming(interaction, e, still)
      ? this.draggedDelta(interaction, e, false)
      : { ...this.rawDelta(interaction, e), guides: [] }
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
      if (el) el.style.translate = `${dx}px ${dy}px`
    }
    // Frames move with what they hold, and reach for or let go of what is
    // joining or leaving them — and edges on a frame go with it.
    for (const [id, frame] of this.groupPreview(interaction, dx, dy, e)) {
      overrides.set(id, frame)
    }
    // In the overview tier those elements do not exist and this map is the
    // drag's only feedback — see `liveNodeRects`.
    this.setLiveNodeRects(overrides)
    this.deps.edges.redrawEdgesForNodes(new Set(overrides.keys()), overrides)
    // The handle layer sits in the same world space as the cards but is not
    // one of them, so a drag has to carry it along explicitly.
    const dragged = overrides.get(this.deps.getLayerNodeId() ?? '')
    if (dragged) this.deps.placeLayer(dragged)
  }

  /**
   * Whether the pointer at `e` is looking for a place to put what it
   * carries (SNAP_AIM_SPEED): slow, or — `still` — stopped. One going too
   * fast to be is looked at again once it has stopped for a moment.
   */
  private aiming(
    interaction: NodeInteraction,
    e: PointerEvent,
    still: boolean,
  ): boolean {
    const win = this.core.context.getWindow()
    if (this.aimTimer !== null) {
      win.clearTimeout(this.aimTimer)
      this.aimTimer = null
    }
    const last = this.pace
    if (still) {
      if (last) last.aiming = true
      return true
    }
    const dt = last ? e.timeStamp - last.t : 0
    const instant =
      last && dt > 0
        ? Math.hypot(e.clientX - last.x, e.clientY - last.y) / dt
        : 0
    const speed = last ? (last.speed + instant) / 2 : 0
    // The first move says nothing about speed yet, and is a hand just
    // setting off: not aiming — or a card dragged from where it lined up
    // would be caught there again at once.
    const aiming = !last
      ? false
      : last.aiming
        ? speed <= SNAP_AIM_LEAVE_SPEED
        : speed <= SNAP_AIM_SPEED
    this.pace = { x: e.clientX, y: e.clientY, t: e.timeStamp, speed, aiming }
    if (!aiming) {
      this.aimTimer = win.setTimeout(() => {
        this.aimTimer = null
        if (this.carried === interaction) {
          this.updateNodeDragPositions(interaction, e, true)
        }
      }, SNAP_AIM_SETTLE_MS)
    }
    return aiming
  }

  /** How far the pointer has carried a drag, as it is. */
  private rawDelta(
    interaction: NodeInteraction,
    e: PointerEvent,
  ): Readonly<{ dx: number; dy: number }> {
    const world = this.core.worldPointFromEvent(e)
    return {
      dx: world.x - interaction.startWorld.x,
      dy: world.y - interaction.startWorld.y,
    }
  }

  /** A press on a card that never moved, alone — on the card itself or on
   * the handle layer over it. A link is followed however the card was
   * selected: aimed at, it is what the click meant, ahead of a second click's
   * opening the card. */
  clickCard(nodeId: NodeId, wasSoleSelection: boolean, e: PointerEvent): void {
    if (this.deps.followPdfLinkAt(nodeId, e)) return
    if (wasSoleSelection && this.deps.openOnSecondClick(nodeId)) return
    this.core.setSelection([nodeId])
  }

  finishNode(interaction: NodeInteraction, e: PointerEvent): void {
    if (!interaction.dragging) {
      if (interaction.additive) {
        this.toggleSelection(interaction.nodeId)
      } else {
        this.clickCard(interaction.nodeId, interaction.wasSoleSelection, e)
      }
      return
    }

    const { dx, dy } = this.draggedDelta(interaction, e)
    if (dx !== 0 || dy !== 0) {
      const point = this.core.worldPointFromEvent(e)
      this.core.commitMove(
        this.withDropMembership(
          moveNodes(this.core.getBoard(), interaction.ids, dx, dy),
          interaction.ids,
          point,
        ),
        interaction.ids,
        point,
        interaction.historyKey,
      )
    }
    // Where each was held as it was let go — taken while the drag's copy of
    // where they are is still there to say.
    const held = this.core.motions.drop()
    // The board holds these positions now; the drag's copy of them retires.
    this.setLiveNodeRects(null)
    this.carried = null
    for (const id of interaction.ids) {
      const el = this.core.getRuntime(id)?.el
      if (!el) continue
      el.classList.remove(CARD_DRAGGING_CLASS)
      // A literal-string style assignment is disallowed (obsidianmd/
      // no-static-styles-assignment) even for a reset; setCssProps is the
      // sanctioned escape hatch (Obsidian and Style Constraints, CLAUDE.md).
      el.setCssProps({ translate: '' })
      const card = this.core.getNode(id)
      if (card) {
        el.style.left = `${card.x}px`
        el.style.top = `${card.y}px`
      }
    }
    // Set down where the board has them now, from where they were held.
    for (const [id, pose] of held) this.core.motions.settle(id, { from: pose })
    this.deps.edges.redrawEdgesForNodes(new Set(interaction.ids))
    this.deps.refreshLayer()
    // Dragged cards may have moved on/off screen — re-evaluate mount state
    // immediately rather than waiting for the next throttled recompute
    // (mirrors onResize()'s direct call).
    this.core.recomputeVisibility()
    this.core.drainQueues()
  }

  /**
   * `moved` — the board with a drag's cards where it dropped them — with them
   * in the group the drop puts them in, or out of the one they left
   * (domain/groups.ts's `groupDropDecision`). A drop through a portal onto
   * the board behind it is that board's business, and changes no group here.
   */
  private withDropMembership(
    moved: Board,
    ids: readonly NodeId[],
    point: ScreenPoint,
  ): Board {
    const drop = this.dropDecision(moved, ids, point)
    if (!drop) return moved
    const roots = draggedRoots(moved.nodes, new Set(ids))
    const target = moved.nodes.find((node) => node.id === drop.target)
    if (!isFolded(target)) return setMembership(moved, roots, drop.target)
    // Into a collapsed group: what it holds comes out for a moment, the
    // dropped cards go beside it — to the right of its frame, along its top —
    // and the group, still collapsed, puts them away with the rest when the
    // board is settled (domain/groupFold.ts).
    const open = unfoldGroup(moved, target.id, true)
    const frame = open.nodes.find((node) => node.id === target.id)
    const covered = unionRect(
      open.nodes.filter((node) => roots.includes(node.id)).map(rectOfCard),
    )
    if (!frame || !covered) return moved
    const placed = moveNodes(
      open,
      ids,
      frame.x + frame.w - covered.x,
      frame.y + GROUP_PADDING * this.core.scaleOf(target.id) - covered.y,
    )
    return setMembership(placed, roots, target.id)
  }

  /** What dropping `ids` at `point` — the board `moved` with them there —
   * does to membership, or null for nothing. A drop through a portal onto
   * the board behind it is that board's business, and changes no group here
   * (canvas.ts's `commitMove`). */
  private dropDecision(
    moved: Board,
    ids: readonly NodeId[],
    point: ScreenPoint,
  ): GroupDrop | null {
    const first = ids[0]
    if (first === undefined) return null
    if (this.core.portalAtPoint(point) !== homePortalOf(first)) return null
    return groupDropDecision(
      moved,
      new Set(ids),
      this.core.scaleOf,
      this.reaching,
    )
  }

  /**
   * The frames of the groups a drag would change if it were put down now,
   * by id — shown on their elements, with the group the dragged cards would
   * be in lit and a tag saying which way they are going
   * (./groupDropFeedback.ts). Groups the drag carries move with it and are
   * not among them.
   */
  private groupPreview(
    interaction: NodeInteraction,
    dx: number,
    dy: number,
    e: PointerEvent,
  ): ReadonlyMap<NodeId, CardRect> {
    const board = this.core.getBoard()
    if (!board.nodes.some((node) => node.type === 'group')) return new Map()
    const moved = moveNodes(board, interaction.ids, dx, dy)
    const point = this.core.worldPointFromEvent(e)
    const moving = new Set(interaction.ids)
    const drop = this.dropDecision(moved, interaction.ids, point)
    this.reaching = drop && !drop.leaving ? drop.target : null
    // A collapsed group's box stays as it is: what is dropped on it is put
    // away, and only the box lighting up says so — the frame it came from
    // lets go of it all the same.
    const intoFolded = isFolded(
      drop?.target ? this.core.getNode(drop.target) : undefined,
    )
    const settled = drop
      ? setMembership(
          moved,
          draggedRoots(moved.nodes, moving),
          intoFolded ? null : drop.target,
        )
      : moved
    const frames = changedFrames(
      board,
      fitGroups(settled, this.core.scaleOf),
      moving,
    )
    let tag: GroupDropTag | null = null
    const roots = new Set(draggedRoots(moved.nodes, moving))
    const covered = unionRect(
      moved.nodes.filter((node) => roots.has(node.id)).map(rectOfCard),
    )
    if (drop && covered) {
      const target =
        drop.target === null ? null : this.core.getNode(drop.target)
      const name = target?.type === 'group' ? (target.label ?? '') : ''
      tag = {
        leaving: drop.leaving,
        at: { x: covered.x, y: covered.y },
        text: drop.leaving
          ? this.core.t('group.dropOut')
          : name
            ? this.core.t('group.dropInto').replace('{name}', name)
            : this.core.t('group.dropIntoUnnamed'),
      }
    }
    this.groupFeedback.show(
      frames,
      drop
        ? drop.leaving
          ? null
          : drop.target
        : this.stayingIn(board, moving, point),
      tag,
    )
    return frames
  }

  /**
   * The group a drag that changes no membership leaves its cards in — the
   * one they were all taken from — lit as a group they are joining is: what
   * is lit is where they will be if let go, whether they came from there or
   * not, so the moment they are taken far enough to leave is the moment it
   * goes out. Null when they came from no group, or from several, or are
   * over a portal's board, which a drop puts them on instead.
   */
  private stayingIn(
    board: Board,
    moving: ReadonlySet<NodeId>,
    point: ScreenPoint,
  ): NodeId | null {
    const [first] = moving
    if (first === undefined) return null
    if (this.core.portalAtPoint(point) !== homePortalOf(first)) return null
    const parents = groupParents(board.nodes)
    const homes = new Set(
      draggedRoots(board.nodes, moving).map((id) => parents.get(id) ?? null),
    )
    return homes.size === 1 ? (homes.values().next().value ?? null) : null
  }

  /**
   * The frames a group resized to `rect` by hand would show, by id: its own
   * — that range and what it holds together — and those of the groups round
   * it, which follow. Null for a node that is not a group.
   */
  private groupResizeFrames(
    id: NodeId,
    rect: CardRect,
  ): ReadonlyMap<NodeId, CardRect> | null {
    const board = this.core.getBoard()
    const group = this.core.getNode(id)
    if (group?.type !== 'group') return null
    const fitted = fitGroups(
      sizeGroup(board, id, rect, this.core.scaleOf),
      this.core.scaleOf,
    )
    const frames = new Map(changedFrames(board, fitted, new Set()))
    const own = fitted.nodes.find((node) => node.id === id)
    if (own) frames.set(id, rectOfCard(own))
    return frames
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
    if (!this.core.canEdit()) return
    this.deps.begin({
      kind: 'create',
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      size,
      create,
      dragging: false,
      snapCandidates: [],
    })
    // Held rather than left on the button: the ghost is dragged across cards
    // and over live content (an embedded page swallows pointer events), and
    // the button must not receive the pointerup either — its click is the
    // keyboard's alone.
    this.deps.holdPointer(e.pointerId, 'grabbing')
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
      ...this.snapOptions(this.core.portalAtPoint(center)),
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

/** The groups whose frame `after` has somewhere `before` does not, but for
 * those in `skip`, by id. */
function changedFrames(
  before: Board,
  after: Board,
  skip: ReadonlySet<NodeId>,
): Map<NodeId, CardRect> {
  const was = new Map(before.nodes.map((node) => [node.id, node]))
  const frames = new Map<NodeId, CardRect>()
  for (const node of after.nodes) {
    if (node.type !== 'group' || skip.has(node.id)) continue
    const old = was.get(node.id)
    if (
      old &&
      old.x === node.x &&
      old.y === node.y &&
      old.w === node.w &&
      old.h === node.h
    ) {
      continue
    }
    frames.set(node.id, rectOfCard(node))
  }
  return frames
}

/** Whether `id` is the one and only selected node. */
export function isSoleSelection(
  selected: ReadonlySet<NodeId>,
  id: NodeId,
): boolean {
  return selected.size === 1 && selected.has(id)
}

/** The portal a card on the composed board is behind — the innermost, whose
 * board it is a card of (domain/nodePath.ts) — or null for the board's own. */
function homePortalOf(id: NodeId): NodeId | null {
  const path = splitNodePath(id)
  return path.length > 1 ? joinNodePath(path.slice(0, -1)) : null
}
