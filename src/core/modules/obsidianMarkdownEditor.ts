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

import { type App, TFile } from 'obsidian'

/** The private editor component, as much of it as we rely on. */
type ObsidianMarkdownEditorInstance = {
  set(value: string, clear?: boolean): void
  destroy(): void
  cm: {
    hasFocus: boolean
    focus(): void
    contentDOM: HTMLElement
  }
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
  if (!value.cm || typeof value.cm.contentDOM !== 'object') {
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

  const instance = new EditorClass(app, options.container, owner)
  assertMarkdownEditorInstance(instance)
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
    },
  }
}
