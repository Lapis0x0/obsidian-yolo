import type { ReactNode } from 'react'

import type { ModuleConfigV1 } from './moduleConfig'
import type { ModuleFailure } from './moduleFailure'
import type { LocalizedTextV1 } from './moduleI18n'
import type { ModulePrivateStorageV1 } from './modulePrivateStorage'
import type { YoloModuleSettingsV1 } from './moduleSettingsContributions'
import type { YoloModuleWorkersV1 } from './moduleWorkerHost'

export type ModuleDisposer = () => void
export type ModuleQuiescenceCallback = () => void | Promise<void>

export type YoloModuleLifecycle = {
  add(disposer: ModuleDisposer): void
  whenActive(callback: () => void | Promise<void>): void
  onQuiesce(callback: ModuleQuiescenceCallback): void
}

export type YoloModuleViewV1 = Readonly<{
  type: string
  name: LocalizedTextV1
  icon: string
  render(): ReactNode
  getState?(): Readonly<Record<string, unknown>>
  setState?(state: Readonly<Record<string, unknown>>): void | Promise<void>
}>

export type YoloModuleRibbonActionV1 = Readonly<{
  icon: string
  title: LocalizedTextV1
  onClick(): void
}>

export type YoloModuleCommandV1 = Readonly<{
  id: string
  name: LocalizedTextV1
  callback(): void | Promise<void>
}>

export type YoloModuleOpenViewOptionsV1 = Readonly<{
  newLeaf?: boolean
  state?: Readonly<Record<string, unknown>>
}>

export type YoloModuleFileViewFileV1 = Readonly<{
  path: string
  basename: string
  extension: string
}>

export type YoloModuleKeymapModifierV1 =
  | 'Mod'
  | 'Ctrl'
  | 'Meta'
  | 'Shift'
  | 'Alt'

export type YoloModuleKeymapBindingV1 = Readonly<{
  modifiers: readonly YoloModuleKeymapModifierV1[]
  /** Obsidian keymap key vocabulary, e.g. 'Escape'. */
  key: string
  /** Return true to consume the key; any other result lets Obsidian continue. */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- void must stay a union member so a handler with no return statement (the common case) type-checks without an explicit `return undefined`.
  handler(): boolean | void
}>

export type YoloModuleFileViewContextV1 = Readonly<{
  /** View content root, already attached to the leaf; build all DOM inside it. */
  contentEl: HTMLElement
  getFile(): YoloModuleFileViewFileV1 | null
  /** Popout-safe: always the document/window currently owning contentEl. */
  getDocument(): Document
  getWindow(): Window
  /** Debounced persist; host serializes via instance.getViewData(). */
  requestSave(): void
  /**
   * Register hotkeys that are live only while this view's leaf is the active
   * one (Obsidian's `View.scope`; popout-safe). Returns a disposer.
   *
   * View-scoped rather than app-wide on purpose: a view's keys are about the
   * thing the user is looking at. Bindings pushed above the whole app stay
   * armed after the user clicks into another leaf, which turns an innocent
   * Delete or Mod+Z somewhere else into an edit of a file they are not even
   * looking at.
   *
   * Registrations from separate calls coexist on one scope, and Obsidian
   * resolves a key bound twice to whichever binding was registered *first* —
   * a later registration cannot shadow an earlier one, so overlapping keys
   * are the caller's to keep apart. Keys the handlers do not consume fall
   * through to Obsidian.
   */
  registerKeymap(bindings: readonly YoloModuleKeymapBindingV1[]): ModuleDisposer
}>

export type YoloModuleFileViewInstanceV1 = Readonly<{
  /** TextFileView semantics: clear=true when a different file loads. May run
   * before the DOM is visible and repeatedly (external modify); must be
   * idempotent. */
  setViewData(data: string, clear: boolean): void
  /** Must reflect live editing state without requiring blur first. */
  getViewData(): string
  clear(): void
  onResize?(): void
  /** Release all DOM, listeners, observers, rAF. Called on view close and on
   * window migration (host rebuilds via factory afterwards). */
  dispose(): void
}>

