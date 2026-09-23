// Copy, cut and paste on the board — Obsidian Canvas's `handleCopy`/
// `handlePaste`, over the same clipboard format (domain/clipboard.ts).
//
// These are the browser's own `copy`/`cut`/`paste` events, not key bindings:
// a clipboard type of our own choosing (`obsidian/canvas`) can only be read
// and written through a `ClipboardEvent`'s `clipboardData` — the async
// clipboard API does not expose it. Such an event goes to whatever has focus,
// so the viewport is made focusable (a press anywhere on the board focuses
// it, the way Canvas's wrapper is) and the events are heard on it: they reach
// this board and no other, in whichever window it lives in.
//
// A field inside the board — a card's editor, a label, a PDF search box —
// keeps its own copy and paste; so does text selected in a card's rendered
// content. The board only acts on the clipboard when nothing else would.
//
// `WhiteboardCanvas` is the only importer; this module must never import it
// back.

import type { ScreenPoint } from '../../domain/camera'
import {
  type BoardFragment,
  CANVAS_CLIPBOARD_TYPE,
  fragmentFromSelection,
  fragmentPlainText,
  parseFragment,
  placeFragment,
  serializeFragment,
} from '../../domain/clipboard'
import type { BoardNode, NodeId } from '../../domain/fileFormat'
import { fileNodeKind } from '../../domain/naming'
import {
  DROP_STAGGER_PX,
  NEW_CARD_SIZE,
  NEW_EMBED_CARD_SIZE,
  WEB_URL_PATTERN,
} from '../constants'

import type { CanvasCore } from './core'
import { isTypingIntoField } from './keymapController'

export type ClipboardControllerDeps = Readonly<{
  core: CanvasCore
  viewportEl: HTMLElement
  /** Where a paste lands when the pointer is not over the board. */
  viewportCenterWorld: () => ScreenPoint
  /** The canvas's own delete path — what a cut removes through. */
  deleteNodes: (ids: readonly NodeId[]) => void
  rebuildEdgesSvg: () => void
}>

export class ClipboardController {
  private readonly core: CanvasCore
  /** The last pointer move over the board, or null once the pointer has
   * left it: a paste lands under the pointer when there is one. Kept as the
   * event rather than a world point, so a camera that moved since is
   * answered for at paste time. */
  private pointer: MouseEvent | null = null

  constructor(private readonly deps: ClipboardControllerDeps) {
    this.core = deps.core
  }

  bind(): void {
    const el = this.deps.viewportEl
    el.tabIndex = -1
    el.addEventListener('copy', this.onCopy)
    el.addEventListener('cut', this.onCut)
    el.addEventListener('paste', this.onPaste)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerleave', this.onPointerLeave)
  }

  destroy(): void {
    const el = this.deps.viewportEl
    el.removeEventListener('copy', this.onCopy)
    el.removeEventListener('cut', this.onCut)
    el.removeEventListener('paste', this.onPaste)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    this.pointer = null
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.pointer = e
  }

  private readonly onPointerLeave = (): void => {
    this.pointer = null
  }

  /** Whether a clipboard event is the board's rather than a field's. */
  private owns(e: ClipboardEvent): boolean {
    if (e.defaultPrevented || e.clipboardData === null) return false
    if (this.core.isParseFailed()) return false
    return !isTypingIntoField(this.deps.viewportEl.ownerDocument)
  }

  /** Copies the selection, or answers null when the event is not the
   * board's to take: text selected in a card's content is the browser's to
   * copy. */
  private copySelection(e: ClipboardEvent): BoardFragment | null {
    if (!this.owns(e)) return null
    const selection = this.deps.viewportEl.ownerDocument.getSelection()
    if (
      selection !== null &&
      !selection.isCollapsed &&
      this.deps.viewportEl.contains(selection.anchorNode)
    ) {
      return null
    }
    const selected = this.core.getSelectedIds()
    if (selected.size === 0) return null
    const fragment = fragmentFromSelection(this.core.getBoard(), selected)
    e.preventDefault()
    e.clipboardData?.setData(CANVAS_CLIPBOARD_TYPE, serializeFragment(fragment))
    const text = fragmentPlainText(fragment)
    if (text) e.clipboardData?.setData('text/plain', text)
    return fragment
  }

