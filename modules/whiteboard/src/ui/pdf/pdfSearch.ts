// In-document search for one PDF reader (./pdfReader.ts): the search bar,
// the scan over the document's text, and the painting of what it found.
//
// The reader is virtualized, so most pages have no text layer to search. The
// scan therefore reads every page's text through the Host API
// (`page.getTextItems()`, which needs no layout) and keeps each hit as a
// selection tuple (./textSearch.ts). A tuple becomes something on screen only
// once its page has a text layer: the reader tells this class when one is
// built or taken down, and a hit on a page that has none yet is revealed by
// going to that page first and finishing the jump when its layer arrives.
//
// Painting is the CSS Custom Highlight API — ranges registered under a name,
// styled by `::highlight(name)` — so nothing is inserted into the text layer
// and nothing here can disturb what a selection lands on. The two names are
// shared by every reader in a window (a panel and a card may both be
// searching); each reader adds and removes only its own ranges. It is also
// kept apart from anything annotations will paint: search owns these two
// highlights and nothing else.

import { createReaderIconButton } from './icons'
import {
  type PageSearchIndex,
  type SearchTuple,
  buildPageSearchIndex,
  findInPage,
  normalizeQuery,
} from './textSearch'

type Translate = (key: string) => string

export type PdfSearchHost = Readonly<{
  /** The reader's root; the bar is added to it. */
  root: HTMLElement
  t: Translate
  getDocument: () => YoloModuleHostPdfDocumentV1 | null
  /** The reader's position, 1-based fractional — where a scan starts. */
  getPosition: () => number
  getTextLayer: (pageIndex: number) => YoloModuleHostPdfTextLayerV1 | null
  /** Brings a hit into view: `range` when its page has a text layer, else
   * null, and the reader goes to the page. */
  reveal: (pageIndex: number, range: Range | null) => void
  reportError?: (stage: string, error: unknown) => void
}>

const MATCH_HIGHLIGHT = 'yolo-whiteboard-pdf-search'
const CURRENT_HIGHLIGHT = 'yolo-whiteboard-pdf-search-current'
/** How long typing has to pause before the document is searched again. */
const QUERY_DEBOUNCE_MS = 150

const BAR_CLASS = 'yolo-whiteboard-pdf-search'
const INPUT_CLASS = 'yolo-whiteboard-pdf-search-input'
const COUNT_CLASS = 'yolo-whiteboard-pdf-search-count'
const BUTTON_CLASS = 'yolo-whiteboard-pdf-search-button'

/** Page text folded for matching, per items array: the engine hands back the
 * same array for a page every time, so the panel's reader and the card's
 * reader over one document share it. */
const indexCache = new WeakMap<
  readonly YoloModuleHostPdfTextItemV1[],
  PageSearchIndex
>()

type Hit = Readonly<{ page: number; index: number }>

// The project's `lib` predates the Set/Map-like members of `Highlight` and
// `HighlightRegistry`, so the surface used is typed here (as the host's
// src/features/editor/selection-highlight/textHighlightRanges.ts does).
type RangeHighlight = {
  priority: number
  add: (range: Range) => void
  delete: (range: Range) => void
}

type HighlightWindow = {
  Highlight?: new () => RangeHighlight
  CSS?: {
    highlights?: {
      get: (name: string) => RangeHighlight | undefined
      set: (name: string, highlight: RangeHighlight) => void
    }
  }
}

export class PdfSearch {
  private readonly barEl: HTMLElement
  private readonly inputEl: HTMLInputElement
  private readonly countEl: HTMLElement
  private query = ''
  /** Bumped by every new scan and by close; a page read for an older one is
   * dropped. */
  private generation = 0
  /** Per page, its hits once read, or null while it has not been. */
  private pageHits: (readonly SearchTuple[] | null)[] = []
  private scanning = false
  private current: Hit | null = null
  /** A hit whose page had no text layer when it was revealed: the jump ends
   * when that layer arrives. */
  private pendingReveal: Hit | null = null
  private readonly painted = new Map<number, Range[]>()
  private debounceTimer: number | null = null
  private destroyed = false

  constructor(private readonly host: PdfSearchHost) {
    const doc = host.root.ownerDocument
    this.barEl = doc.createElement('div')
    this.barEl.className = BAR_CLASS
    this.barEl.hidden = true
    this.inputEl = doc.createElement('input')
    this.inputEl.className = INPUT_CLASS
    this.inputEl.type = 'text'
    this.inputEl.spellcheck = false
    this.inputEl.placeholder = host.t('pdf.searchPlaceholder')
    this.countEl = doc.createElement('span')
    this.countEl.className = COUNT_CLASS
    this.barEl.append(
      this.inputEl,
      this.countEl,
      createReaderIconButton(
        doc,
        BUTTON_CLASS,
        'chevron-up',
        host.t('pdf.searchPrevious'),
        () => this.step(-1),
      ),
      createReaderIconButton(
        doc,
        BUTTON_CLASS,
        'chevron-down',
        host.t('pdf.searchNext'),
        () => this.step(1),
      ),
      createReaderIconButton(
        doc,
        BUTTON_CLASS,
        'x',
        host.t('pdf.searchClose'),
        () => this.close(),
      ),
    )
    host.root.appendChild(this.barEl)
    this.inputEl.addEventListener('input', this.onInput)
    this.inputEl.addEventListener('keydown', this.onKeyDown)
    this.inputEl.addEventListener('focus', this.onFocus)
  }

