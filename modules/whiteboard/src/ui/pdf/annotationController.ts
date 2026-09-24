// What happens when someone annotates a PDF on a board: the floating
// toolbar over a text selection or a clicked annotation, the comment editor,
// the preview of a comment under the pointer, and the store edits they make
// (../../host/annotationStore.ts).
//
// A comment is its own thing, not a part of the toolbar: writing one puts
// the toolbar away and leaves a field under the passage; a commented
// annotation carries a dot (./annotationLayer.ts) whose comment shows on
// hover and opens for editing on a click, without the toolbar.
//
// One per board view. Every reader on the board — each PDF card and the
// reading panel — reports to the same controller (`events`), so there is one
// toolbar, in screen space over the whole view, whichever reader it is
// acting for: a card is under the camera's transform, and chrome must not
// zoom with it.
//
// Excerpts (摘录到白板) are handed to the board (`excerpts`), and are made by
// dragging onto it: a text selection with the platform's own drag of it
// (recognised as ours in `takeExcerptDrag`), a waiting frame or the active
// annotation with a pointer drag of this controller's (`onGrab`), since
// neither is anything the platform can drag. The toolbar offers no excerpt
// button; an annotation's context menu still does, for where there is no
// drag (touch). What was dragged out stays marked in the PDF — a selection
// or a frame becomes an annotation as it lands — but nothing records a link
// between the two afterwards.
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
import type { ExcerptContent, TextExcerpt } from '../../domain/excerpt'
import {
  ANNOTATION_COLORS,
  type AnnotationColor,
  type HighlightAnnotation,
  type PdfAnnotation,
  type PdfRectTuple,
  type SelectionTuple,
  displayColor,
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
import { createReaderIconButton } from './icons'
import { generatePdfLink } from './pdfLink'
import type {
  PdfReader,
  ReaderAnnotationEvents,
  ReaderTextSelection,
} from './pdfReader'

type Translate = (key: string) => string

/** Where excerpts go: the board this controller serves. `at` is the world
 * point a drag let go of it; without one the board picks the place. */
export type ExcerptSink = Readonly<{
  addText: (
    reader: PdfReader,
    excerpt: TextExcerpt,
    at?: ScreenPoint,
  ) => boolean
  addArea: (
    reader: PdfReader,
    page: number,
    rect: PdfRectTuple,
    at?: ScreenPoint,
  ) => Promise<boolean>
  /** Where on the board a pointer drag let go at `event` would land, or
   * null where it cannot (off the board, over a card). */
  dropPoint: (event: MouseEvent) => ScreenPoint | null
  /** Shows the card `content` would become, landed at `at` (world), or —
   * with null — shows none. */
  showLanding: (
    landing: Readonly<{ at: ScreenPoint; content: ExcerptContent }> | null,
  ) => void
}>

/** A text selection being dragged out of a reader. */
export type ExcerptDrag = Readonly<{
  reader: PdfReader
  selection: ReaderTextSelection
  excerpt: TextExcerpt
}>

/** A press on the waiting frame or the active annotation, and — once it has
 * moved far enough to be a drag — the picture following the pointer. */
type Grab = {
  readonly reader: PdfReader
  readonly pointerId: number
  readonly x: number
  readonly y: number
  readonly source:
    | Readonly<{ kind: 'area'; page: number; rect: PdfRectTuple }>
    | Readonly<{ kind: 'annotation'; id: string }>
  /** Pressed on the annotation's comment dot: a click opens the comment. */
  readonly note: boolean
  ghost: HTMLElement | null
}

/** A press that travels less than this is a click, not a drag. */
const GRAB_SLOP_PX = 4
/** The widest the picture carried by a drag is drawn. */
const GHOST_MAX_WIDTH_PX = 220

/** Marks a drag as a selection leaving one of this view's readers. Only the
 * type is read on drop; what is dragged is kept here, not in the transfer. */
const EXCERPT_DRAG_TYPE = 'application/x-yolo-whiteboard-pdf-excerpt'

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
  excerpts: ExcerptSink
  reportError: (stage: string, error: unknown) => void
}>

