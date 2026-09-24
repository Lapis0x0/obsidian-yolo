// A card's text and a label's name, being typed: entering and leaving a
// card's editor, the throttled writes in between, and the one commit path they
// all end in; letting the pointer into a card's live content; handing a
// card's body to rung one's generation and taking it back; renaming a group
// or an edge in place.
//
// Split out of `../canvas.ts` (no behaviour change). The canvas still owns the
// board, its history and the selection; this class owns only what is being
// typed right now (the editing session, the label being renamed, the card the
// pointer was let into), and commits through `CanvasCore`.
// `WhiteboardCanvas` is the only importer; this module must never import it
// back.
//
// Edit lifecycle: click -> live CM6 editor; blur (native, or a programmatic
// `.blur()` from Escape / a card switch / teardown) -> the single `finishEdit`
// commit path. Never write back from anywhere else — this is what keeps blur
// and Escape from double-committing.

import { planNodeCommit } from '../../domain/commit'
import type { Board, BoardNode, EdgeId, NodeId } from '../../domain/fileFormat'
import { isMarkdownPath } from '../../domain/naming'
import { updateEdge, updateNode } from '../../domain/operations'
import { resolveCardContext } from '../../host/cardContext'
import {
  CARD_ENTERED_CLASS,
  EDIT_PERSIST_THROTTLE_MS,
  GROUP_LABEL_CLASS,
} from '../constants'

import type { CardRenderer } from './cardRenderer'
import type { CanvasCore } from './core'
import type { EdgeLayer } from './edgeLayer'
import { KEY_LAYER_RANK, type KeyLayers } from './keymapController'

const CARD_EDITING_CLASS = 'yolo-whiteboard-card-editing'
/** On a card whose body is being written into by rung one
 * (./cardGeneration.ts). */
const CARD_GENERATING_CLASS = 'yolo-whiteboard-card-generating'
const EDITOR_HOST_CLASS = 'yolo-whiteboard-editor-host'
/** On the world layer while an edge label is being typed in the overview
 * tier — see `syncEdgeRenameChrome`. */
const WORLD_EDGE_RENAME_CLASS = 'yolo-whiteboard-world-edge-rename'

type EditingState = {
  readonly nodeId: NodeId
  readonly editor: YoloModuleHostMarkdownEditorV1
  readonly scopeDisposer: () => void
  /** Identifies this editing session to the history, so its many commits
   * (throttled writes plus the final flush) fold into one undo step. */
  readonly historyKey: string
  /** Pending throttled write of what is currently in the editor; see
   * `scheduleEditPersist`. */
  persistTimer: number | null
}

/** Which label a rename is acting on. The two kinds are typed the same way
 * (in place, on the element itself) and differ only in where the text is
 * read from and written back to. */
type LabelTarget =
  | Readonly<{ kind: 'group'; id: NodeId }>
  | Readonly<{ kind: 'edge'; id: EdgeId }>

function sameLabelTarget(a: LabelTarget, b: LabelTarget): boolean {
  return a.kind === b.kind && a.id === b.id
}

export type { LabelTarget }

export type EditingControllerDeps = Readonly<{
  core: CanvasCore
  cards: CardRenderer
  edges: EdgeLayer
  /** The world layer, whose class brings an edge label back into the
   * overview tier's drawing while it is typed. */
  worldEl: HTMLElement
  /** Asked to edit a card in the overview tier, where it has no element:
   * bring the camera in to it and open it once it is there (canvas.ts's
   * `zoomInToEdit`). */
  zoomInToEdit: (id: NodeId) => void
  /** Exempts a card from virtualization unmount, and lifts the exemption. */
  pin: (id: NodeId) => void
  unpin: (id: NodeId) => void
  /** An empty card's AI chips, re-asked (./cardGeneration.ts). */
  syncChips: (id: NodeId) => void
  /** Where the editor was left becomes the card's reading window: written
   * to the board without a history step or a save of its own (the commit
   * that follows saves it). */
  writeReadingWindow: (id: NodeId, line: number) => void
  subscribeViewChange: (listener: () => void) => () => void
  /** Whether the overview tier's chrome (edges and their labels) is out of
   * the drawing. */
  isOverviewChromeHidden: () => boolean
  flushOverviewChromeZoomScale: () => void
  closePopover: () => void
  /** A rename started or ended: the selection's keys re-decide whether they
   * are armed. */
  onRenameChange: () => void
  /** Where Escape's live-content layer goes. */
  keyLayers: KeyLayers
  /** Gives the keyboard back to the board: a field left by a key would
   * otherwise leave focus on nothing, where the board's copy and paste
   * (./clipboardController.ts) cannot hear it. A field left by a press
   * needs nothing — the press focuses whatever it landed on. */
  focusBoard: () => void
}>