  isOpen(): boolean {
    return !this.barEl.hidden
  }

  /** Shows the bar with the caret in it. A short selection inside the reader
   * becomes the query, the way a browser's find does. */
  open(): void {
    if (this.destroyed) return
    const selected = this.selectedText()
    this.barEl.hidden = false
    if (selected !== null && selected !== this.inputEl.value) {
      this.inputEl.value = selected
      this.runQuery()
    }
    this.inputEl.focus()
    this.inputEl.select()
  }

  close(): void {
    if (!this.isOpen()) return
    const hadFocus = this.host.root.ownerDocument.activeElement === this.inputEl
    this.barEl.hidden = true
    this.cancelDebounce()
    this.clearResults()
    this.query = ''
    this.inputEl.value = ''
    this.renderCount()
    // Out of the field, but not out of the reader: the next key press still
    // belongs to whatever holds the reader (the panel, or the card).
    if (hadFocus) this.inputEl.blur()
  }

  /** The document was opened again (the file changed): search it afresh. */
  reset(): void {
    if (this.query === '') return
    const query = this.query
    this.query = ''
    this.startScan(query)
  }

  /** A page's text layer was built: paint its hits, and finish a jump that
   * was waiting for it. */
  onTextLayer(pageIndex: number): void {
    this.paintPage(pageIndex)
    const pending = this.pendingReveal
    if (pending?.page === pageIndex) {
      this.pendingReveal = null
      this.revealHit(pending)
    }
  }

