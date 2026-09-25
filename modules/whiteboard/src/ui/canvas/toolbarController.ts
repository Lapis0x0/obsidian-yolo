// The floating selection toolbar for the `.yoloboard` canvas. Split out of
// `../canvas.ts` structurally (no behavior change): that file remains the
// single state owner (board data, selection, degrade/lock state) and keeps
// to itself every command whose whole body is one board change plus one DOM
// call (`applyColorToNodes`, `applyColorToEdge`,
// `setEdgeEnds` — see those methods' own doc comments); this class owns the
// `SelectionToolbar` instance itself, decides *what* it shows and *where* it
// sits, and reaches every board-mutating command it offers through the narrow
// `ToolbarControllerCallbacks` it is constructed with.
//
// `WhiteboardCanvas` is the only importer; this module must never import it
// back (single-direction dependency between the canvas and its
// collaborators).

import { type AlignEdge, type DistributeAxis } from '../../domain/arrange'
import { type ScreenPoint, unionRect } from '../../domain/camera'
import {
  COLOR_PRESETS,
  type ColorPreset,
  commonColor,
} from '../../domain/color'
import {
  ARROW_DIRECTIONS,
  type ArrowDirection,
  arrowDirection,
} from '../../domain/edges'
import {
  type Board,
  type BoardNode,
  type Edge,
  type EdgeId,
  type NodeColor,
  type NodeId,
  isPlainText,
} from '../../domain/fileFormat'
import { arrangeTargets } from '../../domain/groups'
import type { CardRect } from '../../domain/resize'
import { isSpreadTitle, withTitleAbove } from '../../domain/spread'
import { type ToolbarBounds, toolbarScreenPosition } from '../../domain/toolbar'
import type { CanvasView } from '../../domain/virtualization'
import { TOOLBAR_GAP_PX, TOOLBAR_MARGIN_PX } from '../constants'
import { asNode } from '../eventTarget'
import {
  SelectionToolbar,
  type ToolbarAction,
  type ToolbarColorControl,
  type ToolbarIconName,
  type ToolbarItem,
  type ToolbarMenuControl,
  type ToolbarModel,
} from '../selectionToolbar'

/** i18n key and icon per arrowhead direction (domain/edges.ts's
 * `ArrowDirection`). The icon is the arrangement it writes, drawn the way the
 * edge will look. */
const ARROW_MENU: Readonly<
  Record<ArrowDirection, Readonly<{ key: string; icon: ToolbarIconName }>>
> = {
  none: { key: 'menu.arrowNone', icon: 'minus' },
  forward: { key: 'menu.arrowForward', icon: 'arrow-right' },
  backward: { key: 'menu.arrowBackward', icon: 'arrow-left' },
  both: { key: 'menu.arrowBoth', icon: 'move-horizontal' },
}

/**
 * i18n key and icon per alignment (domain/arrange.ts's `AlignEdge`). Exported
 * because canvas.ts's right-click selection menu offers the same commands and
 * builds its entries from this same table — collaborators may not import
 * canvas.ts back, but canvas.ts importing *from* one is exactly the allowed
 * direction, and it is what keeps the two menus from drifting apart.
 * `ToolbarIconName` is a lucide name, which is also what a host menu item's
 * `icon` takes.
 */
export const ALIGN_MENU: Readonly<
  Record<AlignEdge, Readonly<{ key: string; icon: ToolbarIconName }>>
> = {
  left: { key: 'menu.alignLeft', icon: 'align-start-vertical' },
  center: { key: 'menu.alignCenter', icon: 'align-center-vertical' },
  right: { key: 'menu.alignRight', icon: 'align-end-vertical' },
  top: { key: 'menu.alignTop', icon: 'align-start-horizontal' },
  middle: { key: 'menu.alignMiddle', icon: 'align-center-horizontal' },
  bottom: { key: 'menu.alignBottom', icon: 'align-end-horizontal' },
}

export const DISTRIBUTE_MENU: Readonly<
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
 * The narrow surface `WhiteboardCanvas` injects so the toolbar can read
 * board/selection/degrade/lock state it does not own, and reach every
 * board-mutating command it offers, all without this class importing the
 * canvas.
 */