export class EditingController {
  private readonly core: CanvasCore
  private editing: EditingState | null = null
  private editSessionCounter = 0
  /**
   * The card the pointer has been let into, or null.
   *
   * Only ever the focused card — entering is asked for on a selected card and
   * `applyFocusedNode` drops it the moment focus moves on — but it is its own
   * field rather than a flag on the focus, because that is the whole
   * distinction: a card can be selected without its content being reachable,
   * which is what keeps a selected web card draggable. See
   * `enterLiveContent` and CARD_ENTERED_CLASS.
   */
  private enteredNodeId: NodeId | null = null
  /** The label being typed in place, if any — see `beginRename`. It holds
   * off the selection's keymap scope for as long as it has the caret. */
  private renaming: LabelTarget | null = null

  constructor(private readonly deps: EditingControllerDeps) {
    this.core = deps.core
    // Escape steps out of a card's content before it lets go of the card. An
    // entered card is always the focused one, so this layer only ever answers
    // while there is a selection.
    deps.keyLayers.addLayer('escape', KEY_LAYER_RANK.content, () => {
      if (this.enteredNodeId === null) return null
      this.exitLiveContent()
      return true
    })
  }

  /** Whether a card's editor is open at all. */
  isActive(): boolean {
    return this.editing !== null
  }

  /** Whether this card's editor is the one open. */
  isEditing(id: NodeId | null): boolean {
    return id !== null && this.editing?.nodeId === id
  }

  /** The open editor's live text, when it is this card's. */
  editingText(id: NodeId): string | null {
    return this.editing?.nodeId === id ? this.editing.editor.getValue() : null
  }

  /** Commits the open editor through its one blur path — only when it is
   * the editor of one of `ids`, or of any card when `ids` is omitted. */
  blurEditor(ids?: readonly NodeId[]): void {
    const editing = this.editing
    if (!editing) return
    if (ids && !ids.includes(editing.nodeId)) return
    editing.editor.blur()
  }

  /**
   * The open editor's text folded into `board`, via the same `planNodeCommit`
   * decision the actual commit path uses, without its write side effects (a
   * note card's live text is not part of the board at all, so only a text
   * card's `updateBoard` outcome changes anything here).
   */
  foldLiveEdit(board: Board): Board {
    if (!this.editing) return board
    const liveText = this.editing.editor.getValue()
    const action = planNodeCommit(board, this.editing.nodeId, liveText)
    return action.kind === 'updateBoard' ? action.board : board
  }

  /** The card the pointer has been let into, or null. */
  getEnteredNodeId(): NodeId | null {
    return this.enteredNodeId
  }

  /** Every card is about to go: the entered one is dropped rather than
   * exited, as there is no class left to take off it. */
  forgetEntered(): void {
    this.enteredNodeId = null
  }

  /** Whether any label is being typed. */
  isRenamingAny(): boolean {
    return this.renaming !== null
  }

  /** A label being typed belongs to the edge that was selected when it
   * opened; deselecting that edge ends the session (committing, the same as
   * a blur would). */
  onEdgeSelectionChange(selected: ReadonlySet<EdgeId>): void {
    const typed = this.renaming
    if (typed?.kind === 'edge' && !selected.has(typed.id)) this.endRename(true)
  }

