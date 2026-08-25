// The `.yoloboard` file view's canvas: camera pan/zoom, viewport
// virtualization, and the note/text card static-preview <-> live-editor
// lifecycle (docs/plans/08-25-yolo-whiteboard/p1-design.md §3). Ported from
// the S2/S3 spikes' `WhiteboardFileView` (`git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/fileView.ts`) and
// translated from direct Obsidian API calls (`TextFileView`,
// `MarkdownRenderer`, `app.keymap`) to the Host API surface a module is
// actually allowed to use (Module Boundaries, CLAUDE.md) — `YoloModuleHostApiV1`
// and `YoloModuleHostFileViewContextV1`, both declared globally by
// `modules/host-sdk.d.ts`.
//
// Deliberately DOM-heavy and imperative rather than React (p1-design's task
// brief: "画布主体建议直接 DOM 命令式实现（spike 同款，性能路径更可控）") — a
// rAF loop driving virtualization mount/unmount at a few hundred cards a
// frame is not a good fit for a vdom diff.
//
// Popout safety: every DOM node, listener, timer, and rAF call goes through
// `this.context.getDocument()` / `this.context.getWindow()`, never the
// global `document`/`window` (Popout / Multi-window, CLAUDE.md) — this view
// must keep working when its leaf is dragged into an Obsidian popout
// BrowserWindow, which has its own realm.

import { cameraFromView, dragPan, panByWheel, viewFromCamera, zoomAtPoint } from '../domain/camera'
import { planCardCommit } from '../domain/commit'
import {
  type Board,
  type BoardCard,
  type BoardParseIssue,
  type CardId,
  emptyBoard,
  parseBoard,
  serializeBoard,
} from '../domain/fileFormat'
import { type CanvasView, VirtualizationEngine, computeWorldViewportRect } from '../domain/virtualization'
import { createWhiteboardTranslation } from '../i18n'

import {
  CAMERA_SETTLE_MS,
  INTERACTING_CLASS_TIMEOUT_MS,
  MOUNT_QUOTA_PER_FRAME,
  RECOMPUTE_INTERVAL_MS,
  SCALE_BOUNDS,
  UNMOUNT_QUOTA_PER_FRAME,
  VIEWPORT_BUFFER_PX,
} from './constants'
import { type WhiteboardEditorHandle, mountWhiteboardEditor } from './editor'

const ROOT_CLASS = 'yolo-whiteboard-root'
const VIEWPORT_CLASS = 'yolo-whiteboard-viewport'
const VIEWPORT_HIDDEN_CLASS = 'yolo-whiteboard-viewport-hidden'
const VIEWPORT_PANNING_CLASS = 'yolo-whiteboard-viewport-panning'
const WORLD_CLASS = 'yolo-whiteboard-world'
const WORLD_INTERACTING_CLASS = 'yolo-whiteboard-world-interacting'
const CARD_CLASS = 'yolo-whiteboard-card'
const CARD_EDITING_CLASS = 'yolo-whiteboard-card-editing'
const CARD_BODY_CLASS = 'yolo-whiteboard-card-body'
const CARD_MISSING_CLASS = 'yolo-whiteboard-card-missing'
const CARD_PDF_PLACEHOLDER_CLASS = 'yolo-whiteboard-card-pdf-placeholder'
const CARD_HINT_CLASS = 'yolo-whiteboard-card-hint'
const EDITOR_HOST_CLASS = 'yolo-whiteboard-editor-host'
const ERROR_CLASS = 'yolo-whiteboard-error'
const ERROR_VISIBLE_CLASS = 'yolo-whiteboard-error-visible'
const ERROR_TITLE_CLASS = 'yolo-whiteboard-error-title'
const ERROR_HINT_CLASS = 'yolo-whiteboard-error-hint'
const PREHEAT_CLASS = 'yolo-whiteboard-preheat'

