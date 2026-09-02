// The one place in the repository that reaches into Obsidian's internals.
//
// Obsidian renders Markdown live (formatting shown, markup hidden away from
// the cursor) with a large set of private CodeMirror extensions, and does not
// publish the editor component that carries them. `MarkdownRenderer` covers
// read-only rendering; there is no public counterpart for editing. Rebuilding
// live preview ourselves would mean reimplementing Obsidian's editor, so
// instead we borrow the component the way Obsidian's own Canvas does — the
// same approach several long-standing community plugins take.
//
// The route: ask the embed registry for a Markdown embed, put it in edit mode,
// and walk up from the instance it creates to the base class it derives from.
// That class is then constructed directly into a container of our choosing;
// the embed itself is discarded, because a live embed also carries a preview
// pane and its own chrome that an embedded editor should not drag along.
//
// Everything private is confined to this file, behind types the rest of the
// host uses. The traversal and the shape check are separate pure functions so
// they can be tested against fakes, and each failure names the step that broke
// — when a future Obsidian changes shape, the error should say where.

import { EditorView } from '@codemirror/view'
import { type App, TFile } from 'obsidian'

import { getNodeWindow } from '../../utils/dom/window-context'

/**
 * The private editor component, as much of it as we rely on.
 *
 * Scrolling is deliberately *not* driven through the component's own
 * `getScroll`/`applyScroll` pair, although it speaks the fractional source
 * line the preview renderer answers in. Both convert between the scroller's
 * `scrollTop` and CodeMirror's block map, and the two are in different units
 * whenever the editor sits inside a CSS-scaled ancestor — a card on a zoomed
 * board: `scrollTop` is CSS pixels, the block map is screen pixels. Measured
 * 2026-09-02 at 1.107×: with source line 51 at the top edge, `getScroll` read
 * 45.76; `applyScroll(49)` landed on line 28, because it also scrolls to
 * heights that are still estimates. Obsidian's own Canvas drifts the same
 * way, a line per round trip at its zoom. The CodeMirror view underneath is
 * public API and has both a scale-aware coordinate and a scroll that
 * re-measures until it lands (`readScrollLine`, `openAtLine` below).
 */
type ObsidianMarkdownEditorInstance = {
  set(value: string, clear?: boolean): void
  destroy(): void
  cm: EditorView
  editor: {
    getValue(): string
    setValue(value: string): void
  }
}

type ObsidianMarkdownEditorClass = new (
  app: App,
  container: HTMLElement,
  owner: MarkdownEditorOwner,
) => ObsidianMarkdownEditorInstance

/**
 * What the component reads back from whoever mounted it. It asks for the
 * editing mode, reports scrolling, and resolves links and attachment paths
 * against `file`. It never asks the owner to save — persistence is not this
 * component's job (see `YoloModuleMarkdownEditorV1`).
 *
 * `editor` and `hoverPopover` are not read by the component itself: an edit
 * broadcasts a workspace event carrying the owner as the editing context, and
 * Obsidian's own listeners read `editor` off it. Leaving them out throws
 * inside Obsidian on the first keystroke. They are why this shape is Obsidian's
 * public `MarkdownFileInfo` rather than the smallest thing that constructs.
 *
 * `syncScroll` is called back on every scroll: in a Markdown *view* it keeps
 * the source and preview panes aligned. An embedded editor has no second pane
 * to align with, so there is nothing to do — but the method has to exist, or
 * scrolling inside the editor throws on each event.
 *
 * `editMode` is the component itself. Obsidian assigns whichever owner has
 * focus to `workspace.activeEditor` and reads `editMode.sourceMode` off it to
 * drive the View menu's preview/source checkmarks, so leaving it out throws
 * on every focus change. It is the component and not a stand-in because that
 * is the relationship a real Markdown view has — `view.editMode` is
 * `view.editor.editorComponent` — and the component already carries a real
 * `sourceMode`.
 */
type MarkdownEditorOwner = {
  app: App
  file: TFile | null
  editor: unknown
  editMode: unknown
  hoverPopover: null
  getMode(): 'source'
  onMarkdownScroll(): void
  syncScroll(): void
}

export type ObsidianMarkdownEditorHandle = {
  getValue(): string
  setValue(text: string): void
  focus(): void
  blur(): void
  hasFocus(): boolean
  getScrollLine(): number
  openAtLine(line: number): void
  destroy(): void
}