  private nextEditSessionId(): number {
    this.editSessionCounter += 1
    return this.editSessionCounter
  }

  /**
   * Whether this node has text a card can edit: a text node always, a file
   * node only while it points at markdown. A group has no text surface, and
   * neither does a web card, a PDF or a media file.
   */
  isEditableNode(node: BoardNode): boolean {
    return (
      node.type === 'text' ||
      (node.type === 'file' && isMarkdownPath(node.file))
    )
  }

  /**
   * Opens a card: into its editor when it has text, into its content when
   * that content is live. False when the card is neither, so a key binding
   * can decline instead of silently swallowing the keystroke.
   *
   * One gesture, two destinations, because there is one idea: "I mean what is
   * in this card, not the card". A markdown card answers it with a caret; a
   * web, HTML or media card answers it by letting the pointer through to the
   * page or the transport. Which of the two a card gives is a property of the
   * card, not a second command for the user to know about.
   */
  editCard(id: NodeId): boolean {
    const node = this.core.getNode(id)
    if (!node) return false
    // Zoomed out past the point cards have elements, "open this" still has an
    // answer: go to it, then open it. Declining, which is what this did, left
    // a double-click or Enter doing nothing with no hint as to why.
    if (this.core.isOverview() && !this.core.isParseFailed()) {
      this.deps.zoomInToEdit(id)
      return true
    }
    if (!this.isEditableNode(node)) return this.enterLiveContent(id)
    this.enterEditMode(id)
    return true
  }

  /**
   * Lets the pointer into a card's live content.
   *
   * This is the whole reason the content mask is not lifted by selection.
   * A live body that a pointer can reach is a body the card can no longer be
   * dragged by — the press lands in the page, and `onPointerDown` bails
   * (`isLiveContentTarget`) rather than steal it. Hanging that on selection
   * meant that selecting a web card, the one thing you do before moving it,
   * was also the thing that stopped you moving it. Obsidian Canvas lifts its
   * blocker on focus and pays exactly this price; every canvas that embeds
   * live content and stayed usable — Figma, tldraw, Miro — asks for the
   * enter separately instead, and so do we.
   *
   * The card keeps its selection: entering is about the pointer, not about
   * what the toolbar or a delete key is aimed at. Edit mode is the other way
   * round (a card being edited is never also selected) because there a
   * keystroke has to belong to one of them.
   */
  private enterLiveContent(id: NodeId): boolean {
    // A degraded card has no body to enter, the same reason edit mode
    // declines there.
    if (this.core.isParseFailed() || this.core.isOverview()) return false
    if (!this.deps.cards.hasLiveContent(id)) return false
    if (this.enteredNodeId === id) return true
    this.exitLiveContent()
    const el = this.deps.cards.getRuntime(id)?.el
    if (!el) return false
    el.classList.add(CARD_ENTERED_CLASS)
    this.enteredNodeId = id
    return true
  }

  /** Takes the pointer back out of a card's live content, if it was in one. */
  exitLiveContent(): void {
    if (this.enteredNodeId === null) return
    this.deps.cards
      .getRuntime(this.enteredNodeId)
      ?.el?.classList.remove(CARD_ENTERED_CLASS)
    this.enteredNodeId = null
  }

  // ---- rung one: generating into a card ----------------------------------
  //
  // The two halves of handing a card's body to `./cardGeneration.ts`
  // and taking it back. Deliberately shaped like `enterEditMode`/`finishEdit`:
  // a generation and an edit are the same claim on the same element, they pin
  // the card the same way, and they commit through the same
  // `commitCardText`, so nothing downstream has to know which of the two
  // wrote a card.