export type YoloModuleFileViewV1 = Readonly<{
  /** Workspace view type id, unique across the app. */
  viewType: string
  /** File extensions without leading dot, e.g. ['yoloboard']. */
  extensions: readonly string[]
  name: LocalizedTextV1
  icon: string
  factory(context: YoloModuleFileViewContextV1): YoloModuleFileViewInstanceV1
}>

export type YoloModuleFileMenuActionV1 = Readonly<{
  id: string
  title: LocalizedTextV1
  icon: string
  appliesTo: 'file' | 'folder'
  /** For 'file' targets: show only for these extensions (no dot). Ignored
   * for folders. */
  extensions?: readonly string[]
  onSelect(entry: YoloModuleVaultEntryV1): void | Promise<void>
}>

export type YoloModuleWorkspaceV1 = {
  registerView(view: YoloModuleViewV1): void
  registerRibbonAction(action: YoloModuleRibbonActionV1): void
  registerCommand(command: YoloModuleCommandV1): void
  registerFileView(view: YoloModuleFileViewV1): void
  registerFileMenuAction(action: YoloModuleFileMenuActionV1): void
  openView(options?: YoloModuleOpenViewOptionsV1): Promise<void>
}

export type YoloModuleBackgroundActivityStatusV1 =
  | 'running'
  | 'waiting'
  | 'failed'
  | 'reminder'

export type YoloModuleBackgroundActivityV1 = Readonly<{
  id: string
  title: string
  detail?: string
  summary?: string
  icon?: string
  status: YoloModuleBackgroundActivityStatusV1
  onOpen?: () => void | Promise<void>
}>

export type YoloModuleBackgroundV1 = {
  upsert(activity: YoloModuleBackgroundActivityV1): void
  remove(id: string): void
}

export type YoloModuleAgentCapabilityV1 = 'none' | 'vault-read' | 'vault-write'

export type YoloModuleAgentMessageV1 =
  | Readonly<{
      role: 'user'
      id: string
      content: string
    }>
  | Readonly<{
      role: 'assistant'
      id: string
      content: string
    }>

export type YoloModuleAgentActivityV1 = Readonly<{
  title: string
  detail?: string
}>

export type YoloModuleAgentToolResultV1 = Readonly<{
  /** Text returned to the model. */
  content: string
  /** True when the call failed (e.g. validation) — the model should self-correct. */
  isError?: boolean
}>

export type YoloModuleAgentToolV1 = Readonly<{
  /** Must match `^[a-z][a-z0-9_]*$` and be unique within the request's `tools`. */
  name: string
  description: string
  /** JSON Schema object describing the tool's input. */
  inputSchema: Record<string, unknown>
  /**
   * Invoked serially per run in arrival order: a handler starts only after
   * the previous handler (across all of the run's tools) has settled, even
   * when the model issues multiple tool calls in one turn. Handlers may
   * therefore safely read-modify-write run-scoped state.
   */
  handler: (
    input: Record<string, unknown>,
  ) => Promise<YoloModuleAgentToolResultV1> | YoloModuleAgentToolResultV1
}>

export type YoloModuleAgentRequestV1 = Readonly<{
  prompt?: string
  messages?: readonly YoloModuleAgentMessageV1[]
  modelId?: string
  systemPrompt: string
  capability: YoloModuleAgentCapabilityV1
  workspaceScope?: Readonly<{
    enabled: boolean
    include: readonly string[]
    exclude: readonly string[]
  }>
  activity?: YoloModuleAgentActivityV1
  /**
   * Custom tools scoped to this run only. Registered as an in-process MCP
   * server for the run's lifetime and torn down when it settles. Up to 16.
   */
  tools?: readonly YoloModuleAgentToolV1[]
  signal?: AbortSignal
}>

