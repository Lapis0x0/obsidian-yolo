// Everything that puts a new card on the board: the creation bar and the
// panel it opens to ask which note, which media or which web address; drops
// from Obsidian's file explorer and from the operating system; double-click
// and menu creation; converting a text card to a note. Also the two
// right-click menus, the canvas's and the selection's, which are mostly made
// of these entries.
//
// Split out of `../canvas.ts` (no behaviour change). The canvas still owns the
// board, its history and the selection; this class owns the creation bar,
// the open prompt and the one note waiting to be edited once it renders, and
// commits every card through `CanvasCore`. `WhiteboardCanvas` is the only
// importer; this module must never import it back.

import {
  ALIGN_EDGES,
  type AlignEdge,
  DISTRIBUTE_AXES,
  type DistributeAxis,
} from '../../domain/arrange'
import { type ScreenPoint, screenToWorld } from '../../domain/camera'
import type {
  FileNode,
  GroupNode,
  LinkNode,
  NodeId,
  TextNode,
} from '../../domain/fileFormat'
import { GROUP_SELECTION_PADDING, arrangeTargets } from '../../domain/groups'
import {
  basenameWithoutExtension,
  cardNoteContent,
  fileNodeKind,
  folderPathOf,
  generateCardNoteFileName,
  generateDroppedHtmlFileName,
  sanitizeFileName,
} from '../../domain/naming'
import { addNode, replaceNode } from '../../domain/operations'
import type { CardSize } from '../../domain/resize'
import {
  CardMenu,
  type CardMenuAction,
  type CardMenuIconName,
} from '../cardMenu'
import {
  DROP_STAGGER_PX,
  NEW_CARD_SIZE,
  NEW_EMBED_CARD_SIZE,
  WEB_URL_PATTERN,
} from '../constants'
import { asNode } from '../eventTarget'
import {
  PromptOverlay,
  type PromptOverlayOptions,
  type PromptSuggestion,
} from '../promptOverlay'

import type { CanvasCore } from './core'
import { isPdfNode } from './pdfIntegration'
import { ALIGN_MENU, DISTRIBUTE_MENU } from './toolbarController'

const VIEWPORT_DROP_ACTIVE_CLASS = 'yolo-whiteboard-viewport-drop-active'

/** Which label a rename acts on — the selection menu's "rename group". */
type RenameTarget = Readonly<{ kind: 'group'; id: NodeId }>

export type DropImportDeps = Readonly<{
  core: CanvasCore
  /** The board's viewport: the drop target, and what "the middle of the
   * screen" is measured in. */
  viewportEl: HTMLElement
  /** The toolbar's overlay layer, where the creation bar and the prompt
   * live (see SelectionToolbar.overlay). */
  overlay: HTMLElement
  closePopover: () => void
  /** A prompt opened or closed: the selection's keys re-decide whether they
   * are armed. */
  onPromptChange: () => void
  /** Which node a pointer event landed on, overview tier included. */
  nodeIdAtPointer: (e: MouseEvent) => NodeId | null
  /** A press on a creation-bar button: the drag that may place the card. */
  beginCreateDrag: (
    e: PointerEvent,
    size: CardSize,
    create: (at: ScreenPoint) => void,
  ) => void
  enterEditMode: (id: NodeId) => void
  /** Commits the card's open editor, if the editor is on this card. */
  commitEditOn: (id: NodeId) => void
  purgeNodeRuntime: (id: NodeId) => void
  // The PDF card's entries.
  isExcerptDrag: (e: DragEvent) => boolean
  dropExcerpt: (
    e: DragEvent,
    at: ScreenPoint,
    isOverCard: () => boolean,
  ) => boolean
  openReader: (id: NodeId) => void
  exportAnnotatedPdfItem: (path: string) => YoloModuleHostMenuItemV1
  // The selection's commands, which the menu shares with the toolbar.
  createGroupFromSelection: () => void
  tidySelection: () => void
  alignSelection: (edge: AlignEdge) => void
  distributeSelection: (axis: DistributeAxis) => void
  beginRename: (target: RenameTarget) => void
  deleteNodes: (ids: readonly NodeId[]) => void
  zoomToSelection: () => void
  resetCamera: () => void
}>

