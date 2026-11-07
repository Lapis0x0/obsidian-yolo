// The board's find: a bar over the board (in the overlay, top middle), the
// text of every text and note card searched (../../domain/boardFind.ts), and
// a hit at a time brought to (`reveal`) — the way the PDF reader's find
// works on a document (../pdf/pdfSearch.ts), and with the same keys: Enter
// and Shift+Enter step, Escape closes.
//
// Most cards are drawn rather than built, so there is no DOM to search: the
// text is the cards' own — a text card's Markdown, a note card's note, read
// here and kept until it changes. What is found is a place in a card's
// source; where that is on the board, and how it is marked, is the canvas's
// (`reveal`, `showHits`).

import {
  BoardFind,
  type FindHit,
  type FindableCard,
} from '../../domain/boardFind'
import type { BoardNode } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import { noteBody } from '../../host/noteText'
import { createReaderIconButton } from '../pdf/icons'

export type { FindHit } from '../../domain/boardFind'

export type FindControllerDeps = Readonly<{
  /** Where the bar goes: the board's overlay. */
  overlay: HTMLElement
  t: (key: string) => string
  /** The board's cards. */
  nodes: () => readonly BoardNode[]
  readNote: (path: string) => Promise<string | null>
  /** The world point at the middle of the viewport: where the first hit is
   * looked for from. */
  viewCenter: () => Readonly<{ x: number; y: number }>
  /** Brings a hit to view; its card's source is what it is a place in. */
  reveal: (hit: FindHit, source: string) => void
  /** Every hit to mark, and the one stepped to; none when the bar closes. */
  showHits: (
    hits: readonly Readonly<{ hit: FindHit; source: string }>[],
    current: FindHit | null,
  ) => void
}>

/** How long typing has to pause before the board is searched again. */
const QUERY_DEBOUNCE_MS = 150

const BAR_CLASS = 'yolo-whiteboard-find'
const INPUT_CLASS = 'yolo-whiteboard-find-input'
const COUNT_CLASS = 'yolo-whiteboard-find-count'
const BUTTON_CLASS = 'yolo-whiteboard-find-button'

type Note = { text: string | null; reading: boolean }

export class FindController {
  private readonly barEl: HTMLElement
  private readonly inputEl: HTMLInputElement
  private readonly countEl: HTMLElement
  private readonly find = new BoardFind()
  /** Note cards' text by path, read once and kept until the note changes. */
  private readonly notes = new Map<string, Note>()
  private query = ''
  private hits: readonly FindHit[] = []
  private sources = new Map<string, string>()
  private current = -1
  private debounceTimer: number | null = null
  /** Notes arrived: searched again once, after the ones arriving together. */
  private refreshTimer: number | null = null

  constructor(private readonly deps: FindControllerDeps) {
    const doc = deps.overlay.ownerDocument
    this.barEl = doc.createElement('div')
    this.barEl.className = BAR_CLASS
    this.barEl.hidden = true
    this.inputEl = doc.createElement('input')
    this.inputEl.className = INPUT_CLASS
    this.inputEl.type = 'text'
    this.inputEl.spellcheck = false
    this.inputEl.placeholder = deps.t('find.placeholder')
    this.countEl = doc.createElement('span')
    this.countEl.className = COUNT_CLASS
    this.barEl.append(
      this.inputEl,
      this.countEl,
      createReaderIconButton(
        doc,
        BUTTON_CLASS,
        'chevron-up',
        deps.t('find.previous'),
        () => this.step(-1),
      ),
      createReaderIconButton(
        doc,
        BUTTON_CLASS,
        'chevron-down',
        deps.t('find.next'),
        () => this.step(1),
      ),
      createReaderIconButton(doc, BUTTON_CLASS, 'x', deps.t('find.close'), () =>
        this.close(),
      ),
    )
    deps.overlay.appendChild(this.barEl)
    this.inputEl.addEventListener('input', this.onInput)
    this.inputEl.addEventListener('keydown', this.onKeyDown)
  }

  isOpen(): boolean {
    return !this.barEl.hidden
  }

  /** Shows the bar with the caret in it; a short selection becomes the
   * query, as a browser's find does. */
  open(): void {
    const selected = this.selectedText()
    this.barEl.hidden = false
    if (selected !== null && selected !== this.inputEl.value) {
      this.inputEl.value = selected
    }
    this.inputEl.focus()
    this.inputEl.select()
    this.runQuery(true)
  }

  close(): void {
    if (!this.isOpen()) return
    const hadFocus = this.barEl.ownerDocument.activeElement === this.inputEl
    this.barEl.hidden = true
    this.cancelDebounce()
    this.query = ''
    this.hits = []
    this.current = -1
    this.deps.showHits([], null)
    if (hadFocus) this.inputEl.blur()
  }

  /** A file changed: a note read from it is read again when next wanted. */
  fileChanged(path: string): void {
    if (!this.notes.delete(path) || !this.isOpen()) return
    this.refresh()
  }

  /** The board's cards changed: what is found is found again. */
  boardChanged(): void {
    if (this.isOpen()) this.refresh()
  }