type CardRuntime = {
  el: HTMLElement | null
  bodyEl: HTMLElement | null
  renderer: ReturnType<YoloModuleHostApiV1['ui']['createMarkdownRenderer']> | null
  missingFile: boolean
  /** Last known content for a *note* card (its backing file's text), cached
   * because note-card content never lives in `board` (p1-design §1.2) — this
   * is the only place it's available to seed the live editor. Unused for
   * text/pdf cards. */
  noteText: string | null
}

type DragState = Readonly<{
  origin: CanvasView
  startX: number
  startY: number
}>

type EditingState = Readonly<{
  cardId: CardId
  editor: WhiteboardEditorHandle
  scopeDisposer: () => void
}>

/**
 * One instance per open leaf (and re-created on popout window migration —
 * see the `dispose()`/constructor doc comments). Implements the DOM/camera/
 * card-lifecycle behavior behind the thin `YoloModuleFileViewInstanceV1`
 * wrapper built in `src/index.tsx`.
 */
export class WhiteboardCanvas {
  private board: Board = emptyBoard()
  private boardCardsById = new Map<CardId, BoardCard>()
  private readonly runtimeByCardId = new Map<CardId, CardRuntime>()
  private readonly engine = new VirtualizationEngine()
  private readonly pinnedIds = new Set<CardId>()

  private view: CanvasView = { tx: 0, ty: 0, scale: 1 }
  private dragState: DragState | null = null
  private editing: EditingState | null = null

  private lastRawData = ''
  private parseFailed = false

  private domReady = false
  private rootEl: HTMLElement | null = null
  private viewportEl!: HTMLElement
  private worldEl!: HTMLElement
  private errorEl: HTMLElement | null = null

  private rafId: number | null = null
  private interactingTimer: number | null = null
  private settleTimer: number | null = null
  private lastRecomputeTime = 0

  constructor(
    private readonly context: YoloModuleHostFileViewContextV1,
    private readonly host: YoloModuleHostApiV1,
  ) {}

  // -----------------------------------------------------------------------
  // YoloModuleFileViewInstanceV1 surface (src/index.tsx wires these 1:1).
  // -----------------------------------------------------------------------

  /**
   * TextFileView-style contract: must be idempotent and safe to call
   * repeatedly (host doc: "May run before the DOM is visible and
   * repeatedly (external modify); must be idempotent"). M1 doesn't
   * implement a smooth incremental refresh on external modify (out of
   * scope per p1-design §6 M1 — "modify 重渲染" ships in a later
   * milestone), so both `clear=true` and `clear=false` do the same full
   * rebuild from the freshly parsed board; the `clear` flag itself carries
   * no distinct meaning yet.
   */
  setViewData(data: string, _clear: boolean): void {
    this.ensureDom()
    this.lastRawData = data
    const result = parseBoard(data)
    this.teardownAllCards()

    if (!result.ok) {
      this.parseFailed = true
      this.board = emptyBoard()
      this.boardCardsById = new Map()
      this.showError(result.issues)
      return
    }

    this.parseFailed = false
    this.board = result.board
    this.syncBoardIndex()
    this.view = viewFromCamera(this.board.camera)
    this.applyTransform()
    this.showCanvas()
    this.recomputeVisibility()
    this.drainQueues()
  }

  /**
   * Must reflect live editing state without requiring blur first (host doc
   * comment on `YoloModuleFileViewInstanceV1.getViewData`). Folds in two
   * things that may not have been committed to `this.board` yet:
   *  - the live camera, even mid-gesture (before its settle debounce fires —
   *    see `commitCameraNow`) — otherwise a quick pan-then-close could lose
   *    the camera position, since the host reads `getViewData()` to snapshot
   *    final state *before* calling `dispose()` (see that method's doc
   *    comment), i.e. before any settle timer would have run;
   *  - the active card's live editor text, via the same `planCardCommit`
   *    decision the actual commit path uses, without performing its write
   *    side effects (a note card's live text isn't part of the board at all
   *    — p1-design §1.2 — so there is nothing to fold in for that case; only
   *    a text card's `updateBoard` outcome affects serialization here).
   */
  getViewData(): string {
    if (this.parseFailed) return this.lastRawData
    let board = this.board
    const camera = cameraFromView(this.view)
    if (camera.x !== board.camera.x || camera.y !== board.camera.y || camera.scale !== board.camera.scale) {
      board = { ...board, camera }
    }
    if (this.editing) {
      const liveText = this.editing.editor.view.state.doc.toString()
      const action = planCardCommit(board, this.editing.cardId, liveText)
      if (action.kind === 'updateBoard') board = action.board
    }
    return serializeBoard(board)
  }