export class DropImport {
  private readonly core: CanvasCore
  /** The creation bar along the bottom of the board. */
  private readonly cardMenu: CardMenu
  private prompt: PromptOverlay | null = null
  /** A note card that opens its editor as soon as its note has been read —
   * one just created from the note prompt, whose text is not known until the
   * first read lands (`enterEditMode` declines before it). */
  private editWhenNoteRendered: NodeId | null = null

  constructor(private readonly deps: DropImportDeps) {
    this.core = deps.core
    // The creation bar and the file/URL prompt live in the toolbar's overlay
    // layer, which exists for exactly this (see SelectionToolbar.overlay): one
    // `isOverlayTarget` check then keeps a press on any of this chrome from
    // also being a press on the board behind it.
    this.cardMenu = new CardMenu(
      this.core.context.getDocument(),
      deps.overlay,
      [
        this.creationAction(
          'cardMenu.newCard',
          'sticky-note',
          NEW_CARD_SIZE,
          (at) => this.createTextCardAt(at),
        ),
        this.creationAction(
          'cardMenu.addNote',
          'file-text',
          NEW_EMBED_CARD_SIZE,
          (at) => this.promptForNoteCard(at),
        ),
        this.creationAction(
          'cardMenu.addMedia',
          'file-image',
          NEW_EMBED_CARD_SIZE,
          (at) => this.promptForMediaCard(at),
        ),
        this.creationAction(
          'cardMenu.newWebCard',
          'globe',
          NEW_EMBED_CARD_SIZE,
          (at) => this.promptForWebCard(at),
        ),
      ],
    )
    deps.viewportEl.addEventListener('dragover', this.onDragOver)
    deps.viewportEl.addEventListener('dragleave', this.onDragLeave)
    deps.viewportEl.addEventListener('drop', this.onDrop)
    deps.viewportEl.addEventListener('pointerdown', this.onBoardActivity)
    deps.viewportEl.addEventListener('wheel', this.onBoardActivity, {
      passive: true,
    })
  }

  destroy(): void {
    this.deps.viewportEl.removeEventListener('dragover', this.onDragOver)
    this.deps.viewportEl.removeEventListener('dragleave', this.onDragLeave)
    this.deps.viewportEl.removeEventListener('drop', this.onDrop)
    this.deps.viewportEl.removeEventListener(
      'pointerdown',
      this.onBoardActivity,
    )
    this.deps.viewportEl.removeEventListener('wheel', this.onBoardActivity)
    this.prompt?.close()
    this.prompt = null
    this.cardMenu.destroy()
  }

  /** Whether a creation prompt is open — while it is, Delete/Escape/Enter
   * belong to it rather than to the selection behind it. */
  isPromptOpen(): boolean {
    return this.prompt !== null
  }

  /** A note card's note has been read: the one created from the prompt
   * opens for typing now. */
  onNoteCardRendered(id: NodeId): void {
    if (this.editWhenNoteRendered !== id) return
    this.editWhenNoteRendered = null
    this.deps.enterEditMode(id)
  }

  /**
   * The empty-canvas menu: everything the creation bar offers, created at the
   * point that was clicked rather than at the middle of the screen, plus the
   * board-wide action that has nowhere else to live.
   *
   * Obsidian Canvas's `showCreationMenu(menu, pos, size)` is the same list
   * (card / note / media / website).
   */
  canvasMenuItems(point: ScreenPoint): YoloModuleHostMenuItemV1[] {
    const creation: YoloModuleHostMenuItemV1[] = this.core.canCreate()
      ? [
          {
            title: this.core.t('menu.newCard'),
            icon: 'sticky-note',
            onSelect: () => this.createTextCardAt(point),
          },
          {
            title: this.core.t('cardMenu.addNote'),
            icon: 'file-text',
            onSelect: () => this.promptForNoteCard(point),
          },
          {
            title: this.core.t('cardMenu.addMedia'),
            icon: 'file-image',
            onSelect: () => this.promptForMediaCard(point),
          },
          {
            title: this.core.t('cardMenu.newWebCard'),
            icon: 'globe',
            onSelect: () => this.promptForWebCard(point),
          },
          {
            title: this.core.t('menu.newGroupHere'),
            icon: 'group',
            onSelect: () => this.createEmptyGroupAt(point),
          },
          { kind: 'separator' },
        ]
      : []
    return [
      ...creation,
      {
        title: this.core.t('menu.resetCamera'),
        icon: 'locate-fixed',
        onSelect: () => this.deps.resetCamera(),
      },
    ]
  }