export type ObsidianMarkdownEditorOptions = {
  container: HTMLElement
  value: string
  sourcePath: string
  onChange?: (text: string) => void
  onBlur?: (text: string) => void
}

class ObsidianMarkdownEditorUnavailableError extends Error {
  constructor(step: string) {
    super(
      `Obsidian's Markdown editor is unavailable: ${step}. This build of Obsidian no longer exposes the editor component the host borrows.`,
    )
    this.name = 'ObsidianMarkdownEditorUnavailableError'
  }
}

/**
 * Walks an edit-mode Markdown embed to the editor base class behind it.
 *
 * Two prototype hops, not one: the embed instantiates its own subclass, and
 * the class we want is what that subclass extends. Pure so the traversal can
 * be exercised without an Obsidian instance.
 */
export function extractMarkdownEditorClass(
  widget: unknown,
): ObsidianMarkdownEditorClass {
  if (!widget || typeof widget !== 'object') {
    throw new ObsidianMarkdownEditorUnavailableError(
      'the embed registry returned no Markdown embed',
    )
  }
  const editMode = (widget as { editMode?: unknown }).editMode
  if (!editMode || typeof editMode !== 'object') {
    throw new ObsidianMarkdownEditorUnavailableError(
      'the Markdown embed exposed no edit mode',
    )
  }
  const derived: unknown = Object.getPrototypeOf(editMode)
  const base: unknown = derived === null ? null : Object.getPrototypeOf(derived)
  if (!base || typeof base !== 'object') {
    throw new ObsidianMarkdownEditorUnavailableError(
      'the edit mode has no base prototype',
    )
  }
  const ctor = (base as { constructor?: unknown }).constructor
  if (typeof ctor !== 'function') {
    throw new ObsidianMarkdownEditorUnavailableError(
      'the editor base prototype has no constructor',
    )
  }
  return ctor as ObsidianMarkdownEditorClass
}

/**
 * Confirms a freshly constructed instance still has the members we drive it
 * through. Checked per instance rather than on the class, because they come
 * from further up its prototype chain than the class we extracted.
 */
export function assertMarkdownEditorInstance(
  instance: unknown,
): asserts instance is ObsidianMarkdownEditorInstance {
  const value = instance as Partial<ObsidianMarkdownEditorInstance> | null
  if (!value || typeof value !== 'object') {
    throw new ObsidianMarkdownEditorUnavailableError(
      'constructing the editor produced no instance',
    )
  }
  for (const method of ['set', 'destroy'] as const) {
    if (typeof value[method] !== 'function') {
      throw new ObsidianMarkdownEditorUnavailableError(
        `the editor instance has no ${method}()`,
      )
    }
  }
  if (
    !value.cm ||
    typeof value.cm.contentDOM !== 'object' ||
    typeof value.cm.dispatch !== 'function'
  ) {
    throw new ObsidianMarkdownEditorUnavailableError(
      'the editor instance exposes no CodeMirror view',
    )
  }
  if (!value.editor || typeof value.editor.getValue !== 'function') {
    throw new ObsidianMarkdownEditorUnavailableError(
      'the editor instance exposes no editor interface',
    )
  }
}

/**
 * Where the view is scrolled to, as a fractional source line: the line whose
 * block the viewport's top edge is in, plus how far into that block the edge
 * sits, as a share of the block's lines. The coordinate the preview renderer
 * in `obsidianMarkdownContentView.ts` speaks, which is what lets a position
 * cross between the two surfaces.
 *
 * Both terms are screen pixels — `documentTop` is where CodeMirror says the
 * document begins on screen, and its block map is kept in the same units —
 * so a CSS transform on an ancestor cancels out instead of scaling the answer.
 * The edge is inside the viewport, so the block it lands in has been laid out
 * and measured, never estimated.
 */
function readScrollLine(cm: EditorView): number {
  const doc = cm.state.doc
  const edge = cm.scrollDOM.getBoundingClientRect().top - cm.documentTop
  const block = cm.lineBlockAtHeight(edge)
  const first = doc.lineAt(block.from).number - 1
  const lines = doc.lineAt(block.to).number - first
  const into = block.height > 0 ? (edge - block.top) / block.height : 0
  return first + lines * Math.min(1, Math.max(0, into))
}

