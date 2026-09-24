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
// The two readers are read apart: the panel opens where the card is (or at
// the passage a link names), and from then on neither follows the other — a
// card left at one page while the panel reads another is two places being
// read, not one place shown twice. The node's `startPage` is the card's own
// position (the canvas's `commitReadingWindow`); the panel keeps none.
//
// The board makes room rather than being covered: its viewport's right edge
// moves in by the panel's width, and everything measured against the
// viewport — the camera's zoom floor, virtualization, the toolbar's clamp, the
// overview canvas — is re-measured through the canvas's `onResize`.
// Hit-testing reads the viewport's own client rect, whose left edge never
// moves.

import type { ScreenPoint } from '../../domain/camera'
import { type PdfLinkTarget, parsePdfLink } from '../../domain/excerpt'
import type {
  BoardNode,
  FileNode,
  NodeId,
  TextNode,
} from '../../domain/fileFormat'
import { basenameWithoutExtension, fileNodeKind } from '../../domain/naming'
import { addNode } from '../../domain/operations'
import type { Rect } from '../../domain/placement'
import { isMostlyInView } from '../../domain/virtualization'
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
  /** Shows where an excerpt dragged out of a reader lands (`rect`, world),
   * drawn as it will read (`body`), or — with null — shows none. */
  showExcerptLanding: (
    landing: Readonly<{ rect: Rect; body: HTMLElement }> | null,
  ) => void
}>

export class PdfIntegration {
  private readerPanel: ReaderPanel | null = null
  /** The card the panel is reading, whenever the panel is open. */
  private readerPanelNodeId: NodeId | null = null
  /** Mod+F, bound only while there is a reader to search (see
   * `syncReaderKeymap`). */
  private readerKeymapDisposer: (() => void) | null = null
  /** The PDF annotation toolbar and comment editor, over the whole view
   * (../pdf/annotationController.ts). */
  private readonly annotationController: AnnotationController
  /** The comment dot `hoverNoteAt` last previewed. */
  private hoveredNote: Readonly<{ reader: PdfReader; id: string }> | null = null
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
        addComment: (reader, excerpt, at) =>
          this.pdfExcerpts.addComment(reader, excerpt, at),
        addArea: (reader, page, rect, at) =>
          this.pdfExcerpts.addArea(reader, page, rect, at),
        dropPoint: (event) => deps.excerptDropPoint(event),
        showLanding: (landing) =>
          deps.showExcerptLanding(
            landing && {
              rect: this.pdfExcerpts.landing(landing.content, landing.at),
              body: landing.body,
            },
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
    this.closeReaderPanel()
    this.readerKeymapDisposer?.()
    this.readerKeymapDisposer = null
    this.annotationController.destroy()
  }

  // -- the canvas's lifecycle -------------------------------------------

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
    this.closeReaderPanel()
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
        onClose: () => this.closeReaderPanel(),
        onMenu: (event, path) =>
          core.host.ui.showMenu(event, [this.exportAnnotatedPdfItem(path)]),
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

