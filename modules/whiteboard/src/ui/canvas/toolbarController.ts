// The floating selection toolbar for the `.yoloboard` canvas
// (docs/plans/08-25-yolo-whiteboard/p1-design.md §3, P3 batch 3 surfaces
// ①/②). Split out of `../canvas.ts` structurally (no behavior change): that
// file remains the single state owner (board data, selection, degrade/lock
// state) and keeps to itself every command whose whole body is one board
// change plus one DOM call (`applyColorToNodes`, `applyColorToEdge`,
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
import type {
  Board,
  BoardNode,
  Edge,
  EdgeId,
  NodeColor,
  NodeId,
} from '../../domain/fileFormat'
import { arrangeTargets } from '../../domain/groups'
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
  isOverview: () => boolean
  getBoard: () => Board
  getSelectedIds: () => ReadonlySet<NodeId>
  getSelectedEdgeIds: () => ReadonlySet<EdgeId>
  getEdge: (id: EdgeId) => Edge | undefined
  isEditableNode: (node: BoardNode) => boolean
  /** World point an edge's toolbar anchors to — canvas.ts's own
   * `edgeAnchorPoint`, which needs the edge layer's live geometry this class
   * does not own. */
  edgeAnchorPoint: (edgeId: EdgeId | undefined) => ScreenPoint | null
  getView: () => CanvasView
  getViewportSize: () => Readonly<{ width: number; height: number }>
  t: (key: string, fallback?: string) => string

  deleteNodes: (ids: readonly NodeId[]) => void
  deleteEdges: (ids: readonly EdgeId[]) => void
  zoomToSelection: () => void
  createGroupFromSelection: () => void
  editCard: (id: NodeId) => void
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
 * `positionToolbar` decides *where* it is and runs on every camera frame.
 * Rebuilding the DOM at camera rate would be absurd, and re-placing it only
 * on selection change would leave it stranded mid-pan.
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
    if (!suppressed) this.positionToolbar()
  }

  refreshToolbar(): void {
    this.toolbar.setModel(this.buildToolbarModel())
    this.toolbar.setSuppressed(this.suppressed)
    this.positionToolbar()
  }

  positionToolbar(): void {
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
   */
  private toolbarBounds(): ToolbarBounds | null {
    const selectedEdgeIds = this.callbacks.getSelectedEdgeIds()
    if (selectedEdgeIds.size > 0) {
      const point = this.callbacks.edgeAnchorPoint(
        selectedEdgeIds.values().next().value,
      )
      return point ? { x: point.x, y: point.y, w: 0, h: 0 } : null
    }
    const selectedIds = this.callbacks.getSelectedIds()
    if (selectedIds.size === 0) return null
    return unionRect(
      this.callbacks
        .getBoard()
        .nodes.filter((node) => selectedIds.has(node.id))
        .map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h })),
    )
  }

  private buildToolbarModel(): ToolbarModel | null {
    if (this.callbacks.isParseFailed()) return null
    if (this.callbacks.getSelectedEdgeIds().size > 0) {
      return this.buildEdgeToolbarModel()
    }
    if (this.callbacks.getSelectedIds().size > 0) {
      return this.buildNodeToolbarModel()
    }
    return null
  }

  private buildNodeToolbarModel(): ToolbarModel | null {
    const selectedIds = this.callbacks.getSelectedIds()
    const nodes = this.callbacks
      .getBoard()
      .nodes.filter((node) => selectedIds.has(node.id))
    if (nodes.length === 0) return null
    const single = nodes.length === 1 ? nodes[0] : null
    const ids = nodes.map((node) => node.id)
    const canEdit = this.callbacks.canEdit()

    // The row is Obsidian Canvas's, in its order: delete, colour, focus,
    // group, align — then the one button that is ours, editing what is
    // selected. Nothing is behind an overflow button, because everything a
    // selection can do either fits on the row or belongs to the right-click
    // menu; see canvas.ts's `selectionMenuItems`.
    const items: ToolbarItem[] = []
    if (canEdit) {
      items.push({
        label: this.callbacks.t('menu.deleteCard'),
        icon: 'trash',
        onSelect: () => this.callbacks.deleteNodes(ids),
      })
      items.push(
        this.colorControl(
          commonColor(nodes.map((node) => node.color)),
          (color) => this.callbacks.applyColorToNodes(ids, color),
        ),
      )
    }
    // Framing the selection is a camera move, not an edit — the one button a
    // locked board still gets, and Obsidian Canvas's third button too.
    items.push({
      label: this.callbacks.t('menu.zoomToSelection'),
      icon: 'scan-search',
      onSelect: () => {
        this.callbacks.zoomToSelection()
      },
    })
    if (canEdit && nodes.length > 1) {
      items.push({
        label: this.callbacks.t('menu.createGroup'),
        icon: 'group',
        onSelect: () => this.callbacks.createGroupFromSelection(),
      })
    }
    const tidy = this.tidyControl()
    if (tidy) items.push(tidy)
    // Editing is the one action a card in the overview tier cannot take —
    // it has no element to put an editor in — so the button goes away rather
    // than being offered and declining. A locked board offers it for nothing
    // either.
    if (
      single &&
      this.callbacks.isEditableNode(single) &&
      !this.callbacks.isOverview() &&
      canEdit
    ) {
      items.push({
        label: this.callbacks.t('toolbar.edit'),
        icon: 'pencil',
        onSelect: () => this.callbacks.editCard(single.id),
      })
    }
    // A group has no content to edit, so the pencil in its place renames it —
    // the same command its label's double-click carries, which is otherwise
    // the only way to find it.
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
