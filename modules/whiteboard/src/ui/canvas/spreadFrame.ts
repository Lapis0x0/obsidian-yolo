// The frame around a selected PDF spread (domain/spread.ts), and the two ways
// the whole document is reshaped by hand: its right edge, and its corner.
//
// Shown while a spread's title is the lone selection, at every zoom — the
// overview tier is where a long document is seen whole, so where it is most
// often reshaped. The title is the document, and the frame is what "the
// whole document" covers on the board: the union of the title and every
// sheet, wherever they have been put.
//
// - The right edge is dragged sideways to say how many columns the document
//   takes: every sheet is laid out again under the title at that many
//   across, snapping to whole columns as the pointer passes them
//   (`spreadColumnsForWidth`). It takes back sheets moved away on their own:
//   the grid is a way of arranging the whole document.
// - The bottom-right corner is dragged to say how big a page is: the whole
//   document scales about the title's corner (`scaleSpread`), arrangement
//   and all, in whole grid cells.
//
// A drag is one undo step, however many sizes it passed through.
//
// World-layer DOM, like the snap guides: stated in world coordinates, drawn
// over the cards. The frame itself takes no pointer; only its edge and
// corner do, and a press on them stops there, so the board never sees a
// marquee begin.
//
// Popout safety: everything comes from the `Document` handed in, and the
// drag listens on that document's window.

import { unionRect } from '../../domain/camera'
import type { Board, NodeId } from '../../domain/fileFormat'
import type { CardRect } from '../../domain/resize'
import {
  currentSpreadColumns,
  isSpreadTitle,
  SPREAD_METRICS,
  spreadColumnsForWidth,
  spreadPages,
} from '../../domain/spread'
import { GRID_WORLD_STEP_PX } from '../constants'

const FRAME_CLASS = 'yolo-whiteboard-spread-frame'
const FRAME_HIDDEN_CLASS = 'yolo-whiteboard-spread-frame-hidden'
/** The frame's right edge: what is dragged to lay the spread out again. */
const EDGE_CLASS = 'yolo-whiteboard-spread-frame-edge'
/** The frame's bottom-right corner: what is dragged to size the pages. */
const CORNER_CLASS = 'yolo-whiteboard-spread-frame-corner'
/** On the frame for the length of a drag, with the part being dragged. */
const DRAGGING_CLASS = 'yolo-whiteboard-spread-frame-dragging'
const DRAGGING_PART_CLASS = {
  edge: 'yolo-whiteboard-spread-frame-dragging-edge',
  corner: 'yolo-whiteboard-spread-frame-dragging-corner',
} as const
/** The smallest and largest a page is sized to by the corner, in grid cells:
 * from a thumbnail to about four new cards across. */
const PAGE_WIDTH_CELLS = { min: 10, max: 120 } as const
/** How far outside the sheets the frame is drawn, in world units. */
const FRAME_PADDING = 13

export type SpreadFrameDeps = Readonly<{
  getBoard: () => Board
  getSelectedIds: () => ReadonlySet<NodeId>
  /** Where a drag in progress has put the cards it moves, before the board
   * is told — the frame goes with them. */
  getLiveRects: () => ReadonlyMap<NodeId, CardRect> | null
  canEdit: () => boolean
  worldPointFromEvent: (e: MouseEvent) => Readonly<{ x: number; y: number }>
  /** Lays the spread out again at `columns` across, as part of the step
   * `historyKey` names. */
  reflow: (id: NodeId, columns: number, historyKey: string) => void
  /** Makes the spread's pages `pageWidth` wide, the whole document scaled
   * with them, as part of the step `historyKey` names. */
  resize: (id: NodeId, pageWidth: number, historyKey: string) => void
}>

type DragPart = keyof typeof DRAGGING_PART_CLASS

