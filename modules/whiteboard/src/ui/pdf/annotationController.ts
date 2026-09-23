// What happens when someone annotates a PDF on a board: the floating
// toolbar over a text selection or a clicked annotation, the comment editor,
// and the store edits they make (../../host/annotationStore.ts).
//
// One per board view. Every reader on the board — each PDF card and the
// reading panel — reports to the same controller (`events`), so there is one
// toolbar, in screen space over the whole view, whichever reader it is
// acting for: a card is under the camera's transform, and chrome must not
// zoom with it.
//
// The toolbar is the board's own floating toolbar (../selectionToolbar.ts),
// placed by the same rule (above what it acts on, below when there is no
// room). It follows its anchor — the selection, or the annotation's marks —
// frame by frame while it is open, because both move under it: the reader
// scrolls, the board pans. Buttons keep the text selection alive by taking
// no focus on press.
//
// Keys go through the view's keymap, not listeners here (the canvas's
// Escape and Delete chains call `dismiss` and `deleteActive`), so they work
// in a popout window; everything here is built from the view's document.

import { type ScreenPoint } from '../../domain/camera'
import {
  ANNOTATION_COLORS,
  type AnnotationColor,
  type HighlightAnnotation,
  type PdfAnnotation,
  type PdfRectTuple,
} from '../../domain/pdfAnnotations'
import { toolbarScreenPosition } from '../../domain/toolbar'
import type { AnnotationPrefs } from '../../host/annotationPrefs'
import type { AnnotationStore } from '../../host/annotationStore'
import { TOOLBAR_GAP_PX, TOOLBAR_MARGIN_PX } from '../constants'
import {
  SelectionToolbar,
  type ToolbarItem,
  type ToolbarSwatchControl,
} from '../selectionToolbar'

import { quoteContext, resolveHighlightSelection } from './annotationGeometry'
import { annotationColorClass } from './annotationLayer'
import type {
  PdfReader,
  ReaderAnnotationEvents,
  ReaderTextSelection,
} from './pdfReader'

type Translate = (key: string) => string

export type AnnotationControllerOptions = Readonly<{
  /** The view root: the toolbar spans it, panel included. */
  parent: HTMLElement
  host: YoloModuleHostApiV1
  prefs: AnnotationPrefs
  t: Translate
  /** The board's path: what a copied link is written relative to. */
  getSourcePath: () => string
  /** The view's keymap. Mod+Enter has to be bound there to reach the
   * comment field at all: Obsidian's own Mod+Enter binding takes the key
   * before an element listener would see it. */
  registerKeymap: (
    bindings: readonly YoloModuleHostKeymapBindingV1[],
  ) => () => void
  reportError: (stage: string, error: unknown) => void
}>

const OVERLAY_CLASS = 'yolo-whiteboard-pdf-annotation-overlay'
const HIGHLIGHT_BUTTON_CLASS = 'yolo-whiteboard-pdf-highlight-button'
const COMMENT_CLASS = 'yolo-whiteboard-pdf-comment'
const COMMENT_TEXT_CLASS = 'yolo-whiteboard-pdf-comment-text'
const COMMENT_INPUT_CLASS = 'yolo-whiteboard-pdf-comment-input'

type Mode =
  | Readonly<{
      kind: 'selection'
      reader: PdfReader
      selection: ReaderTextSelection
    }>
  | Readonly<{ kind: 'annotation'; reader: PdfReader; id: string }>

export class AnnotationController {
  readonly events: ReaderAnnotationEvents
  private readonly toolbar: SelectionToolbar
  /** The comment under the toolbar: shown, or being edited. */
  private readonly commentEl: HTMLElement
  private mode: Mode | null = null
  private editor: HTMLTextAreaElement | null = null
  private editorKeymapDisposer: (() => void) | null = null
  private frameId: number | null = null

