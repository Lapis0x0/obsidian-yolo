// Everything that joins PDF reading to the board: the reading panel and the
// card it reads, the annotation controller over the whole view, excerpts, a
// click on a link into one of this board's PDFs, the reader's own keys, and
// the reading position written back to the card.
//
// Split out of `../canvas.ts` (no behaviour change). The canvas still owns the
// board, its history and the selection; this class owns only the panel, the
// annotation chrome and their bookkeeping, and reaches the board through
// `CanvasCore`. `WhiteboardCanvas` is the only importer; this module must
// never import it back.
//
// Reading panel. One PDF card at a time is read in a column beside the board
// (../pdf/readerPanel.ts) — a second reader over the card's file.
//
// Position flows both ways without bouncing: the panel's reader reports every
// move and the card's reader follows it silently (`setPosition` reports
// nothing back), and the card's reader is followed only while it is the
// focused card — the only state in which someone can be scrolling it. A card
// reader built or rebuilt meanwhile opens where the panel is
// (`pdfStartPosition`), so its first report is the panel's own position.
//
// The node's `startPage` is where the position persists: written on a short
// timer while the panel is read, on close, and folded into every save
// (`foldPanelPosition`, from the canvas's `getViewData`).
//
// The board makes room rather than being covered: its viewport's right edge
// moves in by the panel's width, and everything measured against the
// viewport — the camera's zoom floor, virtualization, the toolbar's clamp, the
// overview canvas — is re-measured through the canvas's `onResize`.
// Hit-testing reads the viewport's own client rect, whose left edge never
// moves.

import type { ScreenPoint } from '../../domain/camera'
import { parsePdfLink } from '../../domain/excerpt'
import type {
  Board,
  BoardNode,
  FileNode,
  NodeId,
  TextNode,
} from '../../domain/fileFormat'
import { basenameWithoutExtension, fileNodeKind } from '../../domain/naming'
import { addNode, boardWithPageWindow } from '../../domain/operations'
import type { Rect } from '../../domain/placement'
import type { AnnotationPrefs } from '../../host/annotationPrefs'
import type { AnnotationStores } from '../../host/annotationStore'
import { exportAnnotatedPdf } from '../../host/exportAnnotatedPdf'
import type { ReaderPanelPrefs } from '../../host/readerPanelPrefs'
import {
  AnnotationController,
  type ExcerptDrag,
} from '../pdf/annotationController'
import type { PdfReader, ReaderAnnotationEvents } from '../pdf/pdfReader'
import { READER_PANEL_DEFAULT_WIDTH, ReaderPanel } from '../pdf/readerPanel'

import type { CanvasCore } from './core'
import {
  KEY_LAYER_RANK,
  type KeyLayers,
  isTypingIntoField,
} from './keymapController'
import { PdfExcerpts } from './pdfExcerpts'

/** How much of the view the board keeps however wide the reading panel is
 * dragged. */
const READER_PANEL_MIN_BOARD_WIDTH = 240
/** How often a position read in the panel is written to its card's node.
 * The node is the position's only persistent home — the card's own reader
 * may be parked, evicted or never built — but writing it on every scroll
 * frame would rebuild the board index at scroll rate. */
const READER_PANEL_COMMIT_MS = 800

export type PdfIntegrationDeps = Readonly<{
  core: CanvasCore
  /** The view's root: the panel and the annotation chrome live in it. */
  rootEl: HTMLElement
  /** The board's viewport, whose right edge makes room for the panel. */
  viewportEl: HTMLElement
  readerPanelPrefs: ReaderPanelPrefs
  annotationStores: AnnotationStores
  annotationPrefs: AnnotationPrefs
  /** Where a mounted PDF card's reader is, or null. */
  getPdfPosition: (id: NodeId) => number | null
  /** The card the pointer has been let into, or null. */
  getEnteredNodeId: () => NodeId | null
  /** The board's viewport changed size: re-measure what depends on it. */
  onResize: () => void
  /** Where this class's layers of Escape, Delete and undo/redo go. */
  keyLayers: KeyLayers
  /** The whole Escape chain — the reader keymap binds Escape too. */
  runEscape: () => boolean
  /** Lets the pointer into a selected card's content (the editing
   * controller's `editCard`); whether it did. */
  enterCard: (id: NodeId) => boolean
  /** Where a frame or an annotation dragged out of a reader would land on
   * the board (world), or null where it cannot. */
  excerptDropPoint: (e: MouseEvent) => ScreenPoint | null
  /** Shows the card an excerpt being dragged would become, where it would
   * land (world), or takes it away. */
  showExcerptLanding: (rect: Rect | null) => void
}>