export type YoloModuleAgentEventV1 =
  | Readonly<{ type: 'text'; text: string; delta: string }>
  | Readonly<{
      type: 'tool'
      name: string
      status:
        | 'pending'
        | 'running'
        | 'completed'
        | 'error'
        | 'awaiting_approval'
      arguments?: Readonly<Record<string, unknown>>
    }>
  | Readonly<{ type: 'completed'; text: string }>
  | Readonly<{ type: 'aborted' }>
  | Readonly<{ type: 'error'; message: string }>

export type YoloModuleAgentV1 = {
  stream(
    request: YoloModuleAgentRequestV1,
  ): AsyncIterable<YoloModuleAgentEventV1>
}

export type YoloModuleChatModeToolV1 = YoloModuleAgentToolV1 &
  Readonly<{
    /**
     * true = every call requires user approval (allow/deny), fixed at tool
     * call creation time as part of the call's persisted metadata — YOLO,
     * "always allow for this conversation", and session-resume replay can
     * never bypass it. Used for hard-confirmation tools (e.g. an outline
     * confirmation gate). Default false (auto-approved, subject to the
     * mode's ordinary approval policy).
     */
    requiresApproval?: boolean
  }>

export type YoloModuleChatModeV1 = Readonly<{
  /** Mode-local id, `^[a-z][a-z0-9-]*$`; the host assembles the full runtime
   * id as `module:<moduleId>:<id>`. */
  id: string
  label: LocalizedTextV1
  description?: LocalizedTextV1
  /** lucide icon name (Obsidian `setIcon` vocabulary); falls back to a
   * generic icon when absent or unrecognized. */
  icon?: string
  /** Mode persona, injected into the system prompt in place of assistant
   * instructions. */
  personaPrompt: string
  /** Built-in host tool tier, shared with the module agent capability;
   * `vault-read` carries a structural read-only constraint. */
  capability: YoloModuleAgentCapabilityV1
  /** Mode-specific tools, registered as a persistent in-process tool server
   * for the lifetime of the mode's contribution. */
  tools?: readonly YoloModuleChatModeToolV1[]
  /**
   * Skill packages that apply within this mode. Each entry is the
   * artifact-relative path of a package's `SKILL.md` (e.g.
   * `skills/coach/SKILL.md`); every `role: 'data'` file the verified manifest
   * declares inside that directory is part of the package. On activation the
   * host copies the package out of the (unindexed) plugin directory into
   * `<yolo base>/modules/<moduleId>/skills/<package>/`, so the skill and all
   * its resources behave exactly like an imported or hand-written Vault skill
   * package and are reachable by ordinary agent read tools. Effective only
   * while this mode is active: skills declared here are not visible in
   * ordinary (non-module) chat modes, and a same-named user/vault skill
   * always wins.
   */
  skills?: readonly string[]
}>

/**
 * Which settings-page group a tool set is listed under. Mirrors the host's
 * `BuiltinToolCategory` — a module tool set sits in the same three groups the
 * built-in capabilities do, because from the user's side it is one more thing
 * the assistant can reach for, not a separate species. Spelled as a literal
 * union rather than imported so the module-facing contract does not drag
 * `core/tools` into the SDK surface; `moduleToolSetRegistry.ts` asserts the
 * two stay in step.
 */
export type YoloModuleToolSetCategoryV1 = 'vault' | 'context' | 'external'

/**
 * A set of tools a module contributes to *ordinary* chat, for as long as the
 * module is active — unlike `YoloModuleChatModeV1.tools`, which are reachable
 * only while the user has that mode selected.
 *
 * The tools are registered as one in-process tool server named `yolo_<id>`,
 * so they are addressed, listed, and toggled exactly the way MCP tools are.
 * They ride the deferred tier by default: the model sees their names in the
 * system-prompt catalog and loads a schema only when it reaches for one, so
 * an optional module costs a user who never uses it a handful of names rather
 * than a handful of schemas.
 *
 * No approval knob: a module tool set's safety comes from being undoable, not
 * from a confirmation on every call (docs/plans/09-03-whiteboard-agent-tools
 * Q13). Tools whose every call must be confirmed belong to a chat mode, whose
 * `requiresApproval` is unconditional.
 */
