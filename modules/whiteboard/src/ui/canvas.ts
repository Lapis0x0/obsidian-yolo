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

import {
  approachScale,
  cameraFromView,
  dragPan,
  panByWheel,
  scaleAfterWheel,
  screenToWorld,
  viewAnchoredAt,
  viewFromCamera,
} from '../domain/camera'
import type { ScreenPoint } from '../domain/camera'
import { planCardCommit } from '../domain/commit'
import {
  buildEdgePathD,
  computeEdgeGeometry,
  resolveEdgeSides,
} from '../domain/edges'
import {
  type Board,
  type BoardCard,
  type BoardParseIssue,
  type CardId,
  type Edge,
  type EdgeId,
  type NoteCard,
  type TextCard,
  emptyBoard,
  parseBoard,
  serializeBoard,
} from '../domain/fileFormat'
import { cardNoteBaseName, generateCardNoteFileName } from '../domain/naming'
import {
  addCard,
  moveCard,
  removeCard,
  replaceCard,
  updateCard,
} from '../domain/operations'
import { cardsInMarquee, marqueeRectFromPoints } from '../domain/selection'
import { type MissingNoteCard, planNoteCardSelfHeal } from '../domain/selfHeal'
import {
  type CanvasView,
  type VirtualCardRect,
  VirtualizationEngine,
  computeWorldViewportRect,
} from '../domain/virtualization'
import { createWhiteboardTranslation } from '../i18n'

import {
  CAMERA_SETTLE_MS,
  DEGRADE_SCALE_THRESHOLD,
  DRAG_THRESHOLD_PX,
  DROP_STAGGER_PX,
  EDIT_PERSIST_THROTTLE_MS,
  GRID_MIN_SCREEN_STEP_PX,
  GRID_WORLD_STEP_PX,
  INTERACTING_CLASS_TIMEOUT_MS,
  MOUNT_QUOTA_PER_FRAME,
  NEW_CARD_SIZE,
  RECOMPUTE_INTERVAL_MS,
  SCALE_BOUNDS,
  UNMOUNT_QUOTA_PER_FRAME,
  VIEWPORT_BUFFER_PX,
  WHEEL_DELTA_PER_ZOOM_DOUBLING,
  ZOOM_GLIDE_EPSILON_DOUBLINGS,
  ZOOM_GLIDE_TAU_MS,
} from './constants'
import { degradedCardTitle, isDegradedScale } from './lod'

const SVG_NS = 'http://www.w3.org/2000/svg'

const ROOT_CLASS = 'yolo-whiteboard-root'
const VIEWPORT_CLASS = 'yolo-whiteboard-viewport'
const VIEWPORT_HIDDEN_CLASS = 'yolo-whiteboard-viewport-hidden'
const VIEWPORT_PANNING_CLASS = 'yolo-whiteboard-viewport-panning'
const VIEWPORT_DROP_ACTIVE_CLASS = 'yolo-whiteboard-viewport-drop-active'
const WORLD_CLASS = 'yolo-whiteboard-world'
const WORLD_INTERACTING_CLASS = 'yolo-whiteboard-world-interacting'
const WORLD_DEGRADED_CLASS = 'yolo-whiteboard-world-degraded'
const CARD_CLASS = 'yolo-whiteboard-card'
const CARD_EDITING_CLASS = 'yolo-whiteboard-card-editing'
const CARD_SELECTED_CLASS = 'yolo-whiteboard-card-selected'
const CARD_DRAGGING_CLASS = 'yolo-whiteboard-card-dragging'
const CARD_BODY_CLASS = 'yolo-whiteboard-card-body'
const CARD_DEGRADED_TITLE_CLASS = 'yolo-whiteboard-card-degraded-title'
const CARD_MISSING_CLASS = 'yolo-whiteboard-card-missing'
const CARD_PDF_PLACEHOLDER_CLASS = 'yolo-whiteboard-card-pdf-placeholder'
const CARD_HINT_CLASS = 'yolo-whiteboard-card-hint'
const MARQUEE_CLASS = 'yolo-whiteboard-marquee'
const EDGES_SVG_CLASS = 'yolo-whiteboard-edges'
const EDGE_PATH_CLASS = 'yolo-whiteboard-edge-path'
const EDGE_ARROW_CLASS = 'yolo-whiteboard-edge-arrow'
const EDGE_LABEL_CLASS = 'yolo-whiteboard-edge-label'
const EDITOR_HOST_CLASS = 'yolo-whiteboard-editor-host'
const ERROR_CLASS = 'yolo-whiteboard-error'
const ERROR_VISIBLE_CLASS = 'yolo-whiteboard-error-visible'
const ERROR_TITLE_CLASS = 'yolo-whiteboard-error-title'
const ERROR_HINT_CLASS = 'yolo-whiteboard-error-hint'
const PREHEAT_CLASS = 'yolo-whiteboard-preheat'

type CardRuntime = {
  el: HTMLElement | null
  bodyEl: HTMLElement | null
  renderer: ReturnType<
    YoloModuleHostApiV1['ui']['createMarkdownRenderer']
  > | null
  missingFile: boolean
  /** Last known content for a *note* card (its backing file's text), cached
   * because note-card content never lives in `board` (p1-design §1.2) — this
   * is the only place it's available to seed the live editor. Unused for
   * text/pdf cards. */
  noteText: string | null
}

type EditingState = {
  readonly cardId: CardId
  readonly editor: YoloModuleHostMarkdownEditorV1
  readonly scopeDisposer: () => void
  /** Pending throttled write of what is currently in the editor; see
   * `scheduleEditPersist`. */
  persistTimer: number | null
}

// -- pointer interaction state --------------------------------------------
// One of three mutually-exclusive gestures a left-button (or middle-button)
// press can start, decided at pointerdown by where it landed (canvas.ts's
// onPointerDown): panning the camera, marquee-selecting cards, or
// pressing-and-maybe-dragging a card. `interaction` holds whichever is
// active; `null` when the pointer is up.

type PanInteraction = Readonly<{
  kind: 'pan'
  origin: CanvasView
  startX: number
  startY: number
}>

/** Screen-space (viewport-local) coordinates — see startMarquee()'s doc
 * comment for why both `originLocal` and `originClient` are tracked. */
type MarqueeInteraction = Readonly<{
  kind: 'marquee'
  originLocal: ScreenPoint
  originClient: ScreenPoint
}>

/**
 * A press on a card that hasn't yet crossed `DRAG_THRESHOLD_PX`: still
 * ambiguous between "click to edit" (pointerup with `dragging === false`)
 * and "drag to move" (crossed the threshold, `dragging === true`). `ids`/
 * `startPositions` are populated only once dragging begins (see
 * `beginCardDrag`) — they cover every currently-selected card (a group
 * drag), or just `cardId` alone if it wasn't already selected.
 */
type CardInteraction = {
  readonly kind: 'card'
  readonly cardId: CardId
  readonly startClient: ScreenPoint
  dragging: boolean
  ids: CardId[]
  readonly startPositions: Map<CardId, Readonly<{ x: number; y: number }>>
}

type Interaction = PanInteraction | MarqueeInteraction | CardInteraction

