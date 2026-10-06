// The handles of a selected edge's passages: one at the first and one at the
// last character of each passage the edge reaches, where its card shows it.
// Dragged, an end of the passage follows the pointer to the nearest word's
// edge and the other stays, so a connection that snapped to a whole
// paragraph is narrowed to the sentence it meant, or widened to more — the
// edge redrawn as it goes, the whole drag one undo step.
//
// World-layer DOM like the spread frame (./spreadFrame.ts): stated in world
// coordinates, drawn over the cards, and a press on a handle stops there, so
// the board never sees it begin a gesture of its own.
//
// Popout safety: everything comes from the `Document` handed in, and the
// drag listens on that document's window.

import type { ScreenPoint } from '../../domain/camera'
import type { Edge, EdgeAnchor, EdgeId, NodeId } from '../../domain/fileFormat'
import type { PassageEnds } from '../pdf/pdfReader'

const LAYER_CLASS = 'yolo-whiteboard-passage-handles'
const HANDLE_CLASS = 'yolo-whiteboard-passage-handle'
const HANDLE_DRAGGING_CLASS = 'yolo-whiteboard-passage-handle-dragging'

type End = 'from' | 'to'
type Moving = 'start' | 'end'

export type PassageHandlesDeps = Readonly<{
  /** The one edge selected, or null. */
  getSelectedEdge: () => Edge | null
  canEdit: () => boolean
  /** Where a passage's ends are on screen in its card, or null. */
  passageEnds: (nodeId: NodeId, anchor: EdgeAnchor) => PassageEnds | null
  /** The passage with one end moved to a client point. */
  adjust: (
    nodeId: NodeId,
    anchor: EdgeAnchor,
    moving: Moving,
    clientX: number,
    clientY: number,
  ) => Promise<EdgeAnchor | null>
  /** Gives an edge end a passage, as part of the step `historyKey` names. */
  setAnchor: (
    edgeId: EdgeId,
    end: End,
    anchor: EdgeAnchor,
    historyKey: string,
  ) => void
  worldPoint: (
    point: Readonly<{ clientX: number; clientY: number }>,
  ) => ScreenPoint
}>

type Drag = {
  readonly pointerId: number
  readonly edgeId: EdgeId
  readonly end: End
  readonly moving: Moving
  readonly historyKey: string
  readonly el: HTMLElement
  ticket: number
}

export class PassageHandles {
  private readonly layerEl: HTMLElement
  private drag: Drag | null = null
  private dragCount = 0

  constructor(
    private readonly doc: Document,
    worldEl: HTMLElement,
    private readonly deps: PassageHandlesDeps,
  ) {
    this.layerEl = doc.createElement('div')
    this.layerEl.className = LAYER_CLASS
    worldEl.appendChild(this.layerEl)
  }

  /** Puts the handles where the selected edge's passages are now — or
   * takes them away when there is no such edge, or its cards cannot say. */
  sync(): void {
    // A drag in progress owns its handle; the rest follow it on release.
    if (this.drag) return
    const edge = this.deps.getSelectedEdge()
    const handles: HTMLElement[] = []
    if (edge && this.deps.canEdit()) {
      for (const [end, nodeId, anchor] of [
        ['from', edge.fromNode, edge.fromAnchor],
        ['to', edge.toNode, edge.toAnchor],
      ] as const) {
        if (!anchor) continue
        const ends = this.deps.passageEnds(nodeId, anchor)
        if (!ends) continue
        for (const moving of ['start', 'end'] as const) {
          handles.push(this.handle(edge.id, end, moving, ends[moving]))
        }
      }
    }
    this.layerEl.replaceChildren(...handles)
  }

  private handle(
    edgeId: EdgeId,
    end: End,
    moving: Moving,
    at: PassageEnds['start'],
  ): HTMLElement {
    const el = this.doc.createElement('div')
    el.className = HANDLE_CLASS
    el.dataset.moving = moving
    this.place(el, at)
    el.addEventListener('pointerdown', (event) =>
      this.begin(event, el, edgeId, end, moving),
    )
    return el
  }

  private place(el: HTMLElement, at: PassageEnds['start']): void {
    const top = this.deps.worldPoint({ clientX: at.x, clientY: at.top })
    const bottom = this.deps.worldPoint({ clientX: at.x, clientY: at.bottom })
    el.setCssProps({
      left: `${top.x}px`,
      top: `${top.y}px`,
      height: `${Math.max(0, bottom.y - top.y)}px`,
    })
  }

  private begin(
    event: PointerEvent,
    el: HTMLElement,
    edgeId: EdgeId,
    end: End,
    moving: Moving,
  ): void {
    if (event.button !== 0 || this.drag) return
    // Ours alone: the board must not start a marquee or drop the selection.
    event.stopPropagation()
    event.preventDefault()
    this.drag = {
      pointerId: event.pointerId,
      edgeId,
      end,
      moving,
      historyKey: `passage-handle-${++this.dragCount}`,
      el,
      ticket: 0,
    }
    el.classList.add(HANDLE_DRAGGING_CLASS)
    el.setPointerCapture(event.pointerId)
    const win = this.doc.defaultView
    win?.addEventListener('pointermove', this.onMove)
    win?.addEventListener('pointerup', this.onUp)
    win?.addEventListener('pointercancel', this.onUp)
  }

  private readonly onMove = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    const edge = this.deps.getSelectedEdge()
    if (!edge || edge.id !== drag.edgeId) return
    const nodeId = drag.end === 'from' ? edge.fromNode : edge.toNode
    const anchor = drag.end === 'from' ? edge.fromAnchor : edge.toAnchor
    if (!anchor) return
    const ticket = ++drag.ticket
    void this.deps
      .adjust(nodeId, anchor, drag.moving, event.clientX, event.clientY)
      .then((next) => {
        if (this.drag !== drag || ticket !== drag.ticket || !next) return
        this.deps.setAnchor(drag.edgeId, drag.end, next, drag.historyKey)
        const ends = this.deps.passageEnds(nodeId, next)
        if (ends) this.place(drag.el, ends[drag.moving])
      })
  }

  private readonly onUp = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    this.end()
    this.sync()
  }

  private end(): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    drag.el.classList.remove(HANDLE_DRAGGING_CLASS)
    const win = this.doc.defaultView
    win?.removeEventListener('pointermove', this.onMove)
    win?.removeEventListener('pointerup', this.onUp)
    win?.removeEventListener('pointercancel', this.onUp)
  }

  destroy(): void {
    this.end()
    this.layerEl.remove()
  }
}