  constructor(private readonly options: AnnotationControllerOptions) {
    const doc = options.parent.ownerDocument
    this.toolbar = new SelectionToolbar(doc, options.parent)
    this.toolbar.overlay.classList.add(OVERLAY_CLASS)
    this.commentEl = doc.createElement('div')
    this.commentEl.className = COMMENT_CLASS
    this.commentEl.hidden = true
    this.toolbar.overlay.appendChild(this.commentEl)
    // A press on the toolbar must not take the focus, or collapse the text
    // selection its buttons are about to act on. The comment's text area is
    // the one thing in the overlay that needs a press to focus it.
    this.toolbar.overlay.addEventListener('mousedown', (event) => {
      const target = event.target as Element | null
      if (target?.closest?.(`.${COMMENT_INPUT_CLASS}`)) return
      event.preventDefault()
    })
    doc.addEventListener('pointerdown', this.onDocumentPointerDown, true)

    this.events = {
      onTextSelection: (reader, selection) =>
        this.onTextSelection(reader, selection),
      onAnnotationClick: (reader, id) => this.onAnnotationClick(reader, id),
      onAnnotationContextMenu: (reader, id, event) =>
        this.onAnnotationContextMenu(reader, id, event),
      onAreaDrawn: (reader, page, rect) => this.onAreaDrawn(reader, page, rect),
      onReaderDestroyed: (reader) => this.forgetReader(reader),
    }
  }

  /** Whether a node is part of this chrome (toolbar, comment editor). */
  contains(node: Node | null): boolean {
    return node !== null && this.toolbar.contains(node)
  }

  /** The reader the toolbar is acting for, if it is open. */
  get reader(): PdfReader | null {
    return this.mode?.reader ?? null
  }

  /** Escape: steps out of the editor, then closes the toolbar. */
  dismiss(): boolean {
    if (this.editor) {
      this.closeEditor(false)
      return true
    }
    const mode = this.mode
    if (!mode) return false
    if (mode.kind === 'selection') mode.reader.clearTextSelection()
    this.close()
    return true
  }

  /** Delete or Backspace with an annotation's toolbar open deletes it. */
  deleteActive(): boolean {
    const mode = this.mode
    if (mode?.kind !== 'annotation' || this.editor) return false
    this.remove(mode.reader, mode.id)
    return true
  }

  /** A reader is going away: nothing may keep acting for it. */
  forgetReader(reader: PdfReader): void {
    if (this.mode?.reader === reader) this.close()
  }

  destroy(): void {
    this.close()
    this.options.parent.ownerDocument.removeEventListener(
      'pointerdown',
      this.onDocumentPointerDown,
      true,
    )
    this.toolbar.destroy()
  }

  // -----------------------------------------------------------------------
  // Reader events
  // -----------------------------------------------------------------------

  private onTextSelection(
    reader: PdfReader,
    selection: ReaderTextSelection | null,
  ): void {
    if (!selection) {
      if (this.mode?.kind === 'selection' && this.mode.reader === reader) {
        this.close()
      }
      return
    }
    if (!reader.getAnnotationStore()) return
    this.open({ kind: 'selection', reader, selection })
  }

  private onAnnotationClick(reader: PdfReader, id: string | null): void {
    if (id === null) {
      if (this.mode?.kind === 'annotation') this.close()
      return
    }
    this.open({ kind: 'annotation', reader, id })
  }

  private onAnnotationContextMenu(
    reader: PdfReader,
    id: string,
    event: MouseEvent,
  ): void {
    const store = reader.getAnnotationStore()
    const annotation = store?.get(id)
    if (!store || !annotation) return
    const t = this.options.t
    const items: YoloModuleHostMenuItemV1[] = [
      {
        title: t(
          annotation.comment
            ? 'pdf.annotate.editComment'
            : 'pdf.annotate.comment',
        ),
        icon: 'message-square',
        onSelect: () => {
          this.open({ kind: 'annotation', reader, id })
          this.openEditor()
        },
      },
    ]
    if (annotation.type === 'highlight') {
      items.push(
        {
          title: t('pdf.annotate.copyLink'),
          icon: 'link',
          onSelect: () => void this.copyAnnotationLink(reader, annotation),
        },
        {
          title: t('pdf.annotate.quoteToChat'),
          icon: 'message-square-quote',
          onSelect: () =>
            void this.quoteToChat(
              reader,
              annotation.anchor.quote.exact,
              annotation.anchor.page,
            ),
        },
      )
    }
    items.push(
      { kind: 'separator' },
      {
        title: t('pdf.annotate.delete'),
        icon: 'trash-2',
        onSelect: () => this.remove(reader, id),
      },
    )
    this.options.host.ui.showMenu(event, items)
  }

  private onAreaDrawn(
    reader: PdfReader,
    page: number,
    rect: PdfRectTuple,
  ): void {
    const store = this.writableStore(reader)
    if (!store) return
    const now = new Date().toISOString()
    const annotation: PdfAnnotation = {
      id: newId(),
      type: 'area',
      color: this.options.prefs.getDefaultColor(),
      createdAt: now,
      updatedAt: now,
      anchor: { page, rect },
    }
    store.add([annotation])
    this.open({ kind: 'annotation', reader, id: annotation.id })
  }