/**
 * Puts a fractional source line at the viewport's top edge, and the caret
 * near it.
 *
 * The scroll is CodeMirror's own `scrollIntoView`, which keeps re-measuring
 * until the target is where it was asked to be. That is what a position far
 * below the viewport needs: every line between here and there is an estimate
 * until it has been laid out, and a scroll computed from estimates lands
 * short (measured: 21 lines short of 49). The share of the block above the
 * edge rides along as a negative margin, sized from the block's height as
 * currently known — possibly an estimate too, so once the scroll has been
 * measured the remainder is applied from the measured height, in the same
 * frame, before anything is painted. Usually nothing; up to a heading's top
 * padding when it is.
 *
 * The caret is the other half of it: left where a fresh editor puts it, at
 * the start of the document, the first keystroke scrolls the view back there.
 * It goes on the first line at or below the target that is not replaced by a
 * block widget, because a caret set inside a rendered table opens Obsidian's
 * cell editor, which takes the focus with it.
 */
function openAtLine(cm: EditorView, line: number): void {
  const doc = cm.state.doc
  const target = Math.max(0, Math.min(line, doc.lines - 1))
  const from = doc.line(Math.floor(target) + 1).from
  const above = (): number => {
    const block = cm.lineBlockAt(from)
    const first = doc.lineAt(block.from).number - 1
    const lines = doc.lineAt(block.to).number - first
    return ((target - first) / lines) * block.height
  }
  let caret = from
  for (let n = Math.floor(target) + 1; n <= doc.lines; n += 1) {
    const candidate = doc.line(n)
    const block = cm.lineBlockAt(candidate.from)
    if (block.from === candidate.from && block.to === candidate.to) {
      caret = candidate.from
      break
    }
  }
  cm.dispatch({
    selection: { anchor: caret },
    effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: -above() }),
  })
  // CodeMirror measures and scrolls in a frame callback it scheduled just
  // now; this one is queued behind it, so it runs after the scroll and before
  // the frame is painted.
  getNodeWindow(cm.dom).requestAnimationFrame(() => {
    if (!cm.dom.isConnected) return
    const wanted = cm.scrollDOM.getBoundingClientRect().top - above()
    const actual = cm.documentTop + cm.lineBlockAt(from).top
    const delta = actual - wanted
    if (Math.abs(delta) >= 1) cm.scrollDOM.scrollTop += delta / cm.scaleY
  })
}

type PrivateEmbedRegistry = {
  embedByExtension?: {
    md?: (
      context: { app: App; containerEl: HTMLElement },
      file: TFile | null,
      subpath: string,
    ) => unknown
  }
}

/**
 * Resolves the editor class, once per app.
 *
 * Lazily: the probe mounts a throwaway embed, which is not worth paying for at
 * startup when most sessions never open a module that edits Markdown — and a
 * failure only means anything at the point someone tries to edit. Cached
 * because the answer cannot change while Obsidian is running.
 */
const classByApp = new WeakMap<App, ObsidianMarkdownEditorClass>()

function resolveMarkdownEditorClass(app: App): ObsidianMarkdownEditorClass {
  const cached = classByApp.get(app)
  if (cached) return cached

  const registry = (app as App & { embedRegistry?: PrivateEmbedRegistry })
    .embedRegistry
  const createEmbed = registry?.embedByExtension?.md
  if (typeof createEmbed !== 'function') {
    throw new ObsidianMarkdownEditorUnavailableError(
      'the embed registry has no Markdown entry',
    )
  }

  // The probe embed has to be in a document to enter edit mode, but must never
  // be seen; it is torn down before this returns either way. Moved off screen
  // rather than hidden with `display: none`, which would leave it unlaid-out
  // and the editor it should produce unbuilt.
  const probeEl = document.createElement('div')
  probeEl.setCssProps({ position: 'fixed', left: '-9999px', top: '0' })
  document.body.appendChild(probeEl)
  let widget: unknown
  try {
    widget = createEmbed({ app, containerEl: probeEl }, null, '')
    const editable = widget as { editable?: boolean; showEditor?: () => void }
    editable.editable = true
    if (typeof editable.showEditor !== 'function') {
      throw new ObsidianMarkdownEditorUnavailableError(
        'the Markdown embed cannot be switched to edit mode',
      )
    }
    editable.showEditor()
    const resolved = extractMarkdownEditorClass(widget)
    classByApp.set(app, resolved)
    return resolved
  } finally {
    try {
      ;(widget as { unload?: () => void } | undefined)?.unload?.()
    } catch {
      // A probe that fails to unload must not mask the extraction result;
      // the element is removed regardless, so nothing stays on screen.
    }
    probeEl.remove()
  }
}