  /**
   * Everything that can be done to the current node selection — the
   * right-click menu's contract, and the only place some of it lives:
   * converting a card to a note is too rare to spend a button on.
   *
   * The floating toolbar builds its own row from the same commands rather than
   * showing a slice of this list. That is deliberate: a menu is what a
   * right-click produces, and Obsidian renders it with the platform's own menu
   * where the user asked for that; a button on a canvas should not open one.
   *
   * Obsidian Canvas groups these with `setSection`; with no sections in the
   * Host API's menu model, separators do the same job.
   */
  selectionMenuItems(): YoloModuleHostMenuItemV1[] {
    const ids = Array.from(this.core.getSelectedIds())
    if (ids.length === 0) return []
    const single = ids.length === 1 ? this.core.getNode(ids[0]) : null
    const items: YoloModuleHostMenuItemV1[] = []

    if (single && isPdfNode(single)) {
      items.push(
        {
          title: this.core.t('menu.openReader'),
          icon: 'book-open',
          onSelect: () => this.deps.openReader(single.id),
        },
        this.deps.exportAnnotatedPdfItem(single.file),
      )
    }
    if (this.core.canEdit() && single?.type === 'text') {
      items.push({
        title: this.core.t('menu.convertToNote'),
        icon: 'file-plus',
        onSelect: () => this.convertCardToNote(single.id),
      })
    }
    if (this.core.canEdit() && ids.length > 1) {
      items.push({
        title: this.core.t('menu.createGroup'),
        icon: 'group',
        onSelect: () => this.deps.createGroupFromSelection(),
      })
    }

    // Tidying and aligning both need two things to have a gap between them;
    // distributing needs three, so there is a gap to divide (domain/tidy.ts,
    // domain/arrange.ts). Tidy leads: it is the whole answer for most
    // selections, and the eight below it are the precise instruments for
    // someone who already knows which axis they mean.
    const targets = arrangeTargets(
      this.core.getBoard(),
      this.core.getSelectedIds(),
    ).length
    if (this.core.canEdit() && targets > 1) {
      items.push({ kind: 'separator' })
      items.push({
        title: this.core.t('menu.tidy'),
        icon: 'layout-grid',
        onSelect: () => this.deps.tidySelection(),
      })
      for (const edge of ALIGN_EDGES) {
        items.push({
          title: this.core.t(ALIGN_MENU[edge].key),
          icon: ALIGN_MENU[edge].icon,
          onSelect: () => this.deps.alignSelection(edge),
        })
      }
    }
    if (this.core.canEdit() && targets > 2) {
      items.push({ kind: 'separator' })
      for (const axis of DISTRIBUTE_AXES) {
        items.push({
          title: this.core.t(DISTRIBUTE_MENU[axis].key),
          icon: DISTRIBUTE_MENU[axis].icon,
          onSelect: () => this.deps.distributeSelection(axis),
        })
      }
    }

    items.push({ kind: 'separator' })
    // Framing works on any selection and needs no write access, so it is not
    // the group's own command it used to be.
    items.push({
      title: this.core.t('menu.zoomToSelection'),
      icon: 'scan-search',
      onSelect: () => {
        this.deps.zoomToSelection()
      },
    })
    if (single?.type === 'group' && this.core.canEdit()) {
      items.push({
        title: this.core.t('menu.renameGroup'),
        icon: 'pencil',
        onSelect: () => this.deps.beginRename({ kind: 'group', id: single.id }),
      })
    }

    if (this.core.canEdit()) {
      items.push({ kind: 'separator' })
      items.push({
        title: this.core.t('menu.deleteCard'),
        icon: 'trash-2',
        onSelect: () => this.deps.deleteNodes(ids),
      })
    }
    return trimSeparators(items)
  }

  // -- drag and drop ------------------------------------------------------
  // `dragover` must preventDefault on every event for the drop to fire at
  // all; the host resolves what the drag actually carries at `drop`, because
  // during dragover the browser hides the DataTransfer contents.