export type ToolbarControllerCallbacks = Readonly<{
  isParseFailed: () => boolean
  canEdit: () => boolean
  getBoard: () => Board
  getNode: (id: NodeId) => BoardNode | undefined
  /** Where a drag or resize has the cards it carries right now, before the
   * board is told (canvas.ts's `liveNodeRects`). */
  getLiveRects: () => ReadonlyMap<NodeId, CardRect> | null
  /** Where a PDF's title line is drawn when that is not its node's
   * rectangle — the overview tier grows it to stay readable. */
  getDrawnTitleRect: (id: NodeId) => CardRect | null
  getSelectedIds: () => ReadonlySet<NodeId>
  getSelectedEdgeIds: () => ReadonlySet<EdgeId>
  getEdge: (id: EdgeId) => Edge | undefined
  /** A file card showing a PDF — what "open in the reading panel" applies
   * to. */
  isPdfNode: (node: BoardNode) => boolean
  openReader: (id: NodeId) => void
  /** Spreads a PDF's pages out on the board, or puts them away
   * (the canvas's `toggleSpread`). */
  toggleSpread: (id: NodeId) => void
  /** World point an edge's toolbar anchors to — canvas.ts's own
   * `edgeAnchorPoint`, which needs the edge layer's live geometry this class
   * does not own. */
  edgeAnchorPoint: (edgeId: EdgeId | undefined) => ScreenPoint | null
  getView: () => CanvasView
  getViewportSize: () => Readonly<{ width: number; height: number }>
  t: (key: string, fallback?: string) => string

  deleteNodes: (ids: readonly NodeId[]) => void
  deleteEdges: (ids: readonly EdgeId[]) => void
  /** Frames these nodes — what the toolbar's focus button does for whatever
   * the toolbar is about (a selection, or the card being edited). */
  zoomToNodes: (nodes: readonly BoardNode[]) => void
  /** The card whose editor is open, or null. The toolbar stays with a card
   * while it is typed into, although a card being edited is not selected. */
  getEditingNodeId: () => NodeId | null
  createGroupFromSelection: () => void
  beginRename: (
    target:
      | Readonly<{ kind: 'group'; id: NodeId }>
      | Readonly<{ kind: 'edge'; id: EdgeId }>,
  ) => void
  /** One board change plus one DOM call each (see this file's header
   * comment) — canvas.ts keeps the whole method, this class only decides
   * when to call it. */
  applyColorToNodes: (
    ids: readonly NodeId[],
    color: NodeColor | undefined,
  ) => void
  applyColorToEdge: (edgeId: EdgeId, color: NodeColor | undefined) => void
  setEdgeEnds: (edgeId: EdgeId, direction: ArrowDirection) => void
  alignSelection: (edge: AlignEdge) => void
  distributeSelection: (axis: DistributeAxis) => void
  tidySelection: () => void
}>

/**
 * Owns the floating selection toolbar: the `SelectionToolbar` instance
 * itself, what model it shows, and where it sits. One instance per
 * `WhiteboardCanvas`, constructed once the viewport element exists (see
 * `ensureDom`).
 *
 * Two responsibilities, kept apart because they run at very different rates:
 * `refreshToolbar` decides *what* the toolbar contains and runs on discrete
 * events (selection, degrade state, an edge appearing or going away);
 * `syncPosition` decides *where* it is and runs on every frame of the board.
 *
 * Where is read, not told: every frame, from what is on screen — the camera,
 * the viewport, and the cards as drawn, a drag's live places included. So
 * nothing that moves a card, the camera or the viewport has to remember to
 * re-place the toolbar, and none can leave it behind. It costs a projection
 * a frame; the toolbar is measured once per model and written only when its
 * place changes (`SelectionToolbar`).
 *
 * Everything the buttons do goes through the same board operations the rest
 * of the canvas uses, so a colour picked here is one history step like any
 * other edit.
 */
