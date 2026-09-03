// The panel that asks for one value before a card can be created: which note,
// which media file, or what URL (P3 batch 3 wave B, feature 1).
//
// Obsidian Canvas reaches for a `FuzzySuggestModal` (notes, media) and a small
// prompt modal (website). The Host API publishes neither, and this wave is not
// the place to widen it: a suggester is a *UI* affordance, and the surface a
// module is given (`notice`, `confirm`, `showMenu`) is deliberately about
// host-owned chrome rather than arbitrary dialogs. So the panel is drawn in the
// module — one component for all three prompts, because they differ only in
// whether the typed text is filtered against a list or taken as-is.
//
// A panel in the canvas's own overlay rather than a real modal: it belongs to
// this board, it is dismissed by clicking the board behind it, and it needs no
// host modal stack to be layered correctly in an Obsidian popout.
//
// Popout safety: every element comes from the `Document` handed in, and
// Enter/Escape/arrows are handled on the input element itself (the same reason
// ui/inlineTextInput.ts does) — that is the form that keeps working when this
// view's leaf is in a popout BrowserWindow (Popout / Multi-window, CLAUDE.md).

const BACKDROP_CLASS = 'yolo-whiteboard-prompt-backdrop'
const PANEL_CLASS = 'yolo-whiteboard-prompt'
const TITLE_CLASS = 'yolo-whiteboard-prompt-title'
const INPUT_CLASS = 'yolo-whiteboard-prompt-input'
const LIST_CLASS = 'yolo-whiteboard-prompt-list'
const ITEM_CLASS = 'yolo-whiteboard-prompt-item'
const ITEM_ACTIVE_CLASS = 'yolo-whiteboard-prompt-item-active'
const ITEM_TITLE_CLASS = 'yolo-whiteboard-prompt-item-title'
const ITEM_DETAIL_CLASS = 'yolo-whiteboard-prompt-item-detail'
const EMPTY_CLASS = 'yolo-whiteboard-prompt-empty'
const DROP_ZONE_CLASS = 'yolo-whiteboard-prompt-drop'
const DROP_ZONE_ACTIVE_CLASS = 'yolo-whiteboard-prompt-drop-active'

/** How many matches are drawn. A vault can hold thousands of notes, and a
 * list longer than this is not one anybody reads to the end — they type
 * another character instead. */
const MAX_RENDERED_SUGGESTIONS = 50

export type PromptSuggestion = Readonly<{
  /** What `onSubmit` receives when this row is chosen — a vault path. */
  value: string
  /** Primary line: a file's name. */
  title: string
  /** Secondary line: the containing folder, so two same-named notes differ. */
  detail?: string
}>

export type PromptOverlayMode =
  | Readonly<{ kind: 'text' }>
  | Readonly<{
      kind: 'pick'
      suggestions: readonly PromptSuggestion[]
      emptyText: string
    }>

/**
 * A second way to answer the same ask: instead of typing the value, drop the
 * document itself onto the panel.
 *
 * Only the web prompt has one, because only there does the ask have two
 * honest answers — a page on the network, or a page on disk. It is drawn as
 * part of the panel rather than left to the canvas behind it because the
 * panel is where the user is looking once the button has been pressed; the
 * canvas takes the same drop for the same result (ui/canvas.ts's `onDrop`),
 * and this is the discoverable half of it, not a second mechanism.
 */
export type PromptOverlayDropZone = Readonly<{
  /** Text drawn in the zone. */
  label: string
  /** The dropped files, in the order the browser listed them. Never called
   * with an empty list, and the panel settles as a submission would. */
  onDrop: (files: readonly File[]) => void
}>

export type PromptOverlayOptions = Readonly<{
  title: string
  placeholder: string
  mode: PromptOverlayMode
  dropZone?: PromptOverlayDropZone
  /**
   * The chosen value: the highlighted suggestion's `value` in `pick` mode, or
   * the typed text in `text` mode. Never called with an empty string, and
   * never called at all when the panel is dismissed.
   */
  onSubmit: (value: string) => void
  onClose: () => void
}>