export class PdfIntegration {
  private readerPanel: ReaderPanel | null = null
  /** The card the panel is reading, whenever the panel is open. */
  private readerPanelNodeId: NodeId | null = null
  private readerPanelCommitTimer: number | null = null
  /** Mod+F, bound only while there is a reader to search (see
   * `syncReaderKeymap`). */
  private readerKeymapDisposer: (() => void) | null = null
  /** The PDF annotation toolbar and comment editor, over the whole view
   * (../pdf/annotationController.ts). */
  private readonly annotationController: AnnotationController
  private readonly pdfExcerpts: PdfExcerpts

  constructor(private readonly deps: PdfIntegrationDeps) {
    const { core } = deps
    // Over the whole view rather than the viewport: it serves the reading
    // panel as well as the cards. Built after the board's toolbar, so the two
    // never compete for the same layer.
    this.pdfExcerpts = new PdfExcerpts(core.host, {
      getBoard: core.getBoard,
      canCreate: core.canCreate,
      pdfNodeForReader: (reader) => this.pdfNodeForReader(reader),
      nextNodeId: (board) => core.nextNodeId(board),
      addCard: (node) => this.addExcerptCard(node),
      isInView: (rect) => {
        const view = core.worldViewportRect(0)
        return (
          rect.x >= view.left &&
          rect.y >= view.top &&
          rect.x + rect.w <= view.right &&
          rect.y + rect.h <= view.bottom
        )
      },
      getSourcePath: core.getSourcePath,
      t: core.t,
      reportError: core.reportError,
    })
    this.annotationController = new AnnotationController({
      parent: deps.rootEl,
      host: core.host,
      prefs: deps.annotationPrefs,
      t: core.t,
      getSourcePath: core.getSourcePath,
      registerKeymap: (bindings) => core.context.registerKeymap(bindings),
      excerpts: {
        addText: (reader, excerpt, at) =>
          this.pdfExcerpts.addText(reader, excerpt, at),
        addArea: (reader, page, rect, at) =>
          this.pdfExcerpts.addArea(reader, page, rect, at),
        dropPoint: (event) => deps.excerptDropPoint(event),
        showLanding: (landing) =>
          deps.showExcerptLanding(
            landing && this.pdfExcerpts.landing(landing.content, landing.at),
          ),
      },
      reportError: core.reportError,
    })
    const layers = deps.keyLayers
    const handled = (done: boolean) => (done ? true : null)
    layers.addLayer('escape', KEY_LAYER_RANK.overField, () =>
      handled(this.dismissAnnotation()),
    )
    layers.addLayer('escape', KEY_LAYER_RANK.reader, () =>
      handled(this.escapeReader()),
    )
    layers.addLayer('delete', KEY_LAYER_RANK.reader, () =>
      handled(this.deleteActiveAnnotation()),
    )
    layers.addLayer('undo', KEY_LAYER_RANK.reader, () =>
      handled(this.undoAnnotation()),
    )
    layers.addLayer('redo', KEY_LAYER_RANK.reader, () =>
      handled(this.redoAnnotation()),
    )
  }

  /** What every reader of this view reports its selections and annotation
   * clicks to. */
  get annotationEvents(): ReaderAnnotationEvents {
    return this.annotationController.events
  }

  /** Releases the panel (its position is already in what the host saved —
   * `getViewData` runs first — so it closes without writing it again), the
   * reader keymap (still armed if a PDF card is focused; the scope outlives
   * this canvas, a popout migration builds a new one on the same view), and
   * the annotation chrome. */
  destroy(): void {
    this.closeReaderPanel(false)
    this.readerKeymapDisposer?.()
    this.readerKeymapDisposer = null
    this.annotationController.destroy()
  }

  // -- the canvas's lifecycle -------------------------------------------

  /** The panel's position is written to its card on a timer; the last
   * stretch of reading must not wait for it. */
  foldPanelPosition(board: Board): Board {
    const panelPage = this.readerPanel?.getPosition() ?? null
    if (this.readerPanelNodeId !== null && panelPage !== null) {
      return boardWithPageWindow(board, this.readerPanelNodeId, panelPage)
    }
    return board
  }

  /** A narrower view may leave the panel wider than it may be; giving the
   * difference back lays the board out again (`layoutForReaderPanel`). */
  refitPanel(): void {
    this.readerPanel?.refit()
  }