  /**
   * Whether the board itself will take a drop right now.
   *
   * False while a creation prompt is open: that panel covers the board and is
   * itself asking a question a drop can answer (ui/promptOverlay.ts's drop
   * zone), so the board behind it is not a second target. It is the same rule
   * the panel's backdrop already applies to presses and to the wheel — and
   * without it the board both lights its drop outline for a drag aimed at the
   * panel and, for a drop that lands beside the panel rather than on it,
   * makes a card nobody can see.
   */
  private get acceptsDrop(): boolean {
    return this.core.canCreate() && this.prompt === null
  }

  private readonly onDragOver = (e: DragEvent): void => {
    if (!this.acceptsDrop) return
    // A selection dragged out of a reader lands only on open canvas; over a
    // card it is not a drop at all.
    if (this.deps.isExcerptDrag(e) && this.deps.nodeIdAtPointer(e) !== null) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
      this.deps.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.deps.viewportEl.classList.add(VIEWPORT_DROP_ACTIVE_CLASS)
  }

  private readonly onDragLeave = (e: DragEvent): void => {
    // Moving across a child element fires dragleave on the way out; only a
    // pointer that actually left the viewport should clear the hint.
    const related = asNode(e.relatedTarget)
    if (related !== null && this.deps.viewportEl.contains(related)) return
    this.deps.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
  }

  private readonly onDrop = (e: DragEvent): void => {
    this.deps.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
    if (!this.acceptsDrop) return
    e.preventDefault()
    const at = this.core.worldPointFromEvent(e)
    // Text selected in one of this view's PDF readers, dragged out: an
    // excerpt card where it was dropped (./pdfIntegration.ts).
    if (
      this.deps.dropExcerpt(e, at, () => this.deps.nodeIdAtPointer(e) !== null)
    ) {
      return
    }
    // Two drags arrive here and they carry different things. One comes from
    // inside Obsidian and names vault files, which the host resolves; the
    // other comes from the operating system and carries bytes. The first is
    // asked about first because a vault drag can also expose a `File`, and a
    // file already in the vault is to be referenced, never copied.
    const entries = this.core.host.ui.resolveDropEntries(e)
    if (entries.length > 0) {
      // Every file kind that has a card of its own is droppable — the same
      // table the renderer dispatches on (domain/naming.ts's fileNodeKind), so
      // "you can drop it" and "it renders" can never disagree.
      const droppable = entries.filter(
        (entry) =>
          entry.kind === 'file' && fileNodeKind(entry.path) !== 'unsupported',
      )
      if (droppable.length === 0) {
        this.core.host.ui.notice(this.core.t('notice.dropUnsupported'))
        return
      }
      this.addFileCards(
        droppable.map((entry) => entry.path),
        at,
      )
      return
    }
    // Read out synchronously: the `DataTransfer` is neutered once this handler
    // returns, while the `File` objects taken from it stay readable.
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    void this.importDroppedFiles(files, at)
  }

  /**
   * Takes documents dropped from outside the vault and makes cards of them.
   *
   * Only HTML, for now, and by the same rule everything else on this board
   * follows: a card kind exists or it does not, and `fileNodeKind` is the one
   * table that says so. An image dropped from the desktop is a card we could
   * make too, but Obsidian already owns "import an attachment" with a
   * configurable destination folder, and duplicating that policy here is the
   * kind of second implementation this module is supposed to avoid — an HTML
   * document has no such path anywhere in Obsidian, which is why it gets one.
   *
   * The copy lands beside the board, where a card converted to a note already
   * goes: the board is what the file belongs to.
   */
  private async importDroppedFiles(
    files: readonly File[],
    at: ScreenPoint,
  ): Promise<void> {
    // Checked at both ends: the prompt's drop zone reaches this too, and a
    // board whose file failed to parse between opening that panel and
    // dropping on it should not have files written beside it for cards it
    // will refuse.
    if (!this.core.canCreate()) return
    const importable = files.filter(
      (file) => fileNodeKind(file.name) === 'html',
    )
    if (importable.length === 0) {
      this.core.host.ui.notice(this.core.t('notice.dropUnsupported'))
      return
    }
    const paths: string[] = []
    try {
      // No ensureFolder: the board's own folder exists by definition.
      const folderPath = this.boardFolderPath()
      const taken = new Set(
        this.core.host.vault
          .listChildren(folderPath)
          .filter((entry) => entry.kind === 'file')
          .map((entry) => entry.name),
      )
      for (const file of importable) {
        const fileName = generateDroppedHtmlFileName(
          file.name,
          this.core.t('file.newHtmlBaseName'),
          taken,
        )
        // Written one at a time rather than in parallel: the names are chosen
        // against a set this loop is also adding to, so two documents dropped
        // together cannot be handed the same one.
        taken.add(fileName)
        const path = folderPath ? `${folderPath}/${fileName}` : fileName
        await this.core.host.vault.createBinary(path, await file.arrayBuffer())
        paths.push(path)
      }
    } catch (error) {
      this.core.reportError('importDroppedFiles', error)
      this.core.host.ui.notice(this.core.t('error.dropFailed'))
      // Whatever did land is still a card worth having; only the rest is lost.
      if (paths.length === 0) return
    }
    // The board may have been closed, or failed to parse, while the files
    // were written.
    if (!this.core.canCreate()) return
    this.addFileCards(paths, at)
  }