  beginCardGeneration(id: NodeId): HTMLElement | null {
    if (!this.core.canCreate()) return null
    const node = this.core.getNode(id)
    if (!node || node.type !== 'text') return null
    const runtime = this.deps.cards.getRuntime(id)
    if (!runtime?.bodyEl) return null
    // A card cannot be edited and generated into at once; the blur commits
    // whatever was typed through the one path that writes it.
    if (this.editing?.nodeId === id) this.editing.editor.blur()
    this.deps.cards.destroyCardContent(runtime)
    runtime.bodyEl.replaceChildren()
    runtime.el?.classList.add(CARD_GENERATING_CLASS)
    this.deps.pin(id)
    return runtime.bodyEl
  }

  endCardGeneration(
    id: NodeId,
    text: string,
    { edit }: { edit: boolean },
  ): void {
    const runtime = this.deps.cards.getRuntime(id)
    runtime?.el?.classList.remove(CARD_GENERATING_CLASS)
    runtime?.bodyEl?.replaceChildren()
    this.deps.unpin(id)
    // One history step for the whole run: everything that streamed lands
    // on the board at once, and Cmd+Z takes the card back to empty.
    if (text !== '') {
      this.commitCardText(id, text, `card-ai-${this.nextEditSessionId()}`)
    }
    void this.deps.cards.renderCardPreview(id)
    if (edit) this.enterEditMode(id)
  }

  enterEditMode(id: NodeId): void {
    // Degraded cards render as a title block with the body hidden, so
    // an editor mounted now would be invisible; zooming back in is the way
    // to edit.
    if (!this.core.canCreate()) return
    const node = this.core.getNode(id)
    if (!node || !this.isEditableNode(node)) return
    const runtime = this.deps.cards.getRuntime(id)
    if (!runtime?.bodyEl || runtime.missingFile) return
    // A file card's initial content is read asynchronously on mount
    // (renderCardPreview); if the user clicks to edit before that first
    // read resolves, there's no known draft to seed the editor with yet —
    // entering edit mode anyway would risk a blur immediately after
    // overwriting the file with empty text.
    if (node.type === 'file' && runtime.noteText === null) return

    if (this.editing) {
      if (this.editing.nodeId === id) return
      // Force a real DOM blur on the previously-active editor so it commits
      // through the exact same path before this one takes over.
      this.editing.editor.blur()
    }
    // A card being edited is never also selected (see `selectedIds`). Cleared
    // after the blur above, which selects the card it just left. Keeping the
    // two apart is what stops the selection's own bindings from stealing
    // Enter and Escape from the editor — the keys they mean most.
    this.core.clearSelection()

    // Where the editor opens, read before anything below has touched the card.
    //
    // Asked of the reading surface the editor is about to go over, and only of
    // the node when there is none — a card edited straight out of a clipped
    // render has no finer position to offer. What the node carries is snapped
    // to a block start, because a clipped card cannot begin mid block; the
    // surface the user is looking at is not, and opening the editor on the
    // node's number would step the card back to the top of whatever block the
    // reader's top edge was inside.
    //
    // The node is re-read here rather than taken from `node` above: clearing
    // the selection is what commits where the card was being read, and a board
    // is structurally shared — that commit leaves a *new* node object behind,
    // so the one this method opened with still carries the window before this
    // reading.
    const current = this.core.getNode(id)
    const nodeLine =
      current && (current.type === 'text' || current.type === 'file')
        ? (current.startLine ?? 0)
        : 0
    const startLine = this.deps.cards.getContentScrollLine(id) ?? nodeLine

    const initialText =
      node.type === 'text' ? node.text : (runtime.noteText ?? '')
    // The reading surface stays where it is, holding the card's scroll
    // position, and the class below takes it out of the way (style.css). Only
    // a body holding something an editor cannot sit over — a placeholder, an
    // image, a web frame — is cleared first.
    if (runtime.contentView === null) {
      this.deps.cards.destroyCardContent(runtime)
      runtime.bodyEl.replaceChildren()
    }
    runtime.el?.classList.add(CARD_EDITING_CLASS)
    runtime.bodyEl.classList.add(EDITOR_HOST_CLASS)
    this.deps.pin(id)

    const editor = this.core.host.ui.createMarkdownEditor({
      container: runtime.bodyEl,
      value: initialText,
      // What `[[links]]` in this card resolve against, and where an attachment
      // pasted into it is filed. A note card is its own document; a text card
      // lives inside the board file, so "here" is the board.
      sourcePath: node.type === 'file' ? node.file : this.core.getSourcePath(),
      onChange: () => {
        this.scheduleEditPersist(id)
        // An empty card keeps its chips while its editor is open, and loses
        // them at the first character (./cardGeneration.ts). Typing is
        // the only thing that changes that answer while the editor holds the
        // card's text, so this is where it is re-asked — no second state to
        // keep in step.
        this.deps.syncChips(id)
      },
      onBlur: (text) => this.finishEdit(id, text),
      // Rung two of the board's AI ladder: the host's Quick
      // Ask, opened by the trigger inside the card's own editor.
      quickAsk: {
        // Resolved per request, against the board as it is at that moment —
        // an Agent-mode turn that just rewrote the board must be described by
        // the board it produced, not by the one this editor opened over. The
        // same assembly rung one generates from (host/cardContext.ts), so the
        // two rungs cannot come to describe a card differently; only the
        // prompt wrapped around it differs.
        getContext: () =>
          resolveCardContext(
            this.core.host,
            this.core.getBoard(),
            id,
            this.core.getSourcePath(),
          ),
        // A board pans and zooms by transform and fires no scroll event, so
        // the panel has no other way to learn the card moved out from under
        // it.
        subscribeAnchorMove: (onMove) => this.deps.subscribeViewChange(onMove),
      },
    })
    const scopeDisposer = this.core.context.registerKeymap([
      {
        modifiers: [],
        key: 'Escape',
        handler: () => {
          editor.blur()
          this.deps.focusBoard()
          return true
        },
      },
    ])
    this.editing = {
      nodeId: id,
      editor,
      scopeDisposer,
      historyKey: `edit-${this.nextEditSessionId()}`,
      persistTimer: null,
    }
    editor.focus()
    // Open where the card was being read. Both surfaces speak the same
    // fractional source line, so nothing is mapped between them; what is left
    // is how the two lay a block out, which is bounded by that block and
    // measured, not estimated (obsidianMarkdownEditor.ts's `openAtLine`).
    if (startLine > 0) editor.openAtLine(startLine)
    // A card opened while still empty keeps its chips beside the caret: the
    // main way one gets made — dragging an arrow into empty space — opens the
    // editor on the spot, and chips that waited for it to close would never
    // be seen there. Appended after the editor, which the body now holds.
    this.deps.syncChips(id)
  }