  /** A vault file was deleted. If it was the panel's, there is nothing left
   * to read. (A rename reaches the panel through the board instead — the
   * rename rewriter updates the card, and `syncWithBoard` follows it.) */
  onFileDeleted(path: string): boolean {
    if (path !== this.readerPanel?.path) return false
    this.closeReaderPanel(false)
    return true
  }

  /** Whether a DOM node is inside the panel. */
  panelContains(node: Node | null): boolean {
    return this.readerPanel?.contains(node) ?? false
  }

  // -- reading panel ----------------------------------------------------

  /** "Export PDF with annotations", for a PDF card's menu and the panel's. */
  exportAnnotatedPdfItem(path: string): YoloModuleHostMenuItemV1 {
    return {
      title: this.deps.core.t('menu.exportAnnotatedPdf'),
      icon: 'file-output',
      onSelect: () =>
        exportAnnotatedPdf(
          this.deps.core.host,
          this.deps.annotationStores,
          path,
        ),
    }
  }

  /** Opens the panel on a PDF card, or moves it there from another card. */
  openReaderPanel(id: NodeId): void {
    const { core } = this.deps
    const node = core.getNode(id)
    if (!node || !isPdfNode(node)) return
    if (this.readerPanelNodeId !== null && this.readerPanelNodeId !== id) {
      this.commitReaderPanelPosition()
    }
    const position = this.deps.getPdfPosition(id) ?? node.startPage
    if (!this.readerPanel) {
      const rootEl = this.deps.rootEl
      this.readerPanel = new ReaderPanel({
        pdf: core.host.pdf,
        parent: rootEl,
        t: (key) => core.t(key),
        width: this.deps.readerPanelPrefs.getWidth(READER_PANEL_DEFAULT_WIDTH),
        maxWidth: () => rootEl.clientWidth - READER_PANEL_MIN_BOARD_WIDTH,
        onResize: (width, done) => {
          this.layoutForReaderPanel()
          if (done) this.deps.readerPanelPrefs.setWidth(width)
        },
        onClose: () => this.closeReaderPanel(true),
        onMenu: (event, path) =>
          core.host.ui.showMenu(event, [this.exportAnnotatedPdfItem(path)]),
        onPositionChange: (next) => this.onReaderPanelPosition(next),
        openAnnotations: (path) => this.deps.annotationStores.acquire(path),
        annotationEvents: this.annotationController.events,
        reportError: core.reportError,
      })
    }
    this.readerPanelNodeId = id
    this.readerPanel.show(
      node.file,
      basenameWithoutExtension(node.file),
      position,
    )
    this.layoutForReaderPanel()
    this.syncReaderKeymap()
  }

  /** Closes the panel, writing where it was to its card unless the board it
   * belongs to is going away (`commit` false). */
  closeReaderPanel(commit: boolean): void {
    if (!this.readerPanel) return
    if (commit) this.commitReaderPanelPosition()
    this.clearReaderPanelCommitTimer()
    this.readerPanel.destroy()
    this.readerPanel = null
    this.readerPanelNodeId = null
    this.layoutForReaderPanel()
    this.syncReaderKeymap()
  }

  /** Gives the board the width the panel does not take. */
  private layoutForReaderPanel(): void {
    this.deps.viewportEl.setCssProps({
      right: this.readerPanel ? `${this.readerPanel.width}px` : '',
    })
    this.deps.onResize()
  }

  /** Keeps the panel pointed at a card that still exists and still is the
   * PDF it was — and at its new path, when the file was renamed. Called on
   * every board index rebuild: the one place the panel can learn its card
   * was deleted, undone away, or pointed at another file. */
  syncWithBoard(): void {
    const id = this.readerPanelNodeId
    const panel = this.readerPanel
    if (id === null || !panel) return
    const node = this.deps.core.getNode(id)
    if (!node || !isPdfNode(node)) {
      this.closeReaderPanel(false)
      return
    }
    if (node.file !== panel.path) {
      panel.show(
        node.file,
        basenameWithoutExtension(node.file),
        panel.getPosition() ?? node.startPage,
      )
    }
  }

  /** The panel moved: the card's reader follows, and the node hears soon. */
  private onReaderPanelPosition(position: number): void {
    const id = this.readerPanelNodeId
    if (id === null) return
    this.deps.core.getRuntime(id)?.pdfReader?.setPosition(position)
    this.scheduleReaderPanelCommit()
  }