  // -----------------------------------------------------------------------
  // The toolbar
  // -----------------------------------------------------------------------

  private open(mode: Mode): void {
    if (this.editor) this.closeEditor(true)
    const previous = this.mode
    if (previous && previous.reader !== mode.reader) {
      previous.reader.setActiveAnnotation(null)
    }
    this.mode = mode
    mode.reader.setActiveAnnotation(mode.kind === 'annotation' ? mode.id : null)
    this.rebuild()
    this.startFollowing()
  }

  private close(): void {
    if (this.editor) this.closeEditor(true)
    this.mode?.reader.setActiveAnnotation(null)
    this.mode = null
    this.toolbar.setModel(null)
    this.commentEl.hidden = true
    this.commentEl.replaceChildren()
    this.stopFollowing()
  }

  private rebuild(): void {
    const mode = this.mode
    if (!mode) return
    if (mode.kind === 'selection') {
      this.toolbar.setModel({ items: this.selectionItems(mode) })
      this.showComment(null)
      return
    }
    const annotation = mode.reader.getAnnotationStore()?.get(mode.id)
    if (!annotation) {
      this.close()
      return
    }
    this.toolbar.setModel({
      items: this.annotationItems(mode.reader, annotation),
    })
    if (!this.editor) this.showComment(annotation.comment ?? null)
  }

  private palette(
    current: string | undefined,
    onPick: (color: AnnotationColor) => void,
    icon: ToolbarSwatchControl['icon'],
  ): ToolbarSwatchControl {
    const t = this.options.t
    return {
      kind: 'swatches',
      label: t('pdf.annotate.colors'),
      icon,
      current,
      swatches: ANNOTATION_COLORS.map((color) => ({
        value: color,
        label: t(`pdf.annotate.color.${color}`),
        className: annotationColorClass(color),
      })),
      onPick: (value) => onPick(value as AnnotationColor),
    }
  }

  private selectionItems(
    mode: Extract<Mode, { kind: 'selection' }>,
  ): ToolbarItem[] {
    const t = this.options.t
    const { reader, selection } = mode
    const color = this.options.prefs.getDefaultColor()
    const items: ToolbarItem[] = [
      {
        label: t('pdf.annotate.highlight'),
        icon: 'highlighter',
        className: `${HIGHLIGHT_BUTTON_CLASS} ${annotationColorClass(color)}`,
        onSelect: () => void this.highlight(reader, selection, color, false),
      },
      this.palette(
        color,
        (picked) => {
          this.options.prefs.setDefaultColor(picked)
          void this.highlight(reader, selection, picked, false)
        },
        'chevron-down',
      ),
      {
        label: t('pdf.annotate.comment'),
        icon: 'message-square',
        onSelect: () => void this.highlight(reader, selection, color, true),
      },
      {
        label: t('pdf.annotate.quoteToChat'),
        icon: 'message-square-quote',
        onSelect: () =>
          void this.quoteToChat(
            reader,
            selection.pieces.map((piece) => piece.text).join('\n'),
            selection.pieces[0].pageNumber,
          ),
      },
    ]
    // A native link names one page; a selection across two has none.
    if (selection.pieces.length === 1) {
      const piece = selection.pieces[0]
      items.push({
        label: t('pdf.annotate.copyLink'),
        icon: 'link',
        onSelect: () =>
          void this.copyLink(reader, piece.pageNumber, piece.tuple),
      })
    }
    return items
  }

  private annotationItems(
    reader: PdfReader,
    annotation: PdfAnnotation,
  ): ToolbarItem[] {
    const t = this.options.t
    const items: ToolbarItem[] = [
      this.palette(
        annotation.color,
        (color) => {
          this.writableStore(reader)?.update(annotation.id, { color })
          this.rebuild()
        },
        'palette',
      ),
      {
        label: t(
          annotation.comment
            ? 'pdf.annotate.editComment'
            : 'pdf.annotate.comment',
        ),
        icon: 'message-square',
        onSelect: () => this.openEditor(),
      },
    ]
    if (annotation.type === 'highlight') {
      items.push(
        {
          label: t('pdf.annotate.quoteToChat'),
          icon: 'message-square-quote',
          onSelect: () =>
            void this.quoteToChat(
              reader,
              annotation.anchor.quote.exact,
              annotation.anchor.page,
            ),
        },
        {
          label: t('pdf.annotate.copyLink'),
          icon: 'link',
          onSelect: () => void this.copyAnnotationLink(reader, annotation),
        },
      )
    }
    items.push({
      label: t('pdf.annotate.delete'),
      icon: 'trash',
      onSelect: () => this.remove(reader, annotation.id),
    })
    return items
  }

