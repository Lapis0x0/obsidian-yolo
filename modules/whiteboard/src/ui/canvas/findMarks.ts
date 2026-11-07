// What the board's find (./findController.ts) found, marked on the cards: a
// box over each line a hit covers, the hit stepped to stronger. In the world
// layer, so the camera carries them with the cards; the same for a card the
// GPU scene draws and one that is built, since where a hit is comes from the
// canvas either way (`place`).
//
// Where a card's hits are is kept until the card says it moved them — it
// was typeset, built, or scrolled — so scrolling one card places its hits
// again and no other's.

import type { FindHit } from './findController'

/** A box in board units. */
export type FindMarkBox = Readonly<{
  x: number
  y: number
  w: number
  h: number
}>

export type FindMarksDeps = Readonly<{
  /** Where a hit is on the board, a box per line it covers; none while its
   * card does not show it. */
  place: (hit: FindHit, source: string) => readonly FindMarkBox[] | null
  requestFrame: (callback: () => void) => number
}>

type CardHit = Readonly<{ hit: FindHit; source: string }>

/** At most this many hits are marked, the first in the find's order: a
 * query found everywhere is not worth a box per hit on the whole board. */
const MARKS_MAX = 1000

const MARK_CLASS = 'yolo-whiteboard-find-mark'
const CURRENT_CLASS = 'yolo-whiteboard-find-mark-current'

export class FindMarks {
  private readonly layerEl: HTMLElement
  /** The hits marked, by card. */
  private byCard = new Map<string, CardHit[]>()
  private current: FindHit | null = null
  /** Where each card's hits are, in the order of its hits. */
  private readonly placed = new Map<string, (readonly FindMarkBox[] | null)[]>()
  /** Cards whose hits are placed again on the next frame. */
  private readonly stale = new Set<string>()
  private frame: number | null = null

  constructor(
    world: HTMLElement,
    private readonly deps: FindMarksDeps,
  ) {
    this.layerEl = world.ownerDocument.createElement('div')
    this.layerEl.className = 'yolo-whiteboard-find-marks'
    world.appendChild(this.layerEl)
  }

  /** What to mark, and the hit stepped to; none to clear them. */
  show(hits: readonly CardHit[], current: FindHit | null): void {
    this.byCard = new Map()
    for (const entry of hits.slice(0, MARKS_MAX)) {
      const list = this.byCard.get(entry.hit.id)
      if (list) list.push(entry)
      else this.byCard.set(entry.hit.id, [entry])
    }
    this.current = current
    this.placed.clear()
    this.stale.clear()
    for (const id of this.byCard.keys()) this.stale.add(id)
    this.schedule()
  }

  /** A card's text moved: its hits are placed again. */
  cardMoved(id: string): void {
    if (!this.byCard.has(id)) return
    this.stale.add(id)
    this.schedule()
  }

  destroy(): void {
    this.byCard.clear()
    this.layerEl.remove()
  }

  private schedule(): void {
    if (this.frame !== null) return
    this.frame = this.deps.requestFrame(() => {
      this.frame = null
      this.render()
    })
  }

  private render(): void {
    for (const id of this.stale) {
      const hits = this.byCard.get(id)
      if (hits) {
        this.placed.set(
          id,
          hits.map(({ hit, source }) => this.deps.place(hit, source)),
        )
      }
    }
    this.stale.clear()
    const doc = this.layerEl.ownerDocument
    const els: HTMLElement[] = []
    let currentEls: HTMLElement[] = []
    for (const [id, hits] of this.byCard) {
      const placed = this.placed.get(id)
      hits.forEach(({ hit }, i) => {
        const boxes = placed?.[i]
        if (!boxes) return
        const current =
          this.current?.id === hit.id && this.current.start === hit.start
        const made = boxes.map((box) => {
          const el = doc.createElement('div')
          el.className = current ? `${MARK_CLASS} ${CURRENT_CLASS}` : MARK_CLASS
          Object.assign(el.style, {
            left: `${box.x}px`,
            top: `${box.y}px`,
            width: `${box.w}px`,
            height: `${box.h}px`,
          })
          return el
        })
        if (current) currentEls = made
        else els.push(...made)
      })
    }
    // The hit stepped to over any it overlaps.
    this.layerEl.replaceChildren(...els, ...currentEls)
  }
}