  /** About to load a different file into this leaf. */
  clear(): void {
    this.teardownAllCards()
    this.board = emptyBoard()
    this.boardCardsById = new Map()
    this.parseFailed = false
    this.lastRawData = ''
  }

  onResize(): void {
    if (this.parseFailed) return
    this.recomputeVisibility()
    this.drainQueues()
  }

  /**
   * Called on view close AND on popout window migration (host rebuilds via
   * `factory()` afterwards and replays `setViewData`) — must release
   * everything, and must not lose an in-progress edit in the process. A
   * note card's live text has no other persistence path (unlike a text
   * card's, which `getViewData()` already captures independently), so
   * committing here is what prevents a mid-edit popout drag or leaf close
   * from silently discarding typed text.
   */
  dispose(): void {
    this.forceCommitActiveEdit()
    const win = this.context.getWindow()
    if (this.rafId !== null) {
      win.cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.interactingTimer !== null) {
      win.clearTimeout(this.interactingTimer)
      this.interactingTimer = null
    }
    if (this.settleTimer !== null) {
      win.clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    this.viewportEl?.removeEventListener('pointerdown', this.onPointerDown)
    this.viewportEl?.removeEventListener('wheel', this.onWheel)
    win.removeEventListener('pointermove', this.onPointerMove)
    win.removeEventListener('pointerup', this.onPointerUp)

    this.teardownAllCards()
    this.rootEl?.remove()
    this.rootEl = null
    this.errorEl = null
    this.domReady = false
  }

  // -----------------------------------------------------------------------
  // DOM setup
  // -----------------------------------------------------------------------

  private ensureDom(): void {
    if (this.domReady) return
    const doc = this.context.getDocument()

    const root = doc.createElement('div')
    root.className = ROOT_CLASS

    const viewport = doc.createElement('div')
    viewport.className = VIEWPORT_CLASS
    const world = doc.createElement('div')
    world.className = WORLD_CLASS
    viewport.appendChild(world)
    root.appendChild(viewport)

    const error = doc.createElement('div')
    error.className = ERROR_CLASS
    root.appendChild(error)

    this.context.contentEl.replaceChildren(root)

    this.rootEl = root
    this.viewportEl = viewport
    this.worldEl = world
    this.errorEl = error

    this.setupInteraction()
    this.preheat()

    this.lastRecomputeTime = 0
    this.engine.reset()
    this.rafId = this.context.getWindow().requestAnimationFrame(this.frame)
    this.domReady = true
  }

  private setupInteraction(): void {
    const win = this.context.getWindow()
    this.viewportEl.addEventListener('pointerdown', this.onPointerDown)
    win.addEventListener('pointermove', this.onPointerMove)
    win.addEventListener('pointerup', this.onPointerUp)
    this.viewportEl.addEventListener('wheel', this.onWheel, { passive: false })
  }

  /**
   * Warms up the host's markdown rendering pipeline once per view instance
   * (p1-design §3: "视图打开时用不可见卡预热渲染管线（S2 首卡 335ms 冷启
   * 动）") — renders into an off-screen (not `display:none`, so layout/
   * measurement work isn't skipped) element, then discards it.
   */
  private preheat(): void {
    if (!this.rootEl) return
    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = PREHEAT_CLASS
    this.rootEl.appendChild(el)
    const renderer = this.host.ui.createMarkdownRenderer()
    void renderer
      .render('_', el, this.sourcePathForBoard())
      .catch((error: unknown) => this.reportError('preheat render', error))
      .finally(() => {
        renderer.unload()
        el.remove()
      })
  }

  // -----------------------------------------------------------------------
  // Camera: pointer-drag pan (left-drag from empty canvas, or middle-drag
  // from anywhere) + wheel (plain = two-axis pan, ctrl/cmd = cursor-anchored
  // zoom — the ctrl/cmd-wheel signature is also how Chrome/Safari report
  // trackpad pinch gestures, so this one branch covers both per p1-design
  // §3). Interaction only ever touches `this.view` + the world element's
  // `transform` directly (no reflow); the camera is folded into `board` and
  // persisted only once the gesture settles (see `scheduleCameraSettle`).
  // -----------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.parseFailed) return
    const target = e.target
    const onCard = target instanceof Element && target.closest(`.${CARD_CLASS}`) !== null
    if (e.button === 1) {
      // Middle-click always pans, even starting from a card.
      e.preventDefault()
    } else if (e.button !== 0 || onCard) {
      return
    }
    this.dragState = { origin: { ...this.view }, startX: e.clientX, startY: e.clientY }
    this.viewportEl.classList.add(VIEWPORT_PANNING_CLASS)
    this.viewportEl.setPointerCapture(e.pointerId)
    this.markInteracting()
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragState) return
    this.view = dragPan(
      this.dragState.origin,
      { x: this.dragState.startX, y: this.dragState.startY },
      { x: e.clientX, y: e.clientY },
    )
    this.applyTransform()
    this.markInteracting()
    this.scheduleCameraSettle()
  }

  private readonly onPointerUp = (): void => {
    if (!this.dragState) return
    this.dragState = null
    this.viewportEl.classList.remove(VIEWPORT_PANNING_CLASS)
    this.commitCameraNow()
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.parseFailed) return
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      const rect = this.viewportEl.getBoundingClientRect()
      const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      this.view = zoomAtPoint(this.view, cursor, e.deltaY, SCALE_BOUNDS)
    } else {
      this.view = panByWheel(this.view, e.deltaX, e.deltaY)
    }
    this.applyTransform()
    this.markInteracting()
    this.scheduleCameraSettle()
  }

  private applyTransform(): void {
    this.worldEl.style.transform = `translate(${this.view.tx}px, ${this.view.ty}px) scale(${this.view.scale})`
  }

  // will-change only while actively interacting (S1/S2 finding: a permanent
  // will-change wastes compositor memory for no benefit at rest).
  private markInteracting(): void {
    this.worldEl.classList.add(WORLD_INTERACTING_CLASS)
    const win = this.context.getWindow()
    if (this.interactingTimer !== null) win.clearTimeout(this.interactingTimer)
    this.interactingTimer = win.setTimeout(() => {
      this.worldEl.classList.remove(WORLD_INTERACTING_CLASS)
    }, INTERACTING_CLASS_TIMEOUT_MS)
  }

  private scheduleCameraSettle(): void {
    const win = this.context.getWindow()
    if (this.settleTimer !== null) win.clearTimeout(this.settleTimer)
    this.settleTimer = win.setTimeout(() => {
      this.settleTimer = null
      this.commitCameraNow()
    }, CAMERA_SETTLE_MS)
  }

  private commitCameraNow(): void {
    const win = this.context.getWindow()
    if (this.settleTimer !== null) {
      win.clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    if (this.parseFailed) return
    const camera = cameraFromView(this.view)
    const current = this.board.camera
    if (camera.x === current.x && camera.y === current.y && camera.scale === current.scale) {
      return
    }
    this.board = { ...this.board, camera }
    this.context.requestSave()
  }

  // -----------------------------------------------------------------------
  // Virtualization loop
  // -----------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    if (now - this.lastRecomputeTime > RECOMPUTE_INTERVAL_MS) {
      this.recomputeVisibility()
      this.lastRecomputeTime = now
    }
    this.drainQueues()
    this.rafId = this.context.getWindow().requestAnimationFrame(this.frame)
  }

  private recomputeVisibility(): void {
    if (this.parseFailed || !this.viewportEl) return
    const rect = computeWorldViewportRect(
      this.viewportEl.clientWidth,
      this.viewportEl.clientHeight,
      this.view,
      VIEWPORT_BUFFER_PX,
    )
    this.engine.recompute(this.board.cards, rect, this.pinnedIds)
  }

  private drainQueues(): void {
    const { toMount, toUnmount } = this.engine.drain(MOUNT_QUOTA_PER_FRAME, UNMOUNT_QUOTA_PER_FRAME)
    for (const id of toMount) this.mountCard(id)
    for (const id of toUnmount) this.unmountCard(id)
  }

  // -----------------------------------------------------------------------
  // Card mount/unmount
  // -----------------------------------------------------------------------

  private mountCard(id: CardId): void {
    const card = this.boardCardsById.get(id)
    const existing = this.runtimeByCardId.get(id)
    if (!card || existing?.el) return

    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = CARD_CLASS
    el.style.left = `${card.x}px`
    el.style.top = `${card.y}px`
    el.style.width = `${card.w}px`
    el.style.height = `${card.h}px`
    el.dataset.cardId = id

    const body = doc.createElement('div')
    body.className = CARD_BODY_CLASS
    el.appendChild(body)

    // Card dragging/selection isn't in M1 scope (p1-design §6); a plain
    // click is the only gesture a card handles, and only note/text cards
    // are editable.
    if (card.type !== 'pdf') {
      el.addEventListener('click', () => this.enterEditMode(id))
    }

    this.worldEl.appendChild(el)
    this.runtimeByCardId.set(id, {
      el,
      bodyEl: body,
      renderer: null,
      missingFile: false,
      noteText: existing?.noteText ?? null,
    })

    void this.renderCardPreview(id)
  }

  private unmountCard(id: CardId): void {
    const runtime = this.runtimeByCardId.get(id)
    if (!runtime?.el) return
    // A pinned (editing) card is never queued for unmount by the
    // virtualization engine, but stay defensive: only the commit path
    // (finishEdit) ever destroys a live editor.
    if (this.editing?.cardId === id) return
    runtime.renderer?.unload()
    runtime.renderer = null
    runtime.el.remove()
    runtime.el = null
    runtime.bodyEl = null
  }

  private async renderCardPreview(id: CardId): Promise<void> {
    const card = this.boardCardsById.get(id)
    const runtime = this.runtimeByCardId.get(id)
    if (!card || !runtime?.bodyEl) return

    if (card.type === 'pdf') {
      this.renderPdfPlaceholder(runtime)
      return
    }

    if (card.type === 'note') {
      const entry = this.host.vault.getEntry(card.file)
      if (!entry || entry.kind !== 'file') {
        runtime.missingFile = true
        runtime.noteText = null
        this.renderMissingFilePlaceholder(runtime, card.file)
        return
      }
      let text: string
      try {
        text = await this.host.vault.readText(card.file)
      } catch (error) {
        this.reportError('readText', error)
        if (this.runtimeByCardId.get(id) === runtime) {
          runtime.missingFile = true
          this.renderMissingFilePlaceholder(runtime, card.file)
        }
        return
      }
      if (this.runtimeByCardId.get(id) !== runtime) return // unmounted meanwhile
      runtime.missingFile = false
      runtime.noteText = text
      await this.renderMarkdownInto(id, runtime, text, card.file)
      return
    }

    // text card: markdown lives directly in the board.
    await this.renderMarkdownInto(id, runtime, card.markdown, this.sourcePathForBoard())
  }

  private async renderMarkdownInto(
    id: CardId,
    runtime: CardRuntime,
    markdown: string,
    sourcePath: string,
  ): Promise<void> {
    runtime.renderer?.unload()
    const renderer = this.host.ui.createMarkdownRenderer()
    runtime.renderer = renderer
    const doc = this.context.getDocument()
    const staging = doc.createElement('div')
    try {
      await renderer.render(markdown, staging, sourcePath)
    } catch (error) {
      this.reportError('markdown render', error)
    }
    // The card may have been unmounted, superseded by a newer render call,
    // or swapped into edit mode while the render above was in flight.
    const bodyEl = runtime.bodyEl
    const stale = runtime.renderer !== renderer || !bodyEl || this.editing?.cardId === id
    if (stale || !bodyEl) {
      renderer.unload()
      if (runtime.renderer === renderer) runtime.renderer = null
      return
    }
    bodyEl.replaceChildren(...Array.from(staging.childNodes))
  }

  private renderMissingFilePlaceholder(runtime: CardRuntime, path: string): void {
    runtime.renderer?.unload()
    runtime.renderer = null
    if (!runtime.bodyEl) return
    const doc = this.context.getDocument()
    const placeholder = doc.createElement('div')
    placeholder.className = CARD_MISSING_CLASS
    const title = doc.createElement('div')
    title.textContent = this.t('card.missingFile')
    const hint = doc.createElement('div')
    hint.className = CARD_HINT_CLASS
    hint.textContent = this.t('card.missingFileHint').replace('{path}', path)
    placeholder.append(title, hint)
    runtime.bodyEl.replaceChildren(placeholder)
  }

  private renderPdfPlaceholder(runtime: CardRuntime): void {
    runtime.renderer?.unload()
    runtime.renderer = null
    if (!runtime.bodyEl) return
    const doc = this.context.getDocument()
    const placeholder = doc.createElement('div')
    placeholder.className = CARD_PDF_PLACEHOLDER_CLASS
    const title = doc.createElement('div')
    title.textContent = this.t('card.pdfPlaceholder')
    const hint = doc.createElement('div')
    hint.className = CARD_HINT_CLASS
    hint.textContent = this.t('card.pdfPlaceholderHint')
    placeholder.append(title, hint)
    runtime.bodyEl.replaceChildren(placeholder)
  }

  // -----------------------------------------------------------------------
  // Edit lifecycle: click -> live CM6 editor; blur (native, or a
  // programmatic `.blur()` from Escape / a card switch / teardown) -> the
  // single `finishEdit` commit path. Never write back from anywhere else —
  // this is what keeps blur and Escape from double-committing
  // (p1-design §3).
  // -----------------------------------------------------------------------

  private enterEditMode(id: CardId): void {
    if (this.parseFailed) return
    const card = this.boardCardsById.get(id)
    if (!card || card.type === 'pdf') return
    const runtime = this.runtimeByCardId.get(id)
    if (!runtime?.bodyEl || runtime.missingFile) return
    // A note card's initial content is read asynchronously on mount
    // (renderCardPreview); if the user clicks to edit before that first
    // read resolves, there's no known draft to seed the editor with yet —
    // entering edit mode anyway would risk a blur immediately after
    // overwriting the file with empty text.
    if (card.type === 'note' && runtime.noteText === null) return

    if (this.editing) {
      if (this.editing.cardId === id) return
      // Force a real DOM blur on the previously-active editor so it commits
      // through the exact same path before this one takes over.
      this.editing.editor.view.contentDOM.blur()
    }

    const initialText = card.type === 'note' ? (runtime.noteText ?? '') : card.markdown
    runtime.renderer?.unload()
    runtime.renderer = null
    runtime.bodyEl.replaceChildren()
    runtime.el?.classList.add(CARD_EDITING_CLASS)
    runtime.bodyEl.classList.add(EDITOR_HOST_CLASS)
    this.pinnedIds.add(id)

    const doc = this.context.getDocument()
    const editor = mountWhiteboardEditor(runtime.bodyEl, doc, initialText, (text) => this.finishEdit(id, text))
    const scopeDisposer = this.context.pushKeymapScope([
      {
        modifiers: [],
        key: 'Escape',
        handler: () => {
          editor.view.contentDOM.blur()
          return true
        },
      },
    ])
    this.editing = { cardId: id, editor, scopeDisposer }
  }

  private finishEdit(id: CardId, text: string): void {
    const editing = this.editing
    if (!editing || editing.cardId !== id) return // stale callback: already exited some other way
    this.editing = null
    editing.scopeDisposer()
    editing.editor.destroy()
    this.pinnedIds.delete(id)

    const runtime = this.runtimeByCardId.get(id)
    runtime?.el?.classList.remove(CARD_EDITING_CLASS)
    runtime?.bodyEl?.classList.remove(EDITOR_HOST_CLASS)

    const action = planCardCommit(this.board, id, text)
    switch (action.kind) {
      case 'writeNoteFile':
        if (runtime) runtime.noteText = action.markdown
        void this.host.vault
          .writeText(action.file, action.markdown)
          .catch((error: unknown) => this.reportError('writeText', error))
        break
      case 'updateBoard':
        this.board = action.board
        this.syncBoardIndex()
        this.context.requestSave()
        break
      case 'noop':
        break
    }
    void this.renderCardPreview(id)
  }

  /** Commits the active edit (if any) through the single `finishEdit` path
   * by forcing a real blur — used by every non-interactive teardown
   * (`dispose`, `setViewData`, `clear`) so none of them need their own
   * write-back logic. */
  private forceCommitActiveEdit(): void {
    if (!this.editing) return
    this.editing.editor.view.contentDOM.blur()
  }

  // -----------------------------------------------------------------------
  // Teardown / error state
  // -----------------------------------------------------------------------

  private teardownAllCards(): void {
    this.forceCommitActiveEdit()
    for (const runtime of this.runtimeByCardId.values()) {
      runtime.renderer?.unload()
      runtime.renderer = null
      runtime.el?.remove()
      runtime.el = null
      runtime.bodyEl = null
    }
    this.runtimeByCardId.clear()
    this.pinnedIds.clear()
    this.engine.reset()
  }

  private syncBoardIndex(): void {
    this.boardCardsById = new Map(this.board.cards.map((card) => [card.id, card]))
  }

  private showError(issues: readonly BoardParseIssue[]): void {
    if (!this.errorEl) return
    this.errorEl.classList.add(ERROR_VISIBLE_CLASS)
    this.viewportEl?.classList.add(VIEWPORT_HIDDEN_CLASS)
    const doc = this.context.getDocument()
    this.errorEl.replaceChildren()
    const title = doc.createElement('div')
    title.className = ERROR_TITLE_CLASS
    title.textContent = this.t('error.title')
    const hint = doc.createElement('div')
    hint.className = ERROR_HINT_CLASS
    hint.textContent = this.t('error.hint')
    this.errorEl.append(title, hint)
    // Diagnostics are developer-facing, not user copy — logged for
    // support/debugging rather than shown verbatim.
    if (issues.length > 0) {
      console.warn('[YOLO Whiteboard] failed to parse .yoloboard file', issues)
    }
  }

  private showCanvas(): void {
    this.errorEl?.classList.remove(ERROR_VISIBLE_CLASS)
    this.viewportEl?.classList.remove(VIEWPORT_HIDDEN_CLASS)
  }

  private sourcePathForBoard(): string {
    return this.context.getFile()?.path ?? ''
  }

  private t(key: string, fallback?: string): string {
    return createWhiteboardTranslation(this.host.i18n.getSnapshot().locale)(key, fallback)
  }

  private reportError(stage: string, error: unknown): void {
    console.error(`[YOLO Whiteboard] ${stage} failed`, error)
  }
}
