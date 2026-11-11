// What a drag shows about groups before it is put down (styles/cards/
// group.css): every frame where the drop would leave it — following a member
// moved inside it, reaching out to take in a card about to join, letting go
// of one about to leave — the group about to be joined lit, and a tag over
// the dragged cards saying which way they are going.
//
// Nothing here decides anything: dragGestures.ts asks domain/groups.ts what
// the drop would do and hands the answer over, so what is shown is what
// happens on release. The frames are written on the groups' own elements,
// the way a resize writes a card's, and given back to the board's geometry
// when the drag ends.

import type { NodeId } from '../../domain/fileFormat'
import type { CardRect } from '../../domain/resize'

import { nodeElementScale } from './cardContent'
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
  /** Groups whose element is held at a frame the board does not have. */
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
      const el = this.core.getRuntime(id)?.el
      if (!el) continue
      placeFrame(el, rect)
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
    const node = this.core.getNode(id)
    const el = this.core.getRuntime(id)?.el
    if (node && el) placeFrame(el, node)
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

function placeFrame(el: HTMLElement, rect: CardRect): void {
  const scale = nodeElementScale(el)
  el.style.left = `${rect.x}px`
  el.style.top = `${rect.y}px`
  el.style.width = `${rect.w / scale}px`
  el.style.height = `${rect.h / scale}px`
}