  /**
   * Persists in-progress edits without waiting for the user to leave the card.
   *
   * Blur alone used to be the only write point, which meant everything typed
   * since the card was opened was held in the editor and nowhere else — a
   * crash mid-edit lost it. Throttled rather than per-keystroke because the
   * board's own save is debounced downstream anyway, and a note card's write
   * is a real file write.
   */
  private scheduleEditPersist(id: NodeId): void {
    const editing = this.editing
    if (!editing || editing.nodeId !== id) return
    // Leading edge already scheduled: the timer reads the editor when it
    // fires, so it always writes the latest text and never needs restarting.
    if (editing.persistTimer !== null) return
    const win = this.core.context.getWindow()
    editing.persistTimer = win.setTimeout(() => {
      editing.persistTimer = null
      if (this.editing !== editing) return
      this.commitCardText(id, editing.editor.getValue(), editing.historyKey)
    }, EDIT_PERSIST_THROTTLE_MS)
  }

  /** Writes a card's text to wherever that card's content lives — the note
   * file for a note card, the board for a text card. */
  private commitCardText(id: NodeId, text: string, historyKey?: string): void {
    const action = planNodeCommit(this.core.getBoard(), id, text)
    switch (action.kind) {
      case 'writeNoteFile': {
        const runtime = this.deps.cards.getRuntime(id)
        if (runtime) runtime.noteText = action.markdown
        void this.core.host.vault
          .writeText(action.file, action.markdown)
          .catch((error: unknown) => this.core.reportError('writeText', error))
        break
      }
      case 'updateBoard':
        this.core.applyBoardChange(action.board, historyKey)
        break
      case 'noop':
        break
    }
  }