export type YoloModuleToolSetV1 = Readonly<{
  /**
   * Set-local id, `^[a-z][a-z0-9_]*$`. The host addresses the set as
   * `yolo_<id>` and it must be unique across every active module — the id is
   * part of a fully-qualified tool name, which is a public contract with the
   * model, so it cannot be namespaced by module behind the user's back.
   */
  id: string
  label: LocalizedTextV1
  /** One line about the whole set, shown as the catalog group heading and in
   * settings. Costs O(sets), never O(tools) — which is why the catalog gives
   * a set a description and a tool only its name. */
  description?: LocalizedTextV1
  category: YoloModuleToolSetCategoryV1
  tools: readonly YoloModuleAgentToolV1[]
}>

/**
 * How a module-owned file format reads to a *model* — the text `fs_read`
 * returns for it and the text an @mention injects, in place of its raw bytes.
 *
 * Registered per extension, because that is how the host's read paths already
 * dispatch (a PDF goes through text extraction, an Office document through
 * its own extractor). A module-owned format simply adds a source to that
 * table: the host still reads the bytes and enforces the size limits, and the
 * module supplies only the transform.
 *
 * `content` is the file's raw text. The returned string is what the model
 * sees, so it should be the *summary* form — for a format whose file is large
 * and mostly machine state, returning the raw text back is the one answer
 * that helps nobody.
 */
export type YoloModuleFileTextRendererV1 = Readonly<{
  /** Extensions without a leading dot, e.g. ['yoloboard']. */
  extensions: readonly string[]
  render(
    file: Readonly<{ path: string; content: string }>,
  ): string | Promise<string>
}>

export type YoloModuleChatV1 = Readonly<{
  registerMode(mode: YoloModuleChatModeV1): void
  registerToolSet(set: YoloModuleToolSetV1): void
  /** Returns a disposer; also revoked automatically when the module unloads. */
  registerFileTextRenderer(
    renderer: YoloModuleFileTextRendererV1,
  ): ModuleDisposer
}>

export type YoloModulePathsSnapshotV1 = Readonly<{
  contentRoot: string
}>

export type YoloModuleLocaleSnapshotV1 = Readonly<{ locale: string }>

export type YoloModuleI18nV1 = Readonly<{
  getSnapshot(): YoloModuleLocaleSnapshotV1
  subscribe(listener: () => void): ModuleDisposer
}>

export type YoloModulePathsV1 = {
  getSnapshot(): YoloModulePathsSnapshotV1
  subscribe(listener: () => void): ModuleDisposer
  /**
   * Serializes module-managed data access for this module and namespace.
   * The callback starts after lock acquisition and must not reacquire the same
   * namespace before it settles.
   */
  runExclusive<T>(
    namespace: string,
    operation: () => T | PromiseLike<T>,
  ): Promise<T>
}

export type YoloModuleAssetsV1 = Readonly<{
  readText(path: string): Promise<string>
  readArrayBuffer(path: string): Promise<ArrayBuffer>
  createBlobUrl(path: string): Promise<string>
}>

export type YoloModuleConfirmOptionsV1 = Readonly<{
  title: string
  message: string
  ctaText?: string
  cancelText?: string
}>

export type YoloModuleActionToastV1 = Readonly<{
  id: string
  tone: 'success' | 'warning' | 'error'
  title: string
  message: string
  actionLabel: string
  dismissLabel: string
  onAction(): void | Promise<void>
}>

export type YoloModuleOpenFileLocationV1 = Readonly<{
  path: string
  line?: number
  column?: number
  newLeaf?: boolean
}>

