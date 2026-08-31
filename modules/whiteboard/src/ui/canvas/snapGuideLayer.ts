// The lines a drag or a resize draws to say what it has lined up with
// (domain/snapping.ts decides *what* lined up; this only draws it). Split out
// of `../canvas.ts` for the same reason as its neighbours here: that file
// owns the gesture and the board, and hands this class a list of guides.
//
// One SVG in the world layer, so a guide is stated in the same world
// coordinates the snapping thought in and needs no projection. It paints over
// the cards — an alignment you cannot see behind the card that caused it is
// not feedback.
//
// Modelled on Obsidian Canvas's `.canvas-snaps`: a line per alignment with a
// dot at each anchor that took part, so "these three left edges" reads as
// three dots on one line.
//
// Popout safety: every element is created from the `Document` handed in,
// never the global one (Popout / Multi-window, CLAUDE.md).

import type { SnapGuide } from '../../domain/snapping'

const SVG_NS = 'http://www.w3.org/2000/svg'
const LAYER_CLASS = 'yolo-whiteboard-snap-guides'
const MARK_RADIUS = 3

export class SnapGuideLayer {
  private readonly el: SVGElement
  /** What is currently drawn, so a pointer event that changes nothing —
   * which is most of them, since a guide either holds or is gone — does not
   * rebuild the layer. */
  private drawn = ''

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
  ) {
    this.el = doc.createElementNS(SVG_NS, 'svg')
    this.el.setAttribute('class', LAYER_CLASS)
    parent.appendChild(this.el)
  }

  show(guides: readonly SnapGuide[]): void {
    const key = guides
      .map((g) => `${g.axis}${g.position},${g.from},${g.to},${g.marks}`)
      .join('|')
    if (key === this.drawn) return
    this.drawn = key
    this.el.replaceChildren()
    for (const guide of guides) {
      const horizontal = guide.axis === 'y'
      this.line(
        horizontal ? guide.from : guide.position,
        horizontal ? guide.position : guide.from,
        horizontal ? guide.to : guide.position,
        horizontal ? guide.position : guide.to,
      )
      for (const mark of guide.marks) {
        this.mark(
          horizontal ? mark : guide.position,
          horizontal ? guide.position : mark,
        )
      }
    }
  }

  clear(): void {
    if (this.drawn === '') return
    this.drawn = ''
    this.el.replaceChildren()
  }

  destroy(): void {
    this.el.remove()
  }

  private line(x1: number, y1: number, x2: number, y2: number): void {
    const line = this.doc.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', String(x1))
    line.setAttribute('y1', String(y1))
    line.setAttribute('x2', String(x2))
    line.setAttribute('y2', String(y2))
    this.el.appendChild(line)
  }

  private mark(x: number, y: number): void {
    const circle = this.doc.createElementNS(SVG_NS, 'circle')
    circle.setAttribute('cx', String(x))
    circle.setAttribute('cy', String(y))
    circle.setAttribute('r', String(MARK_RADIUS))
    this.el.appendChild(circle)
  }
}