export class SpreadFrame {
  private readonly frameEl: HTMLElement
  private readonly edgeEl: HTMLElement
  private readonly cornerEl: HTMLElement
  private titleId: NodeId | null = null
  private drag: Readonly<{
    pointerId: number
    id: NodeId
    part: DragPart
    historyKey: string
    /** Corner only: the page width, and the frame's reach right of the
     * title's left edge, when the drag began — the pointer's reach is read
     * against it, since the whole document scales about that edge. */
    startPageWidth: number
    startReach: number
  }> | null = null
  /** The last column count (edge) or page width (corner) asked for. */
  private asked = 0
  private dragCount = 0

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
    private readonly deps: SpreadFrameDeps,
  ) {
    this.frameEl = doc.createElement('div')
    this.frameEl.className = `${FRAME_CLASS} ${FRAME_HIDDEN_CLASS}`
    this.edgeEl = doc.createElement('div')
    this.edgeEl.className = EDGE_CLASS
    this.cornerEl = doc.createElement('div')
    this.cornerEl.className = CORNER_CLASS
    this.frameEl.append(this.edgeEl, this.cornerEl)
    parent.appendChild(this.frameEl)
    this.edgeEl.addEventListener('pointerdown', this.onEdgePointerDown)
    this.cornerEl.addEventListener('pointerdown', this.onCornerPointerDown)
  }

  /** The counter-scaled chrome element (CameraController's applyZoomScale):
   * the handle keeps its size on screen at every zoom. */
  get element(): HTMLElement {
    return this.frameEl
  }

  destroy(): void {
    this.endDrag()
    this.edgeEl.removeEventListener('pointerdown', this.onEdgePointerDown)
    this.cornerEl.removeEventListener('pointerdown', this.onCornerPointerDown)
    this.frameEl.remove()
  }

  /** Puts the frame around the selected spread, or takes it away — after
   * anything that could have changed which spread that is or where its
   * sheets are. */
  sync(): void {
    const board = this.deps.getBoard()
    const selected = this.deps.getSelectedIds()
    let id: NodeId | null = null
    if (selected.size === 1) {
      const only = selected.values().next().value
      const node = board.nodes.find((candidate) => candidate.id === only)
      if (isSpreadTitle(node)) id = node.id
    }
    // A drag in progress keeps its spread, whatever the selection does.
    if (this.drag) id = this.drag.id
    this.titleId = id
    const title =
      id === null ? undefined : board.nodes.find((node) => node.id === id)
    const sheets = id === null ? [] : spreadPages(board, id)
    const live = this.deps.getLiveRects()
    const at = (node: CardRect & { id: NodeId }): CardRect =>
      live?.get(node.id) ?? node
    const bounds =
      title && sheets.length > 0
        ? unionRect([at(title), ...sheets.map(at)])
        : null
    this.frameEl.classList.toggle(FRAME_HIDDEN_CLASS, bounds === null)
    if (!bounds) return
    this.frameEl.style.left = `${bounds.x - FRAME_PADDING}px`
    this.frameEl.style.top = `${bounds.y - FRAME_PADDING}px`
    this.frameEl.style.width = `${bounds.w + FRAME_PADDING * 2}px`
    this.frameEl.style.height = `${bounds.h + FRAME_PADDING * 2}px`
  }

  private readonly onEdgePointerDown = (e: PointerEvent): void => {
    this.beginDrag(e, 'edge')
  }

  private readonly onCornerPointerDown = (e: PointerEvent): void => {
    this.beginDrag(e, 'corner')
  }

  private beginDrag(e: PointerEvent, part: DragPart): void {
    if (e.button !== 0 || this.titleId === null || !this.deps.canEdit()) return
    const board = this.deps.getBoard()
    const title = board.nodes.find((node) => node.id === this.titleId)
    const sheets = spreadPages(board, this.titleId)
    if (!title || sheets.length === 0) return
    // The press is the frame's: not a marquee, not a pan, not a click that
    // clears the selection this frame belongs to.
    e.stopPropagation()
    e.preventDefault()
    const bounds = unionRect([title, ...sheets])
    this.asked = part === 'edge' ? currentSpreadColumns(sheets) : sheets[0].w
    this.dragCount += 1
    this.drag = {
      pointerId: e.pointerId,
      id: this.titleId,
      part,
      historyKey: `spread-${part}-${this.titleId}-${this.dragCount}`,
      startPageWidth: sheets[0].w,
      startReach: bounds ? bounds.x + bounds.w - title.x : sheets[0].w,
    }
    this.frameEl.classList.add(DRAGGING_CLASS, DRAGGING_PART_CLASS[part])
    const win = this.doc.defaultView
    win?.addEventListener('pointermove', this.onPointerMove)
    win?.addEventListener('pointerup', this.onPointerUp)
    win?.addEventListener('pointercancel', this.onPointerUp)
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const drag = this.drag
    if (!drag || e.pointerId !== drag.pointerId) return
    const board = this.deps.getBoard()
    const title = board.nodes.find((node) => node.id === drag.id)
    const sheets = spreadPages(board, drag.id)
    if (!title || sheets.length === 0) {
      this.endDrag()
      return
    }
    const reach = this.deps.worldPointFromEvent(e).x - title.x
    if (drag.part === 'edge') {
      const columns = spreadColumnsForWidth(reach, {
        ...SPREAD_METRICS,
        pageWidth: sheets[0].w,
      })
      if (columns === this.asked) return
      this.asked = columns
      this.deps.reflow(drag.id, columns, drag.historyKey)
      return
    }
    // The document scales about the title's left edge, so the frame's right
    // side moves in proportion to the page width: the pointer's reach, over
    // the reach the drag began with, is the factor.
    const cells = Math.round(
      (drag.startPageWidth * reach) / drag.startReach / GRID_WORLD_STEP_PX,
    )
    const pageWidth =
      Math.min(PAGE_WIDTH_CELLS.max, Math.max(PAGE_WIDTH_CELLS.min, cells)) *
      GRID_WORLD_STEP_PX
    if (pageWidth === this.asked) return
    this.asked = pageWidth
    this.deps.resize(drag.id, pageWidth, drag.historyKey)
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.drag && e.pointerId !== this.drag.pointerId) return
    this.endDrag()
    this.sync()
  }

  private endDrag(): void {
    const win = this.doc.defaultView
    win?.removeEventListener('pointermove', this.onPointerMove)
    win?.removeEventListener('pointerup', this.onPointerUp)
    win?.removeEventListener('pointercancel', this.onPointerUp)
    this.drag = null
    this.frameEl.classList.remove(
      DRAGGING_CLASS,
      ...Object.values(DRAGGING_PART_CLASS),
    )
  }
}
