// The frame around a selected PDF spread (domain/spread.ts), and the one way
// a spread is laid out again as a grid: dragging the frame's right edge.
//
// Shown while a spread's title is the lone selection — the title is the
// document, and the frame is what "the whole document" covers on the board:
// the union of the title and every sheet, wherever they have been put. Its
// right edge is dragged sideways to say how wide the document should be;
// every sheet is laid out again under the title at that many columns,
// snapping to whole columns as the pointer passes them
// (`spreadColumnsForWidth`), and the frame follows the grid it makes. It
// takes back sheets that were moved away on their own: the grid is a way of
// arranging the whole document, not a place some of it belongs to. A drag is
// one undo step, however many column counts it passed through.
//
// World-layer DOM, like the snap guides: stated in world coordinates, drawn
// over the cards. The frame itself takes no pointer; only its right edge
// does, and a press on it stops there, so the board never sees a marquee
// begin.
//
// Popout safety: everything comes from the `Document` handed in, and the
// drag listens on that document's window.

import { unionRect } from '../../domain/camera'
import type { Board, NodeId } from '../../domain/fileFormat'
import {
  currentSpreadColumns,
  isSpreadTitle,
  spreadColumnsForWidth,
  spreadPages,
} from '../../domain/spread'

const FRAME_CLASS = 'yolo-whiteboard-spread-frame'
const FRAME_HIDDEN_CLASS = 'yolo-whiteboard-spread-frame-hidden'
/** The frame's right edge: what is dragged to lay the spread out again. */
const EDGE_CLASS = 'yolo-whiteboard-spread-frame-edge'
/** On the frame for the length of a drag, so the edge stays lit. */
const DRAGGING_CLASS = 'yolo-whiteboard-spread-frame-dragging'
/** How far outside the sheets the frame is drawn, in world units. */
const FRAME_PADDING = 13

export type SpreadFrameDeps = Readonly<{
  getBoard: () => Board
  getSelectedIds: () => ReadonlySet<NodeId>
  canEdit: () => boolean
  isOverview: () => boolean
  worldPointFromEvent: (e: MouseEvent) => Readonly<{ x: number; y: number }>
  /** Lays the spread out again at `columns` across, as part of the step
   * `historyKey` names. */
  reflow: (id: NodeId, columns: number, historyKey: string) => void
}>

export class SpreadFrame {
  private readonly frameEl: HTMLElement
  private readonly edgeEl: HTMLElement
  private titleId: NodeId | null = null
  private drag: Readonly<{
    pointerId: number
    id: NodeId
    historyKey: string
  }> | null = null
  private columns = 0
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
    this.frameEl.appendChild(this.edgeEl)
    parent.appendChild(this.frameEl)
    this.edgeEl.addEventListener('pointerdown', this.onPointerDown)
  }

  /** The counter-scaled chrome element (CameraController's applyZoomScale):
   * the handle keeps its size on screen at every zoom. */
  get element(): HTMLElement {
    return this.frameEl
  }

  destroy(): void {
    this.endDrag()
    this.edgeEl.removeEventListener('pointerdown', this.onPointerDown)
    this.frameEl.remove()
  }

  /** Puts the frame around the selected spread, or takes it away — after
   * anything that could have changed which spread that is or where its
   * sheets are. */
  sync(): void {
    const board = this.deps.getBoard()
    const selected = this.deps.getSelectedIds()
    let id: NodeId | null = null
    if (selected.size === 1 && !this.deps.isOverview()) {
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
    const bounds =
      title && sheets.length > 0 ? unionRect([title, ...sheets]) : null
    this.frameEl.classList.toggle(FRAME_HIDDEN_CLASS, bounds === null)
    if (!bounds) return
    this.frameEl.style.left = `${bounds.x - FRAME_PADDING}px`
    this.frameEl.style.top = `${bounds.y - FRAME_PADDING}px`
    this.frameEl.style.width = `${bounds.w + FRAME_PADDING * 2}px`
    this.frameEl.style.height = `${bounds.h + FRAME_PADDING * 2}px`
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.titleId === null || !this.deps.canEdit()) return
    // The press is the edge's: not a marquee, not a pan, not a click that
    // clears the selection this frame belongs to.
    e.stopPropagation()
    e.preventDefault()
    const sheets = spreadPages(this.deps.getBoard(), this.titleId)
    this.columns = currentSpreadColumns(sheets)
    this.dragCount += 1
    this.drag = {
      pointerId: e.pointerId,
      id: this.titleId,
      historyKey: `spread-reflow-${this.titleId}-${this.dragCount}`,
    }
    this.frameEl.classList.add(DRAGGING_CLASS)
    const win = this.doc.defaultView
    win?.addEventListener('pointermove', this.onPointerMove)
    win?.addEventListener('pointerup', this.onPointerUp)
    win?.addEventListener('pointercancel', this.onPointerUp)
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const drag = this.drag
    if (!drag || e.pointerId !== drag.pointerId) return
    const title = this.deps.getBoard().nodes.find((node) => node.id === drag.id)
    if (!title) {
      this.endDrag()
      return
    }
    const point = this.deps.worldPointFromEvent(e)
    const columns = spreadColumnsForWidth(point.x - title.x)
    if (columns === this.columns) return
    this.columns = columns
    this.deps.reflow(drag.id, columns, drag.historyKey)
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
    this.frameEl.classList.remove(DRAGGING_CLASS)
  }
}