const OVERLAY_CLASS = 'yolo-whiteboard-pdf-annotation-overlay'
const HIGHLIGHT_BUTTON_CLASS = 'yolo-whiteboard-pdf-highlight-button'
const PAGES_SELECTOR = '.yolo-whiteboard-pdf-pages'
const COMMENT_CLASS = 'yolo-whiteboard-pdf-comment'
const COMMENT_NEW_CLASS = 'yolo-whiteboard-pdf-comment-new'
const COMMENT_HIDDEN_CLASS = 'yolo-whiteboard-pdf-comment-hidden'
/** A comment past one line: its buttons go under it rather than beside. */
const COMMENT_MULTILINE_CLASS = 'yolo-whiteboard-pdf-comment-multiline'
const COMMENT_INPUT_CLASS = 'yolo-whiteboard-pdf-comment-input'
const COMMENT_ACTIONS_CLASS = 'yolo-whiteboard-pdf-comment-actions'
const COMMENT_BUTTON_CLASS = 'yolo-whiteboard-pdf-comment-button'
const PREVIEW_CLASS = 'yolo-whiteboard-pdf-comment-preview'
const GHOST_CLASS = 'yolo-whiteboard-pdf-drag-ghost'
const GHOST_TEXT_CLASS = 'yolo-whiteboard-pdf-drag-ghost-text'
const GHOST_DROPPABLE_CLASS = 'yolo-whiteboard-pdf-drag-ghost-droppable'
/** On the view root while something is being dragged out. */
const GRABBING_CLASS = 'yolo-whiteboard-pdf-grabbing'

type Mode =
  | Readonly<{
      kind: 'selection'
      reader: PdfReader
      selection: ReaderTextSelection
    }>
  | Readonly<{ kind: 'annotation'; reader: PdfReader; id: string }>
  /** An annotation's comment being written. `isNew` when the annotation was
   * made to be commented on, just now: letting it go with Escape takes the
   * annotation back too. */
  | Readonly<{
      kind: 'comment'
      reader: PdfReader
      id: string
      isNew: boolean
    }>
  /** A frame drawn in area mode, not yet anything: it becomes an area
   * annotation, an excerpt, or nothing. */
  | Readonly<{
      kind: 'area'
      reader: PdfReader
      page: number
      rect: PdfRectTuple
    }>

export class AnnotationController {
  readonly events: ReaderAnnotationEvents
  private readonly toolbar: SelectionToolbar
  /** The field a comment is written in, under its passage. */
  private readonly commentEl: HTMLElement
  /** A commented annotation's comment, over its dot while the pointer
   * is on it. */
  private readonly previewEl: HTMLElement
  private preview: Readonly<{ reader: PdfReader; id: string }> | null = null
  private mode: Mode | null = null
  private editor: HTMLTextAreaElement | null = null
  private editorKeymapDisposer: (() => void) | null = null
  private frameId: number | null = null
  private drag: ExcerptDrag | null = null
  private grab: Grab | null = null