  /** A card's reader moved. Only the focused card is one someone can be
   * scrolling; any other report is a reader settling where it was put. */
  onCardPdfPosition(id: NodeId, position: number): void {
    if (
      id !== this.readerPanelNodeId ||
      id !== this.deps.core.getFocusedNodeId()
    ) {
      return
    }
    this.readerPanel?.setPosition(position)
    this.scheduleReaderPanelCommit()
  }

  /** Where a PDF card's reader should open: the panel's place when the panel
   * is reading that card, which is newer than the node's. */
  pdfStartPosition(id: NodeId): number | undefined {
    if (id === this.readerPanelNodeId) {
      const position = this.readerPanel?.getPosition()
      if (position !== null && position !== undefined) return position
    }
    const node = this.deps.core.getNode(id)
    return node?.type === 'file' ? node.startPage : undefined
  }

  private scheduleReaderPanelCommit(): void {
    if (this.readerPanelCommitTimer !== null) return
    this.readerPanelCommitTimer = this.deps.core.context
      .getWindow()
      .setTimeout(() => {
        this.readerPanelCommitTimer = null
        this.commitReaderPanelPosition()
      }, READER_PANEL_COMMIT_MS)
  }

  private clearReaderPanelCommitTimer(): void {
    if (this.readerPanelCommitTimer === null) return
    this.deps.core.context.getWindow().clearTimeout(this.readerPanelCommitTimer)
    this.readerPanelCommitTimer = null
  }

  /** Written like the canvas's `commitReadingWindow`: straight to the board,
   * not a step anyone would undo. */
  private commitReaderPanelPosition(): void {
    this.clearReaderPanelCommitTimer()
    const { core } = this.deps
    const id = this.readerPanelNodeId
    const position = this.readerPanel?.getPosition() ?? null
    if (id === null || position === null || core.isParseFailed()) return
    core.commitWithoutHistory(
      boardWithPageWindow(core.getBoard(), id, position),
    )
  }

  // -- excerpts ---------------------------------------------------------

  /** The PDF card a reader shows: the panel's card, or the card whose body
   * the reader is. */
  private pdfNodeForReader(reader: PdfReader): NodeId | null {
    if (this.readerPanel?.getReader() === reader) return this.readerPanelNodeId
    const { core } = this.deps
    for (const node of core.getBoard().nodes) {
      if (core.getRuntime(node.id)?.pdfReader === reader) {
        return node.id
      }
    }
    return null
  }

  /** An excerpt card lands like any card made on the board: one undoable
   * step, mounted now so it is there to be seen. */
  private addExcerptCard(node: TextNode): void {
    const { core } = this.deps
    core.applyBoardChange(addNode(core.getBoard(), node))
    core.recomputeVisibility()
    core.drainQueues()
  }

  /** Whether a drag is a selection leaving one of this view's readers. */
  isExcerptDrag(e: DragEvent): boolean {
    return this.annotationController.isExcerptDrag(e)
  }

  /** Such a drag over the board: the card it would make, where it would
   * land (`at`, world), or nothing where it cannot. */
  previewExcerpt(e: DragEvent, at: ScreenPoint | null): void {
    const quote = this.annotationController.draggedQuote(e)
    this.deps.showExcerptLanding(
      at && quote !== null
        ? this.pdfExcerpts.landing({ kind: 'text', quote }, at)
        : null,
    )
  }

  /**
   * Text selected in one of this view's PDF readers, dragged out: an excerpt
   * card where it was dropped (./pdfExcerpts.ts) — only on open canvas, which
   * `isOverCard` answers. True when the drop was such a drag, whatever came
   * of it; false when it is some other drag for the board to take.
   */
  dropExcerpt(
    e: DragEvent,
    at: Readonly<{ x: number; y: number }>,
    isOverCard: () => boolean,
  ): boolean {
    const excerpt: ExcerptDrag | null =
      this.annotationController.takeExcerptDrag(e)
    if (!excerpt) return false
    if (
      !isOverCard() &&
      this.pdfExcerpts.addText(excerpt.reader, excerpt.excerpt, at)
    ) {
      this.annotationController.markDropped(excerpt)
    }
    return true
  }

  // -- links into this board's PDFs --------------------------------------