  // -----------------------------------------------------------------------
  // Card creation and conversion.
  //
  // Double-click and the canvas context menu both create a *text* card: it
  // is pure board data, so the cheapest gesture on the canvas carries no
  // side effect outside the file. "Card as note" is
  // reached deliberately, through `convertCardToNote` — the user decides
  // when a card earns a file, rather than every stray double-click leaving
  // an empty note in the vault.

  /**
   * The world point the creation bar's buttons place a card on: the middle of
   * what is currently on screen.
   *
   * Obsidian Canvas's own `posCenter()` for the same three buttons. Placing a
   * card somewhere precise is the canvas context menu's job — it creates at the
   * point that was right-clicked, exactly as Canvas's `showCreationMenu(menu,
   * pos, size)` does.
   */
  viewportCenterWorld(): ScreenPoint {
    return screenToWorld(this.core.getView(), {
      x: this.deps.viewportEl.clientWidth / 2,
      y: this.deps.viewportEl.clientHeight / 2,
    })
  }

  refreshCardMenu(): void {
    this.cardMenu?.setAvailable(this.core.canCreate())
    if (this.core.getBoard().nodes.length === 0) {
      this.cardMenu?.setAutoCollapse(false)
    }
  }

  /**
   * The creation bar stays out while a board is being opened and looked at,
   * and tucks itself away once the board is being worked on — any press or
   * wheel on it — coming back when the pointer reaches for it
   * (ui/cardMenu.ts). Not on an empty board: there it is the way in, and the
   * board's hint points at it.
   */
  private readonly onBoardActivity = (event: Event): void => {
    if (this.deps.overlay.contains(event.target as Node | null)) return
    if (this.core.getBoard().nodes.length === 0) return
    this.cardMenu.setAutoCollapse(true)
  }

  /** One entry on the bar: the same creation from the keyboard, which names
   * no place and takes the middle of the screen, and from a pointer, which
   * names one. `size` is what this entry creates, so the ghost is a ghost of
   * the card rather than of a card. */
  private creationAction(
    labelKey: string,
    icon: CardMenuIconName,
    size: CardSize,
    create: (at: ScreenPoint) => void,
  ): CardMenuAction {
    return {
      label: this.core.t(labelKey),
      icon,
      onSelect: () => create(this.viewportCenterWorld()),
      onPress: (event) => this.deps.beginCreateDrag(event, size, create),
    }
  }

  // -- creation prompts ---------------------------------------------------
  // Three of the four creation entries need a value before they can act. Each
  // opens the same panel (ui/promptOverlay.ts); what differs is the list it
  // filters and what the chosen value becomes.
  //
  // Where the card goes is settled before the panel opens and carried through
  // it: a drop names its place, and by the time a note has been chosen the
  // pointer is long gone. Canvas orders it the same way — `dragTempNode`'s
  // callback opens the picker with the dropped position already captured.

  /** Opens a prompt, replacing any already open. Closing is this view's own
   * bookkeeping, so callers describe only what they are asking for. */
  private openPrompt(options: Omit<PromptOverlayOptions, 'onClose'>): void {
    if (!this.core.canCreate()) return
    this.prompt?.close()
    this.deps.closePopover()
    this.prompt = new PromptOverlay(
      this.core.context.getDocument(),
      this.deps.overlay,
      {
        ...options,
        onClose: () => {
          this.prompt = null
          this.deps.onPromptChange()
        },
      },
    )
    // While the panel has the caret, Delete/Escape/Enter belong to it — the
    // same rule that keeps the selection's bindings off an open label field.
    this.deps.onPromptChange()
  }

