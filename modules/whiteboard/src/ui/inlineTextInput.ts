// A one-line text field floated over the canvas — currently the edge-label
// editor, and the only editing surface on the board that is neither a card's
// Markdown editor nor a menu.
//
// A plain `<input>` rather than a modal: an edge label is a handful of
// characters attached to a specific place on the canvas, and a dialog would
// take the board off screen to type them. It lives in the screen-space overlay
// (like the toolbar) and is re-positioned as the camera moves, so it stays on
// its edge.
//
// Enter/Escape are handled with a listener on the input element itself, not a
// document-level capture: the event is dispatched to a node in whichever
// Document owns this view, so this is the form that keeps working in an
// Obsidian popout (Popout / Multi-window, CLAUDE.md). Obsidian's keymap is for
// keys that must be caught while focus is elsewhere; this field has focus.

import type { ScreenPoint } from '../domain/camera'

const INPUT_CLASS = 'yolo-whiteboard-inline-input'

export type InlineTextInputOptions = Readonly<{
  value: string
  placeholder: string
  ariaLabel: string
  /** Called once, with the final text, when the field is committed (Enter or
   * blur). Cancelling (Escape) closes without calling it. */
  onCommit: (value: string) => void
  onClose: () => void
}>

export class InlineTextInput {
  private readonly el: HTMLInputElement
  private settled = false

  constructor(
    doc: Document,
    parent: HTMLElement,
    private readonly options: InlineTextInputOptions,
  ) {
    const input = doc.createElement('input')
    input.type = 'text'
    input.className = INPUT_CLASS
    input.value = options.value
    input.placeholder = options.placeholder
    input.setAttribute('aria-label', options.ariaLabel)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        this.settle(true)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        this.settle(false)
      }
    })
    input.addEventListener('blur', () => this.settle(true))
    parent.appendChild(input)
    this.el = input
    input.focus()
    input.select()
  }

  place(point: ScreenPoint): void {
    // The second translate centres the field on the point (the edge's own
    // label anchor). It is written here rather than in the stylesheet because
    // a `transform` written from script replaces the whole property.
    this.el.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`
  }

  contains(node: Node): boolean {
    return this.el === node || this.el.contains(node)
  }

  /** Ends the session from outside (the edge went away, the view is closing),
   * committing whatever is in the field the same way a blur would. */
  close(): void {
    this.settle(true)
  }

  private settle(commit: boolean): void {
    if (this.settled) return
    this.settled = true
    const value = this.el.value
    this.el.remove()
    if (commit) this.options.onCommit(value)
    this.options.onClose()
  }
}