  /**
   * A click on a card that landed on a link to a place in a PDF on this
   * board (`[[x.pdf#page=N&selection=…]]`, an excerpt's citation) reads it
   * there: the reading panel opens on that PDF's card at the page, and the
   * text the link names is marked (PdfReader's `revealLocation`).
   *
   * A card's rendered content takes no pointer events (style.css's content
   * mask), so which link was clicked is found by geometry. Only these links
   * are taken: a link to a PDF that has no card here, or to anything else,
   * is left as it was — a card's links are followed where Obsidian follows
   * them, in its editor.
   */
  /**
   * A click on a PDF card that landed on one of its annotations — while the
   * card's content was still under its mask, so the reader never saw it. The
   * annotation is what was aimed at, not the card: the card is selected and
   * entered, as a second click would, and the annotation opened, as a click
   * on it inside would. True when that is what happened.
   */
  openAnnotationAt(id: NodeId, e: MouseEvent): boolean {
    const { core } = this.deps
    const reader = core.getRuntime(id)?.pdfReader
    if (!reader || core.isParseFailed()) return false
    const annotationId = reader.annotationAtPoint(e.clientX, e.clientY)
    if (annotationId === null) return false
    core.setSelection([id])
    if (!this.deps.enterCard(id)) return false
    this.annotationController.openAnnotation(reader, annotationId)
    return true
  }

  /** Whether a pointer on a PDF card whose content has not been entered
   * is over one of its annotations — where a click would open it
   * (`openAnnotationAt`). An entered card's reader says so itself. */
  isOverAnnotation(id: NodeId, e: MouseEvent): boolean {
    if (this.deps.getEnteredNodeId() === id) return false
    const reader = this.deps.core.getRuntime(id)?.pdfReader
    return reader?.annotationAtPoint(e.clientX, e.clientY) != null
  }

  followPdfLinkAt(id: NodeId, e: MouseEvent): void {
    const { core } = this.deps
    const runtime = core.getRuntime(id)
    const body = runtime?.bodyEl
    if (!runtime || !body || core.isParseFailed()) return
    const link = internalLinkAtPoint(body, e.clientX, e.clientY)
    const linktext = link?.getAttribute('data-href') ?? ''
    const parsed = parsePdfLink(linktext)
    if (!parsed) return
    let file: YoloModuleHostVaultEntryV1 | null = null
    try {
      file = core.host.vault.resolveLink(
        parsed.linkpath,
        runtime.contentSourcePath ?? core.getSourcePath(),
      )
    } catch (error) {
      core.reportError('resolve pdf link', error)
      return
    }
    if (!file) return
    const target = this.pdfCardFor(file.path, id)
    if (target === null) return
    this.openReaderPanel(target)
    this.readerPanel
      ?.getReader()
      ?.revealLocation(parsed.target.page, parsed.target.selection)
  }

  /** The card to read a PDF in: the one the panel is already on, else the
   * nearest to `near`. */
  private pdfCardFor(path: string, near: NodeId): NodeId | null {
    const { core } = this.deps
    const cards = core
      .getBoard()
      .nodes.filter(
        (node): node is FileNode => isPdfNode(node) && node.file === path,
      )
    if (cards.length === 0) return null
    const current = cards.find((node) => node.id === this.readerPanelNodeId)
    if (current) return current.id
    const from = core.getNode(near)
    if (!from) return cards[0].id
    const centre = (node: BoardNode) => ({
      x: node.x + node.w / 2,
      y: node.y + node.h / 2,
    })
    const origin = centre(from)
    let best = cards[0]
    let bestDistance = Number.POSITIVE_INFINITY
    for (const card of cards) {
      const c = centre(card)
      const distance = Math.hypot(c.x - origin.x, c.y - origin.y)
      if (distance < bestDistance) {
        best = card
        bestDistance = distance
      }
    }
    return best.id
  }

  // -- the reader's keys ------------------------------------------------

  /** The focused card, when it is a PDF card. */
  private focusedPdfNodeId(): NodeId | null {
    const { core } = this.deps
    const id = core.getFocusedNodeId()
    if (id === null) return null
    const node = core.getNode(id)
    return node && isPdfNode(node) ? id : null
  }