  private promptForNoteCard(
    center: ScreenPoint = this.viewportCenterWorld(),
  ): void {
    this.openPrompt({
      title: this.core.t('prompt.addNoteTitle'),
      placeholder: this.core.t('prompt.searchPlaceholder'),
      mode: {
        kind: 'pick',
        suggestions: this.core.host.vault
          .listMarkdownFiles()
          .map((file) => this.suggestionForPath(file.path)),
        emptyText: this.core.t('prompt.noMatches'),
        // A note that does not exist yet is one keystroke away rather than a
        // text card and a "convert to note" later.
        create: {
          nameFor: (query) => sanitizeFileName(query) || null,
          label: (name) =>
            this.core.t('prompt.createNote').replace('{name}', name),
          onCreate: (name) => void this.createNoteCardAt(name, center),
        },
      },
      onSubmit: (path) => this.addFileCards([path], center),
    })
  }

  /** Writes a new, empty note beside the board and puts it on the board as a
   * note card, opened for typing. */
  private async createNoteCardAt(
    baseName: string,
    world: ScreenPoint,
  ): Promise<void> {
    if (!this.core.canEdit()) return
    let path: string
    try {
      path = await this.createBoardNote(baseName, '')
    } catch (error) {
      this.core.reportError('create note', error)
      this.core.host.ui.notice(this.core.t('error.createNoteFailed'))
      return
    }
    const [id] = this.addFileCards([path], world)
    if (id === undefined) return
    this.core.clearSelection()
    this.editWhenNoteRendered = id
  }

  private promptForMediaCard(
    center: ScreenPoint = this.viewportCenterWorld(),
  ): void {
    this.openPrompt({
      title: this.core.t('prompt.addMediaTitle'),
      placeholder: this.core.t('prompt.searchPlaceholder'),
      mode: {
        kind: 'pick',
        suggestions: this.collectMediaPaths('').map((path) =>
          this.suggestionForPath(path),
        ),
        emptyText: this.core.t('prompt.noMedia'),
      },
      onSubmit: (path) => this.addFileCards([path], center),
    })
  }

  private promptForWebCard(
    center: ScreenPoint = this.viewportCenterWorld(),
  ): void {
    this.openPrompt({
      title: this.core.t('prompt.newWebCardTitle'),
      placeholder: this.core.t('prompt.urlPlaceholder'),
      mode: { kind: 'text' },
      dropZone: {
        label: this.core.t('prompt.webDropHint'),
        onDrop: (files) => void this.importDroppedFiles(files, center),
      },
      onSubmit: (url) => this.createLinkCardAt(url, center),
    })
  }

  private suggestionForPath(path: string): PromptSuggestion {
    const folder = folderPathOf(path)
    return {
      value: path,
      title: basenameWithoutExtension(path),
      // The containing folder, so two notes of the same name are told apart.
      ...(folder ? { detail: folder } : {}),
    }
  }

  /**
   * Every image, audio, video and PDF file in the vault, depth-first from
   * `folderPath` — Obsidian Canvas's "add media from vault" offers PDFs
   * alongside the rest too.
   *
   * The Host API lists markdown files directly (`listMarkdownFiles`) but has
   * nothing equivalent for media, so this walks the tree the same way
   * `host/importCanvasFile.ts` already walks it looking for `.canvas` files.
   * The kinds come from the same table the renderer dispatches on
   * (domain/naming.ts's `fileNodeKind`), so "you can pick it" and "it renders"
   * cannot disagree.
   */
  private collectMediaPaths(folderPath: string): string[] {
    const paths: string[] = []
    for (const entry of this.core.host.vault.listChildren(folderPath)) {
      if (entry.kind === 'folder') {
        paths.push(...this.collectMediaPaths(entry.path))
        continue
      }
      const kind = fileNodeKind(entry.path)
      if (
        kind === 'image' ||
        kind === 'audio' ||
        kind === 'video' ||
        kind === 'pdf'
      ) {
        paths.push(entry.path)
      }
    }
    return paths
  }