type EdgeDomEntry = Readonly<{
  path: SVGPathElement
  label: SVGTextElement | null
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
  private interaction: Interaction | null = null
  private editing: EditingState | null = null

  // Selection (W3-A): UI state, not board data — never serialized. A
  // non-empty selection pushes a keymap scope (Delete/Backspace/Escape);
  // editing a card always clears the selection first (see enterEditMode),
  // so the two states never overlap and their keymap scopes never compete
  // for the same Backspace/Escape keystroke (a card being edited is never
  // also in `selectedIds`).
  private selectedIds = new Set<CardId>()
  private selectionScopeDisposer: (() => void) | null = null
  private marqueeEl: HTMLElement | null = null

  // Edges (W3-A): a single SVG overlay drawn into the world layer, redrawn
  // wholesale on structural change (rebuildEdgesSvg) and per-path on card
  // position change (redrawEdgesForCards) — see those methods' doc
  // comments for the mount-independent, DOM-measurement-free approach.
  private edgesGroupEl: SVGGElement | null = null
  private boardEdgesById = new Map<EdgeId, Edge>()
  private edgeIndexByCardId = new Map<CardId, Set<EdgeId>>()
  private readonly edgeElsById = new Map<EdgeId, EdgeDomEntry>()
  private readonly arrowMarkerId = `yolo-whiteboard-edge-arrow-${Math.random().toString(36).slice(2)}`

  private lastRawData = ''
  private parseFailed = false

  // Content-freshness (W3-B): a vault-wide `modify` subscription, live for
  // the leaf's whole lifetime (set up once in ensureDom, released in
  // dispose) — a note card's backing file can change from outside this
  // whiteboard (another leaf, another app) and the mounted card should pick
  // it up without requiring the whole `.yoloboard` file to reload. Scoped
  // to '' (vault-wide) rather than per-card because cards can reference
  // files anywhere; see handleBackingFileModified for the actual filtering
  // (mounted note cards only, and never the one currently being edited).
  private vaultSubscriptionDisposer: (() => void) | null = null

  private domReady = false
  private rootEl: HTMLElement | null = null
  private viewportEl!: HTMLElement
  private worldEl!: HTMLElement
  private errorEl: HTMLElement | null = null

  private rafId: number | null = null
  private interactingTimer: number | null = null
  private settleTimer: number | null = null
  private lastRecomputeTime = 0
  /** Zoom the wheel has asked for but the camera has not reached yet, with
   * the point the gesture grabbed. Null when the camera is at rest. */
  private zoomGlide: {
    targetScale: number
    screen: ScreenPoint
    world: ScreenPoint
  } | null = null
  private lastGlideTime: number | null = null
  /** Current zoom-degrade state, updated only at recomputeVisibility's ~70ms
   * throttle (see updateDegradedState) — not evaluated per frame. */
  private degraded = false

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
    this.selfHealMissingNoteCards()
    this.rebuildEdgesSvg()
    this.view = viewFromCamera(this.board.camera)
    // A glide aimed at the previous board's camera has nothing to say about
    // this one, and would drag the new view away from where it opened.
    this.zoomGlide = null
    this.lastGlideTime = null
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
    if (
      camera.x !== board.camera.x ||
      camera.y !== board.camera.y ||
      camera.scale !== board.camera.scale
    ) {
      board = { ...board, camera }
    }
    if (this.editing) {
      const liveText = this.editing.editor.getValue()
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
    this.viewportEl?.removeEventListener('dblclick', this.onDoubleClick)
    this.viewportEl?.removeEventListener('contextmenu', this.onContextMenu)
    this.viewportEl?.removeEventListener('dragover', this.onDragOver)
    this.viewportEl?.removeEventListener('dragleave', this.onDragLeave)
    this.viewportEl?.removeEventListener('drop', this.onDrop)
    win.removeEventListener('pointermove', this.onPointerMove)
    win.removeEventListener('pointerup', this.onPointerUp)
    this.vaultSubscriptionDisposer?.()
    this.vaultSubscriptionDisposer = null

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

    // The host does not auto-apply a module's style.css artifact — a module
    // owns its own style injection (same pattern as modules/learning's
    // inline <style> render). Mounted under the view root so it lives in
    // the view's Document (popout-correct: a <style> in the main window
    // does nothing for a popout's document) and is torn down with the root
    // on dispose. Filled asynchronously; layout self-corrects on the next
    // visibility recompute once the rules land.
    const styleEl = doc.createElement('style')
    root.appendChild(styleEl)
    void this.host.assets
      .readText('style.css')
      .then((css) => {
        styleEl.textContent = css
      })
      .catch((error: unknown) => this.reportError('style load', error))

    const viewport = doc.createElement('div')
    viewport.className = VIEWPORT_CLASS
    const world = doc.createElement('div')
    world.className = WORLD_CLASS

    // Edges overlay: one SVG covering the whole (unbounded) world layer.
    // `overflow: visible` on a nominally 1x1px element lets paths be drawn
    // anywhere in world coordinates (including negative x/y) without
    // needing a viewBox that tracks board extent — see style.css's
    // .yolo-whiteboard-edges. Inserted before any card so it paints behind
    // them (position:absolute children with no z-index stack in DOM order).
    const edgesSvg = doc.createElementNS(SVG_NS, 'svg')
    edgesSvg.setAttribute('class', EDGES_SVG_CLASS)
    const defs = doc.createElementNS(SVG_NS, 'defs')
    const marker = doc.createElementNS(SVG_NS, 'marker')
    marker.setAttribute('id', this.arrowMarkerId)
    marker.setAttribute('markerWidth', '8')
    marker.setAttribute('markerHeight', '8')
    marker.setAttribute('refX', '7')
    marker.setAttribute('refY', '4')
    // auto-start-reverse: the same marker, reused for both marker-start and
    // marker-end (an edge's `arrow: 'both'`), points outward correctly at
    // each end without needing two separate marker defs.
    marker.setAttribute('orient', 'auto-start-reverse')
    marker.setAttribute('markerUnits', 'userSpaceOnUse')
    const arrowPath = doc.createElementNS(SVG_NS, 'path')
    arrowPath.setAttribute('class', EDGE_ARROW_CLASS)
    arrowPath.setAttribute('d', 'M0,0 L8,4 L0,8 Z')
    marker.appendChild(arrowPath)
    defs.appendChild(marker)
    edgesSvg.appendChild(defs)
    const edgesGroup = doc.createElementNS(SVG_NS, 'g')
    edgesSvg.appendChild(edgesGroup)
    world.appendChild(edgesSvg)

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
    this.edgesGroupEl = edgesGroup

    this.setupInteraction()
    this.setupVaultSubscription()
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
    this.viewportEl.addEventListener('dblclick', this.onDoubleClick)
    this.viewportEl.addEventListener('contextmenu', this.onContextMenu)
    this.viewportEl.addEventListener('dragover', this.onDragOver)
    this.viewportEl.addEventListener('dragleave', this.onDragLeave)
    this.viewportEl.addEventListener('drop', this.onDrop)
  }

  /** Content-freshness (p1-design §1.2): scoped to the whole vault ('' —
   * see moduleVault.ts's `doesPathAffectScope`) because a note card's
   * backing file can live anywhere; `handleBackingFileModified` does the
   * actual per-card filtering. Set up once per leaf lifetime alongside the
   * pointer listeners; released in `dispose()`. */
  private setupVaultSubscription(): void {
    this.vaultSubscriptionDisposer = this.host.vault.subscribe('', (event) => {
      if (event.type !== 'modify') return
      this.handleBackingFileModified(event.entry.path)
    })
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
  // Pointer interaction dispatch. A left-button press decides its gesture
  // at pointerdown by where it landed:
  //   - on a card not currently being edited -> a `CardInteraction`,
  //     ambiguous between click-to-edit and drag-to-move until it crosses
  //     DRAG_THRESHOLD_PX (see `updateCardInteraction`/`beginCardDrag`);
  //   - on empty canvas with Alt held -> pan (an alt+left-drag path for
  //     trackpad users with no middle button);
  //   - on empty canvas otherwise -> marquee selection.
  // Middle-button always pans, from anywhere (including over a card).
  // Wheel handles both plain two-axis pan and ctrl/cmd-anchored zoom (the
  // ctrl/cmd-wheel signature is also how Chrome/Safari report trackpad
  // pinch). All three gestures only ever touch `this.view` + per-element
  // `transform`/`left`/`top` directly (no reflow); the camera is folded
  // into `board` and persisted only once a pan/zoom gesture settles (see
  // `scheduleCameraSettle`); a card drag/marquee commits immediately on
  // pointerup instead (no settle debounce — those are already discrete,
  // single-shot gestures, unlike the continuous wheel/pointer-pan stream).
  // -----------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.parseFailed) return
    const cardId = this.cardIdFromEventTarget(e.target)

    if (e.button === 1) {
      // Middle-click always pans, even starting from a card.
      e.preventDefault()
      this.startPan(e)
      return
    }
    if (e.button !== 0) return

    if (cardId !== null) {
      // The card currently being edited owns its own pointer handling
      // (native text selection/cursor placement inside its CM6 editor) —
      // don't intercept.
      if (this.editing?.cardId === cardId) return
      this.interaction = {
        kind: 'card',
        cardId,
        startClient: { x: e.clientX, y: e.clientY },
        dragging: false,
        ids: [],
        startPositions: new Map(),
      }
      this.viewportEl.setPointerCapture(e.pointerId)
      return
    }

    if (e.altKey) {
      this.startPan(e)
      return
    }

    this.startMarquee(e)
  }

  /**
   * Double-click on empty canvas creates a card.
   *
   * `dblclick` rather than a click counter read off `pointerdown`: measured
   * in a real Obsidian window, `pointerdown.detail` is 0 on both presses of
   * a double-click (only `mousedown` carries the count), while `dblclick`
   * arrives intact — the marquee's pointer capture, the reason for doubting
   * it, does not suppress it.
   */
  private readonly onDoubleClick = (e: MouseEvent): void => {
    if (this.parseFailed) return
    // A double-click on a card belongs to that card's editor: the first
    // click already opened it, and the second places the cursor.
    if (this.cardIdFromEventTarget(e.target) !== null) return
    this.createTextCardAt(this.worldPointFromEvent(e))
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.parseFailed) return
    const cardId = this.cardIdFromEventTarget(e.target)
    // The card being edited owns its own context menu (CM6's, with the text
    // actions that belong to an editor).
    if (cardId !== null && this.editing?.cardId === cardId) return
    e.preventDefault()

    if (cardId === null) {
      const point = this.worldPointFromEvent(e)
      this.host.ui.showMenu(e, [
        {
          title: this.t('menu.newCard'),
          icon: 'plus',
          onSelect: () => this.createTextCardAt(point),
        },
      ])
      return
    }

    const card = this.boardCardsById.get(cardId)
    if (!card) return
    this.host.ui.showMenu(e, [
      ...(card.type === 'text'
        ? [
            {
              title: this.t('menu.convertToNote'),
              icon: 'file-plus',
              onSelect: () => this.convertCardToNote(cardId),
            },
          ]
        : []),
      {
        title: this.t('menu.deleteCard'),
        icon: 'trash-2',
        onSelect: () => this.deleteCards([cardId]),
      },
    ])
  }

  // -- drag and drop ------------------------------------------------------
  // `dragover` must preventDefault on every event for the drop to fire at
  // all; the host resolves what the drag actually carries at `drop`, because
  // during dragover the browser hides the DataTransfer contents.

  private readonly onDragOver = (e: DragEvent): void => {
    if (this.parseFailed) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.viewportEl.classList.add(VIEWPORT_DROP_ACTIVE_CLASS)
  }

  private readonly onDragLeave = (e: DragEvent): void => {
    // Moving across a child element fires dragleave on the way out; only a
    // pointer that actually left the viewport should clear the hint.
    const related = e.relatedTarget
    if (related instanceof Node && this.viewportEl.contains(related)) return
    this.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
  }

  private readonly onDrop = (e: DragEvent): void => {
    this.viewportEl.classList.remove(VIEWPORT_DROP_ACTIVE_CLASS)
    if (this.parseFailed) return
    e.preventDefault()
    const entries = this.host.ui.resolveDropEntries(e)
    if (entries.length === 0) return
    const notes = entries.filter(
      (entry) =>
        entry.kind === 'file' && entry.path.toLowerCase().endsWith('.md'),
    )
    if (notes.length === 0) {
      this.host.ui.notice(this.t('notice.dropUnsupported'))
      return
    }
    this.addNoteCards(
      notes.map((entry) => entry.path),
      this.worldPointFromEvent(e),
    )
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const interaction = this.interaction
    if (!interaction) return
    switch (interaction.kind) {
      case 'pan':
        this.updatePan(interaction, e)
        break
      case 'marquee':
        this.updateMarquee(interaction, e)
        break
      case 'card':
        this.updateCardInteraction(interaction, e)
        break
    }
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    const interaction = this.interaction
    if (!interaction) return
    this.interaction = null
    switch (interaction.kind) {
      case 'pan':
        this.finishPan()
        break
      case 'marquee':
        this.finishMarquee(interaction, e)
        break
      case 'card':
        this.finishCardInteraction(interaction, e)
        break
    }
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.parseFailed) return
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(e.deltaY, this.viewportPointFromEvent(e))
      return
    }
    this.view = panByWheel(this.view, e.deltaX, e.deltaY)
    this.applyTransform()
    this.markInteracting()
    this.scheduleCameraSettle()
  }

  /**
   * Aims the camera at a new zoom, anchored on the point under the cursor.
   *
   * The camera glides there over the next few frames rather than arriving at
   * once (see `advanceZoomGlide`), so consecutive notches accumulate against
   * the *target* rather than wherever the glide currently is — otherwise
   * spinning the wheel would fight the easing and cover less ground the
   * faster it was spun. The anchor is re-taken from the live view each time,
   * which is what lets the cursor move mid-gesture and still zoom about
   * wherever it now points.
   */
  private zoomBy(deltaY: number, cursor: ScreenPoint): void {
    const targetScale = scaleAfterWheel(
      this.zoomGlide?.targetScale ?? this.view.scale,
      deltaY,
      WHEEL_DELTA_PER_ZOOM_DOUBLING,
      SCALE_BOUNDS,
    )
    const anchor = { screen: cursor, world: screenToWorld(this.view, cursor) }
    if (this.prefersReducedMotion()) {
      this.zoomGlide = null
      this.view = viewAnchoredAt(anchor.screen, anchor.world, targetScale)
      this.applyTransform()
      this.markInteracting()
      this.scheduleCameraSettle()
      return
    }
    this.zoomGlide = { ...anchor, targetScale }
  }

  /**
   * Moves the camera one frame closer to the zoom the last gesture asked for.
   *
   * Driven from the rAF loop rather than by the input events themselves: the
   * motion has to continue after the wheel stops, which is the whole point of
   * gliding — a gesture ends with the camera still travelling, the way it does
   * everywhere else in Obsidian.
   */
  private advanceZoomGlide(now: number): void {
    const glide = this.zoomGlide
    if (!glide) return
    // A first frame, or one after the tab was backgrounded, has no meaningful
    // elapsed time; treat it as a single 60Hz frame rather than teleporting.
    const elapsed =
      this.lastGlideTime === null
        ? 16.7
        : Math.min(now - this.lastGlideTime, 100)
    this.lastGlideTime = now

    const next = approachScale(
      this.view.scale,
      glide.targetScale,
      elapsed,
      ZOOM_GLIDE_TAU_MS,
    )
    const settled =
      Math.abs(Math.log2(next / glide.targetScale)) <
      ZOOM_GLIDE_EPSILON_DOUBLINGS
    this.view = viewAnchoredAt(
      glide.screen,
      glide.world,
      settled ? glide.targetScale : next,
    )
    this.applyTransform()
    this.markInteracting()
    if (settled) {
      this.zoomGlide = null
      this.lastGlideTime = null
      this.scheduleCameraSettle()
    }
  }

  /** Viewport-relative position of a mouse event. */
  private viewportPointFromEvent(e: MouseEvent): ScreenPoint {
    const rect = this.viewportEl.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** Resolved per gesture rather than cached: the setting can change while a
   * view is open, and this runs once per wheel gesture, not per frame. */
  private prefersReducedMotion(): boolean {
    return this.context
      .getWindow()
      .matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  private applyTransform(): void {
    this.worldEl.style.transform = `translate(${this.view.tx}px, ${this.view.ty}px) scale(${this.view.scale})`
    this.applyGrid()
  }

  /**
   * Places the dot grid. It is painted on the viewport (screen space), not
   * inside the world layer, because a world-space grid would be scaled by
   * the camera along with everything else — dots would swell into blobs
   * zoomed in and vanish zoomed out. Instead the lattice is positioned by
   * hand: spacing tracks the camera scale, the tile origin tracks the camera
   * translation, and the dot itself (style.css owns its size and colour)
   * stays constant on screen. The result is anchored to world coordinates —
   * it pans with the board and spreads as you zoom in — which is the whole
   * point of a grid rather than a decorative backdrop.
   *
   * Writing background-position per frame repaints the viewport. That is
   * paint only (no reflow) and the card layer above it remains a composited
   * transform, so the pan path keeps its compositor fast-path; it is also
   * what Obsidian's own canvas does, and there is no way to keep a grid
   * locked to world coordinates without moving it every frame.
   */
  private applyGrid(): void {
    const { scale, tx, ty } = this.view
    const doublings = Math.max(
      0,
      Math.ceil(
        Math.log2(GRID_MIN_SCREEN_STEP_PX / (GRID_WORLD_STEP_PX * scale)),
      ),
    )
    const step = GRID_WORLD_STEP_PX * 2 ** doublings * scale
    this.viewportEl.style.backgroundSize = `${step}px ${step}px`
    this.viewportEl.style.backgroundPosition = `${tx}px ${ty}px`
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
    // Mid-glide, the view is a frame on the way to somewhere; what the user
    // asked for is the target. Persisting the intermediate one would reopen
    // the board half-way through a zoom the gesture had already finished.
    const glide = this.zoomGlide
    const camera = cameraFromView(
      glide
        ? viewAnchoredAt(glide.screen, glide.world, glide.targetScale)
        : this.view,
    )
    const current = this.board.camera
    if (
      camera.x === current.x &&
      camera.y === current.y &&
      camera.scale === current.scale
    ) {
      return
    }
    this.board = { ...this.board, camera }
    this.context.requestSave()
  }

  // -----------------------------------------------------------------------
  // Pan gesture (middle-drag anywhere, or Alt+left-drag from empty canvas).
  // -----------------------------------------------------------------------

  private startPan(e: PointerEvent): void {
    this.interaction = {
      kind: 'pan',
      origin: { ...this.view },
      startX: e.clientX,
      startY: e.clientY,
    }
    this.viewportEl.classList.add(VIEWPORT_PANNING_CLASS)
    this.viewportEl.setPointerCapture(e.pointerId)
    this.markInteracting()
  }

  private updatePan(interaction: PanInteraction, e: PointerEvent): void {
    this.view = dragPan(
      interaction.origin,
      { x: interaction.startX, y: interaction.startY },
      { x: e.clientX, y: e.clientY },
    )
    this.applyTransform()
    this.markInteracting()
    this.scheduleCameraSettle()
  }

  private finishPan(): void {
    this.viewportEl.classList.remove(VIEWPORT_PANNING_CLASS)
    this.commitCameraNow()
  }

  // -----------------------------------------------------------------------
  // Marquee selection (left-drag from empty canvas). The overlay div lives
  // in the *viewport* layer (a sibling of the scaled/panned world layer),
  // so it's drawn in plain screen coordinates and never needs to account
  // for the camera transform itself — only its two corner points get
  // converted to world space, once, at pointerup (p1-design's W3-A task
  // brief allows either a live per-move highlight or a single hit-test at
  // release; this takes the latter, cheaper option — repainting a
  // dashed-rectangle overlay already gives the user drag feedback, and
  // hit-testing every card on every pointermove has no payoff for M1's
  // board sizes).
  // -----------------------------------------------------------------------

  private startMarquee(e: PointerEvent): void {
    const rect = this.viewportEl.getBoundingClientRect()
    const originLocal = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    this.interaction = {
      kind: 'marquee',
      originLocal,
      originClient: { x: e.clientX, y: e.clientY },
    }
    this.viewportEl.setPointerCapture(e.pointerId)
    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = MARQUEE_CLASS
    this.viewportEl.appendChild(el)
    this.marqueeEl = el
    this.applyMarqueeRect(originLocal, originLocal)
  }

  /** `originClient` is the raw pointerdown screen position (page-relative,
   * comparable across pointermove events without re-querying
   * getBoundingClientRect on every one); `originLocal` is that same instant
   * converted once to viewport-local coordinates. Since the viewport itself
   * doesn't move mid-gesture, the current local position is just
   * `originLocal` plus how far the pointer has moved since. */
  private currentMarqueePoint(
    interaction: MarqueeInteraction,
    e: PointerEvent,
  ): ScreenPoint {
    return {
      x: interaction.originLocal.x + (e.clientX - interaction.originClient.x),
      y: interaction.originLocal.y + (e.clientY - interaction.originClient.y),
    }
  }

  private updateMarquee(
    interaction: MarqueeInteraction,
    e: PointerEvent,
  ): void {
    this.applyMarqueeRect(
      interaction.originLocal,
      this.currentMarqueePoint(interaction, e),
    )
  }

  private applyMarqueeRect(a: ScreenPoint, b: ScreenPoint): void {
    if (!this.marqueeEl) return
    this.marqueeEl.style.transform = `translate(${Math.min(a.x, b.x)}px, ${Math.min(a.y, b.y)}px)`
    this.marqueeEl.style.width = `${Math.abs(a.x - b.x)}px`
    this.marqueeEl.style.height = `${Math.abs(a.y - b.y)}px`
  }

  private finishMarquee(
    interaction: MarqueeInteraction,
    e: PointerEvent,
  ): void {
    const current = this.currentMarqueePoint(interaction, e)
    this.marqueeEl?.remove()
    this.marqueeEl = null
    const worldA = screenToWorld(this.view, interaction.originLocal)
    const worldB = screenToWorld(this.view, current)
    // A zero-size marquee (a plain click on empty canvas, no movement)
    // naturally selects nothing here, subsuming "click empty clears
    // selection" without a separate code path.
    this.setSelection(
      cardsInMarquee(this.board.cards, marqueeRectFromPoints(worldA, worldB)),
    )
  }

  // -----------------------------------------------------------------------
  // Card press: click-to-edit vs. drag-to-move, disambiguated by
  // DRAG_THRESHOLD_PX. A plain click (never crosses the threshold) clears
  // the selection and enters edit mode — unchanged from the pre-W3-A
  // behavior, just re-homed from a per-card `click` listener into this
  // central pointerup handler so it can share the threshold check with
  // dragging. A drag moves either just the pressed card, or the whole
  // current selection if the pressed card was already part of it (and
  // never enters edit mode). Position updates during drag write only
  // `transform` on the affected card elements (compositor-friendly, no
  // layout write) — `left`/`top` are reconciled to the final board values
  // once on drop, matching how a freshly-mounted card is positioned.
  // -----------------------------------------------------------------------

  private updateCardInteraction(
    interaction: CardInteraction,
    e: PointerEvent,
  ): void {
    if (!interaction.dragging) {
      const dx = e.clientX - interaction.startClient.x
      const dy = e.clientY - interaction.startClient.y
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      this.beginCardDrag(interaction)
    }
    this.updateCardDragPositions(interaction, e)
  }

  private beginCardDrag(interaction: CardInteraction): void {
    interaction.dragging = true
    if (!this.selectedIds.has(interaction.cardId)) {
      this.setSelection([interaction.cardId])
    }
    interaction.ids = Array.from(this.selectedIds)
    for (const id of interaction.ids) {
      const card = this.boardCardsById.get(id)
      if (!card) continue
      interaction.startPositions.set(id, { x: card.x, y: card.y })
      // Exempt every dragged card from virtualization unmount for the
      // duration of the drag (mirrors the existing editing-card pin).
      this.pinnedIds.add(id)
      this.runtimeByCardId.get(id)?.el?.classList.add(CARD_DRAGGING_CLASS)
    }
  }

  private worldDelta(
    interaction: CardInteraction,
    e: PointerEvent,
  ): Readonly<{ dx: number; dy: number }> {
    return {
      dx: (e.clientX - interaction.startClient.x) / this.view.scale,
      dy: (e.clientY - interaction.startClient.y) / this.view.scale,
    }
  }

  private updateCardDragPositions(
    interaction: CardInteraction,
    e: PointerEvent,
  ): void {
    const { dx, dy } = this.worldDelta(interaction, e)
    const overrides = new Map<CardId, Readonly<{ x: number; y: number }>>()
    for (const id of interaction.ids) {
      const start = interaction.startPositions.get(id)
      if (!start) continue
      overrides.set(id, { x: start.x + dx, y: start.y + dy })
      const el = this.runtimeByCardId.get(id)?.el
      if (el) el.style.transform = `translate(${dx}px, ${dy}px)`
    }
    this.redrawEdgesForCards(new Set(interaction.ids), overrides)
  }

  private finishCardInteraction(
    interaction: CardInteraction,
    e: PointerEvent,
  ): void {
    if (!interaction.dragging) {
      this.clearSelection()
      const card = this.boardCardsById.get(interaction.cardId)
      if (card && card.type !== 'pdf') this.enterEditMode(interaction.cardId)
      return
    }

    const { dx, dy } = this.worldDelta(interaction, e)
    if (dx !== 0 || dy !== 0) {
      this.board = moveCard(this.board, interaction.ids, dx, dy)
      this.syncBoardIndex()
      this.context.requestSave()
    }
    for (const id of interaction.ids) {
      this.pinnedIds.delete(id)
      const el = this.runtimeByCardId.get(id)?.el
      if (!el) continue
      el.classList.remove(CARD_DRAGGING_CLASS)
      // A literal-string style assignment is disallowed (obsidianmd/
      // no-static-styles-assignment) even for a reset; setCssProps is the
      // sanctioned escape hatch (Obsidian and Style Constraints, CLAUDE.md).
      el.setCssProps({ transform: '' })
      const card = this.boardCardsById.get(id)
      if (card) {
        el.style.left = `${card.x}px`
        el.style.top = `${card.y}px`
      }
    }
    this.redrawEdgesForCards(new Set(interaction.ids))
    // Dragged cards may have moved on/off screen — re-evaluate mount state
    // immediately rather than waiting for the next throttled recompute
    // (mirrors onResize()'s direct call).
    this.recomputeVisibility()
    this.drainQueues()
  }

  // -----------------------------------------------------------------------
  // Selection (W3-A). `selectedIds` is UI state only — never touches
  // `board` or triggers requestSave by itself. Pushes/pops a keymap scope
  // exactly when the selection transitions to/from empty, so
  // Delete/Backspace/Escape are only ever intercepted while there's
  // something to act on (and, by construction, never while a card is being
  // edited — see the class-field doc comment on `selectedIds`).
  // -----------------------------------------------------------------------

  private setSelection(ids: readonly CardId[]): void {
    const next = new Set(ids)
    for (const id of this.selectedIds) {
      if (!next.has(id))
        this.runtimeByCardId.get(id)?.el?.classList.remove(CARD_SELECTED_CLASS)
    }
    for (const id of next) {
      if (!this.selectedIds.has(id))
        this.runtimeByCardId.get(id)?.el?.classList.add(CARD_SELECTED_CLASS)
    }
    const hadSelection = this.selectedIds.size > 0
    this.selectedIds = next
    const hasSelection = next.size > 0
    if (hasSelection && !hadSelection) this.pushSelectionKeymapScope()
    else if (!hasSelection && hadSelection) this.popSelectionKeymapScope()
  }

  private clearSelection(): void {
    if (this.selectedIds.size > 0) this.setSelection([])
  }

  private pushSelectionKeymapScope(): void {
    this.selectionScopeDisposer = this.context.pushKeymapScope([
      {
        modifiers: [],
        key: 'Backspace',
        handler: () => {
          this.deleteSelectedCards()
          return true
        },
      },
      {
        modifiers: [],
        key: 'Delete',
        handler: () => {
          this.deleteSelectedCards()
          return true
        },
      },
      {
        modifiers: [],
        key: 'Escape',
        handler: () => {
          this.clearSelection()
          return true
        },
      },
    ])
  }

  private popSelectionKeymapScope(): void {
    this.selectionScopeDisposer?.()
    this.selectionScopeDisposer = null
  }

  private deleteSelectedCards(): void {
    if (this.selectedIds.size === 0) return
    this.deleteCards(Array.from(this.selectedIds))
  }

  private deleteCards(ids: readonly CardId[]): void {
    if (this.parseFailed || ids.length === 0) return
    if (this.editing && ids.includes(this.editing.cardId)) {
      // Commit through the one blur path before the card stops existing,
      // rather than leaving an editor mounted on a deleted card.
      this.editing.editor.blur()
    }
    let board = this.board
    for (const id of ids) {
      if (board.cards.some((card) => card.id === id))
        board = removeCard(board, id)
    }
    this.board = board
    this.syncBoardIndex()
    for (const id of ids) this.purgeCardRuntime(id)
    this.clearSelection()
    // Deleting cards cascades edge removal (operations.ts's removeCard) —
    // the edge *set* changed, not just endpoint positions, so a full
    // rebuild (rather than redrawEdgesForCards) is the correct/simplest
    // response; edge mutations are rare in M1 (no add/remove-edge UI, only
    // this cascade), so its cost is a non-issue.
    this.rebuildEdgesSvg()
    this.context.requestSave()
  }

  // -----------------------------------------------------------------------
  // Card creation and conversion.
  //
  // Double-click and the canvas context menu both create a *text* card: it
  // is pure board data, so the cheapest gesture on the canvas carries no
  // side effect outside the file. "Card as note" (p1-design §1.2) is
  // reached deliberately, through `convertCardToNote` — the user decides
  // when a card earns a file, rather than every stray double-click leaving
  // an empty note in the vault.

  /** Creates an empty text card centered on `world` and opens it for typing. */
  private createTextCardAt(world: ScreenPoint): void {
    if (this.parseFailed) return
    const card: TextCard = {
      id: this.nextCardId(),
      type: 'text',
      x: Math.round(world.x - NEW_CARD_SIZE.w / 2),
      y: Math.round(world.y - NEW_CARD_SIZE.h / 2),
      w: NEW_CARD_SIZE.w,
      h: NEW_CARD_SIZE.h,
      markdown: '',
      extra: {},
    }
    this.board = addCard(this.board, card)
    this.syncBoardIndex()
    this.clearSelection()
    // The card has to exist in the DOM before an editor can be mounted into
    // it, and mounting is normally driven by the rAF loop. Draining now
    // makes the new card available in this same turn; it is inside the
    // viewport by construction, so it is always in the mount queue.
    this.recomputeVisibility()
    this.drainQueues()
    this.context.requestSave()
    this.enterEditMode(card.id)
  }

  /** Adds one note card per vault path, staggered from `world`. */
  private addNoteCards(paths: readonly string[], world: ScreenPoint): void {
    if (this.parseFailed || paths.length === 0) return
    let board = this.board
    for (const [index, path] of paths.entries()) {
      const offset = index * DROP_STAGGER_PX
      board = addCard(board, {
        id: this.nextCardId(),
        type: 'note',
        x: Math.round(world.x - NEW_CARD_SIZE.w / 2 + offset),
        y: Math.round(world.y - NEW_CARD_SIZE.h / 2 + offset),
        w: NEW_CARD_SIZE.w,
        h: NEW_CARD_SIZE.h,
        file: path,
        extra: {},
      })
    }
    this.board = board
    this.syncBoardIndex()
    this.recomputeVisibility()
    this.drainQueues()
    this.context.requestSave()
  }

  /**
   * Turns a text card into a note card backed by a real vault file.
   *
   * The card keeps its id, position, and edges (`replaceCard`); only its
   * identity changes. Its markdown is written verbatim — including the
   * heading the file name came from, because a conversion that silently
   * rewrote the user's text would be a worse surprise than a duplicated
   * title.
   */
  private convertCardToNote(id: CardId): void {
    if (this.parseFailed) return
    const card = this.boardCardsById.get(id)
    if (!card || card.type !== 'text') return
    if (this.editing?.cardId === id) {
      // Commit the live text first so the note is written from what the user
      // currently sees, not from the last committed snapshot.
      this.editing.editor.blur()
    }
    const current = this.boardCardsById.get(id)
    if (!current || current.type !== 'text') return
    void this.writeCardNote(current)
  }

  private async writeCardNote(card: TextCard): Promise<void> {
    const markdown = card.markdown
    try {
      // No ensureFolder: the board's own folder exists by definition.
      const folderPath = this.boardFolderPath()
      const existingNames = new Set(
        this.host.vault
          .listChildren(folderPath)
          .filter((entry) => entry.kind === 'file')
          .map((entry) => entry.name),
      )
      const fileName = generateCardNoteFileName(
        cardNoteBaseName(markdown, this.t('file.newNoteBaseName')),
        existingNames,
      )
      const path = folderPath ? `${folderPath}/${fileName}` : fileName
      await this.host.vault.createText(path, markdown)

      // The board may have moved on while the file was being written.
      const latest = this.boardCardsById.get(card.id)
      if (!latest || latest.type !== 'text') return
      const note: NoteCard = {
        id: latest.id,
        type: 'note',
        x: latest.x,
        y: latest.y,
        w: latest.w,
        h: latest.h,
        file: path,
        extra: latest.extra,
      }
      this.board = replaceCard(this.board, latest.id, note)
      this.syncBoardIndex()
      // The card's content now comes from a file rather than from the board,
      // so its mounted preview has to be rebuilt against the new source.
      this.purgeCardRuntime(latest.id)
      this.recomputeVisibility()
      this.drainQueues()
      this.context.requestSave()
      this.host.ui.notice(
        this.t('notice.convertedToNote').replace('{path}', path),
      )
    } catch (error) {
      this.reportError('convert card to note', error)
      this.host.ui.notice(this.t('error.convertFailed'))
    }
  }

  /**
   * The board's own folder — where a converted card's note is written.
   *
   * Deliberately not a `<board name> Cards/` subfolder (p1-design §1.2's
   * original rule): a folder named after the board has to be renamed and
   * moved whenever the board is, and until it is, one board's cards sit in
   * two different folders. Writing beside the board needs no such rule and
   * cannot drift. A board at the vault root returns '', which every vault
   * call here already treats as the root.
   */
  private boardFolderPath(): string {
    const boardPath = this.sourcePathForBoard()
    const lastSlash = boardPath.lastIndexOf('/')
    return lastSlash === -1 ? '' : boardPath.slice(0, lastSlash)
  }

  private nextCardId(): CardId {
    const uuid = this.context.getWindow().crypto.randomUUID()
    return `c-${uuid}`
  }

  private worldPointFromEvent(e: MouseEvent): ScreenPoint {
    return screenToWorld(this.view, this.viewportPointFromEvent(e))
  }

  private cardIdFromEventTarget(target: EventTarget | null): CardId | null {
    if (!(target instanceof Element)) return null
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Element.closest()'s generic return type defaults to `Element` here (no type argument to infer it from); the assertion is required for `.dataset` below to type-check under tsc even though this lint rule's own type resolution disagrees.
    const cardEl = target.closest(`.${CARD_CLASS}`) as HTMLElement | null
    return cardEl?.dataset.cardId ?? null
  }

  /** Fully removes a card no longer present in `board` (as opposed to
   * `unmountCard`, which keeps its runtime entry around — minus the DOM —
   * for a card that's merely scrolled off-screen but still valid). Keeps
   * the virtualization engine's bookkeeping in sync via `markUnmounted`
   * since a removed card is absent from the `cards` array `recompute()`
   * iterates, so it would otherwise never be queued for unmount on its
   * own. */
  private purgeCardRuntime(id: CardId): void {
    const runtime = this.runtimeByCardId.get(id)
    if (runtime) {
      runtime.renderer?.unload()
      runtime.el?.remove()
    }
    this.runtimeByCardId.delete(id)
    this.pinnedIds.delete(id)
    this.engine.markUnmounted(id)
  }

  // -----------------------------------------------------------------------
  // Virtualization loop
  // -----------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    this.advanceZoomGlide(now)
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
    this.updateDegradedState()
  }

  /** Toggles the zoom-degrade CSS class at this method's ~70ms throttle
   * (recomputeVisibility's caller), not per frame — p1-design §3's
   * "阈值切换时机放在相机 settle 或节流点，不逐帧判断切换". This throttle
   * point (rather than only the longer 300ms camera-settle debounce) keeps
   * a deliberate zoom-out gesture feeling responsive. */
  private updateDegradedState(): void {
    const next = isDegradedScale(this.view.scale, DEGRADE_SCALE_THRESHOLD)
    if (next === this.degraded) return
    this.degraded = next
    this.worldEl.classList.toggle(WORLD_DEGRADED_CLASS, next)
  }

  private drainQueues(): void {
    const { toMount, toUnmount } = this.engine.drain(
      MOUNT_QUOTA_PER_FRAME,
      UNMOUNT_QUOTA_PER_FRAME,
    )
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
    // Re-apply selection state — a selected card can unmount (scrolled
    // off-screen) and remount without its selection ever changing.
    if (this.selectedIds.has(id)) el.classList.add(CARD_SELECTED_CLASS)

    const body = doc.createElement('div')
    body.className = CARD_BODY_CLASS
    el.appendChild(body)

    // Degraded (low-zoom) title block: always built, CSS-only toggled
    // against the full markdown body via the world element's
    // WORLD_DEGRADED_CLASS (updateDegradedState) — see style.css. Computed
    // once from card data at mount time; card title-affecting fields
    // (file/markdown) never change post-mount in M1, only position does.
    const degradedTitle = doc.createElement('div')
    degradedTitle.className = CARD_DEGRADED_TITLE_CLASS
    degradedTitle.textContent = degradedCardTitle(card)
    el.appendChild(degradedTitle)

    // Click-to-edit vs. drag-to-move is disambiguated centrally in
    // onPointerDown/Move/Up (DRAG_THRESHOLD_PX) rather than a per-card
    // `click` listener, so the same gesture can also drive dragging.

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
    await this.renderMarkdownInto(
      id,
      runtime,
      card.markdown,
      this.sourcePathForBoard(),
    )
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
    const stale =
      runtime.renderer !== renderer || !bodyEl || this.editing?.cardId === id
    if (stale || !bodyEl) {
      renderer.unload()
      if (runtime.renderer === renderer) runtime.renderer = null
      return
    }
    bodyEl.replaceChildren(...Array.from(staging.childNodes))
  }

  private renderMissingFilePlaceholder(
    runtime: CardRuntime,
    path: string,
  ): void {
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
  // Edges: a single SVG overlay in the world layer draws every edge
  // (p1-design §3: "世界层内单个 SVG overlay 画全部 edges...只在 edges 或
  // 端点卡片位移时重绘（不进逐帧路径）"). Two redraw paths:
  //   - `rebuildEdgesSvg` — full rebuild, for a structural change (a new
  //     file loaded, or a card delete cascading edge removal). Rare in M1
  //     (no edge create/edit UI yet), so its cost is a non-issue.
  //   - `redrawEdgesForCards` — updates only the `d`/label position of
  //     edges incident to the given card ids, via `edgeIndexByCardId`.
  //     Used on every card-drag pointermove (with live override positions)
  //     and once more after a drag commits (against the final board data).
  // Endpoint coordinates always come from board data (via
  // `effectiveCardRect`), never the DOM — an edge still draws correctly
  // even when one of its endpoint cards isn't currently mounted
  // (virtualization) or is mid-drag (temporary override coordinates).
  // -----------------------------------------------------------------------

  private rebuildEdgesSvg(): void {
    this.clearEdgesSvg()
    this.boardEdgesById = new Map(
      this.board.edges.map((edge) => [edge.id, edge]),
    )
    for (const edge of this.board.edges) {
      this.indexEdgeIncidence(edge)
      this.createEdgeDom(edge)
      this.redrawEdge(edge.id)
    }
  }

  private clearEdgesSvg(): void {
    this.edgesGroupEl?.replaceChildren()
    this.edgeElsById.clear()
    this.boardEdgesById = new Map()
    this.edgeIndexByCardId = new Map()
  }

  private indexEdgeIncidence(edge: Edge): void {
    this.addEdgeIndex(edge.from, edge.id)
    this.addEdgeIndex(edge.to, edge.id)
  }

  private addEdgeIndex(cardId: CardId, edgeId: EdgeId): void {
    let ids = this.edgeIndexByCardId.get(cardId)
    if (!ids) {
      ids = new Set()
      this.edgeIndexByCardId.set(cardId, ids)
    }
    ids.add(edgeId)
  }

  private createEdgeDom(edge: Edge): void {
    if (!this.edgesGroupEl) return
    const doc = this.context.getDocument()
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('class', EDGE_PATH_CLASS)
    if (edge.arrow === 'end' || edge.arrow === 'both') {
      path.setAttribute('marker-end', `url(#${this.arrowMarkerId})`)
    }
    if (edge.arrow === 'both') {
      path.setAttribute('marker-start', `url(#${this.arrowMarkerId})`)
    }
    this.edgesGroupEl.appendChild(path)

    let label: SVGTextElement | null = null
    if (edge.label && edge.label.trim().length > 0) {
      label = doc.createElementNS(SVG_NS, 'text')
      label.setAttribute('class', EDGE_LABEL_CLASS)
      label.setAttribute('text-anchor', 'middle')
      label.setAttribute('dominant-baseline', 'middle')
      label.textContent = edge.label
      this.edgesGroupEl.appendChild(label)
    }

    this.edgeElsById.set(edge.id, { path, label })
  }

  /** Board-data rect for `id`, or its live drag position from `overrides`
   * when provided (see `updateCardDragPositions`) — the single lookup both
   * `redrawEdge` call sites (live drag, and the post-commit redraw against
   * final data) go through. */
  private effectiveCardRect(
    id: CardId,
    overrides?: ReadonlyMap<CardId, Readonly<{ x: number; y: number }>>,
  ): VirtualCardRect | null {
    const card = this.boardCardsById.get(id)
    if (!card) return null
    const override = overrides?.get(id)
    return override
      ? { id: card.id, x: override.x, y: override.y, w: card.w, h: card.h }
      : card
  }

  private redrawEdge(
    edgeId: EdgeId,
    overrides?: ReadonlyMap<CardId, Readonly<{ x: number; y: number }>>,
  ): void {
    const edge = this.boardEdgesById.get(edgeId)
    const dom = this.edgeElsById.get(edgeId)
    if (!edge || !dom) return
    const from = this.effectiveCardRect(edge.from, overrides)
    const to = this.effectiveCardRect(edge.to, overrides)
    if (!from || !to) return // dangling edges are rejected at parse time; stay defensive
    const { fromSide, toSide } = resolveEdgeSides(
      from,
      to,
      edge.fromSide,
      edge.toSide,
    )
    const geometry = computeEdgeGeometry(from, to, fromSide, toSide)
    dom.path.setAttribute('d', buildEdgePathD(geometry))
    if (dom.label) {
      dom.label.setAttribute('x', String(geometry.label.x))
      dom.label.setAttribute('y', String(geometry.label.y))
    }
  }

  private redrawEdgesForCards(
    cardIds: ReadonlySet<CardId>,
    overrides?: ReadonlyMap<CardId, Readonly<{ x: number; y: number }>>,
  ): void {
    const edgeIds = new Set<EdgeId>()
    for (const id of cardIds) {
      const incident = this.edgeIndexByCardId.get(id)
      if (!incident) continue
      for (const edgeId of incident) edgeIds.add(edgeId)
    }
    for (const edgeId of edgeIds) this.redrawEdge(edgeId, overrides)
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
      this.editing.editor.blur()
    }

    const initialText =
      card.type === 'note' ? (runtime.noteText ?? '') : card.markdown
    runtime.renderer?.unload()
    runtime.renderer = null
    runtime.bodyEl.replaceChildren()
    runtime.el?.classList.add(CARD_EDITING_CLASS)
    runtime.bodyEl.classList.add(EDITOR_HOST_CLASS)
    this.pinnedIds.add(id)

    const editor = this.host.ui.createMarkdownEditor({
      container: runtime.bodyEl,
      value: initialText,
      // What `[[links]]` in this card resolve against, and where an attachment
      // pasted into it is filed. A note card is its own document; a text card
      // lives inside the board file, so "here" is the board.
      sourcePath: card.type === 'note' ? card.file : this.sourcePathForBoard(),
      onChange: () => this.scheduleEditPersist(id),
      onBlur: (text) => this.finishEdit(id, text),
    })
    const scopeDisposer = this.context.pushKeymapScope([
      {
        modifiers: [],
        key: 'Escape',
        handler: () => {
          editor.blur()
          return true
        },
      },
    ])
    this.editing = { cardId: id, editor, scopeDisposer, persistTimer: null }
    editor.focus()
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
  private scheduleEditPersist(id: CardId): void {
    const editing = this.editing
    if (!editing || editing.cardId !== id) return
    // Leading edge already scheduled: the timer reads the editor when it
    // fires, so it always writes the latest text and never needs restarting.
    if (editing.persistTimer !== null) return
    const win = this.context.getWindow()
    editing.persistTimer = win.setTimeout(() => {
      editing.persistTimer = null
      if (this.editing !== editing) return
      this.commitCardText(id, editing.editor.getValue())
    }, EDIT_PERSIST_THROTTLE_MS)
  }

  /** Writes a card's text to wherever that card's content lives — the note
   * file for a note card, the board for a text card. */
  private commitCardText(id: CardId, text: string): void {
    const action = planCardCommit(this.board, id, text)
    switch (action.kind) {
      case 'writeNoteFile': {
        const runtime = this.runtimeByCardId.get(id)
        if (runtime) runtime.noteText = action.markdown
        void this.host.vault
          .writeText(action.file, action.markdown)
          .catch((error: unknown) => this.reportError('writeText', error))
        break
      }
      case 'updateBoard':
        this.board = action.board
        this.syncBoardIndex()
        this.context.requestSave()
        break
      case 'noop':
        break
    }
  }

  private finishEdit(id: CardId, text: string): void {
    const editing = this.editing
    if (!editing || editing.cardId !== id) return // stale callback: already exited some other way
    this.editing = null
    if (editing.persistTimer !== null) {
      this.context.getWindow().clearTimeout(editing.persistTimer)
    }
    editing.scopeDisposer()
    editing.editor.destroy()
    this.pinnedIds.delete(id)

    const runtime = this.runtimeByCardId.get(id)
    runtime?.el?.classList.remove(CARD_EDITING_CLASS)
    runtime?.bodyEl?.classList.remove(EDITOR_HOST_CLASS)

    // Final flush: the throttled writes may have left the last keystrokes
    // unpersisted, and a no-op commit costs nothing.
    this.commitCardText(id, text)
    void this.renderCardPreview(id)
  }

  /** Commits the active edit (if any) through the single `finishEdit` path
   * by forcing a real blur — used by every non-interactive teardown
   * (`dispose`, `setViewData`, `clear`) so none of them need their own
   * write-back logic. */
  private forceCommitActiveEdit(): void {
    if (!this.editing) return
    this.editing.editor.blur()
  }

  // -----------------------------------------------------------------------
  // Teardown / error state
  // -----------------------------------------------------------------------

  private teardownAllCards(): void {
    this.forceCommitActiveEdit()
    this.interaction = null
    this.marqueeEl?.remove()
    this.marqueeEl = null
    this.popSelectionKeymapScope()
    this.selectedIds = new Set()
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
    this.clearEdgesSvg()
  }

  private syncBoardIndex(): void {
    this.boardCardsById = new Map(
      this.board.cards.map((card) => [card.id, card]),
    )
  }

  // ---------------------------------------------------------------------
  // Self-heal (p1-design §1.2, "自愈层"): run once per setViewData, right
  // after a board finishes parsing. Only note cards are covered in M1 — a
  // pdf card's relocation has no vault API to enumerate PDFs the way
  // `listMarkdownFiles()` does for notes (out of scope; the actual decision
  // of *which* cards get relocated lives in domain/selfHeal.ts so it's
  // unit-testable without a vault fixture). A card with zero or multiple
  // same-basename candidates is left alone — it keeps rendering as the
  // existing "file missing" placeholder (renderMissingFilePlaceholder)
  // rather than risk repointing to the wrong note.
  // ---------------------------------------------------------------------

  private selfHealMissingNoteCards(): void {
    const missing: MissingNoteCard[] = []
    for (const card of this.board.cards) {
      if (card.type !== 'note') continue
      const entry = this.host.vault.getEntry(card.file)
      if (entry && entry.kind === 'file') continue
      missing.push({ cardId: card.id, file: card.file })
    }
    if (missing.length === 0) return

    const relocations = planNoteCardSelfHeal(
      missing,
      this.host.vault.listMarkdownFiles(),
    )
    if (relocations.length === 0) return

    let board = this.board
    for (const relocation of relocations) {
      board = updateCard(board, relocation.cardId, { file: relocation.file })
    }
    this.board = board
    this.syncBoardIndex()
    this.context.requestSave()
  }

  // ---------------------------------------------------------------------
  // Content-freshness (p1-design §1.2, "内容时效"): a mounted note card's
  // static preview reflects an external edit to its backing file without
  // requiring the whole `.yoloboard` to reload. Two guards keep this from
  // fighting the edit lifecycle:
  //   - a card currently in edit mode is skipped entirely — the live
  //     editor's content is authoritative and must never be silently
  //     replaced out from under a typing user;
  //   - `runtime.noteText === text` short-circuits the render for the
  //     redundant modify event `finishEdit`'s own `writeText` triggers,
  //     without needing an "ignore my own write" time-window flag.
  // ---------------------------------------------------------------------

  private handleBackingFileModified(path: string): void {
    if (this.parseFailed) return
    for (const [id, card] of this.boardCardsById) {
      if (card.type !== 'note' || card.file !== path) continue
      if (this.editing?.cardId === id) continue
      const runtime = this.runtimeByCardId.get(id)
      if (!runtime?.el) continue // not currently mounted
      void this.refreshMountedNoteCard(id, runtime, path)
    }
  }

  private async refreshMountedNoteCard(
    id: CardId,
    runtime: CardRuntime,
    path: string,
  ): Promise<void> {
    let text: string
    try {
      text = await this.host.vault.readText(path)
    } catch (error) {
      this.reportError('readText (modify refresh)', error)
      return
    }
    // The card may have unmounted, been superseded, or entered edit mode
    // while the read above was in flight.
    if (this.runtimeByCardId.get(id) !== runtime) return
    if (this.editing?.cardId === id) return
    if (runtime.noteText === text) return // no real change — short-circuit
    runtime.noteText = text
    runtime.missingFile = false
    await this.renderMarkdownInto(id, runtime, text, path)
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
    return createWhiteboardTranslation(this.host.i18n.getSnapshot().locale)(
      key,
      fallback,
    )
  }

  private reportError(stage: string, error: unknown): void {
    console.error(`[YOLO Whiteboard] ${stage} failed`, error)
  }
}