  private readonly onCopy = (e: ClipboardEvent): void => {
    this.copySelection(e)
  }

  private readonly onCut = (e: ClipboardEvent): void => {
    const fragment = this.copySelection(e)
    if (fragment === null || !this.core.canEdit()) return
    // Everything that was copied goes, a selected group's contents included:
    // cut and paste is a move, and a move takes what the copy took.
    this.deps.deleteNodes(fragment.nodes.map((node) => node.id))
  }

  /**
   * Canvas's order: files first (a picture copied from elsewhere), then cards
   * copied from a board or a Canvas, then text — a web address as a web
   * card, anything else as a text card.
   */
  private readonly onPaste = (e: ClipboardEvent): void => {
    if (!this.owns(e) || !this.core.canEdit()) return
    const data = e.clipboardData
    if (data === null) return
    const at = this.pasteAnchor()
    const files = Array.from(data.files).filter(
      (file) => fileNodeKind(file.name) !== 'unsupported',
    )
    if (files.length > 0) {
      e.preventDefault()
      void this.pasteFiles(files, at)
      return
    }
    const cards = parseFragment(data.getData(CANVAS_CLIPBOARD_TYPE))
    if (cards !== null) {
      e.preventDefault()
      this.place(cards, at)
      return
    }
    const text = data.getData('text/plain').trim()
    if (!text) return
    e.preventDefault()
    this.place({ nodes: [textOrLinkNode(text)], edges: [] }, at)
  }

  private pasteAnchor(): ScreenPoint {
    return this.pointer === null
      ? this.deps.viewportCenterWorld()
      : this.core.worldPointFromEvent(this.pointer)
  }

  /**
   * Files from outside the vault become attachments, filed where the user's
   * attachment setting files a picture pasted into a note written at the
   * board's path, and a card each.
   */
  private async pasteFiles(files: readonly File[], at: ScreenPoint) {
    const { vault } = this.core.host
    const sourcePath = this.core.getSourcePath()
    const nodes: BoardNode[] = []
    try {
      // One at a time: each free path is chosen against the files already
      // written, so two pasted together cannot be handed the same one.
      for (const [index, file] of files.entries()) {
        const path = await vault.getAvailableAttachmentPath(
          file.name,
          sourcePath,
        )
        await vault.createBinary(path, await file.arrayBuffer())
        const offset = index * DROP_STAGGER_PX
        nodes.push({
          id: `pasted-${index}`,
          type: 'file',
          x: offset,
          y: offset,
          w: NEW_EMBED_CARD_SIZE.w,
          h: NEW_EMBED_CARD_SIZE.h,
          file: path,
          extra: {},
        })
      }
    } catch (error) {
      this.core.reportError('pasteFiles', error)
      this.core.host.ui.notice(this.core.t('error.pasteFailed'))
    }
    // The board may have been closed, or broken, while the files were
    // written; the attachments stay, as a pasted one would in a note.
    if (nodes.length === 0 || !this.core.canEdit()) return
    this.place({ nodes, edges: [] }, at)
  }

  private place(fragment: BoardFragment, at: ScreenPoint): void {
    const { board, nodeIds } = placeFragment(this.core.getBoard(), fragment, at)
    this.core.applyBoardChange(board)
    this.core.recomputeVisibility()
    this.core.drainQueues()
    if (fragment.edges.length > 0) this.deps.rebuildEdgesSvg()
    this.core.setSelection(nodeIds)
  }
}

/** Pasted text as a card: a lone web address is a web card, the way it is in
 * Canvas; anything else is a text card holding it. The id is a placeholder —
 * `placeFragment` mints the real one. */
function textOrLinkNode(text: string): BoardNode {
  if (WEB_URL_PATTERN.test(text) && !/\s/.test(text)) {
    return {
      id: 'pasted',
      type: 'link',
      x: 0,
      y: 0,
      w: NEW_EMBED_CARD_SIZE.w,
      h: NEW_EMBED_CARD_SIZE.h,
      url: text,
      extra: {},
    }
  }
  return {
    id: 'pasted',
    type: 'text',
    x: 0,
    y: 0,
    w: NEW_CARD_SIZE.w,
    h: NEW_CARD_SIZE.h,
    text,
    extra: {},
  }
}