  private finishEdit(id: NodeId, text: string): void {
    const editing = this.editing
    if (!editing || editing.nodeId !== id) return // stale callback: already exited some other way
    this.editing = null
    if (editing.persistTimer !== null) {
      this.core.context.getWindow().clearTimeout(editing.persistTimer)
    }
    editing.scopeDisposer()

    // Where the editor was left is where the card is now — the other half of
    // `enterEditMode`, and the same shape as Obsidian's own embed leaving edit
    // mode: read once, carried across once, unconditionally. Read before
    // `destroy()`, which is what makes the editor unable to answer.
    const line = editing.editor.getScrollLine()
    this.deps.writeReadingWindow(id, line)
    editing.editor.destroy()
    this.deps.unpin(id)

    const runtime = this.deps.cards.getRuntime(id)
    runtime?.el?.classList.remove(CARD_EDITING_CLASS)
    runtime?.bodyEl?.classList.remove(EDITOR_HOST_CLASS)

    // Final flush: the throttled writes may have left the last keystrokes
    // unpersisted, and a no-op commit costs nothing. Still under the
    // session's history key — the whole session is one step to undo.
    this.commitCardText(id, text, editing.historyKey)
    void this.deps.cards.renderCardPreview(id)
    // The reading surface comes out of hiding where the editor left off.
    runtime?.contentView?.scrollToLine(line)
    // Leaving the editor lands on the card, not on nothing: Escape steps
    // out to the selected card and only a second Escape clears it. A blur
    // caused by pressing somewhere else is overwritten by whatever that
    // press selects, a moment later in the same gesture.
    if (this.core.getNode(id) !== undefined) this.core.setSelection([id])
  }

  /** Commits the active edit (if any) through the single `finishEdit` path
   * by forcing a real blur — used by every non-interactive teardown
   * (`dispose`, `setViewData`, `clear`) so none of them need their own
   * write-back logic. */
  forceCommitActiveEdit(): void {
    if (!this.editing) return
    this.editing.editor.blur()
  }

  /**
   * Ends the active edit for a board that is about to be replaced wholesale
   * (`setViewData`) — the file was rewritten from outside, or a different one
   * is being loaded into this leaf.
   *
   * A note card's text is still written: it belongs to that *file*, and the
   * note is owed those keystrokes whether or not a card pointing at it
   * survives the incoming board.
   *
   * A text card's is dropped, because there is nowhere left to put it. The
   * ordinary commit path would `applyBoardChange` it onto `this.core.getBoard()` — the
   * board `setViewData` discards two statements later, which takes the
   * history entry with it and leaves a queued `requestSave` that goes on to
   * persist the *replacing* board. The edit is lost either way; committing it
   * only adds the corruption. (This is the "外部改写 board 后卡片消失" bug,
   * which needed the rare editing-while-rewritten window to reproduce — a
   * window the agent whiteboard tools make ordinary.)
   */
  endEditForIncomingBoard(): void {
    const editing = this.editing
    if (!editing) return
    // Nulled first, so the blur that `destroy()` fires reaches `finishEdit`
    // as a stale callback and takes its early return instead of committing.
    this.editing = null
    if (editing.persistTimer !== null) {
      this.core.context.getWindow().clearTimeout(editing.persistTimer)
    }
    editing.scopeDisposer()
    const action = planNodeCommit(
      this.core.getBoard(),
      editing.nodeId,
      editing.editor.getValue(),
    )
    if (action.kind === 'writeNoteFile') {
      void this.core.host.vault
        .writeText(action.file, action.markdown)
        .catch((error: unknown) => this.core.reportError('writeText', error))
    }
    editing.editor.destroy()
  }