  closeReaderPanel(): void {
    if (!this.readerPanel) return
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
      this.closeReaderPanel()
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
    const landing = at && this.annotationController.draggedLanding(e)
    this.deps.showExcerptLanding(
      landing && {
        rect: this.pdfExcerpts.landing(landing.content, at),
        body: landing.body,
      },
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
   * A press on a PDF card, whose content has not been entered, that landed
   * on one of its annotations or comment dots — under the card's mask, so
   * the reader never saw it. The annotation is what was aimed at, not the
   * card: the card is selected and entered, as a second click would, and the
   * press handed to the annotation controller as the reader's own press on
   * it would be — a click opens it (or its comment), a drag takes it out.
   * True when that is what happened.
   */
  grabAnnotationAt(id: NodeId, e: PointerEvent): boolean {
    const { core } = this.deps
    if (this.deps.getEnteredNodeId() === id || core.isParseFailed()) {
      return false
    }
    const reader = core.getRuntime(id)?.pdfReader
    if (!reader) return false
    const noteId = reader.noteAtPoint(e.clientX, e.clientY)
    const annotationId =
      noteId ?? reader.annotationAtPoint(e.clientX, e.clientY)
    if (annotationId === null) return false
    core.setSelection([id])
    if (!this.deps.enterCard(id)) return false
    this.annotationController.takePress(
      reader,
      e,
      annotationId,
      noteId !== null,
    )
    return true
  }

  /** What a press at the pointer on the card `id` would do to something in
   * its content, for the cursor to say: take an annotation of a PDF card not
   * entered (`grabAnnotationAt`) — `grab` — or open a comment dot or follow
   * a link into one of the board's PDFs — `open`. An entered card's reader
   * says so itself. */
  contentAffordanceAt(id: NodeId, e: MouseEvent): 'grab' | 'open' | null {
    if (this.pdfLinkAt(id, e) !== null) return 'open'
    if (this.deps.getEnteredNodeId() === id) return null
    const reader = this.deps.core.getRuntime(id)?.pdfReader
    if (!reader) return null
    if (reader.noteAtPoint(e.clientX, e.clientY) !== null) return 'open'
    return reader.annotationAtPoint(e.clientX, e.clientY) !== null
      ? 'grab'
      : null
  }

  /** The pointer on the board is at `e`, over the card `id` (or none): on
   * a comment dot of a PDF card whose content has not been entered, that
   * comment is previewed, as the reader shows it once entered. */
  hoverNoteAt(id: NodeId | null, e: MouseEvent): void {
    const reader =
      id !== null && this.deps.getEnteredNodeId() !== id
        ? (this.deps.core.getRuntime(id)?.pdfReader ?? null)
        : null
    const note = reader?.noteAtPoint(e.clientX, e.clientY) ?? null
    const hovered = this.hoveredNote
    if (hovered?.reader === reader && hovered?.id === note) return
    if (hovered) this.annotationController.hoverNote(hovered.reader, null)
    this.hoveredNote = reader && note !== null ? { reader, id: note } : null
    if (reader && note !== null) {
      this.annotationController.hoverNote(reader, note)
    }
  }

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
   *
   * Read where it can be seen: a card of that PDF already on screen is
   * entered and taken to the passage, the camera left where it is — a panel beside it would show the same pages
   * twice. Otherwise, and whenever the panel is already showing that PDF,
   * the panel. Either way the board stays where the reader was working.
   * Selects what the click leaves being read. True when a link was followed.
   */
  followPdfLinkAt(id: NodeId, e: MouseEvent): boolean {
    const link = this.pdfLinkAt(id, e)
    if (!link) return false
    const { core } = this.deps
    const { page, selection } = link.target
    const inPanel = this.readerPanelNodeId === link.cardId
    const inPlace = inPanel ? null : this.readableCardFor(link.path)
    const reader = inPlace === null ? null : core.getRuntime(inPlace)?.pdfReader
    if (inPlace !== null && reader) {
      core.setSelection([inPlace])
      if (this.deps.enterCard(inPlace)) {
        reader.revealLocation(page, selection)
        return true
      }
    }
    core.setSelection([id])
    this.openReaderPanel(link.cardId)
    this.readerPanel?.getReader()?.revealLocation(page, selection)
    return true
  }

  /** A card of the PDF at `path` that is read where it is: holding a reader
   * (so not in the overview tier, where a card is too small to read and has
   * none) and mostly on screen (`isMostlyInView`). The widest, when there are
   * several. */
  private readableCardFor(path: string): NodeId | null {
    const { core } = this.deps
    if (core.isOverview()) return null
    const view = core.worldViewportRect(0)
    let best: FileNode | null = null
    for (const node of core.getBoard().nodes) {
      if (!isPdfNode(node) || node.file !== path) continue
      if (!core.getRuntime(node.id)?.pdfReader) continue
      if (!isMostlyInView(node, view)) continue
      if (!best || node.w > best.w) best = node
    }
    return best?.id ?? null
  }

  /** The link into one of the board's PDFs at the pointer on the card `id`:
   * the PDF card it reads in, and where. */
  private pdfLinkAt(
    id: NodeId,
    e: MouseEvent,
  ): Readonly<{ path: string; cardId: NodeId; target: PdfLinkTarget }> | null {
    const { core } = this.deps
    const runtime = core.getRuntime(id)
    const body = runtime?.bodyEl
    if (!runtime || !body || core.isParseFailed()) return null
    const link = internalLinkAtPoint(body, e.clientX, e.clientY)
    const linktext = link?.getAttribute('data-href') ?? ''
    const parsed = parsePdfLink(linktext)
    if (!parsed) return null
    let file: YoloModuleHostVaultEntryV1 | null = null
    try {
      file = core.host.vault.resolveLink(
        parsed.linkpath,
        runtime.contentSourcePath ?? core.getSourcePath(),
      )
    } catch (error) {
      core.reportError('resolve pdf link', error)
      return null
    }
    if (!file) return null
    const cardId = this.pdfCardFor(file.path, id)
    return cardId === null
      ? null
      : { path: file.path, cardId, target: parsed.target }
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