  // -----------------------------------------------------------------------
  // Following the anchor
  // -----------------------------------------------------------------------

  private anchorRect(): DOMRect | null {
    const mode = this.mode
    if (!mode) return null
    return mode.kind === 'selection'
      ? mode.selection.getRect()
      : mode.reader.getAnnotationRect(mode.id)
  }

  private startFollowing(): void {
    if (this.frameId !== null) return
    this.follow()
  }

  private stopFollowing(): void {
    if (this.frameId === null) return
    this.window()?.cancelAnimationFrame(this.frameId)
    this.frameId = null
  }

  private readonly follow = (): void => {
    this.frameId = null
    if (!this.mode) return
    this.place()
    this.frameId = this.window()?.requestAnimationFrame(this.follow) ?? null
  }

  private place(): void {
    const rect = this.anchorRect()
    const overlay = this.toolbar.overlay.getBoundingClientRect()
    if (!rect || !(overlay.width > 0)) {
      this.toolbar.setSuppressed(true)
      this.commentEl.classList.add('yolo-whiteboard-pdf-comment-hidden')
      return
    }
    this.toolbar.setSuppressed(false)
    this.commentEl.classList.remove('yolo-whiteboard-pdf-comment-hidden')
    const size = this.toolbar.size()
    const point: ScreenPoint = toolbarScreenPosition(
      {
        x: rect.left - overlay.left,
        y: rect.top - overlay.top,
        w: rect.width,
        h: rect.height,
      },
      { tx: 0, ty: 0, scale: 1 },
      { width: overlay.width, height: overlay.height },
      size,
      TOOLBAR_GAP_PX,
      TOOLBAR_MARGIN_PX,
    )
    this.toolbar.place(point)
    if (!this.commentEl.hidden) {
      // Under the toolbar, left-aligned with it; above it when the toolbar
      // sits below its anchor (it flipped for lack of room above).
      const below = point.y > rect.top - overlay.top
      const commentHeight = this.commentEl.offsetHeight
      const y = below ? point.y + size.height + 4 : point.y - commentHeight - 4
      this.commentEl.style.transform = `translate(${point.x}px, ${Math.max(TOOLBAR_MARGIN_PX, y)}px)`
    }
  }

  // -----------------------------------------------------------------------
  // The comment
  // -----------------------------------------------------------------------

  private showComment(comment: string | null): void {
    if (comment === null) {
      this.commentEl.hidden = true
      this.commentEl.replaceChildren()
      return
    }
    const doc = this.commentEl.ownerDocument
    const text = doc.createElement('div')
    text.className = COMMENT_TEXT_CLASS
    text.textContent = comment
    text.addEventListener('click', () => this.openEditor())
    this.commentEl.replaceChildren(text)
    this.commentEl.hidden = false
  }

  private openEditor(): void {
    const mode = this.mode
    if (mode?.kind !== 'annotation' || this.editor) return
    const annotation = mode.reader.getAnnotationStore()?.get(mode.id)
    if (!annotation) return
    const doc = this.commentEl.ownerDocument
    const input = doc.createElement('textarea')
    input.className = COMMENT_INPUT_CLASS
    input.rows = 3
    input.value = annotation.comment ?? ''
    input.placeholder = this.options.t('pdf.annotate.commentPlaceholder')
    this.editorKeymapDisposer = this.options.registerKeymap([
      {
        modifiers: ['Mod'],
        key: 'Enter',
        handler: () => {
          if (this.editor !== input) return false
          this.closeEditor(true)
          return true
        },
      },
    ])
    input.addEventListener('blur', () => {
      if (this.editor === input) this.closeEditor(true)
    })
    this.editor = input
    this.commentEl.replaceChildren(input)
    this.commentEl.hidden = false
    this.place()
    input.focus()
  }