  // -- labels (edge, group) -----------------------------------------------
  // A group's label and an edge's are both HTML in the world layer, and both
  // are typed where they already are: the element takes the caret itself
  // (`contenteditable`) rather than having a field floated over it. This is
  // Obsidian Canvas's arrangement for both, and the only one under which the
  // text keeps the size, weight and position it had a moment ago — a
  // screen-space field standing in for world-scaled text can match it at one
  // zoom level and no other, which is what both of these used to do.
  //
  // One session for the two, because there is now only one mechanism. What
  // differs is which element holds the text, what the text is committed to,
  // and what an emptied label means: a group keeps its label element (it is
  // the group's only handle), an edge's goes away with its text.

  beginRename(target: LabelTarget): void {
    if (!this.core.canEdit() || !this.renameSubjectExists(target)) return
    if (this.isRenaming(target)) return
    this.endRename(true)
    // Whatever the viewport last said about this edge, it is about to hold a
    // caret — and a culled edge's label is `display: none`.
    if (target.kind === 'edge') this.deps.edges.revealEdge(target.id)
    const el =
      this.labelEl(target) ??
      (target.kind === 'edge'
        ? this.deps.edges.attachEdgeLabel(target.id)
        : null)
    if (!el) return
    this.deps.closePopover()
    this.renaming = target
    // `plaintext-only` rather than plain `contenteditable` so a paste arrives
    // as the text it looked like rather than as markup a label cannot hold.
    el.setAttribute('contenteditable', 'plaintext-only')
    // Before the focus: in the overview tier this element is out of the
    // document, and a hidden element cannot take the caret.
    this.syncEdgeRenameChrome()
    el.focus()
    // Selected rather than left with a caret where the click landed: renaming
    // usually replaces the name. Obsidian Canvas selects it too.
    const range = el.ownerDocument.createRange()
    range.selectNodeContents(el)
    const selection = this.core.context.getWindow().getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    this.deps.onRenameChange()
  }

  /** Ends a rename: committing writes what was typed, cancelling puts back
   * what the board still holds. Either way the label goes back to being a
   * label. `target` defaults to whichever one is being typed, so a caller
   * that only means "whatever is in flight" (a lock, a teardown) can say
   * that; naming one that is not being typed is a no-op. */
  endRename(commit: boolean, target: LabelTarget | null = this.renaming): void {
    if (!target || !this.isRenaming(target)) return
    this.renaming = null
    const el = this.labelEl(target)
    if (el) {
      el.removeAttribute('contenteditable')
      el.blur()
      if (commit) this.commitLabel(target, el.textContent ?? '')
      else this.restoreLabel(target, el)
    }
    this.syncEdgeRenameChrome()
    this.deps.onRenameChange()
  }

  handleLabelKeyDown(target: LabelTarget, e: KeyboardEvent): void {
    if (!this.isRenaming(target)) return
    // `isComposing` so the Enter that accepts an IME candidate is the IME's,
    // not ours — Obsidian Canvas guards its own label the same way.
    if (e.isComposing) return
    if (e.key !== 'Enter' && e.key !== 'Escape') return
    e.preventDefault()
    // Neither key means anything else while a name is being typed: Escape in
    // particular must not travel on to whatever Obsidian would close with it.
    e.stopPropagation()
    this.endRename(e.key === 'Enter', target)
    this.deps.focusBoard()
  }

  isRenaming(target: LabelTarget): boolean {
    return this.renaming !== null && sameLabelTarget(this.renaming, target)
  }

  /** Whether an edge label is being typed right now — the one label the
   * overview canvas leaves to the DOM, since a canvas holds no caret. */
  get renamingEdgeId(): EdgeId | null {
    return this.renaming?.kind === 'edge' ? this.renaming.id : null
  }