  destroy(): void {
    this.cancelDebounce()
    if (this.refreshTimer !== null) {
      this.barEl.ownerDocument.defaultView?.clearTimeout(this.refreshTimer)
    }
    this.inputEl.removeEventListener('input', this.onInput)
    this.inputEl.removeEventListener('keydown', this.onKeyDown)
    this.barEl.remove()
  }

  // ---------------------------------------------------------------------

  private readonly onInput = (): void => {
    const win = this.barEl.ownerDocument.defaultView
    if (!win) return
    this.cancelDebounce()
    this.debounceTimer = win.setTimeout(() => {
      this.debounceTimer = null
      this.runQuery(false)
    }, QUERY_DEBOUNCE_MS)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      // Typed but not searched yet: Enter searches rather than stepping
      // through the last query's hits.
      if (this.debounceTimer !== null || this.inputEl.value !== this.query) {
        this.runQuery(false)
        return
      }
      this.step(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    }
  }

  private cancelDebounce(): void {
    if (this.debounceTimer === null) return
    this.barEl.ownerDocument.defaultView?.clearTimeout(this.debounceTimer)
    this.debounceTimer = null
  }

  /** Searches for what is typed, from the hit nearest the middle of the
   * viewport. `again`: even when the query is the one already searched. */
  private runQuery(again: boolean): void {
    this.cancelDebounce()
    const query = this.inputEl.value
    if (!again && query === this.query) return
    this.query = query
    this.current = -1
    this.refresh()
  }

  /** Searches the cards as they are now, keeping the hit stepped to where
   * it is still there. */
  private refresh(): void {
    const cards = this.cards()
    const before = this.hits[this.current] ?? null
    this.sources = new Map(cards.map((card) => [card.id, card.source]))
    this.hits = this.find.find(cards, this.query)
    this.current = before
      ? this.hits.findIndex(
          (hit) => hit.id === before.id && hit.start === before.start,
        )
      : -1
    if (this.current === -1 && this.hits.length > 0) {
      this.current = this.nearest()
      this.reveal()
    }
    this.render()
  }

  private step(direction: 1 | -1): void {
    if (this.hits.length === 0) return
    this.current =
      (this.current + direction + this.hits.length) % this.hits.length
    this.reveal()
    this.render()
  }

  private reveal(): void {
    const hit = this.hits[this.current]
    if (hit) this.deps.reveal(hit, this.sources.get(hit.id) ?? '')
  }

  private render(): void {
    const reading = [...this.notes.values()].some((note) => note.reading)
    const total = this.hits.length
    this.countEl.textContent =
      this.query.trim() === ''
        ? ''
        : total === 0
          ? reading
            ? '…'
            : this.deps.t('find.noResults')
          : `${String(this.current + 1)} / ${String(total)}${reading ? '…' : ''}`
    const current = this.hits[this.current] ?? null
    this.deps.showHits(
      this.hits.map((hit) => ({ hit, source: this.sources.get(hit.id) ?? '' })),
      current,
    )
  }

  /** The first hit of the card nearest the middle of the viewport. */
  private nearest(): number {
    const center = this.deps.viewCenter()
    const byId = new Map(this.deps.nodes().map((node) => [node.id, node]))
    let best = 0
    let bestDistance = Infinity
    this.hits.forEach((hit, index) => {
      const node = byId.get(hit.id)
      if (!node) return
      const distance = Math.hypot(
        node.x + node.w / 2 - center.x,
        node.y + node.h / 2 - center.y,
      )
      if (distance < bestDistance) {
        best = index
        bestDistance = distance
      }
    })
    return best
  }

  /** The text and note cards, top to bottom and left to right, with their
   * text — a note's read first, and searched again once it is there. */
  private cards(): FindableCard[] {
    const cards: (FindableCard & { y: number; x: number })[] = []
    for (const node of this.deps.nodes()) {
      if (node.type === 'text') {
        cards.push({
          id: node.id,
          source: node.text,
          from: 0,
          y: node.y,
          x: node.x,
        })
        continue
      }
      if (node.type !== 'file' || fileNodeKind(node.file) !== 'markdown') {
        continue
      }
      const text = this.noteText(node.file)
      if (text === null) continue
      cards.push({
        id: node.id,
        source: text,
        from: text.length - noteBody(text).length,
        y: node.y,
        x: node.x,
      })
    }
    return cards.sort((a, b) => a.y - b.y || a.x - b.x)
  }

  private noteText(path: string): string | null {
    const known = this.notes.get(path)
    if (known) return known.text
    const note: Note = { text: null, reading: true }
    this.notes.set(path, note)
    void this.deps.readNote(path).then((text) => {
      note.text = text ?? ''
      note.reading = false
      if (this.notes.get(path) === note) this.scheduleRefresh()
    })
    return null
  }

  private scheduleRefresh(): void {
    const win = this.barEl.ownerDocument.defaultView
    if (!win || this.refreshTimer !== null) return
    this.refreshTimer = win.setTimeout(() => {
      this.refreshTimer = null
      if (this.isOpen()) this.refresh()
    }, 0)
  }

  private selectedText(): string | null {
    const text = this.barEl.ownerDocument.getSelection()?.toString().trim()
    if (!text || text.length > 200 || text.includes('\n')) return null
    return text
  }
}
