// What a drag shows about groups before it is put down (styles/cards/
// group.css): every frame where the drop would leave it — following a member
// moved inside it, reaching out to take in a card about to join, letting go
// of one about to leave — the group about to be joined lit, and a tag over
// the dragged cards saying which way they are going.
//
// Nothing here decides anything: dragGestures.ts asks domain/groups.ts what
// the drop would do and hands the answer over, so what is shown is what
// happens on release. Each frame is shown going to where the drop would put
// it (./motions.ts's `follow`): one reaching out for a card about to join
// glides out to take it in, and back when the card is taken away again,
// instead of jumping with every pointer move. When the drag ends each goes
// to where the board has it — which, on a drop, is where it was already
// going.

import type { NodeId } from '../../domain/fileFormat'
import type { CardRect } from '../../domain/resize'

import type { CanvasCore } from './core'

const TARGET_CLASS = 'yolo-whiteboard-group-drop-target'
const TAG_CLASS = 'yolo-whiteboard-group-drop-tag'
const TAG_LEAVING_CLASS = 'yolo-whiteboard-group-drop-tag-leaving'

/** How far above the dragged cards' top edge the tag sits, in world units. */
const TAG_LIFT = 30

export type GroupDropTag = Readonly<{
  text: string
  leaving: boolean
  /** The top-left corner of what is being dragged. */
  at: Readonly<{ x: number; y: number }>
}>

export class GroupDropFeedback {
  /** Groups shown at a frame the board does not have. */
  private held = new Set<NodeId>()
  private target: NodeId | null = null
  private tagEl: HTMLElement | null = null

  constructor(
    private readonly core: CanvasCore,
    private readonly worldEl: HTMLElement,
  ) {}

  show(
    frames: ReadonlyMap<NodeId, CardRect>,
    target: NodeId | null,
    tag: GroupDropTag | null,
  ): void {
    for (const id of this.held) {
      if (!frames.has(id)) this.release(id)
    }
    for (const [id, rect] of frames) {
      this.core.motions.follow(id, rect)
      this.held.add(id)
    }
    if (target !== this.target) {
      if (this.target !== null) {
        this.core.getRuntime(this.target)?.el?.classList.remove(TARGET_CLASS)
      }
      this.target = target
    }
    if (target !== null) {
      this.core.getRuntime(target)?.el?.classList.add(TARGET_CLASS)
    }
    this.showTag(tag)
  }

  clear(): void {
    for (const id of this.held) this.release(id)
    if (this.target !== null) {
      this.core.getRuntime(this.target)?.el?.classList.remove(TARGET_CLASS)
      this.target = null
    }
    this.showTag(null)
  }

  /** Back to the frame the board has. */
  private release(id: NodeId): void {
    this.held.delete(id)
    this.core.motions.settle(id, { reshape: true })
  }

  private showTag(tag: GroupDropTag | null): void {
    if (!tag) {
      this.tagEl?.remove()
      this.tagEl = null
      return
    }
    if (!this.tagEl) {
      this.tagEl = this.core.context.getDocument().createElement('div')
      this.tagEl.className = TAG_CLASS
      this.worldEl.appendChild(this.tagEl)
    }
    const el = this.tagEl
    if (el.textContent !== tag.text) el.textContent = tag.text
    el.classList.toggle(TAG_LEAVING_CLASS, tag.leaving)
    el.style.translate = `${tag.at.x}px ${tag.at.y - TAG_LIFT}px`
  }
}
