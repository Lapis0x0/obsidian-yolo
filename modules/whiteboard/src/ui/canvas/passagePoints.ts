// The connection points of a passage: text selected in a card on the board
// shows two, at the selection's own left and right edges, level with its
// middle — where an edge reaching that passage ends (domain/edges.ts's
// `resolveEdgeEnds`), so what is dragged out is where the edge will be.
// Pulled out, they start a connection from the passage
// (./connectGesture.ts's `startFromPassage`); the selected text itself, still
// dragged as text, is an excerpt (../pdf/annotationController.ts).
//
// World-layer DOM, sized like the cards' own connection points
// (resize-handles.css): one layer for the board, parked over the card the
// selection is in, shown while that card can say where the passage is.
//
// `WhiteboardCanvas` builds it and is its only importer, together with the
// interaction controller it hands presses to.

import type { EdgeAnchor, NodeId, NodeSide } from '../../domain/fileFormat'
import { asElement } from '../eventTarget'

import type { CardPassagePlacement } from './edgeLayer'

const LAYER_CLASS = 'yolo-whiteboard-passage-points'
const LAYER_HIDDEN_CLASS = 'yolo-whiteboard-passage-points-hidden'
const POINT_CLASS = 'yolo-whiteboard-passage-point'

/** A passage a press on one of its points pulls a connection from. */
export type PassageSource = Readonly<{
  nodeId: NodeId
  side: NodeSide
  anchor: EdgeAnchor
}>

export type PassagePointsDeps = Readonly<{
  getNodeRect: (
    id: NodeId,
  ) => Readonly<{ x: number; y: number; w: number; h: number }> | null
  placePassage: (id: NodeId, anchor: EdgeAnchor) => CardPassagePlacement | null
}>

export class PassagePoints {
  private readonly layerEl: HTMLElement
  private source: Readonly<{ nodeId: NodeId; anchor: EdgeAnchor }> | null = null

  constructor(
    doc: Document,
    worldEl: HTMLElement,
    private readonly deps: PassagePointsDeps,
  ) {
    this.layerEl = doc.createElement('div')
    this.layerEl.className = `${LAYER_CLASS} ${LAYER_HIDDEN_CLASS}`
    for (const side of ['left', 'right'] as const) {
      const el = doc.createElement('div')
      el.className = POINT_CLASS
      el.dataset.side = side
      this.layerEl.appendChild(el)
    }
    worldEl.appendChild(this.layerEl)
  }

  /** The passage selected in `nodeId`'s card, or — with null — none. */
  setSource(
    source: Readonly<{ nodeId: NodeId; anchor: EdgeAnchor }> | null,
  ): void {
    this.source = source
    this.sync()
  }

  /** The passage selected in `nodeId`'s card, if the points stand for one
   * there: a connection let go on it reaches that passage exactly. */
  sourceIn(nodeId: NodeId): EdgeAnchor | null {
    return this.source?.nodeId === nodeId ? this.source.anchor : null
  }

  /** Whether the points are standing for a passage in `nodeId`. */
  isOn(nodeId: NodeId): boolean {
    return this.source?.nodeId === nodeId
  }

  /** Puts the points where the passage now is: its card moved, scrolled,
   * or loaded the page. */
  sync(): void {
    const source = this.source
    const rect = source && this.deps.getNodeRect(source.nodeId)
    const placement =
      source && rect && this.deps.placePassage(source.nodeId, source.anchor)
    if (!rect || !placement || placement.state !== 'visible') {
      this.layerEl.classList.add(LAYER_HIDDEN_CLASS)
      return
    }
    const middle = (placement.top + placement.bottom) / 2
    this.layerEl.setCssProps({
      left: `${rect.x + placement.left}px`,
      top: `${rect.y + middle}px`,
      width: `${Math.max(0, placement.right - placement.left)}px`,
    })
    this.layerEl.classList.remove(LAYER_HIDDEN_CLASS)
  }

  /** The passage and side a press on one of the points pulls from, or null
   * for a press anywhere else. */
  sourceAt(target: EventTarget | null): PassageSource | null {
    const el = asElement(target)
    if (!this.source || !el?.classList.contains(POINT_CLASS)) return null
    const side = (el as HTMLElement).dataset.side
    if (side !== 'left' && side !== 'right') return null
    return { ...this.source, side }
  }

  destroy(): void {
    this.layerEl.remove()
  }
}