  constructor(private readonly options: AnnotationControllerOptions) {
    const doc = options.parent.ownerDocument
    this.toolbar = new SelectionToolbar(doc, options.parent)
    this.toolbar.overlay.classList.add(OVERLAY_CLASS)
    this.commentEl = doc.createElement('div')
    this.commentEl.className = COMMENT_CLASS
    this.commentEl.hidden = true
    this.toolbar.overlay.appendChild(this.commentEl)
    this.previewEl = doc.createElement('div')
    this.previewEl.className = PREVIEW_CLASS
    this.previewEl.hidden = true
    this.toolbar.overlay.appendChild(this.previewEl)
    // A press on the toolbar must not take the focus, or collapse the text
    // selection its buttons are about to act on. The comment's text area is
    // the one thing in the overlay that needs a press to focus it.
    this.toolbar.overlay.addEventListener('mousedown', (event) => {
      const target = event.target as Element | null
      if (target?.closest?.(`.${COMMENT_INPUT_CLASS}`)) return
      event.preventDefault()
    })
    doc.addEventListener('pointerdown', this.onDocumentPointerDown, true)
    options.parent.addEventListener('dragstart', this.onDragStart)
    options.parent.addEventListener('dragend', this.onDragEnd)

    this.events = {
      onTextSelection: (reader, selection) =>
        this.onTextSelection(reader, selection),
      onAnnotationClick: (reader, id) => this.onAnnotationClick(reader, id),
      onAnnotationContextMenu: (reader, id, event) =>
        this.onAnnotationContextMenu(reader, id, event),
      onAreaDrawn: (reader, page, rect) => this.onAreaDrawn(reader, page, rect),
      onGrab: (reader, event, id, note) => this.onGrab(reader, event, id, note),
      onNoteHover: (reader, id) => this.hoverNote(reader, id),
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

  /** Escape: drops a drag in progress, lets go of a comment unwritten (and
   * of the annotation made for it), then closes the toolbar. */
  dismiss(): boolean {
    if (this.grab?.ghost) {
      this.endGrab()
      return true
    }
    const mode = this.mode
    if (mode?.kind === 'comment') {
      this.closeEditor(false)
      if (mode.isNew) this.remove(mode.reader, mode.id)
      else this.close()
      return true
    }
    if (!mode) return false
    if (mode.kind === 'selection') mode.reader.clearTextSelection()
    this.close()
    return true
  }

  /** Whether a drag is a selection leaving one of this view's readers. */
  isExcerptDrag(event: DragEvent): boolean {
    return (
      this.drag !== null &&
      (event.dataTransfer?.types.includes(EXCERPT_DRAG_TYPE) ?? false)
    )
  }

  /** The passage a dragged selection carries, or null for any other drag. */
  draggedQuote(event: DragEvent): string | null {
    return this.isExcerptDrag(event) ? (this.drag?.excerpt.quote ?? null) : null
  }

  /** The selection a drop carries, taken: a drop is one excerpt. */
  takeExcerptDrag(event: DragEvent): ExcerptDrag | null {
    if (!this.isExcerptDrag(event)) return null
    const drag = this.drag
    this.drag = null
    return drag
  }

  /** Opens an annotation's toolbar as a click on it would. */
  openAnnotation(reader: PdfReader, id: string): void {
    this.open({ kind: 'annotation', reader, id })
  }

  /** Opens an annotation's comment for editing, as a click on its dot
   * would. */
  openComment(reader: PdfReader, id: string, isNew = false): void {
    this.open({ kind: 'comment', reader, id, isNew })
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
    if (this.grab?.reader === reader) this.endGrab()
    if (this.preview?.reader === reader) this.hidePreview()
    if (this.mode?.reader === reader) this.close()
  }

  /** The selection a drop made into a card stays marked where it was read,
   * in the colour a highlight would take now. Quietly not, on a PDF whose
   * annotations are read-only: the excerpt itself was what was asked for. */
  markDropped(drag: ExcerptDrag): void {
    if (!drag.reader.getAnnotationStore()?.writable) {
      drag.reader.clearTextSelection()
      return
    }
    void this.highlight(
      drag.reader,
      drag.selection,
      this.options.prefs.getDefaultColor(),
      false,
    )
  }

  destroy(): void {
    this.endGrab()
    this.close()
    this.options.parent.ownerDocument.removeEventListener(
      'pointerdown',
      this.onDocumentPointerDown,
      true,
    )
    this.options.parent.removeEventListener('dragstart', this.onDragStart)
    this.options.parent.removeEventListener('dragend', this.onDragEnd)
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
        onSelect: () => this.openComment(reader, id),
      },
      {
        title: t('pdf.annotate.excerpt'),
        icon: annotation.type === 'area' ? 'image-plus' : 'text-quote',
        onSelect: () => void this.excerptAnnotation(reader, annotation),
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
    this.open({ kind: 'area', reader, page, rect })
  }

  /** Makes the waiting frame an area annotation. */
  private annotateArea(
    mode: Extract<Mode, { kind: 'area' }>,
    color: AnnotationColor,
    withComment: boolean,
  ): void {
    const store = this.writableStore(mode.reader)
    if (!store) return
    const id = addArea(store, mode.page, mode.rect, color)
    if (id === null) return
    if (withComment) this.openComment(mode.reader, id, true)
    else this.open({ kind: 'annotation', reader: mode.reader, id })
  }

  // -----------------------------------------------------------------------
  // The toolbar
  // -----------------------------------------------------------------------

  private open(mode: Mode): void {
    this.closeEditor(true)
    this.hidePreview()
    const previous = this.mode
    if (previous && previous.reader !== mode.reader) {
      previous.reader.setActiveAnnotation(null)
    }
    // A waiting frame the toolbar moves on from is let go — unless what it
    // moves on to is the next frame on the same reader, which is the one the
    // reader is now showing.
    if (
      previous?.kind === 'area' &&
      !(mode.kind === 'area' && mode.reader === previous.reader)
    ) {
      previous.reader.clearPendingArea()
    }
    this.mode = mode
    mode.reader.setActiveAnnotation(
      mode.kind === 'annotation' || mode.kind === 'comment' ? mode.id : null,
    )
    this.rebuild()
    this.startFollowing()
  }

  private close(): void {
    this.endGrab()
    this.closeEditor(true)
    if (this.mode?.kind === 'area') this.mode.reader.clearPendingArea()
    this.mode?.reader.setActiveAnnotation(null)
    this.mode = null
    this.toolbar.setModel(null)
    this.stopFollowing()
  }

  private rebuild(): void {
    const mode = this.mode
    if (!mode) return
    if (mode.kind === 'selection') {
      this.toolbar.setModel({ items: this.selectionItems(mode) })
      return
    }
    if (mode.kind === 'area') {
      this.toolbar.setModel({ items: this.areaItems(mode) })
      return
    }
    const annotation = mode.reader.getAnnotationStore()?.get(mode.id)
    if (!annotation) {
      this.close()
      return
    }
    if (mode.kind === 'comment') {
      this.toolbar.setModel(null)
      this.openEditor(mode)
      return
    }
    this.toolbar.setModel({
      items: this.annotationItems(mode.reader, annotation),
    })
  }

  /** The annotation colours. With `primary`, the split button that marks in
   * the current colour on its body and in another from its row; without,
   * the one button that recolours. */
  private palette(
    current: AnnotationColor,
    onPick: (color: AnnotationColor) => void,
    primary?: Readonly<{
      label: string
      onSelect: () => void
    }>,
  ): ToolbarSwatchControl {
    const t = this.options.t
    return {
      kind: 'swatches',
      label: t('pdf.annotate.colors'),
      primary: primary && {
        ...primary,
        icon: 'highlighter',
        className: `${HIGHLIGHT_BUTTON_CLASS} ${annotationColorClass(current)}`,
      },
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
    // Marking, commenting and asking about the passage. Taking it onto the
    // board is dragging it there; a link to it is on the highlight's menu.
    const color = this.options.prefs.getDefaultColor()
    return [
      this.palette(
        color,
        (picked) => {
          this.options.prefs.setDefaultColor(picked)
          void this.highlight(reader, selection, picked, false)
        },
        {
          label: t('pdf.annotate.highlight'),
          onSelect: () => void this.highlight(reader, selection, color, false),
        },
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
  }

  /** A waiting frame's toolbar: the selection toolbar's, for an area — which
   * a chat cannot take, being a picture. */
  private areaItems(mode: Extract<Mode, { kind: 'area' }>): ToolbarItem[] {
    const t = this.options.t
    const color = this.options.prefs.getDefaultColor()
    return [
      this.palette(
        color,
        (picked) => {
          this.options.prefs.setDefaultColor(picked)
          this.annotateArea(mode, picked, false)
        },
        {
          label: t('pdf.annotate.frame'),
          onSelect: () => this.annotateArea(mode, color, false),
        },
      ),
      {
        label: t('pdf.annotate.comment'),
        icon: 'message-square',
        onSelect: () => this.annotateArea(mode, color, true),
      },
    ]
  }

  /** An annotation's toolbar: the selection toolbar's, with the colour now
   * one to change and the annotation one to delete. */
  private annotationItems(
    reader: PdfReader,
    annotation: PdfAnnotation,
  ): ToolbarItem[] {
    const t = this.options.t
    const items: ToolbarItem[] = [
      this.palette(displayColor(annotation.color), (color) => {
        this.writableStore(reader)?.update(annotation.id, { color })
        this.rebuild()
      }),
      {
        label: t(
          annotation.comment
            ? 'pdf.annotate.editComment'
            : 'pdf.annotate.comment',
        ),
        icon: 'message-square',
        onSelect: () => this.openComment(reader, annotation.id),
      },
    ]
    if (annotation.type === 'highlight') {
      items.push({
        label: t('pdf.annotate.quoteToChat'),
        icon: 'message-square-quote',
        onSelect: () =>
          void this.quoteToChat(
            reader,
            annotation.anchor.quote.exact,
            annotation.anchor.page,
          ),
      })
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
    if (mode.kind === 'selection') return mode.selection.getRect()
    if (mode.kind === 'area') return mode.reader.getPendingAreaRect()
    if (mode.kind === 'comment')
      return mode.reader.getAnnotationEndRect(mode.id)
    return mode.reader.getAnnotationRect(mode.id)
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
    // What is being dragged out is under the pointer, not under the toolbar.
    if (this.grab?.ghost) {
      this.toolbar.setSuppressed(true)
      return
    }
    const rect = this.anchorRect()
    // A waiting frame that is gone (a press on the pages let it go) takes
    // its toolbar with it.
    if (!rect && this.mode?.kind === 'area') {
      this.close()
      return
    }
    const overlay = this.toolbar.overlay.getBoundingClientRect()
    if (this.mode?.kind === 'comment') {
      this.placeEditor(rect, overlay)
      return
    }
    if (!rect || !(overlay.width > 0)) {
      this.toolbar.setSuppressed(true)
      return
    }
    this.toolbar.setSuppressed(false)
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
    // The colour row opens away from the text it is about to colour.
    const below = point.y > rect.top - overlay.top
    this.toolbar.setPopoversAbove(!below)
  }

  // -----------------------------------------------------------------------
  // The comment
  // -----------------------------------------------------------------------

  /** Opens the field for the comment `mode` is writing, if it is not open. */
  private openEditor(mode: Extract<Mode, { kind: 'comment' }>): void {
    if (this.editor) return
    const annotation = mode.reader.getAnnotationStore()?.get(mode.id)
    if (!annotation) return
    const t = this.options.t
    const doc = this.commentEl.ownerDocument
    const input = doc.createElement('textarea')
    input.className = COMMENT_INPUT_CLASS
    input.rows = 1
    input.value = annotation.comment ?? ''
    input.placeholder = t('pdf.annotate.commentPlaceholder')
    input.addEventListener('input', () => this.fitEditor())
    // Enter writes it; Shift+Enter is a new line. Not while an input method
    // is composing, where Enter picks the candidate.
    input.addEventListener('keydown', (event) => {
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.altKey ||
        event.isComposing
      ) {
        return
      }
      event.preventDefault()
      this.closeEditor(true)
      this.close()
    })
    // Mod+Enter, which Obsidian's own binding would otherwise take first.
    this.editorKeymapDisposer = this.options.registerKeymap([
      {
        modifiers: ['Mod'],
        key: 'Enter',
        handler: () => {
          if (this.editor !== input) return false
          this.closeEditor(true)
          this.close()
          return true
        },
      },
    ])
    // Focus leaving it — a press anywhere else — writes it and puts it away.
    input.addEventListener('blur', () => {
      if (this.editor !== input) return
      this.closeEditor(true)
      this.close()
    })
    const children: Node[] = [input]
    // A comment already written can be taken off, or confirmed; a new one is
    // only the field.
    if (!mode.isNew) {
      const actions = doc.createElement('div')
      actions.className = COMMENT_ACTIONS_CLASS
      actions.append(
        createReaderIconButton(
          doc,
          COMMENT_BUTTON_CLASS,
          'trash-2',
          t('pdf.annotate.deleteComment'),
          () => {
            this.closeEditor(false)
            this.writableStore(mode.reader)?.update(mode.id, { comment: '' })
            this.close()
          },
        ),
        createReaderIconButton(
          doc,
          COMMENT_BUTTON_CLASS,
          'check',
          t('pdf.annotate.saveComment'),
          () => {
            this.closeEditor(true)
            this.close()
          },
        ),
      )
      children.push(actions)
    }
    this.editor = input
    this.commentEl.classList.toggle(COMMENT_NEW_CLASS, mode.isNew)
    this.commentEl.replaceChildren(...children)
    this.commentEl.hidden = false
    this.fitEditor()
    this.place()
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }

  /** Grows the field with what is written in it, up to its CSS max-height.
   * Past one line, the buttons beside it would leave a column of nothing
   * above them, so they move under it. Whether it is past one line is
   * measured beside the buttons, always: measured in the wider field under
   * them, a line that just fits there would put them back beside it, where
   * it wraps again. */
  private fitEditor(): void {
    const input = this.editor
    if (!input) return
    this.commentEl.classList.remove(COMMENT_MULTILINE_CLASS)
    input.setCssProps({ height: 'auto' })
    // At `rows = 1` and no set height, the field is one line tall.
    if (input.scrollHeight > input.clientHeight + 1) {
      this.commentEl.classList.add(COMMENT_MULTILINE_CLASS)
    }
    input.setCssProps({ height: `${input.scrollHeight}px` })
  }

  /** Puts the comment field away, writing what was typed unless `save` is
   * false. What the mode does next is the caller's. */
  private closeEditor(save: boolean): void {
    const input = this.editor
    if (!input) return
    this.editor = null
    this.editorKeymapDisposer?.()
    this.editorKeymapDisposer = null
    const mode = this.mode
    if (
      save &&
      mode?.kind === 'comment' &&
      mode.reader.getAnnotationStore()?.get(mode.id)
    ) {
      this.writableStore(mode.reader)?.update(mode.id, {
        comment: input.value,
      })
    }
    this.commentEl.hidden = true
    this.commentEl.replaceChildren()
  }

  /** Under the passage's last line, from where it starts; above the whole
   * passage when there is no room below. */
  private placeEditor(end: DOMRect | null, overlay: DOMRect): void {
    const mode = this.mode
    if (!end || !(overlay.width > 0) || mode?.kind !== 'comment') {
      this.commentEl.classList.add(COMMENT_HIDDEN_CLASS)
      return
    }
    this.commentEl.classList.remove(COMMENT_HIDDEN_CLASS)
    const width = this.commentEl.offsetWidth
    const height = this.commentEl.offsetHeight
    const x = Math.max(
      TOOLBAR_MARGIN_PX,
      Math.min(
        end.left - overlay.left,
        overlay.width - width - TOOLBAR_MARGIN_PX,
      ),
    )
    let y = end.bottom - overlay.top + TOOLBAR_GAP_PX
    if (y + height > overlay.height - TOOLBAR_MARGIN_PX) {
      const whole = mode.reader.getAnnotationRect(mode.id) ?? end
      y = whole.top - overlay.top - TOOLBAR_GAP_PX - height
    }
    this.commentEl.style.transform = `translate(${x}px, ${Math.max(TOOLBAR_MARGIN_PX, y)}px)`
  }

  // -----------------------------------------------------------------------
  // The comment under the pointer
  // -----------------------------------------------------------------------

  /** The pointer came onto a comment dot (`id`), or left it (null): its
   * comment is previewed over it. The reader reports its own; the board
   * reports those on a card not entered, which the reader never sees. */
  hoverNote(reader: PdfReader, id: string | null): void {
    if (id === null) {
      if (this.preview?.reader === reader) this.hidePreview()
      return
    }
    const comment = reader.getAnnotationStore()?.get(id)?.comment?.trim()
    // Not while it is open for editing, nor while something is carried.
    if (
      !comment ||
      this.grab ||
      (this.mode?.kind === 'comment' && this.mode.id === id)
    ) {
      this.hidePreview()
      return
    }
    const note = reader.getNoteRect(id)
    const overlay = this.toolbar.overlay.getBoundingClientRect()
    if (!note || !(overlay.width > 0)) {
      this.hidePreview()
      return
    }
    this.preview = { reader, id }
    this.previewEl.textContent = comment
    this.previewEl.hidden = false
    // Centred over the dot; under it when there is no room above.
    const width = this.previewEl.offsetWidth
    const height = this.previewEl.offsetHeight
    const x = Math.max(
      TOOLBAR_MARGIN_PX,
      Math.min(
        note.left + note.width / 2 - overlay.left - width / 2,
        overlay.width - width - TOOLBAR_MARGIN_PX,
      ),
    )
    let y = note.top - overlay.top - TOOLBAR_GAP_PX - height
    if (y < TOOLBAR_MARGIN_PX) y = note.bottom - overlay.top + TOOLBAR_GAP_PX
    this.previewEl.style.transform = `translate(${x}px, ${y}px)`
  }

  private hidePreview(): void {
    if (!this.preview) return
    this.preview = null
    this.previewEl.hidden = true
    this.previewEl.textContent = ''
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
      this.openComment(reader, created[0].id, true)
    } else {
      this.close()
    }
  }

  /** An annotation as an excerpt card, from its own anchor. Nothing ties the
   * two together afterwards. */
  private async excerptAnnotation(
    reader: PdfReader,
    annotation: PdfAnnotation,
    at?: ScreenPoint,
  ): Promise<void> {
    if (annotation.type === 'area') {
      await this.excerptArea(
        reader,
        annotation.anchor.page,
        annotation.anchor.rect,
        at,
      )
      return
    }
    // The tuple where its text is now; the page alone when it has moved.
    let tuple: SelectionTuple | null = null
    try {
      const items = await reader.getTextItems(annotation.anchor.page)
      tuple = resolveHighlightSelection(items, annotation.anchor)
    } catch (error) {
      this.options.reportError('pdf annotation excerpt', error)
    }
    if (
      this.options.excerpts.addText(
        reader,
        {
          page: annotation.anchor.page,
          selection: tuple,
          quote: annotation.anchor.quote.exact,
        },
        at,
      ) &&
      this.mode?.kind === 'annotation' &&
      this.mode.id === annotation.id
    ) {
      this.close()
    }
  }

  private async excerptArea(
    reader: PdfReader,
    page: number,
    rect: PdfRectTuple,
    at?: ScreenPoint,
  ): Promise<void> {
    const before = this.mode
    const added = await this.options.excerpts.addArea(reader, page, rect, at)
    // Closed only if it is still the toolbar the excerpt was asked from.
    if (added && this.mode === before) this.close()
  }

  private remove(reader: PdfReader, id: string): void {
    const store = this.writableStore(reader)
    if (!store) return
    store.remove(id)
    const mode = this.mode
    if (
      (mode?.kind === 'annotation' || mode?.kind === 'comment') &&
      mode.id === id
    ) {
      this.close()
    }
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
    let tuple: SelectionTuple | null = null
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
    tuple: SelectionTuple,
  ): Promise<void> {
    const link = generatePdfLink(this.options.host, this.options.t, {
      pdfPath: reader.path,
      sourcePath: this.options.getSourcePath(),
      page,
      selection: tuple,
    })
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
    if (this.mode?.kind !== 'annotation' && this.mode?.kind !== 'area') return
    const target = event.target as Node | null
    if (this.contains(target)) return
    // A press on the reader's pages is the reader's to report: it may be a
    // click on another annotation, or on this one again — or, for a frame,
    // the next frame being drawn.
    const pages = (target as Element | null)?.closest?.(PAGES_SELECTOR)
    if (pages) return
    this.close()
  }

  /** A drag that starts on the selected text of the reader the toolbar is
   * acting for is an excerpt being dragged out. The browser's own drag of
   * the selection goes on as always (its text in the transfer, for anywhere
   * else it is dropped); the board only learns it is ours. */
  private readonly onDragStart = (event: DragEvent): void => {
    const mode = this.mode
    this.drag = null
    if (mode?.kind !== 'selection' || !event.dataTransfer) return
    if (!mode.reader.containsPageNode(event.target as Node | null)) return
    event.dataTransfer.setData(EXCERPT_DRAG_TYPE, '1')
    this.drag = {
      reader: mode.reader,
      selection: mode.selection,
      excerpt: selectionExcerpt(mode.selection),
    }
  }

  private readonly onDragEnd = (): void => {
    this.drag = null
    // A drag let go anywhere but the board — or taken back with Escape —
    // hears of it only here.
    this.options.excerpts.showLanding(null)
  }

  // -----------------------------------------------------------------------
  // Dragging a frame or an annotation out
  // -----------------------------------------------------------------------

  /** A press on an annotation (`id`) or on the waiting frame (null). It
   * stays a press until it moves — let go there, it is a click, which opens
   * the annotation — and a drag once it has. */
  private onGrab(
    reader: PdfReader,
    event: PointerEvent,
    id: string | null,
    note: boolean,
  ): void {
    const mode = this.mode
    let source: Grab['source']
    if (id !== null) source = { kind: 'annotation', id }
    else if (mode?.kind === 'area' && mode.reader === reader) {
      source = { kind: 'area', page: mode.page, rect: mode.rect }
    } else return
    this.endGrab()
    this.hidePreview()
    this.grab = {
      reader,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      source,
      note,
      ghost: null,
    }
    const doc = this.options.parent.ownerDocument
    doc.addEventListener('pointermove', this.onGrabMove)
    doc.addEventListener('pointerup', this.onGrabUp)
    doc.addEventListener('pointercancel', this.onGrabUp)
  }

  private readonly onGrabMove = (event: PointerEvent): void => {
    const grab = this.grab
    if (!grab || event.pointerId !== grab.pointerId) return
    if (!grab.ghost) {
      const moved = Math.hypot(event.clientX - grab.x, event.clientY - grab.y)
      if (moved < GRAB_SLOP_PX) return
      grab.ghost = this.createGhost(grab)
      if (!grab.ghost) {
        this.endGrab()
        return
      }
      // A press that kept the page from taking it also kept any selection
      // standing; what is being carried now is the annotation.
      grab.reader.clearTextSelection()
      this.options.parent.classList.add(GRABBING_CLASS)
      this.place()
    }
    const overlay = this.toolbar.overlay.getBoundingClientRect()
    const ghost = grab.ghost
    // Centred on the pointer, where the card it becomes will be centred.
    ghost.style.transform = `translate(${event.clientX - overlay.left - ghost.offsetWidth / 2}px, ${event.clientY - overlay.top - ghost.offsetHeight / 2}px)`
    const at = this.options.excerpts.dropPoint(event)
    const content = at && this.grabbedContent(grab)
    ghost.classList.toggle(GHOST_DROPPABLE_CLASS, content !== null)
    this.options.excerpts.showLanding(at && content && { at, content })
  }

  /** What the grabbed thing will be once dropped, or null when it is gone. */
  private grabbedContent(grab: Grab): ExcerptContent | null {
    const { source } = grab
    if (source.kind === 'area') return { kind: 'area', rect: source.rect }
    const annotation = grab.reader.getAnnotationStore()?.get(source.id)
    if (!annotation) return null
    return annotation.type === 'area'
      ? { kind: 'area', rect: annotation.anchor.rect }
      : { kind: 'text', quote: annotation.anchor.quote.exact }
  }

  private readonly onGrabUp = (event: PointerEvent): void => {
    const grab = this.grab
    if (!grab || event.pointerId !== grab.pointerId) return
    const at =
      grab.ghost && event.type === 'pointerup'
        ? this.options.excerpts.dropPoint(event)
        : null
    const clicked = !grab.ghost && event.type === 'pointerup'
    this.endGrab()
    if (at) this.dropGrabbed(grab, at)
    // Let go where it was pressed: a click on the annotation, which opens
    // it — the reader never saw this press, so it reports no click.
    if (clicked && grab.source.kind === 'annotation') {
      grab.reader.clearTextSelection()
      if (grab.note) this.openComment(grab.reader, grab.source.id)
      else this.onAnnotationClick(grab.reader, grab.source.id)
    }
  }

  /** Ends a press or a drag, dropping nothing. */
  private endGrab(): void {
    const grab = this.grab
    if (!grab) return
    this.grab = null
    const doc = this.options.parent.ownerDocument
    doc.removeEventListener('pointermove', this.onGrabMove)
    doc.removeEventListener('pointerup', this.onGrabUp)
    doc.removeEventListener('pointercancel', this.onGrabUp)
    if (!grab.ghost) return
    grab.ghost.remove()
    this.options.parent.classList.remove(GRABBING_CLASS)
    this.options.excerpts.showLanding(null)
    if (this.mode) this.place()
  }

  /** What was dragged, let go of on the board: a card there, and — for a
   * frame — the area annotation it was waiting to become. */
  private dropGrabbed(grab: Grab, at: ScreenPoint): void {
    const { reader, source } = grab
    if (source.kind === 'area') {
      const store = reader.getAnnotationStore()
      if (store?.writable) {
        addArea(
          store,
          source.page,
          source.rect,
          this.options.prefs.getDefaultColor(),
        )
      }
      if (this.mode?.kind === 'area' && this.mode.reader === reader) {
        this.close()
      }
      void this.options.excerpts.addArea(reader, source.page, source.rect, at)
      return
    }
    const annotation = reader.getAnnotationStore()?.get(source.id)
    if (annotation) void this.excerptAnnotation(reader, annotation, at)
  }

  /** The picture a drag carries: the framed region itself, or the passage
   * as the card will quote it. */
  private createGhost(grab: Grab): HTMLElement | null {
    const { reader, source } = grab
    const annotation =
      source.kind === 'annotation'
        ? reader.getAnnotationStore()?.get(source.id)
        : undefined
    if (source.kind === 'annotation' && !annotation) return null
    const doc = this.options.parent.ownerDocument
    const ghost = doc.createElement('div')
    ghost.className = GHOST_CLASS
    if (annotation?.type === 'highlight') {
      ghost.classList.add(annotationColorClass(annotation.color))
      const text = doc.createElement('div')
      text.className = GHOST_TEXT_CLASS
      text.textContent = annotation.anchor.quote.exact
      ghost.appendChild(text)
    } else {
      const rect =
        source.kind === 'area'
          ? reader.getPendingAreaRect()
          : reader.getAnnotationRect(source.id)
      const picture = rect ? reader.snapshot(rect, GHOST_MAX_WIDTH_PX) : null
      if (!picture) return null
      ghost.appendChild(picture)
    }
    this.toolbar.overlay.appendChild(ghost)
    return ghost
  }

  private window(): Window | null {
    return this.options.parent.ownerDocument.defaultView
  }
}

function selectionExcerpt(selection: ReaderTextSelection): TextExcerpt {
  const first = selection.pieces[0]
  return {
    page: first.pageNumber,
    selection: first.tuple,
    quote: selection.pieces.map((piece) => piece.text).join('\n'),
  }
}

function newId(): string {
  return crypto.randomUUID()
}

/** A frame as an area annotation; its id, or null when the store refused. */
function addArea(
  store: AnnotationStore,
  page: number,
  rect: PdfRectTuple,
  color: AnnotationColor,
): string | null {
  const now = new Date().toISOString()
  const annotation: PdfAnnotation = {
    id: newId(),
    type: 'area',
    color,
    createdAt: now,
    updatedAt: now,
    anchor: { page, rect },
  }
  return store.add([annotation]) ? annotation.id : null
}