export type YoloModuleMarkdownRendererV1 = {
  render(
    markdown: string,
    container: HTMLElement,
    sourcePath: string,
  ): Promise<void>
  unload(): void
}

export type YoloModuleMarkdownContentViewOptionsV1 = Readonly<{
  container: HTMLElement
  /**
   * The vault path this content belongs to: what `[[links]]` and embeds inside
   * it resolve against. It does not have to be the file the text is stored in,
   * or a Markdown file at all — content that lives inside some other document
   * (a card stored in a board, say) passes that document's path, exactly as
   * `YoloModuleMarkdownEditorOptionsV1` does.
   */
  sourcePath: string
  value: string
}>

/**
 * A read-only Markdown surface for a whole document.
 *
 * Obsidian's own preview: it keeps only the sections around the scroll
 * position mounted and fakes the height of the rest, so a container holding a
 * five-thousand-line note costs what one screenful of it costs. That is the
 * whole reason it exists next to `createMarkdownRenderer`, which renders a
 * fragment in one pass and is the right tool for a fragment.
 *
 * Nothing about the windowing reaches the module — no resize hook, no scroll
 * hook. The view watches its own container and re-picks its window when the
 * size changes; a module that had to remember to call back would be a module
 * that could forget.
 */
export type YoloModuleMarkdownContentViewV1 = {
  setValue(text: string): void
  /**
   * Where the view is scrolled to, as a fractional source line: 12.5 is line
   * 12, half of it above the top edge.
   *
   * The document's own coordinate rather than either surface's pixels, which
   * is what makes it portable — the same text is a different height rendered
   * than it is in an editor, so a scroll position handed across as pixels
   * lands somewhere else. See `YoloModuleMarkdownEditorV1`, which reads and
   * writes the same coordinate: a module swapping one surface for the other
   * carries the reading position over by passing this number along.
   */
  getScrollLine(): number
  /**
   * `onSettled` runs when the view is actually showing that line, which is
   * not when this returns: a preview that has not rendered yet has no
   * measured sections to find the line among, so it stays where it is and
   * moves once the render lands, a frame or several later. A module mounting
   * a view that should open part-way down has to keep something over that
   * gap — otherwise the view paints the top of the document first — and this
   * is how it knows the gap is over.
   */
  scrollToLine(line: number, onSettled?: () => void): void
  destroy(): void
}

export type YoloModuleMarkdownEditorOptionsV1 = Readonly<{
  container: HTMLElement
  value: string
  /**
   * The vault path the content is written in the context of: what `[[links]]`
   * resolve against, where a pasted attachment is filed. It does not have to
   * be the file the text is stored in, or a Markdown file at all — content
   * that lives inside some other document passes that document's path.
   */
  sourcePath: string
  onChange?: (text: string) => void
  onBlur?: (text: string) => void
}>

/**
 * A live-preview Markdown editor: Obsidian's own, with its keymaps, link
 * completion, paste handling and rendered formatting.
 *
 * Persistence is entirely the caller's — the editor never writes to the
 * vault, not even when `sourcePath` names a real file. Content reaches the
 * module through `onChange`/`onBlur` and it decides what to do with it.
 */
export type YoloModuleMarkdownEditorV1 = {
  getValue(): string
  setValue(text: string): void
  focus(): void
  blur(): void
  hasFocus(): boolean
  /** The same fractional source line as `YoloModuleMarkdownContentViewV1`. */
  getScrollLine(): number
  /**
   * Opens the editor on `line`: puts it at the top of the view *and* the caret
   * on it — or on the nearest line below it that is not a rendered widget.
   * The caret is half of it — left where a fresh editor puts it, at the start
   * of the document, the first keystroke scrolls the view back there.
   */
  openAtLine(line: number): void
  destroy(): void
}

export type YoloModuleHoverLinkOptionsV1 = Readonly<{
  event: MouseEvent
  targetEl: HTMLElement
  linktext: string
  sourcePath: string
}>