/**
 * Mounts a live-preview Markdown editor into `options.container`.
 *
 * `sourcePath` is resolved to a file when one exists so links and attachment
 * paths behave as they would inside that document; content that lives inside a
 * non-Markdown file (a card stored in a board, say) still resolves relative to
 * that file, which is what the user means by "here".
 */
export function createObsidianMarkdownEditor(
  app: App,
  options: ObsidianMarkdownEditorOptions,
): ObsidianMarkdownEditorHandle {
  const EditorClass = resolveMarkdownEditorClass(app)
  const file = app.vault.getAbstractFileByPath(options.sourcePath)

  const owner: MarkdownEditorOwner = {
    app,
    file: file instanceof TFile ? file : null,
    editor: null,
    editMode: null,
    hoverPopover: null,
    getMode: () => 'source',
    onMarkdownScroll: () => undefined,
    syncScroll: () => undefined,
  }

  // Obsidian's component builds its own `.markdown-source-view` inside
  // whatever container it is handed, and its `destroy()` tears down
  // CodeMirror without taking that element away again. Mounted straight into
  // the caller's container, every editor this function ever built would stay
  // behind as a full-height empty box — so it gets a wrapper of its own to be
  // removed by, and `destroy()` leaves the container as it found it.
  //
  // Box-less (`display: contents`), so the component's own layout still
  // resolves against the caller's container exactly as it did when it was
  // mounted there directly. Appended before construction, not after:
  // CodeMirror measures itself as it is built, and a detached container has
  // no size to measure.
  const hostEl = options.container.ownerDocument.createElement('div')
  hostEl.className = 'yolo-markdown-editor'
  hostEl.setCssProps({ display: 'contents' })
  options.container.appendChild(hostEl)

  let instance: ObsidianMarkdownEditorInstance
  try {
    instance = new EditorClass(app, hostEl, owner)
    assertMarkdownEditorInstance(instance)
  } catch (error) {
    hostEl.remove()
    throw error
  }
  // Only available once constructed, and needed before the first edit and the
  // first focus respectively — see MarkdownEditorOwner.
  owner.editor = instance.editor
  owner.editMode = instance

  let destroyed = false
  const read = (): string => instance.editor.getValue()

  // Change notification comes from the component's own update hook; blur from
  // the DOM, so noticing that the user left does not depend on another private
  // member. `relatedTarget` filters focus moving *within* the editor (its
  // search field, a suggestion popup), which is not the user leaving.
  const onUpdate = options.onChange
  if (onUpdate) {
    const proto = instance as unknown as {
      onUpdate?: (update: unknown, changed: boolean) => void
    }
    const inherited = proto.onUpdate?.bind(instance)
    proto.onUpdate = (update: unknown, changed: boolean) => {
      inherited?.(update, changed)
      if (changed && !destroyed) onUpdate(read())
    }
  }

  const onBlur = options.onBlur
  const handleBlur = (event: FocusEvent): void => {
    if (destroyed) return
    const next = event.relatedTarget
    if (next instanceof Node && instance.cm.contentDOM.contains(next)) return
    onBlur?.(read())
  }
  if (onBlur) instance.cm.contentDOM.addEventListener('blur', handleBlur)

  instance.set(options.value, true)

  return {
    getValue: read,
    setValue: (text: string) => instance.editor.setValue(text),
    focus: () => instance.cm.focus(),
    blur: () => instance.cm.contentDOM.blur(),
    hasFocus: () => instance.cm.hasFocus,
    getScrollLine: () => (destroyed ? 0 : readScrollLine(instance.cm)),
    openAtLine: (line: number) => {
      if (!destroyed) openAtLine(instance.cm, line)
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      if (onBlur) instance.cm.contentDOM.removeEventListener('blur', handleBlur)
      // Obsidian points `workspace.activeEditor` at whichever owner has focus
      // and only clears it when one of its own views unloads. Nothing unloads
      // this one, so without this it keeps a live reference to a destroyed
      // editor and the container it was mounted in, and the next menu update
      // reads editing state off an editor that is gone.
      const workspace = app.workspace as unknown as { activeEditor: unknown }
      if (workspace.activeEditor === owner) workspace.activeEditor = null
      instance.destroy()
      hostEl.remove()
    },
  }
}