  /** Ends editing, writing what was typed unless `save` is false. */
  private closeEditor(save: boolean): void {
    const input = this.editor
    if (!input) return
    this.editor = null
    this.editorKeymapDisposer?.()
    this.editorKeymapDisposer = null
    const mode = this.mode
    if (
      save &&
      mode?.kind === 'annotation' &&
      mode.reader.getAnnotationStore()?.get(mode.id)
    ) {
      this.writableStore(mode.reader)?.update(mode.id, {
        comment: input.value,
      })
    }
    input.remove()
    if (this.mode) this.rebuild()
  }

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  /** Turns the selection into highlights, one per page it touches. */
  private async highlight(
    reader: PdfReader,
    selection: ReaderTextSelection,
    color: AnnotationColor,
    withComment: boolean,
  ): Promise<void> {
    const store = this.writableStore(reader)
    if (!store) return
    const now = new Date().toISOString()
    const created: HighlightAnnotation[] = []
    try {
      for (const piece of selection.pieces) {
        const items = await reader.getTextItems(piece.pageNumber)
        const context = quoteContext(items, piece.tuple)
        created.push({
          id: newId(),
          type: 'highlight',
          color,
          createdAt: now,
          updatedAt: now,
          anchor: {
            page: piece.pageNumber,
            quadPoints: [...piece.quadPoints],
            quote: {
              exact: piece.text,
              ...(context.prefix ? { prefix: context.prefix } : {}),
              ...(context.suffix ? { suffix: context.suffix } : {}),
            },
            selection: [...piece.tuple],
          },
        })
      }
    } catch (error) {
      this.options.reportError('pdf highlight', error)
      return
    }
    if (!store.add(created)) return
    reader.clearTextSelection()
    if (withComment && created.length > 0) {
      this.open({ kind: 'annotation', reader, id: created[0].id })
      this.openEditor()
    } else {
      this.close()
    }
  }

  private remove(reader: PdfReader, id: string): void {
    const store = this.writableStore(reader)
    if (!store) return
    store.remove(id)
    if (this.mode?.kind === 'annotation' && this.mode.id === id) this.close()
  }

  /** The reader's store, when it takes edits. One that does not is showing
   * a file a newer version wrote (or one still being read): that is said,
   * rather than an edit silently going nowhere. */
  private writableStore(reader: PdfReader): AnnotationStore | null {
    const store = reader.getAnnotationStore()
    if (!store) return null
    if (!store.writable) {
      this.options.host.ui.notice(this.options.t('pdf.annotate.readOnly'))
      return null
    }
    return store
  }

  private async quoteToChat(
    reader: PdfReader,
    text: string,
    page: number,
  ): Promise<void> {
    try {
      await this.options.host.chat.addSelection({
        path: reader.path,
        text,
        page,
      })
      this.dismiss()
    } catch (error) {
      this.options.reportError('pdf quote to chat', error)
    }
  }

  private async copyAnnotationLink(
    reader: PdfReader,
    annotation: HighlightAnnotation,
  ): Promise<void> {
    let tuple: readonly number[] | null = null
    try {
      const items = await reader.getTextItems(annotation.anchor.page)
      tuple = resolveHighlightSelection(items, annotation.anchor)
    } catch (error) {
      this.options.reportError('pdf annotation link', error)
    }
    if (!tuple) {
      this.options.host.ui.notice(
        this.options.t('pdf.annotate.linkUnavailable'),
      )
      return
    }
    await this.copyLink(reader, annotation.anchor.page, tuple)
  }

  /** Copies Obsidian's own link to a selection on a page, written the way
   * the user's link settings write links. */
  private async copyLink(
    reader: PdfReader,
    page: number,
    tuple: readonly number[],
  ): Promise<void> {
    const link = this.options.host.vault.generateLink(
      reader.path,
      this.options.getSourcePath(),
      `#page=${page}&selection=${tuple.join(',')}`,
    )
    if (!link) return
    try {
      const clipboard = this.window()?.navigator.clipboard
      if (!clipboard) throw new Error('No clipboard in this window')
      await clipboard.writeText(link)
      this.options.host.ui.notice(this.options.t('pdf.annotate.linkCopied'))
    } catch (error) {
      this.options.reportError('pdf copy link', error)
    }
  }

  // -----------------------------------------------------------------------

  /** A press anywhere else closes an annotation's toolbar (a selection's
   * closes with the selection itself). */
  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (this.mode?.kind !== 'annotation') return
    const target = event.target as Node | null
    if (this.contains(target)) return
    // A press on the reader's pages is the reader's to report: it may be a
    // click on another annotation, or on this one again.
    const pages = (target as Element | null)?.closest?.(
      '.yolo-whiteboard-pdf-pages',
    )
    if (pages) return
    this.close()
  }

  private window(): Window | null {
    return this.options.parent.ownerDocument.defaultView
  }
}

function newId(): string {
  return crypto.randomUUID()
}
