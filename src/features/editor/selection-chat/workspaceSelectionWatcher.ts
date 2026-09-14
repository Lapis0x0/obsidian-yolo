/**
 * Debounced `selectionchange` across every workspace window.
 *
 * `selectionchange` fires on a document, and each Obsidian popout is a
 * separate document. Selection surfaces that are not tied to one editor
 * element (PDF text layers, reading views) have to listen in the main window
 * and in every popout, including ones opened later.
 */

import type { App, EventRef } from 'obsidian'

type WatchedDocument = {
  listener: () => void
  timer: number | null
}

export class WorkspaceSelectionWatcher {
  private readonly documents = new Map<Document, WatchedDocument>()
  private eventRefs: EventRef[] = []

  constructor(
    private readonly app: App,
    private readonly debounceDelay: number,
    private readonly onSelectionChange: (selection: Selection | null) => void,
  ) {}

  start(): void {
    this.watch(document)
    this.app.workspace.iterateAllLeaves((leaf) => {
      this.watch(leaf.view.containerEl.ownerDocument)
    })
    this.eventRefs = [
      this.app.workspace.on('window-open', (_workspaceWindow, win) => {
        this.watch(win.document)
      }),
      this.app.workspace.on('window-close', (_workspaceWindow, win) => {
        this.unwatch(win.document)
      }),
    ]
  }

  stop(): void {
    for (const ref of this.eventRefs) this.app.workspace.offref(ref)
    this.eventRefs = []
    for (const doc of Array.from(this.documents.keys())) this.unwatch(doc)
  }

  private watch(doc: Document): void {
    if (this.documents.has(doc)) return
    const win = doc.defaultView ?? window
    const state: WatchedDocument = {
      timer: null,
      listener: () => {
        if (state.timer !== null) win.clearTimeout(state.timer)
        state.timer = win.setTimeout(() => {
          state.timer = null
          this.onSelectionChange(doc.getSelection())
        }, this.debounceDelay)
      },
    }
    doc.addEventListener('selectionchange', state.listener)
    this.documents.set(doc, state)
  }

  private unwatch(doc: Document): void {
    const state = this.documents.get(doc)
    if (!state) return
    doc.removeEventListener('selectionchange', state.listener)
    if (state.timer !== null) {
      ;(doc.defaultView ?? window).clearTimeout(state.timer)
    }
    this.documents.delete(doc)
  }
}