/**
 * Ranked matches for `query`, best first.
 *
 * Case-insensitive substring rather than Obsidian's fuzzy matching, with a
 * name hit ranked above a folder-only hit: a module cannot reach the host's
 * matcher, and an honest substring filter beats a hand-rolled fuzzy scorer
 * that ranks differently from every other search box in the app. An empty
 * query keeps the input order, which is the caller's own (files newest-first,
 * or however it listed them).
 */
export function filterSuggestions(
  suggestions: readonly PromptSuggestion[],
  query: string,
): readonly PromptSuggestion[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return suggestions
  const scored: { suggestion: PromptSuggestion; rank: number }[] = []
  for (const suggestion of suggestions) {
    const inTitle = suggestion.title.toLowerCase().includes(needle)
    const inValue = suggestion.value.toLowerCase().includes(needle)
    if (!inTitle && !inValue) continue
    scored.push({ suggestion, rank: inTitle ? 0 : 1 })
  }
  // Stable within a rank, so equally-good matches keep the caller's order.
  scored.sort((a, b) => a.rank - b.rank)
  return scored.map((entry) => entry.suggestion)
}

export class PromptOverlay {
  private readonly backdropEl: HTMLElement
  private readonly inputEl: HTMLInputElement
  private readonly listEl: HTMLElement | null
  private matches: readonly PromptSuggestion[] = []
  private activeIndex = 0
  private settled = false

  constructor(
    private readonly doc: Document,
    parent: HTMLElement,
    private readonly options: PromptOverlayOptions,
  ) {
    const backdrop = doc.createElement('div')
    backdrop.className = BACKDROP_CLASS
    // A press on the board behind the panel dismisses it, the way clicking
    // away from a menu does. Pressing the panel itself must not, so the panel
    // stops the event before it reaches here.
    backdrop.addEventListener('pointerdown', () => this.settle(null))
    // The wheel belongs to the ask, not to the board behind it — the same
    // rule as the press, and for a second reason besides: the panel's own
    // list is a scroller, and the canvas's wheel handler ends in an
    // unconditional `preventDefault` that would take its scrolling away.
    // Stopped rather than prevented: the board's handler is on an ancestor
    // (the panel lives in the canvas overlay, not in a host modal), while
    // native scrolling follows the scroll chain and is left alone.
    //
    // The whole backdrop, not just the panel: where the new card goes was
    // settled before this opened, so panning the board underneath would move
    // the board out from under a point the card is still going to land on.
    backdrop.addEventListener('wheel', (event) => event.stopPropagation())

    const panel = doc.createElement('div')
    panel.className = PANEL_CLASS
    panel.addEventListener('pointerdown', (event) => event.stopPropagation())

    const title = doc.createElement('div')
    title.className = TITLE_CLASS
    title.textContent = options.title
    panel.appendChild(title)

    const input = doc.createElement('input')
    input.type = 'text'
    input.className = INPUT_CLASS
    input.placeholder = options.placeholder
    input.setAttribute('aria-label', options.title)
    input.addEventListener('keydown', (event) => this.onKeyDown(event))
    panel.appendChild(input)
    this.inputEl = input

    if (options.mode.kind === 'pick') {
      const list = doc.createElement('div')
      list.className = LIST_CLASS
      panel.appendChild(list)
      this.listEl = list
      input.addEventListener('input', () => this.refreshMatches())
    } else {
      this.listEl = null
    }

    if (options.dropZone)
      panel.appendChild(this.createDropZone(options.dropZone))

    backdrop.appendChild(panel)
    parent.appendChild(backdrop)
    this.backdropEl = backdrop

    if (options.mode.kind === 'pick') this.refreshMatches()
    input.focus()
  }

  contains(node: Node): boolean {
    return this.backdropEl === node || this.backdropEl.contains(node)
  }

  /** Dismisses from outside (the view is closing). */
  close(): void {
    this.settle(null)
  }

  // -- internals ----------------------------------------------------------