/**
 * One entry in a module-requested context menu. A separator carries nothing
 * else; an item is pure data — a module never touches a menu object, so the
 * menu's lifetime, keyboard layering, and owning window all stay with the
 * host (see `YoloModuleUiV1.showMenu`).
 */
export type YoloModuleMenuItemV1 =
  | Readonly<{
      kind?: 'item'
      /** Already localized: the module resolves its own locale at call time. */
      title: string
      icon?: string
      onSelect(): void | Promise<void>
    }>
  | Readonly<{ kind: 'separator' }>

export type YoloModuleUiV1 = {
  notice(message: string): void
  showActionToast(toast: YoloModuleActionToastV1): void
  confirm(options: YoloModuleConfirmOptionsV1): Promise<boolean>
  /**
   * Renders a Markdown *fragment* into a container, in one pass.
   *
   * For a whole document — anything that can grow past a screenful — use
   * `createMarkdownContentView` instead: this one keeps everything it renders
   * in the DOM.
   */
  createMarkdownRenderer(): YoloModuleMarkdownRendererV1
  /**
   * Mounts a windowed, read-only Markdown preview into `options.container` —
   * see `YoloModuleMarkdownContentViewV1`.
   *
   * Obsidian does not publish the component that carries the windowing, so
   * this throws when a future Obsidian no longer exposes it. As with
   * `createMarkdownEditor` there is deliberately nothing degraded behind it.
   */
  createMarkdownContentView(
    options: YoloModuleMarkdownContentViewOptionsV1,
  ): YoloModuleMarkdownContentViewV1
  /**
   * Mounts an editable, live-preview Markdown editor into `options.container`.
   *
   * The counterpart to `createMarkdownRenderer` for content the user edits in
   * place. It is Obsidian's own editor rather than a plain text area, so it
   * carries the whole editing experience — rendered formatting, `[[` link
   * completion, the user's keymaps and editor settings, paste handling — none
   * of which a module could reproduce and all of which users expect anywhere
   * they type Markdown inside Obsidian.
   *
   * Reaching Obsidian's editor requires an API it does not publish, so this
   * throws when a future Obsidian no longer exposes it. There is deliberately
   * no degraded editor behind it: a fallback nobody exercises is a fallback
   * that does not work, and a module silently dropping to a worse editor hides
   * exactly the breakage we need to see.
   */
  createMarkdownEditor(
    options: YoloModuleMarkdownEditorOptionsV1,
  ): YoloModuleMarkdownEditorV1
  htmlToMarkdown(html: string): string
  isModEvent(event: MouseEvent): boolean
  /**
   * Opens a native context menu at the given mouse event's position.
   *
   * The event is required rather than a coordinate pair because it is also
   * what tells the host which window the menu belongs to — a module view can
   * live in an Obsidian popout, which has its own document, and a module that
   * computed its own coordinates would sooner or later open the menu on the
   * wrong screen. Menus opened this way are closed when the module deactivates.
   */
  showMenu(event: MouseEvent, items: readonly YoloModuleMenuItemV1[]): void
  /**
   * Resolves a drop event into the vault entries it carries, or an empty list
   * when it carries none.
   *
   * A drag that started inside Obsidian leaves no usable vault path in the
   * `DataTransfer`; the authoritative source is Obsidian's private drag
   * state, which a module can never reach on its own. Returning vault
   * entries rather than raw drag data is also what keeps this surface stable:
   * when dropping a file from outside the vault becomes supported, the host
   * can import it and return it as an entry, with no change on the module
   * side. Files from outside the vault currently resolve to nothing.
   */
  resolveDropEntries(event: DragEvent): readonly YoloModuleVaultEntryV1[]
  openLink(
    linktext: string,
    sourcePath: string,
    newLeaf?: boolean,
  ): Promise<void>
  openFileAt(location: YoloModuleOpenFileLocationV1): Promise<boolean>
  hoverLink(options: YoloModuleHoverLinkOptionsV1): void
}