  /**
   * Creates a web card for `url`, centred on `world`.
   *
   * A bare host ("example.com") is given `https://`, because a URL typed
   * without a scheme is still a URL the user meant — and the card only ever
   * loads http(s) anyway (WEB_URL_PATTERN), so a value that cannot be made
   * into one is refused here rather than becoming a card that says it is not a
   * web address.
   */
  private createLinkCardAt(url: string, world: ScreenPoint): void {
    if (!this.core.canCreate()) return
    const normalized = WEB_URL_PATTERN.test(url) ? url : `https://${url}`
    if (!WEB_URL_PATTERN.test(normalized)) {
      this.core.host.ui.notice(this.core.t('notice.invalidUrl'))
      return
    }
    const node: LinkNode = {
      id: this.core.nextNodeId(),
      type: 'link',
      x: Math.round(world.x - NEW_EMBED_CARD_SIZE.w / 2),
      y: Math.round(world.y - NEW_EMBED_CARD_SIZE.h / 2),
      w: NEW_EMBED_CARD_SIZE.w,
      h: NEW_EMBED_CARD_SIZE.h,
      url: normalized,
      extra: {},
    }
    this.core.applyBoardChange(addNode(this.core.getBoard(), node))
    this.core.recomputeVisibility()
    this.core.drainQueues()
    this.core.setSelection([node.id])
  }

  /** Creates an empty text card centered on `world` and opens it for typing. */
  createTextCardAt(world: ScreenPoint): void {
    // Below the LOD threshold enterEditMode declines, which would leave this
    // gesture producing an invisible empty card with no editor. That lives in
    // `canCreate`.
    if (!this.core.canCreate()) return
    const node: TextNode = {
      id: this.core.nextNodeId(),
      type: 'text',
      x: Math.round(world.x - NEW_CARD_SIZE.w / 2),
      y: Math.round(world.y - NEW_CARD_SIZE.h / 2),
      w: NEW_CARD_SIZE.w,
      h: NEW_CARD_SIZE.h,
      text: '',
      extra: {},
    }
    this.core.applyBoardChange(addNode(this.core.getBoard(), node))
    this.core.clearSelection()
    // The card has to exist in the DOM before an editor can be mounted into
    // it, and mounting is normally driven by the rAF loop. Draining now
    // makes the new card available in this same turn; it is inside the
    // viewport by construction, so it is always in the mount queue.
    this.core.recomputeVisibility()
    this.core.drainQueues()
    this.core.context.requestSave()
    this.deps.enterEditMode(node.id)
  }

  /** Adds one file card per vault path, staggered from `world`. Which kind of
   * card each becomes is decided at render time from its extension, so this
   * is one path for notes, images, audio and video alike. */
  private addFileCards(paths: readonly string[], world: ScreenPoint): NodeId[] {
    if (!this.core.canEdit() || paths.length === 0) return []
    let board = this.core.getBoard()
    const ids: NodeId[] = []
    for (const [index, path] of paths.entries()) {
      const offset = index * DROP_STAGGER_PX
      const id = this.core.nextNodeId(board)
      ids.push(id)
      board = addNode(board, {
        id,
        type: 'file',
        x: Math.round(world.x - NEW_EMBED_CARD_SIZE.w / 2 + offset),
        y: Math.round(world.y - NEW_EMBED_CARD_SIZE.h / 2 + offset),
        w: NEW_EMBED_CARD_SIZE.w,
        h: NEW_EMBED_CARD_SIZE.h,
        file: path,
        extra: {},
      })
    }
    this.core.applyBoardChange(board)
    this.core.recomputeVisibility()
    this.core.drainQueues()
    return ids
  }

  /** An empty group centered on the clicked point, sized to hold one default
   * card with the same breathing room a selection-made group gets. Selected on
   * creation so the double-click-to-name affordance is one gesture away. */
  private createEmptyGroupAt(world: ScreenPoint): void {
    if (!this.core.canCreate()) return
    const w = NEW_CARD_SIZE.w + GROUP_SELECTION_PADDING * 2
    const h = NEW_CARD_SIZE.h + GROUP_SELECTION_PADDING * 2
    const group: GroupNode = {
      id: this.core.nextNodeId(),
      type: 'group',
      x: Math.round(world.x - w / 2),
      y: Math.round(world.y - h / 2),
      w,
      h,
      extra: {},
    }
    this.core.applyBoardChange({
      ...this.core.getBoard(),
      nodes: [group, ...this.core.getBoard().nodes],
    })
    this.core.recomputeVisibility()
    this.core.drainQueues()
    this.core.setSelection([group.id])
  }