  /** A page's text layer went away, taking the nodes its ranges point at. */
  onTextLayerGone(pageIndex: number): void {
    this.unpaintPage(pageIndex)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancelDebounce()
    this.clearResults()
    this.inputEl.removeEventListener('input', this.onInput)
    this.inputEl.removeEventListener('keydown', this.onKeyDown)
    this.inputEl.removeEventListener('focus', this.onFocus)
    this.barEl.remove()
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  private readonly onInput = (): void => {
    const win = this.window()
    if (!win) return
    if (this.debounceTimer !== null) win.clearTimeout(this.debounceTimer)
    this.debounceTimer = win.setTimeout(() => {
      this.debounceTimer = null
      this.runQuery()
    }, QUERY_DEBOUNCE_MS)
  }

  private readonly onFocus = (): void => {
    this.inputEl.select()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      // Typed but not searched yet: Enter searches rather than stepping
      // through the previous query's hits.
      if (this.debounceTimer !== null || this.pendingQueryDiffers()) {
        this.runQuery()
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

  private pendingQueryDiffers(): boolean {
    return normalizeQuery(this.inputEl.value) !== this.query
  }

  private cancelDebounce(): void {
    if (this.debounceTimer === null) return
    this.window()?.clearTimeout(this.debounceTimer)
    this.debounceTimer = null
  }

  private runQuery(): void {
    this.cancelDebounce()
    const query = normalizeQuery(this.inputEl.value)
    if (query === this.query) return
    this.startScan(query)
  }

  // -----------------------------------------------------------------------
  // Scanning
  // -----------------------------------------------------------------------

  private startScan(query: string): void {
    this.clearResults()
    this.query = query
    const handle = this.host.getDocument()
    if (query === '' || !handle) {
      this.renderCount()
      return
    }
    this.pageHits = new Array<readonly SearchTuple[] | null>(
      handle.pageCount,
    ).fill(null)
    this.scanning = true
    this.renderCount()
    void this.scan(this.generation, handle, query)
  }

  /**
   * Reads every page's text, starting from the one being read and wrapping
   * around, so the first hit found — the one jumped to — is the first one at
   * or after where the reader is.
   */
  private async scan(
    generation: number,
    handle: YoloModuleHostPdfDocumentV1,
    query: string,
  ): Promise<void> {
    const count = handle.pageCount
    const start = Math.min(
      count - 1,
      Math.max(0, Math.floor(this.host.getPosition()) - 1),
    )
    for (let step = 0; step < count; step += 1) {
      const pageIndex = (start + step) % count
      let hits: readonly SearchTuple[] = []
      try {
        const page = await handle.getPage(pageIndex + 1)
        const items = await page.getTextItems()
        if (generation !== this.generation) return
        let index = indexCache.get(items)
        if (!index) {
          index = buildPageSearchIndex(items)
          indexCache.set(items, index)
        }
        hits = findInPage(index, query)
      } catch (error) {
        if (generation !== this.generation) return
        this.host.reportError?.('pdf search', error)
      }
      this.pageHits[pageIndex] = hits
      if (hits.length > 0 && this.current === null) {
        this.setCurrent({ page: pageIndex, index: 0 })
      } else {
        this.paintPage(pageIndex)
      }
      this.renderCount()
    }
    if (generation !== this.generation) return
    this.scanning = false
    this.renderCount()
  }

  /** Forgets every hit and everything painted for them, and stops a scan. */
  private clearResults(): void {
    this.generation += 1
    this.scanning = false
    for (const pageIndex of [...this.painted.keys()]) {
      this.unpaintPage(pageIndex)
    }
    this.pageHits = []
    this.current = null
    this.pendingReveal = null
  }

  // -----------------------------------------------------------------------
  // Stepping
  // -----------------------------------------------------------------------

  private step(direction: 1 | -1): void {
    const current = this.current
    const count = this.pageHits.length
    if (!current || count === 0) return
    const onPage = this.pageHits[current.page] ?? []
    const within = current.index + direction
    if (within >= 0 && within < onPage.length) {
      this.setCurrent({ page: current.page, index: within })
      return
    }
    // The next page with hits, wrapping around; pages not read yet are
    // passed over, since nothing is known about them.
    for (let step = 1; step <= count; step += 1) {
      const page = (((current.page + direction * step) % count) + count) % count
      const hits = this.pageHits[page]
      if (!hits || hits.length === 0) continue
      this.setCurrent({ page, index: direction > 0 ? 0 : hits.length - 1 })
      return
    }
  }

  private setCurrent(hit: Hit): void {
    const previous = this.current
    this.current = hit
    if (previous && previous.page !== hit.page) this.paintPage(previous.page)
    this.paintPage(hit.page)
    this.renderCount()
    this.revealHit(hit)
  }

  private revealHit(hit: Hit): void {
    const tuple = this.pageHits[hit.page]?.[hit.index]
    if (!tuple) return
    const range = this.host.getTextLayer(hit.page)?.createRange(tuple) ?? null
    if (!range) this.pendingReveal = hit
    this.host.reveal(hit.page, range)
  }

  private renderCount(): void {
    const total = this.pageHits.reduce(
      (sum, hits) => sum + (hits?.length ?? 0),
      0,
    )
    if (this.query === '') {
      this.countEl.textContent = ''
      return
    }
    if (total === 0) {
      this.countEl.textContent = this.scanning
        ? '…'
        : this.host.t('pdf.searchNoResults')
      return
    }
    const current = this.current
    let ordinal = 0
    if (current) {
      for (let page = 0; page < current.page; page += 1) {
        ordinal += this.pageHits[page]?.length ?? 0
      }
      ordinal += current.index + 1
    }
    this.countEl.textContent = `${ordinal} / ${total}${this.scanning ? '…' : ''}`
  }

  // -----------------------------------------------------------------------
  // Painting
  // -----------------------------------------------------------------------

  private paintPage(pageIndex: number): void {
    this.unpaintPage(pageIndex)
    const hits = this.pageHits[pageIndex]
    const layer = this.host.getTextLayer(pageIndex)
    if (!hits || hits.length === 0 || !layer) return
    const matches = this.highlight(MATCH_HIGHLIGHT, 0)
    const current = this.highlight(CURRENT_HIGHLIGHT, 1)
    if (!matches || !current) return
    const ranges: Range[] = []
    hits.forEach((tuple, index) => {
      const range = layer.createRange(tuple)
      if (!range) return
      ranges.push(range)
      const isCurrent =
        this.current?.page === pageIndex && this.current.index === index
      ;(isCurrent ? current : matches).add(range)
    })
    this.painted.set(pageIndex, ranges)
  }

  private unpaintPage(pageIndex: number): void {
    const ranges = this.painted.get(pageIndex)
    if (!ranges) return
    this.painted.delete(pageIndex)
    const matches = this.highlight(MATCH_HIGHLIGHT, 0)
    const current = this.highlight(CURRENT_HIGHLIGHT, 1)
    for (const range of ranges) {
      matches?.delete(range)
      current?.delete(range)
    }
  }

  /** The window-wide highlight of that name, registered on first use. Null
   * where the Custom Highlight API is missing: hits are still counted and
   * jumped to, just not painted. */
  private highlight(name: string, priority: number): RangeHighlight | null {
    const win = this.window() as HighlightWindow | null
    const registry = win?.CSS?.highlights
    if (!win || !registry || typeof win.Highlight !== 'function') return null
    let highlight = registry.get(name)
    if (!highlight) {
      highlight = new win.Highlight()
      highlight.priority = priority
      registry.set(name, highlight)
    }
    return highlight
  }

  // -----------------------------------------------------------------------

  private selectedText(): string | null {
    const selection = this.window()?.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null
    }
    const range = selection.getRangeAt(0)
    if (!this.host.root.contains(range.commonAncestorContainer)) return null
    const text = selection.toString().replace(/\s+/g, ' ').trim()
    return text !== '' && text.length <= 200 ? text : null
  }

  private window(): Window | null {
    return this.host.root.ownerDocument.defaultView
  }
}