  /**
   * Puts the label being typed back in the drawing for the length of the
   * rename, in the tier that has taken every label out of it.
   *
   * Naming a relation is what this zoom is for (see style.css's
   * `.yolo-whiteboard-edge-label` on why a label is sized the way it is), so
   * declining the rename here was not an option, and neither was drawing it:
   * the caret lives in the element. The class the stylesheet reads brings the
   * layer back and hides every label but the editable one, which costs a
   * style recalculation over the board's labels — paid once, at the start of a
   * deliberate action the user is about to spend seconds on.
   */
  syncEdgeRenameChrome(): void {
    const wanted =
      this.renamingEdgeId !== null && this.deps.isOverviewChromeHidden()
    if (
      this.deps.worldEl.classList.contains(WORLD_EDGE_RENAME_CLASS) === wanted
    ) {
      return
    }
    // The layer is about to be seen; it must not be seen at the counter-scale
    // it wore whenever the tier began (CameraController's applyZoomScale).
    if (wanted) this.deps.flushOverviewChromeZoomScale()
    this.deps.worldEl.classList.toggle(WORLD_EDGE_RENAME_CLASS, wanted)
  }

  /** False once the thing being named has left the board, which is what makes
   * calling any of this on a stale target safe. */
  private renameSubjectExists(target: LabelTarget): boolean {
    return target.kind === 'group'
      ? this.core.getNode(target.id)?.type === 'group'
      : this.core.getEdge(target.id) !== undefined
  }

  private labelEl(target: LabelTarget): HTMLElement | null {
    if (target.kind === 'edge') {
      return this.deps.edges.getLabelEl(target.id)
    }
    return (
      this.deps.cards
        .getRuntime(target.id)
        ?.el?.querySelector<HTMLElement>(`.${GROUP_LABEL_CLASS}`) ?? null
    )
  }

  /** Puts back what the board still holds, after a cancelled rename. An
   * edge that had no label to begin with loses the element it was given. */
  private restoreLabel(target: LabelTarget, el: HTMLElement): void {
    const stored =
      target.kind === 'group'
        ? this.groupLabelText(target.id)
        : (this.core.getEdge(target.id)?.label ?? '')
    if (target.kind === 'edge' && stored.length === 0) {
      this.deps.edges.detachEdgeLabel(target.id)
      return
    }
    el.textContent = stored
  }

  private commitLabel(target: LabelTarget, value: string): void {
    if (target.kind === 'group') this.commitGroupLabel(target.id, value)
    else this.commitEdgeLabel(target.id, value)
  }

  private groupLabelText(nodeId: NodeId): string {
    const group = this.core.getNode(nodeId)
    return group?.type === 'group' ? (group.label ?? '') : ''
  }

  /** An empty group label removes the attribute rather than storing `""` —
   * the same rule an edge label follows. The element stays either way: it is
   * the group's only handle. */
  private commitGroupLabel(nodeId: NodeId, value: string): void {
    if (!this.core.canEdit()) return
    const group = this.core.getNode(nodeId)
    if (!group || group.type !== 'group') return
    const label = value.trim().length > 0 ? value : undefined
    const el = this.labelEl({ kind: 'group', id: nodeId })
    if (el) el.textContent = label ?? ''
    const board = updateNode(this.core.getBoard(), nodeId, { label })
    if (board === this.core.getBoard()) return
    this.core.applyBoardChange(board)
  }

  /** An empty label removes the attribute rather than storing `""` — an edge
   * with a blank label and one with no label are the same edge, and neither
   * carries an element on its curve. */
  private commitEdgeLabel(edgeId: EdgeId, value: string): void {
    if (!this.core.canEdit() || this.core.getEdge(edgeId) === undefined) return
    const label = value.trim().length > 0 ? value : undefined
    if (label === undefined) this.deps.edges.detachEdgeLabel(edgeId)
    else {
      const el = this.deps.edges.attachEdgeLabel(edgeId)
      if (el) el.textContent = label
    }
    const board = updateEdge(this.core.getBoard(), edgeId, { label })
    if (board === this.core.getBoard()) return
    this.core.applyBoardChange(board)
  }
}
