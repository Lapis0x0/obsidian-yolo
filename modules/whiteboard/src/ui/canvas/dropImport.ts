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
  sanitizeFileName,
} from '../../domain/naming'
import { addNode, replaceNode, updateNode } from '../../domain/operations'
import type { Rect } from '../../domain/placement'
import type { CardSize } from '../../domain/resize'
import { isSpreadTitle } from '../../domain/spread'
import {
  CardMenu,
  type CardMenuAction,
  type CardMenuIconName,
} from '../cardMenu'
import {
  DROP_STAGGER_PX,
  GRID_WORLD_STEP_PX,
  MIN_CARD_SIZE,
  NEW_CARD_SIZE,
  NEW_EMBED_CARD_SIZE,
  NEW_TEXT_SIZE,
  WEB_URL_PATTERN,
  fileCardSizes,
} from '../constants'
import { asNode } from '../eventTarget'
import {
  PromptOverlay,
  type PromptOverlayOptions,
  type PromptSuggestion,
} from '../promptOverlay'

import type { CanvasCore } from './core'
import { importExternalFiles } from './externalFiles'
import { isPdfNode } from './pdfIntegration'
import { ALIGN_MENU, DISTRIBUTE_MENU } from './toolbarController'

const VIEWPORT_DROP_ACTIVE_CLASS = 'yolo-whiteboard-viewport-drop-active'
/** Where an excerpt dragged out of a PDF will land, drawn in the world
 * layer (`showLandingSlot`). */
const LANDING_SLOT_CLASS = 'yolo-whiteboard-landing-slot'
const LANDING_SLOT_SHOWN_CLASS = 'yolo-whiteboard-landing-slot-shown'

/** Which label a rename acts on — the selection menu's "rename group". */
type RenameTarget = Readonly<{ kind: 'group'; id: NodeId }>