  /**
   * The panel's drop target.
   *
   * Every drag event is stopped as well as prevented: the canvas listens for
   * the same three on an ancestor of this panel, and without that it would
   * both light its own drop outline and take the drop a second time.
   */
  private createDropZone(dropZone: PromptOverlayDropZone): HTMLElement {
    const zone = this.doc.createElement('div')
    zone.className = DROP_ZONE_CLASS
    zone.textContent = dropZone.label
    zone.addEventListener('dragover', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      zone.classList.add(DROP_ZONE_ACTIVE_CLASS)
    })
    zone.addEventListener('dragleave', (event) => {
      event.stopPropagation()
      const related = event.relatedTarget
      if (related instanceof Node && zone.contains(related)) return
      zone.classList.remove(DROP_ZONE_ACTIVE_CLASS)
    })
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      event.stopPropagation()
      zone.classList.remove(DROP_ZONE_ACTIVE_CLASS)
      const files = Array.from(event.dataTransfer?.files ?? [])
      // A drag carrying no file at all — a selection of text, a vault note —
      // leaves the panel open rather than dismissing it on nothing.
      if (files.length === 0) return
      this.finish(() => dropZone.onDrop(files))
    })
    return zone
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      this.settle(null)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      this.settle(this.currentValue())
      return
    }
    if (this.listEl === null) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      this.setActiveIndex(this.activeIndex + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      this.setActiveIndex(this.activeIndex - 1)
    }
  }

  /** What Enter commits: the highlighted row, or the raw text when there is
   * no list. Null when there is nothing to commit — an empty box, or a query
   * that matches no file — so Enter is inert rather than closing on nothing. */
  private currentValue(): string | null {
    if (this.listEl === null) {
      const typed = this.inputEl.value.trim()
      return typed.length > 0 ? typed : null
    }
    return this.matches[this.activeIndex]?.value ?? null
  }

  private refreshMatches(): void {
    const mode = this.options.mode
    if (this.listEl === null || mode.kind !== 'pick') return
    this.matches = filterSuggestions(
      mode.suggestions,
      this.inputEl.value,
    ).slice(0, MAX_RENDERED_SUGGESTIONS)
    this.activeIndex = 0
    this.listEl.replaceChildren()

    if (this.matches.length === 0) {
      const empty = this.doc.createElement('div')
      empty.className = EMPTY_CLASS
      empty.textContent = mode.emptyText
      this.listEl.appendChild(empty)
      return
    }

    for (const [index, suggestion] of this.matches.entries()) {
      const item = this.doc.createElement('div')
      item.className = ITEM_CLASS
      const title = this.doc.createElement('div')
      title.className = ITEM_TITLE_CLASS
      title.textContent = suggestion.title
      item.appendChild(title)
      if (suggestion.detail) {
        const detail = this.doc.createElement('div')
        detail.className = ITEM_DETAIL_CLASS
        detail.textContent = suggestion.detail
        item.appendChild(detail)
      }
      // Highlight follows the pointer so the keyboard and the mouse agree on
      // what Enter would take.
      item.addEventListener('pointerenter', () => this.setActiveIndex(index))
      item.addEventListener('click', () => this.settle(suggestion.value))
      this.listEl.appendChild(item)
    }
    this.markActiveItem()
  }

  private setActiveIndex(index: number): void {
    if (this.matches.length === 0) return
    // Wraps, so ArrowUp from the first row reaches the last — the behaviour of
    // every suggester in Obsidian.
    const count = this.matches.length
    this.activeIndex = ((index % count) + count) % count
    this.markActiveItem()
  }

  private markActiveItem(): void {
    if (!this.listEl) return
    for (const [index, child] of Array.from(this.listEl.children).entries()) {
      const active = index === this.activeIndex
      child.classList.toggle(ITEM_ACTIVE_CLASS, active)
      if (active) child.scrollIntoView({ block: 'nearest' })
    }
  }

  private settle(value: string | null): void {
    this.finish(value === null ? null : () => this.options.onSubmit(value))
  }

  /** Closes the panel exactly once, running `commit` — what the user chose,
   * or nothing at all when they dismissed it — before saying so. */
  private finish(commit: (() => void) | null): void {
    if (this.settled) return
    this.settled = true
    this.backdropEl.remove()
    commit?.()
    this.options.onClose()
  }
}