export type YoloModuleVaultFileV1 = Readonly<{
  kind: 'file'
  path: string
  name: string
  ctime: number
  mtime: number
}>

export type YoloModuleVaultFolderV1 = Readonly<{
  kind: 'folder'
  path: string
  name: string
}>

export type YoloModuleVaultEntryV1 =
  | YoloModuleVaultFileV1
  | YoloModuleVaultFolderV1

export type YoloModuleVaultEventV1 =
  | Readonly<{
      type: 'create' | 'modify' | 'delete'
      entry: YoloModuleVaultEntryV1
    }>
  | Readonly<{
      type: 'rename'
      entry: YoloModuleVaultEntryV1
      oldPath: string
    }>

export type YoloModuleVaultWrittenFileV1 = Readonly<{
  path: string
  mtime: number
}>

export type YoloModuleVaultTextSnapshotV1 = Readonly<{
  path: string
  content: string
}>

export type YoloModuleVaultV1 = {
  getEntry(path: string): YoloModuleVaultEntryV1 | null
  listChildren(folderPath: string): readonly YoloModuleVaultEntryV1[]
  listMarkdownFiles(): readonly YoloModuleVaultFileV1[]
  stat(path: string): Promise<YoloModuleVaultEntryV1 | null>
  list(folderPath: string): Promise<readonly YoloModuleVaultEntryV1[]>
  exists(path: string): Promise<boolean>
  readText(filePath: string): Promise<string>
  readBinary(filePath: string): Promise<ArrayBuffer>
  /**
   * The URL that serves `filePath`'s bytes to the renderer — what an `<img>`,
   * `<audio>` or `<video>` in a module's UI points its `src` at.
   *
   * `readBinary` plus a blob URL would technically get there, but it copies
   * the whole file into memory and makes the module responsible for revoking
   * the URL; this hands out the same `app://` URL Obsidian's own embeds use,
   * so the media element streams and seeks exactly as it does in a note.
   *
   * Synchronous and total: it maps a path to a URL without touching the file,
   * so a path that does not exist simply yields a URL that 404s. Only the
   * usual path validation applies (vault-relative, no dot segments).
   */
  getResourceUrl(filePath: string): string
  /**
   * The file a wiki link names, read the way Obsidian reads it: `linktext` is
   * what stands between the brackets (a bare name, a partial path, with or
   * without an extension, with or without a `#heading` after it), and it is
   * resolved against `sourcePath` — the document the link is written in — by
   * the same shortest-path rules the editor's autocomplete uses.
   *
   * Null means the link points at nothing, which is a real answer and the
   * reason this exists: a module rendering Markdown itself has the markup for
   * a link but not a view's knowledge of whether it leads anywhere, and an
   * unresolved link that is not shown as unresolved is a lie about the vault.
   *
   * Synchronous, off Obsidian's own link index. Nothing is created, opened,
   * or read.
   */
  resolveLink(
    linktext: string,
    sourcePath: string,
  ): YoloModuleVaultFileV1 | null
  ensureFolder(folderPath: string): Promise<void>
  createFolder(folderPath: string): Promise<void>
  createText(
    filePath: string,
    content: string,
  ): Promise<YoloModuleVaultWrittenFileV1>
  createBinary(filePath: string, content: ArrayBuffer): Promise<void>
  writeText(
    filePath: string,
    content: string,
  ): Promise<YoloModuleVaultWrittenFileV1>
  renamePath(oldPath: string, newPath: string): Promise<void>
  trashPath(path: string): Promise<boolean>
  removeFileExact(path: string): Promise<boolean>
  removeEmptyFolderExact(path: string): Promise<boolean>
  readTextSnapshot(
    filePath: string,
  ): Promise<YoloModuleVaultTextSnapshotV1 | null>
  createTextIfAbsent(
    filePath: string,
    content: string,
  ): Promise<YoloModuleVaultTextSnapshotV1 | null>
  replaceTextIfUnchanged(
    expected: YoloModuleVaultTextSnapshotV1,
    content: string,
  ): Promise<YoloModuleVaultTextSnapshotV1 | null>
  revertOwnedCreatedTextIfUnchanged(
    created: YoloModuleVaultTextSnapshotV1,
    expected: YoloModuleVaultTextSnapshotV1,
    fallbackContent: string,
  ): Promise<YoloModuleVaultTextSnapshotV1 | null>
  subscribe(
    scopePath: string,
    listener: (event: YoloModuleVaultEventV1) => void | Promise<void>,
  ): ModuleDisposer
}