export type DropImportDeps = Readonly<{
  core: CanvasCore
  /** The board's viewport: the drop target, and what "the middle of the
   * screen" is measured in. */
  viewportEl: HTMLElement
  /** The camera-transformed layer the cards are in: the landing slot is
   * drawn there, so it is sized and moved by the camera as a card is. */
  worldEl: HTMLElement
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
  /** A dragged selection is over the board: where it would land (world),
   * or null where it cannot. */
  previewExcerpt: (e: DragEvent, at: ScreenPoint | null) => void
  dropExcerpt: (
    e: DragEvent,
    at: ScreenPoint,
    isOverCard: () => boolean,
  ) => boolean
  openReader: (id: NodeId) => void
  /** Spreads a PDF's pages out on the board, or puts them away
   * (the canvas's `toggleSpread`). */
  toggleSpread: (id: NodeId) => void
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

  private landingSlot: HTMLElement | null = null

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
        this.creationAction('cardMenu.addText', 'type', NEW_TEXT_SIZE, (at) =>
          this.createTextAt(at),
        ),
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
    this.landingSlot?.remove()
    this.landingSlot = null
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
    const creation: YoloModuleHostMenuItemV1[] = this.core.canEdit()
      ? [
          {
            title: this.core.t('menu.newText'),
            icon: 'type',
            onSelect: () => this.createTextAt(point),
          },
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
    // A PDF card spreads its pages out on the board, and a spread — asked
    // through its title or any of its sheets — is put away again.
    const spreadOf =
      single?.type === 'pdf-page' ? this.core.getNode(single.parent) : single
    if (this.core.canEdit() && spreadOf && isPdfNode(spreadOf)) {
      const open = isSpreadTitle(spreadOf)
      items.push({
        title: this.core.t(open ? 'menu.closeSpread' : 'menu.openSpread'),
        icon: open ? 'minimize-2' : 'maximize-2',
        onSelect: () => this.deps.toggleSpread(spreadOf.id),
      })
    }
    if (this.core.canEdit() && single?.type === 'text') {
      const plain = single.plain === true
      items.push({
        title: this.core.t(plain ? 'menu.convertToCard' : 'menu.convertToText'),
        icon: plain ? 'sticky-note' : 'type',
        onSelect: () => this.switchTextDisplay(single.id),
      })
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
   *
   * Open in the overview tier too, as all creation is: what a drop makes is
   * a file card, drawn there as it will be up close.
   */
  private get acceptsDrop(): boolean {
    return this.core.canEdit() && this.prompt === null
  }

  /**
   * Where a card dragged out of a PDF reader by pointer — a frame or an
   * annotation, which the platform's drag and drop cannot carry — would
   * land: the world point under the pointer, on open canvas of a board that
   * takes drops now; null anywhere else. The same rule `onDragOver` applies
   * to a dragged selection.
   */
  pointerDropPoint(e: MouseEvent): ScreenPoint | null {
    if (!this.acceptsDrop) return null
    const target = asNode(e.target)
    if (target === null || !this.deps.viewportEl.contains(target)) return null
    if (this.deps.nodeIdAtPointer(e) !== null) return null
    return this.core.worldPointFromEvent(e)
  }

  /**
   * Shows where an excerpt dragged out of a PDF will land — `rect` in world
   * units, the text it will be, holding `body`, that text as it will read —
   * or, with null, takes the slot away.
   *
   * An excerpt's drag shows this instead of the board-wide drop hint. That
   * hint is for a file from outside, whose card nobody can see coming; an
   * excerpt has a known look and a known place, and showing exactly that,
   * where the pointer is, says more than lighting up the whole board.
   */
  showLandingSlot(
    landing: Readonly<{ rect: Readonly<Rect>; body: HTMLElement }> | null,
  ): void {
    if (!landing) {
      this.landingSlot?.classList.remove(LANDING_SLOT_SHOWN_CLASS)
      return
    }
    let slot = this.landingSlot
    if (!slot) {
      slot = this.deps.worldEl.ownerDocument.createElement('div')
      slot.className = LANDING_SLOT_CLASS
      this.landingSlot = slot
    }
    // Last in the world layer: over the cards it would overlap, since that
    // overlap is part of what it is showing.
    if (slot !== this.deps.worldEl.lastElementChild) {
      this.deps.worldEl.appendChild(slot)
    }
    // As wide as the text will be, from where its top will be; as tall as
    // what it holds, laid out as the text will lay it out — the height the
    // text takes once made, which the rect only estimates.
    const { rect, body } = landing
    if (slot.firstChild !== body) slot.replaceChildren(body)
    slot.setCssProps({
      width: `${rect.w}px`,
      transform: `translate(${rect.x}px, ${rect.y}px)`,
    })
    slot.classList.add(LANDING_SLOT_SHOWN_CLASS)
  }

  private readonly onDragOver = (e: DragEvent): void => {
    if (!this.acceptsDrop) return
    // A selection dragged out of a reader lands only on open canvas; over a
    // card it is not a drop at all.
    if (this.deps.isExcerptDrag(e)) {
      if (this.deps.nodeIdAtPointer(e) !== null) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
        this.deps.previewExcerpt(e, null)
        return
      }
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      this.deps.previewExcerpt(e, this.core.worldPointFromEvent(e))
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
    this.showLandingSlot(null)
  }

  private readonly onDrop = (e: DragEvent): void => {
    this.deps.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
    this.showLandingSlot(null)
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
      void this.placeFileCards(
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
   * Makes cards of files dropped from outside the vault: every kind that has
   * a card of its own (`fileNodeKind`, the table the renderer dispatches on),
   * brought in as attachments exactly as a paste brings them
   * (./externalFiles.ts) — one way in from outside, however they arrive.
   */
  private async importDroppedFiles(
    files: readonly File[],
    at: ScreenPoint,
  ): Promise<void> {
    // Checked at both ends: the prompt's drop zone reaches this too, and a
    // board whose file failed to parse between opening that panel and
    // dropping on it should not have files written for cards it will refuse.
    if (!this.core.canEdit()) return
    const importable = files.filter(
      (file) => fileNodeKind(file.name) !== 'unsupported',
    )
    if (importable.length === 0) {
      this.core.host.ui.notice(this.core.t('notice.dropUnsupported'))
      return
    }
    const paths = await importExternalFiles(
      this.core,
      importable,
      this.core.t('error.dropFailed'),
    )
    // Whether the board is still there to take them is `addFileCards`'s to
    // ask, after the measuring too.
    if (paths.length === 0) return
    await this.placeFileCards(paths, at)
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
    this.cardMenu?.setAvailable(this.core.canEdit())
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
    if (!this.core.canEdit()) return
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
    // Down in the overview tier it renders only once the camera has gone to
    // it, which `enterEditMode` does, waiting for the note's text itself.
    if (this.core.isOverview()) this.deps.enterEditMode(id)
    else this.editWhenNoteRendered = id
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
      onSubmit: (path) => void this.placeFileCards([path], center),
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
    if (!this.core.canEdit()) return
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
    // In the overview tier `enterEditMode` goes to the card first.
    if (!this.core.canEdit()) return
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

  /**
   * Starts bare text at `world` and opens it for typing: the caret lands
   * where the double-click was, one line's box around it.
   *
   * Not recorded yet. Text with nothing in it is nothing to undo, and text
   * left that way is taken off again (canvas.ts's `discardText`); the first
   * thing typed records it, with the text in it, as one step.
   */
  createTextAt(world: ScreenPoint): void {
    if (!this.core.canEdit()) return
    const node: TextNode = {
      id: this.core.nextNodeId(),
      type: 'text',
      // Its inset (styles/cards/text.css) before the caret.
      x: Math.round(world.x - 4),
      y: Math.round(world.y - NEW_TEXT_SIZE.h / 2),
      w: NEW_TEXT_SIZE.w,
      h: NEW_TEXT_SIZE.h,
      text: '',
      plain: true,
      autoWidth: true,
      extra: {},
    }
    this.core.commitWithoutHistory(addNode(this.core.getBoard(), node))
    this.core.clearSelection()
    // Mounted now rather than on the next frame, so the editor has an
    // element to go into (the same as a new card).
    this.core.recomputeVisibility()
    this.core.drainQueues()
    this.deps.enterEditMode(node.id)
  }

  /** `addFileCards` at the size each file's card is made at, which for a
   * PDF means reading its first page first (`fileCardSize`). */
  private async placeFileCards(
    paths: readonly string[],
    world: ScreenPoint,
  ): Promise<void> {
    const sizes = await fileCardSizes(this.core.host.pdf, paths)
    // The board may have been closed, or broken, meanwhile — which
    // `addFileCards` asks about itself.
    this.addFileCards(paths, world, sizes)
  }

  /** Adds one file card per vault path, staggered from `world`, at `sizes`
   * (an embed card's where it says nothing: a note just written, which has
   * nothing to measure). Which kind of card each becomes is decided at
   * render time from its extension, so this is one path for notes, images,
   * audio, video and PDFs alike. */
  private addFileCards(
    paths: readonly string[],
    world: ScreenPoint,
    sizes: ReadonlyMap<string, CardSize> = new Map(),
  ): NodeId[] {
    if (!this.core.canEdit() || paths.length === 0) return []
    let board = this.core.getBoard()
    const ids: NodeId[] = []
    for (const [index, path] of paths.entries()) {
      const offset = index * DROP_STAGGER_PX
      const size = sizes.get(path) ?? NEW_EMBED_CARD_SIZE
      const id = this.core.nextNodeId(board)
      ids.push(id)
      board = addNode(board, {
        id,
        type: 'file',
        x: Math.round(world.x - size.w / 2 + offset),
        y: Math.round(world.y - size.h / 2 + offset),
        w: size.w,
        h: size.h,
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
    if (!this.core.canEdit()) return
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

  /**
   * Turns a text card into bare text, or bare text into a card: the same
   * node, the same markdown, drawn the other way.
   *
   * Card to text keeps the card's width as the text's own, and the height
   * becomes whatever the text takes at it. Text to card keeps the box the
   * text had, rounded out to whole grid cells so the card sits on the grid
   * the way a card made on the board does.
   */
  private switchTextDisplay(id: NodeId): void {
    if (!this.core.canEdit()) return
    this.deps.commitEditOn(id)
    const node = this.core.getNode(id)
    if (!node || node.type !== 'text') return
    const cell = (size: number, min: number) =>
      Math.max(min, Math.ceil(size / GRID_WORLD_STEP_PX) * GRID_WORLD_STEP_PX)
    const patch =
      node.plain === true
        ? {
            plain: undefined,
            autoWidth: undefined,
            w: cell(node.w, MIN_CARD_SIZE.w),
            h: cell(node.h, MIN_CARD_SIZE.h),
          }
        : { plain: true, startLine: undefined }
    this.core.applyBoardChange(updateNode(this.core.getBoard(), id, patch))
    // Which element it is and how it is sized are decided at mount.
    this.deps.purgeNodeRuntime(id)
    this.core.recomputeVisibility()
    this.core.drainQueues()
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