export class ToolbarController {
  private readonly toolbar: SelectionToolbar
  /** Hidden for the duration of a pointer gesture (drag, resize, marquee,
   * pan, connect) — Obsidian Canvas hides its menu the same way, and a
   * toolbar that follows a card being dragged is a toolbar in the way. */
  private suppressed = false

  constructor(
    context: YoloModuleHostFileViewContextV1,
    parent: HTMLElement,
    private readonly callbacks: ToolbarControllerCallbacks,
  ) {
    this.toolbar = new SelectionToolbar(context.getDocument(), parent)
  }

  /** The layer the caller can hang other screen-space editing chrome in (the
   * creation bar, the file/URL prompt) — see `SelectionToolbar.overlay`. */
  get overlay(): HTMLElement {
    return this.toolbar.overlay
  }

  /** Whether a pointer event landed on the toolbar or anything else in its
   * overlay — canvas.ts's gesture dispatch uses this to keep a press on this
   * chrome from also being a press on the board behind it. */
  isOverlayTarget(target: EventTarget | null): boolean {
    const node = asNode(target)
    return node !== null && this.toolbar.contains(node)
  }

  /** Dismisses the colour/arrow/arrange popover, the same way a press
   * anywhere else dismisses a menu. */
  closePopover(): void {
    this.toolbar.closePopover()
  }

  destroy(): void {
    this.toolbar.destroy()
  }

  setToolbarSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return
    this.suppressed = suppressed
    this.toolbar.setSuppressed(suppressed)
    // Placed as it shows, not a frame later: it would arrive where it was.
    if (!suppressed) this.syncPosition()
  }

  refreshToolbar(): void {
    this.toolbar.setModel(this.buildToolbarModel())
    this.toolbar.setSuppressed(this.suppressed)
    this.syncPosition()
  }

  /** Puts the toolbar over what it is about, as that is on screen now.
   * Called by the board once a frame, and as the toolbar shows. */
  syncPosition(): void {
    if (this.suppressed) return
    const bounds = this.toolbarBounds()
    if (!bounds) return
    this.toolbar.place(
      toolbarScreenPosition(
        bounds,
        this.callbacks.getView(),
        this.callbacks.getViewportSize(),
        this.toolbar.size(),
        TOOLBAR_GAP_PX,
        TOOLBAR_MARGIN_PX,
      ),
    )
  }

  /**
   * World rectangle the toolbar is anchored to: the union of the selected
   * nodes, or — for an edge — a zero-size rect at the point its label hangs
   * from, which is the only place on a curve that reads as "the edge itself".
   * A folded PDF card counts its title with it, so the toolbar stands over
   * the title, where it stands over an open spread's. A card a gesture is
   * carrying counts where it is drawn, and so does a title the overview tier
   * draws larger than its node.
   */
  private toolbarBounds(): ToolbarBounds | null {
    const selectedEdgeIds = this.callbacks.getSelectedEdgeIds()
    if (selectedEdgeIds.size > 0) {
      const point = this.callbacks.edgeAnchorPoint(
        selectedEdgeIds.values().next().value,
      )
      return point ? { x: point.x, y: point.y, w: 0, h: 0 } : null
    }
    const targetIds = this.targetIds()
    if (targetIds.size === 0) return null
    const live = this.callbacks.getLiveRects()
    const rects: CardRect[] = []
    for (const id of targetIds) {
      const node = this.callbacks.getNode(id)
      if (!node) continue
      const rect = live?.get(id) ?? node
      const bounds = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
      rects.push(
        this.callbacks.isPdfNode(node) && !isSpreadTitle(node)
          ? withTitleAbove(bounds)
          : bounds,
      )
      const drawn = this.callbacks.getDrawnTitleRect(id)
      if (drawn) rects.push(drawn)
    }
    return rects.length > 0 ? unionRect(rects) : null
  }

  private buildToolbarModel(): ToolbarModel | null {
    if (this.callbacks.isParseFailed()) return null
    if (this.callbacks.getSelectedEdgeIds().size > 0) {
      return this.buildEdgeToolbarModel()
    }
    if (this.targetIds().size > 0) return this.buildNodeToolbarModel()
    return null
  }

  /**
   * The nodes the toolbar is about: the selection, or — with nothing selected
   * — the card being edited. Editing clears the selection so that Backspace
   * and Escape belong to the editor (EditingController's `enterEditMode`),
   * but what the card can have done to it does not change because it is
   * being typed into; losing delete, colour and focus at the moment the user
   * is working on the card was the wrong way round.
   */
  private targetIds(): ReadonlySet<NodeId> {
    const selectedIds = this.callbacks.getSelectedIds()
    if (selectedIds.size > 0) return selectedIds
    const editing = this.callbacks.getEditingNodeId()
    return editing === null ? selectedIds : new Set([editing])
  }

  private buildNodeToolbarModel(): ToolbarModel | null {
    const targetIds = this.targetIds()
    const nodes = this.callbacks
      .getBoard()
      .nodes.filter((node) => targetIds.has(node.id))
    if (nodes.length === 0) return null
    const single = nodes.length === 1 ? nodes[0] : null
    const ids = nodes.map((node) => node.id)
    const canEdit = this.callbacks.canEdit()
    // Pages of a spread and nothing else: pieces of a document that is
    // deleted, grouped and put away as a whole, from its title. What is a
    // page's own is its colour, and where the camera looks.
    const onlySheets = nodes.every((node) => node.type === 'pdf-page')

    // The row is Obsidian Canvas's, in its order: delete, colour, focus,
    // group, align. No edit button: a second click on the selected card opens
    // it (DragGestures' `finishNode`), as do a double-click and Enter, and a
    // button that only repeated them was one more icon on every selection.
    // Nothing is behind an overflow button, because everything a selection
    // can do either fits on the row or belongs to the right-click menu; see
    // canvas.ts's `selectionMenuItems`.
    const items: ToolbarItem[] = []
    if (canEdit) {
      if (!onlySheets) {
        items.push({
          label: this.callbacks.t('menu.deleteCard'),
          icon: 'trash',
          onSelect: () => this.callbacks.deleteNodes(ids),
        })
      }
      items.push(
        this.colorControl(
          commonColor(nodes.map((node) => node.color)),
          (color) => this.callbacks.applyColorToNodes(ids, color),
        ),
      )
    }
    // Framing the selection is a camera move, not an edit — Obsidian Canvas's
    // third button too. Not for a lone bare text: it is already read where it
    // is, and its row is kept to what a line of text has.
    if (!isPlainText(single ?? undefined)) {
      items.push({
        label: this.callbacks.t('menu.zoomToSelection'),
        icon: 'scan-search',
        onSelect: () => this.callbacks.zoomToNodes(nodes),
      })
    }
    if (canEdit && nodes.length > 1 && !onlySheets) {
      items.push({
        label: this.callbacks.t('menu.createGroup'),
        icon: 'group',
        onSelect: () => this.callbacks.createGroupFromSelection(),
      })
    }
    const tidy = this.tidyControl()
    if (tidy) items.push(tidy)
    // A PDF card's own button: read it in the panel beside the board. Offered
    // in the overview tier too — the panel needs no card element.
    if (single && this.callbacks.isPdfNode(single)) {
      items.push({
        label: this.callbacks.t('toolbar.openReader'),
        icon: 'book-open',
        onSelect: () => this.callbacks.openReader(single.id),
      })
    }
    // Spread a PDF's pages out, or put a spread away — from the card or the
    // title, not from a page, where it would put away more than was pointed
    // at (the page's right-click menu still has it). In the overview tier
    // too: the board changes and the canvas draws it, and the cards are
    // built when the zoom comes back.
    if (canEdit && single && this.callbacks.isPdfNode(single)) {
      const open = isSpreadTitle(single)
      items.push({
        label: this.callbacks.t(
          open ? 'toolbar.closeSpread' : 'toolbar.openSpread',
        ),
        icon: open ? 'minimize-2' : 'maximize-2',
        onSelect: () => this.callbacks.toggleSpread(single.id),
      })
    }
    // A group has no content to type into, so its pencil renames it — the
    // same command its label's double-click carries, which is otherwise the
    // only way to find it.
    if (single?.type === 'group' && canEdit) {
      items.push({
        label: this.callbacks.t('menu.renameGroup'),
        icon: 'pencil',
        onSelect: () =>
          this.callbacks.beginRename({ kind: 'group', id: single.id }),
      })
    }

    return { items }
  }

  /**
   * The tidy button, or null when there is nothing to tidy — it takes two
   * things to have a gap between them.
   *
   * One click, no popover. This is the toolbar's answer to "make this look
   * tidy", and a command that has to be found inside a grid of eight
   * geometric icons is not an answer to that: those icons are a vocabulary
   * for someone who has already translated their intent into "align left,
   * then distribute vertically". They still exist, in the right-click menu,
   * where they are labelled in words and where the person reaching for them
   * knows which axis they mean — see canvas.ts's selection menu.
   */
  private tidyControl(): ToolbarAction | null {
    const targets = arrangeTargets(
      this.callbacks.getBoard(),
      this.callbacks.getSelectedIds(),
    ).length
    if (!this.callbacks.canEdit() || targets < 2) return null
    return {
      label: this.callbacks.t('toolbar.tidy'),
      icon: 'layout-grid',
      onSelect: () => this.callbacks.tidySelection(),
    }
  }

  private buildEdgeToolbarModel(): ToolbarModel | null {
    const edgeId = this.callbacks.getSelectedEdgeIds().values().next().value
    const edge =
      edgeId === undefined ? undefined : this.callbacks.getEdge(edgeId)
    if (!edge) return null

    // Same row shape as a node's: delete, colour, then what is specific to an
    // edge. Deleting was this menu's only entry, so "more" goes with it.
    if (!this.callbacks.canEdit()) return { items: [] }
    return {
      items: [
        {
          label: this.callbacks.t('menu.deleteEdge'),
          icon: 'trash',
          onSelect: () => this.callbacks.deleteEdges([edge.id]),
        },
        this.colorControl(edge.color, (color) =>
          this.callbacks.applyColorToEdge(edge.id, color),
        ),
        this.arrowControl(edge),
        {
          label: this.callbacks.t('toolbar.edgeLabel'),
          icon: 'tag',
          onSelect: () =>
            this.callbacks.beginRename({ kind: 'edge', id: edge.id }),
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
      label: this.callbacks.t('toolbar.color'),
      defaultLabel: this.callbacks.t('color.default'),
      presetLabels: Object.fromEntries(
        COLOR_PRESETS.map((preset) => [
          preset,
          this.callbacks.t(`color.preset${preset}`),
        ]),
      ) as Readonly<Record<ColorPreset, string>>,
      customLabel: this.callbacks.t('color.custom'),
      current,
      onPick: (color) => {
        onPick(color)
        this.toolbar.setCurrentColor(color)
      },
    }
  }

  /**
   * Arrowheads, as JSON Canvas models them: an independent `fromEnd`/`toEnd`
   * per end. Offered as four named states rather than a cycling button —
   * "which way does it point" has a direction, and a button that only cycles
   * makes reversing an edge a guessing game. Four states need names, so this
   * is the toolbar's one `list` menu, with the edge's current state checked.
   */
  private arrowControl(edge: Edge): ToolbarMenuControl {
    const current = arrowDirection(edge.fromEnd, edge.toEnd)
    return {
      kind: 'menu',
      label: this.callbacks.t('toolbar.arrows'),
      icon: ARROW_MENU[current].icon,
      groups: [
        ARROW_DIRECTIONS.map((direction) => ({
          label: this.callbacks.t(ARROW_MENU[direction].key),
          icon: ARROW_MENU[direction].icon,
          checked: direction === current,
          onSelect: () => {
            this.callbacks.setEdgeEnds(edge.id, direction)
            // Both the button's icon and the checked entry say what the edge
            // is now, so the control has to be rebuilt from the board it just
            // changed — the arrowhead counterpart of `setCurrentColor`.
            this.refreshToolbar()
          },
        })),
      ],
    }
  }
}