export type YoloModuleCapabilitiesV1 = Readonly<{
  agent: YoloModuleAgentV1
  assets: YoloModuleAssetsV1
  background: YoloModuleBackgroundV1
  chat: YoloModuleChatV1
  config: ModuleConfigV1
  i18n: YoloModuleI18nV1
  paths: YoloModulePathsV1
  privateStorage: ModulePrivateStorageV1
  settings: YoloModuleSettingsV1
  ui: YoloModuleUiV1
  vault: YoloModuleVaultV1
  workers: YoloModuleWorkersV1
}>

export type YoloHostApiV1 = Readonly<{
  version: 1
  lifecycle: YoloModuleLifecycle
  workspace: YoloModuleWorkspaceV1
}> &
  YoloModuleCapabilitiesV1

export type YoloModuleDefinition = {
  id: string
  activate(host: YoloHostApiV1): void | Promise<void>
}

/** The only runtime object made available to a module entry script. */
export type YoloModuleRuntimeRegistration = {
  registerModule(definition: YoloModuleDefinition): void
}

export type YoloModuleEntry = {
  id: string
  byteSize: number
  sha256: string
}

export type ModuleStatus =
  | 'available'
  | 'installed'
  | 'active'
  | 'disabled'
  | 'update-available'
  | 'activation-pending'
  | 'failed'

export type ModuleCompatibilityIssue = Readonly<{
  kind: 'platform' | 'host-api' | 'data-schema'
}>

export type ModuleCatalogEntry = {
  id: string
  version: string
  icon?: string
  name?: string
  description?: string
  releaseNotes?: Readonly<{
    url: string
    byteSize: number
    sha256: string
  }>
  compatibilityIssues?: readonly ModuleCompatibilityIssue[]
}

export type InstalledModuleState = {
  id: string
  version: string
  pendingVersion?: string
  active?: boolean
  disabled?: boolean
  error?: string
}

export type ModuleCatalogSource = {
  load(): Promise<ReadonlyArray<ModuleCatalogEntry>>
}

export type InstalledModuleStateSource = {
  load(): Promise<ReadonlyArray<InstalledModuleState>>
}

export type ModuleIntentState = Readonly<{
  id: string
  state: 'uninstalled' | 'disabled' | 'enabled'
}>

export type ModuleIntentStateSource = {
  load(
    moduleIds: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<ModuleIntentState>>
}

export type ModuleRecord = Readonly<{
  id: string
  name: string
  description: string
  version: string
  availableVersion?: string
  pendingVersion?: string
  error?: string
  failure?: ModuleFailure
  compatibilityIssues?: readonly ModuleCompatibilityIssue[]
  status: ModuleStatus
  desiredInstalled?: boolean
  enabled?: boolean
  catalog?: Readonly<ModuleCatalogEntry>
  installed?: Readonly<InstalledModuleState>
}>

export type ModuleManagerStatus = 'loading' | 'ready' | 'error'

export type ModuleManagerSnapshot = Readonly<{
  status: ModuleManagerStatus
  modules: ReadonlyArray<ModuleRecord>
  errors: Readonly<{
    catalog?: string
    installed?: string
    intent?: string
  }>
  error?: string
}>