  /**
   * Binds Mod+F while there is a reader to search — the panel, or a focused
   * PDF card — and only then. A binding on the view's scope that declines
   * still ends the key's journey there (Obsidian's `Scope.handleKey` returns
   * on the first binding for a key), so one left armed all the time would
   * swallow the user's own Mod+F hotkey on every board.
   */
  syncReaderKeymap(): void {
    const wanted = this.readerPanel !== null || this.focusedPdfNodeId() !== null
    if (wanted && !this.readerKeymapDisposer) {
      this.readerKeymapDisposer = this.deps.core.context.registerKeymap([
        {
          modifiers: ['Mod'],
          key: 'F',
          handler: () => this.openReaderSearch(),
        },
        { modifiers: [], key: 'Escape', handler: () => this.deps.runEscape() },
      ])
    } else if (!wanted && this.readerKeymapDisposer) {
      this.readerKeymapDisposer()
      this.readerKeymapDisposer = null
    }
  }

  /**
   * Mod+F: searches the reader being read. That is the panel when focus is
   * in it (a press anywhere in the panel gives it focus) or when no PDF card
   * is focused; otherwise the focused card's reader.
   */
  private openReaderSearch(): boolean {
    const { core } = this.deps
    const active = core.context.getDocument().activeElement
    const panel = this.readerPanel
    const cardId = this.focusedPdfNodeId()
    const cardEl = cardId === null ? null : core.getRuntime(cardId)?.el
    // Typing somewhere else — a label, a prompt — is not reading.
    if (
      isTypingIntoField(core.context.getDocument()) &&
      !panel?.contains(active) &&
      !(active && cardEl?.contains(active))
    ) {
      return false
    }
    if (panel && (panel.contains(active) || cardId === null)) {
      panel.openSearch()
      return true
    }
    const reader = cardId === null ? null : core.getRuntime(cardId)?.pdfReader
    if (!reader) return false
    reader.openSearch()
    return true
  }

  /** Escape's first layer: the PDF annotation toolbar (or its comment
   * editor). */
  private dismissAnnotation(): boolean {
    return this.annotationController.dismiss()
  }

  /** Escape's reader layer: the reader being read leaves area mode, else
   * closes its search. */
  private escapeReader(): boolean {
    const reader = this.activeReader()
    if (reader?.isAreaMode()) {
      reader.setAreaMode(false)
      return true
    }
    return this.closeReaderSearchForEscape()
  }

  /** Closes the search of the reader being read. */
  private closeReaderSearchForEscape(): boolean {
    const { core } = this.deps
    const active = core.context.getDocument().activeElement
    if (this.readerPanel?.contains(active)) {
      return this.readerPanel.closeSearch()
    }
    const cardId = this.focusedPdfNodeId()
    const reader = cardId === null ? null : core.getRuntime(cardId)?.pdfReader
    if (!reader?.isSearchOpen()) return false
    reader.closeSearch()
    return true
  }

  /** Delete/Backspace: a PDF annotation being acted on is what the key
   * deletes. */
  private deleteActiveAnnotation(): boolean {
    return this.annotationController.deleteActive()
  }

  /** Mod+Z: while a PDF reader is the thing being read, its annotation edits
   * are what is taken back first. False when there is nothing to undo there,
   * so the board's own history comes next. */
  private undoAnnotation(): boolean {
    const store = this.activeReader()?.getAnnotationStore()
    if (!store?.canUndo()) return false
    store.undo()
    return true
  }

  private redoAnnotation(): boolean {
    const store = this.activeReader()?.getAnnotationStore()
    if (!store?.canRedo()) return false
    store.redo()
    return true
  }

  /**
   * The PDF reader being read: the one the annotation toolbar is acting
   * for, else the panel's when focus is in it, else the entered card's.
   */
  private activeReader(): PdfReader | null {
    const acting = this.annotationController.reader
    if (acting) return acting
    const active = this.deps.core.context.getDocument().activeElement
    if (this.readerPanel?.contains(active)) {
      return this.readerPanel.getReader()
    }
    const entered = this.deps.getEnteredNodeId()
    if (entered !== null) {
      return this.deps.core.getRuntime(entered)?.pdfReader ?? null
    }
    return null
  }
}

/** A file card showing a PDF — the cards the reading panel can open. */
export function isPdfNode(node: BoardNode): node is FileNode {
  return node.type === 'file' && fileNodeKind(node.file) === 'pdf'
}

/** The rendered internal link under a point, if any. Asked of each link's
 * own line boxes, so a link wrapped across two lines is hit on either. */
function internalLinkAtPoint(
  root: HTMLElement,
  x: number,
  y: number,
): HTMLElement | null {
  for (const link of Array.from(
    root.querySelectorAll<HTMLElement>('a.internal-link'),
  )) {
    for (const rect of Array.from(link.getClientRects())) {
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      )
        return link
    }
  }
  return null
}