  /**
   * Turns a text card into a note card backed by a real vault file.
   *
   * The card keeps its id, position, and edges (`replaceCard`); only its
   * identity changes. Its markdown is written as `cardNoteContent` splits
   * it: the leading heading that named the file does not also stay in the
   * body, because from here on the card shows that name as its title.
   */
  private convertCardToNote(id: NodeId): void {
    if (!this.core.canEdit()) return
    const card = this.core.getNode(id)
    if (!card || card.type !== 'text') return
    // Commit the live text first so the note is written from what the user
    // currently sees, not from the last committed snapshot.
    this.deps.commitEditOn(id)
    const current = this.core.getNode(id)
    if (!current || current.type !== 'text') return
    void this.writeCardNote(current)
  }

  private async writeCardNote(node: TextNode): Promise<void> {
    const { baseName, body } = cardNoteContent(
      node.text,
      this.core.t('file.newNoteBaseName'),
    )
    try {
      const path = await this.createBoardNote(baseName, body)

      // The board may have moved on while the file was being written.
      const latest = this.core.getNode(node.id)
      if (!latest || latest.type !== 'text') return
      const note: FileNode = {
        id: latest.id,
        type: 'file',
        x: latest.x,
        y: latest.y,
        w: latest.w,
        h: latest.h,
        file: path,
        extra: latest.extra,
      }
      this.core.applyBoardChange(
        replaceNode(this.core.getBoard(), latest.id, note),
      )
      // The card's content now comes from a file rather than from the board,
      // so its mounted preview has to be rebuilt against the new source.
      this.deps.purgeNodeRuntime(latest.id)
      this.core.recomputeVisibility()
      this.core.drainQueues()
      this.core.context.requestSave()
      this.core.host.ui.notice(
        this.core.t('notice.convertedToNote').replace('{path}', path),
      )
    } catch (error) {
      this.core.reportError('convert card to note', error)
      this.core.host.ui.notice(this.core.t('error.convertFailed'))
    }
  }

  /**
   * Writes a note beside the board under `baseName`, numbered if that name is
   * taken, and returns its path — the one rule both a converted card and a
   * note created from the prompt follow.
   */
  private async createBoardNote(
    baseName: string,
    body: string,
  ): Promise<string> {
    // No ensureFolder: the board's own folder exists by definition.
    const folderPath = this.boardFolderPath()
    const existingNames = new Set(
      this.core.host.vault
        .listChildren(folderPath)
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.name),
    )
    const fileName = generateCardNoteFileName(baseName, existingNames)
    const path = folderPath ? `${folderPath}/${fileName}` : fileName
    await this.core.host.vault.createText(path, body)
    return path
  }

  /**
   * The board's own folder — where a converted card's note is written.
   *
   * Deliberately not a `<board name> Cards/` subfolder (the original rule):
   * a folder named after the board has to be renamed and
   * moved whenever the board is, and until it is, one board's cards sit in
   * two different folders. Writing beside the board needs no such rule and
   * cannot drift. A board at the vault root returns '', which every vault
   * call here already treats as the root.
   */
  private boardFolderPath(): string {
    const boardPath = this.core.getSourcePath()
    const lastSlash = boardPath.lastIndexOf('/')
    return lastSlash === -1 ? '' : boardPath.slice(0, lastSlash)
  }
}

/**
 * Drops separators that no longer divide anything — leading, trailing, or
 * doubled. A menu assembled from optional groups cannot know which of them
 * survived, so it writes the divider it needs and lets this settle the result.
 */
function trimSeparators(
  items: readonly YoloModuleHostMenuItemV1[],
): YoloModuleHostMenuItemV1[] {
  const trimmed: YoloModuleHostMenuItemV1[] = []
  for (const item of items) {
    if (item.kind !== 'separator') {
      trimmed.push(item)
      continue
    }
    if (trimmed[trimmed.length - 1]?.kind === 'separator') continue
    if (trimmed.length > 0) trimmed.push(item)
  }
  if (trimmed[trimmed.length - 1]?.kind === 'separator') trimmed.pop()
  return trimmed
}
