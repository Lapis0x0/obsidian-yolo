// Card mount/unmount, the hidden card pool, and per-card content rendering
// for the `.yoloboard` canvas (docs/plans/08-25-yolo-whiteboard/p1-design.md
// §3). Split out of `../canvas.ts` structurally (no behavior change): that
// file remains the single state owner (board data, selection, editing) and
// this class owns only the DOM/runtime side of a mounted card, reached
// through the narrow `CardRendererCallbacks` it is constructed with.
//
// `WhiteboardCanvas` is the only importer; this module must never import it
// back (single-direction dependency between the canvas and its
// collaborators).

import type { BoardNode, NodeId } from '../../domain/fileFormat'
import {
  type FileNodeKind,
  basenameWithoutExtension,
  fileNodeKind,
} from '../../domain/naming'
import {
  CARD_BODY_LIVE_CLASS,
  CARD_BODY_SCROLLS_CLASS,
  CARD_FOCUSED_CLASS,
  CARD_SELECTED_CLASS,
  GROUP_LABEL_CLASS,
  WEB_URL_PATTERN,
} from '../constants'
import { cardMarkdownWindow, nodeTitleText } from '../lod'
import { applyColorToElement } from '../selectionToolbar'

/** The host's one-pass Markdown renderer. Named through the Host API rather
 * than imported: the module SDK exports no alias for it. */
type CardMarkdownRenderer = ReturnType<
  YoloModuleHostApiV1['ui']['createMarkdownRenderer']
>

/** Obsidian's own preview wrapper chain, rebuilt around a one-pass render.
 * Same classes as `createMarkdownContentView` produces, so every rule that
 * styles a card's content — Obsidian's element styling keyed off
 * `markdown-rendered`, and style.css's inset and card-scale type — applies to
 * both without a second set of selectors to keep in step. */
const PREVIEW_VIEW_CLASS = 'markdown-preview-view markdown-rendered'
const PREVIEW_SIZER_CLASS = 'markdown-preview-sizer markdown-preview-section'

const CARD_CLASS = 'yolo-whiteboard-card'
const GROUP_CLASS = 'yolo-whiteboard-group'
const CARD_BODY_CLASS = 'yolo-whiteboard-card-body'
const CARD_MEDIA_CLASS = 'yolo-whiteboard-card-media'
const CARD_WEB_FRAME_CLASS = 'yolo-whiteboard-card-web-frame'
const CARD_TITLE_CLASS = 'yolo-whiteboard-card-title'
const CARD_TITLE_BLOCK_CLASS = 'yolo-whiteboard-card-title-block'
const CARD_MISSING_CLASS = 'yolo-whiteboard-card-missing'
const CARD_UNSUPPORTED_PLACEHOLDER_CLASS =
  'yolo-whiteboard-card-unsupported-placeholder'
/** A card parked in the hidden pool: out of the viewport, out of sight, still
 * in the document so what it holds survives. Invisible but still laid out,
 * because its content view's section measurements are the expensive part and
 * they only survive if its boxes do — see `parkCard` and style.css. */
const CARD_PARKED_CLASS = 'yolo-whiteboard-card-parked'
/** A parked *web* card: taken out of layout altogether, which suspends the
 * page inside it. See WEB_FRAME_POOL_CAPACITY. */
const CARD_POOLED_CLASS = 'yolo-whiteboard-card-pooled'
const CARD_HINT_CLASS = 'yolo-whiteboard-card-hint'

/**
 * What a web card's frame is allowed to do.
 *
 * Copied verbatim from Obsidian's own non-desktop link node (`app.js`'s
 * `recreateFrame`), which is a sandboxed `<iframe>`. Its desktop branch uses
 * an Electron `<webview>` instead, and we deliberately do not: the parts that
 * make that webview safe — `app.getWebviewPartition()` plus the
 * `create-browser-session` IPC that installs the session's permission
 * allowlist (clipboard only), user-agent scrubbing and ad blocking — are host
 * internals a module cannot reach, and Electron grants every permission a page
 * asks for when no such handler is installed. `webviewTag` *is* enabled in
 * both the main window and popouts (verified against `main.js`), so this is a
 * deliberate trade, not a missing capability: an iframe grants no permissions
 * by default and behaves identically on mobile, at the cost of the sites that
 * refuse to be framed.
 */
const WEB_FRAME_SANDBOX =
  'allow-forms allow-presentation allow-same-origin allow-scripts allow-modals'

/**
 * How many *web* cards may keep a live page while parked off screen
 * (p3-canvas-parity §六's D13 scope revision).
 *
 * An `<iframe>` removed from the document tree loses its browsing context, and
 * re-inserting it reloads the page from the top — every scroll position, form
 * field and session in it gone. So a web card that scrolls out of the viewport
 * is hidden rather than destroyed. Each survivor is a whole live page (its own
 * JavaScript, timers, sockets and media), which is why this cap is small and
 * separate from the pool's own: six background pages is already a real cost,
 * and a board with more than six web cards in play at once is not the case
 * this exists for. Past the cap the least-recently-seen one is destroyed for
 * real. Every other parked card is inert DOM and answers to `parkedCapacity`.
 */
const WEB_FRAME_POOL_CAPACITY = 6

export type NodeRuntime = {
  el: HTMLElement | null
  bodyEl: HTMLElement | null
  /** A card's read-only content, one-pass rendered from as much of its source
   * as the card can show (`cardMarkdownWindow`). What every card that is not
   * the focused one holds — so what a pan pays for. Null while the card shows
   * a placeholder, is being edited, or holds the scrollable view below. */
  contentRenderer: CardMarkdownRenderer | null
  /** The focused card's content: Obsidian's windowed preview over the *whole*
   * note, because that card can be scrolled and the rest cannot. At most one
   * card on the board has this. Mutually exclusive with `contentRenderer`. */
  contentView: YoloModuleHostMarkdownContentViewV1 | null
  /** What the content above was built against. Links resolve against this, so
   * a card whose source moves needs a new render rather than none. */
  contentSourcePath: string | null
  /** The exact markdown last handed to the renderer — the *prefix* for an
   * unfocused card, the whole note for the focused one. Compared before
   * re-rendering so an edit below a card's fold, which cannot change what the
   * card shows, costs nothing. */
  contentMarkdown: string | null
  /**
   * Teardown for a body that holds something other than a content view — a
   * media element or a web frame. Removing those from the DOM is not enough:
   * a detached `<audio>`/`<video>` keeps playing and keeps streaming, and a
   * detached frame keeps its page alive until it is collected. Null whenever
   * the body holds nothing that needs releasing.
   */
  releaseContent: (() => void) | null
  /**
   * The URL this card's live web frame was built for, or null when its body
   * holds anything else. Set only for web cards, and the flag that decides
   * whether an unmount parks the card in the hidden pool instead of tearing it
   * down (see WEB_FRAME_POOL_CAPACITY and `unmountNode`).
   */
  webFrameUrl: string | null
  missingFile: boolean
  /** Last known content for a *note* card (its backing file's text), cached
   * because note-card content never lives in `board` (p1-design §1.2) — this
   * is the only place it's available to seed the live editor. Unused for
   * text/pdf cards. */
  noteText: string | null
}

/**
 * The narrow surface `WhiteboardCanvas` injects so a card's DOM lifecycle can
 * read board/selection/editing state it does not own, and call back into
 * canvas-owned systems (the content-sync queue, virtualization, rename), all
 * without this class importing the canvas.
 */
export type CardRendererCallbacks = Readonly<{
  getNode: (id: NodeId) => BoardNode | undefined
  isSelected: (id: NodeId) => boolean
  isFocused: (id: NodeId) => boolean
  isEditing: (id: NodeId) => boolean
  isRenamingGroup: (id: NodeId) => boolean
  onGroupLabelKeyDown: (id: NodeId, event: KeyboardEvent) => void
  onGroupLabelBlur: (id: NodeId) => void
  canBuildContent: () => boolean
  queueContentSync: (id: NodeId) => void
  dequeueContentSync: (id: NodeId) => void
  getMountedCount: () => number
  /** Full teardown of a node's runtime plus everything canvas.ts owns for it
   * (pinning, the content-sync queue, virtualization bookkeeping, an
   * in-progress group rename) — the other half of what was one
   * `purgeNodeRuntime` method before this class existed. Only `evictParkedCard`
   * still needs the *combined* operation; every other caller already lives in
   * canvas.ts and calls its own `purgeNodeRuntime`, which calls this class's
   * `destroyRuntime` for the half that moved here. */
  purgeNode: (id: NodeId) => void
  getSourcePath: () => string
  reportError: (stage: string, error: unknown) => void
  t: (key: string, fallback?: string) => string
}>

/**
 * Owns the mounted-card runtime map, the hidden/pooled card cache, and the
 * per-card content build (markdown preview, media, web frame, placeholders).
 * One instance per `WhiteboardCanvas`, constructed once its world layer
 * element exists (see `ensureDom`).
 */
export class CardRenderer {
  private readonly runtimeByNodeId = new Map<NodeId, NodeRuntime>()
  /**
   * Cards parked off screen with what they hold intact, least-recently-seen
   * first: a Set iterates in insertion order, and every re-park deletes before
   * it adds, so the iteration order *is* the LRU order and the first entry is
   * always the one to evict. See `parkCard`.
   */
  private readonly parkedCards = new Set<NodeId>()
  /**
   * Pool capacity while it is pinned, or null when it follows the mounted set
   * as usual — see `freezeParkedCapacity`.
   */
  private frozenParkedCapacity: number | null = null
  /**
   * The same pin for the web frames' own, much smaller pool — null while it
   * follows WEB_FRAME_POOL_CAPACITY as usual. See `freezeParkedCapacity`.
   */
  private frozenWebFramePoolCapacity: number | null = null
  /**
   * Group label size in world units while the overview tier is overriding it,
   * or null while the stylesheet's own value stands — see
   * `setGroupLabelFontSize`.
   */
  private groupLabelFontPx: number | null = null

  constructor(
    private readonly context: YoloModuleHostFileViewContextV1,
    private readonly host: YoloModuleHostApiV1,
    private readonly worldEl: HTMLElement,
    private readonly callbacks: CardRendererCallbacks,
  ) {}

  // -----------------------------------------------------------------------
  // Runtime lookup — the read-only surface canvas.ts's own gesture,
  // selection, edit and history-restore code reaches a mounted card's DOM
  // through, now that this class owns `runtimeByNodeId`.
  // -----------------------------------------------------------------------

  getRuntime(id: NodeId): NodeRuntime | undefined {
    return this.runtimeByNodeId.get(id)
  }

  /** Tears every mounted/parked card down to nothing — used by
   * canvas.ts's `teardownAllCards` on a full reload/dispose. */
  destroyAll(): void {
    for (const runtime of this.runtimeByNodeId.values()) {
      this.destroyCardContent(runtime)
      runtime.el?.remove()
      runtime.el = null
      runtime.bodyEl = null
    }
    this.runtimeByNodeId.clear()
    this.parkedCards.clear()
  }

  /**
   * The `runtimeByNodeId`/`parkedCards` half of what used to be one
   * `purgeNodeRuntime` method: destroys a card's content, removes its
   * element, and drops both maps' entries. The rest of that teardown
   * (ending an in-progress rename, unpinning, dequeuing, telling the
   * virtualization engine) is canvas-owned state this class never touches —
   * see `CardRendererCallbacks.purgeNode` for how the two halves stay one
   * operation from every other caller's point of view.
   */
  destroyRuntime(id: NodeId): void {
    const runtime = this.runtimeByNodeId.get(id)
    if (runtime) {
      this.destroyCardContent(runtime)
      runtime.el?.remove()
    }
    this.runtimeByNodeId.delete(id)
    this.parkedCards.delete(id)
  }

  // -----------------------------------------------------------------------
  // Card mount/unmount
  // -----------------------------------------------------------------------

  mountNode(id: NodeId): void {
    const node = this.callbacks.getNode(id)
    const existing = this.runtimeByNodeId.get(id)
    // A card that never really left (it was parked in the hidden pool) comes
    // back by being shown again — rebuilding it would be exactly the page
    // reload, or the whole-note re-parse, the pool exists to prevent.
    if (existing?.el && this.parkedCards.has(id)) {
      this.revealParkedCard(id)
      return
    }
    if (!node || existing?.el) return

    const doc = this.context.getDocument()
    const el = doc.createElement('div')
    el.className = node.type === 'group' ? GROUP_CLASS : CARD_CLASS
    el.style.left = `${node.x}px`
    el.style.top = `${node.y}px`
    el.style.width = `${node.w}px`
    el.style.height = `${node.h}px`
    el.dataset.nodeId = id
    // JSON Canvas's `color` (p3-canvas-parity D5): a preset or a hex, both
    // resolved to the one custom property style.css paints from.
    applyColorToElement(el, node.color)
    // Re-apply selection state — a selected node can unmount (scrolled
    // off-screen) and remount without its selection ever changing.
    if (this.callbacks.isSelected(id)) el.classList.add(CARD_SELECTED_CLASS)
    if (this.callbacks.isFocused(id)) el.classList.add(CARD_FOCUSED_CLASS)

    // A group is a labelled frame behind the cards, not a card: it has no
    // body, no content view and no title block (p3-canvas-parity D5, and
    // batch 3 for the membership interactions). Everything else a node gets
    // here — selection, dragging, resizing, edges — it gets for free, because
    // it goes through the same runtime as a card.
    if (node.type === 'group') {
      const label = doc.createElement('div')
      label.className = GROUP_LABEL_CLASS
      label.textContent = node.label ?? ''
      // The label is renamed in place (see beginRename), so it needs the
      // two listeners that end a rename. They are attached here, for the
      // element's whole life, rather than for the duration of a session:
      // both are no-ops until this group is the one being renamed, and a
      // listener that outlives its session cannot leak one that doesn't.
      label.spellcheck = false
      label.addEventListener('keydown', (event) =>
        this.callbacks.onGroupLabelKeyDown(id, event),
      )
      label.addEventListener('blur', () => this.callbacks.onGroupLabelBlur(id))
      el.appendChild(label)
      this.worldEl.appendChild(el)
      // A group mounting while the overview tier holds labels at a screen size
      // has to arrive at that size, not at the stylesheet's.
      if (this.groupLabelFontPx !== null) {
        label.style.fontSize = `${this.groupLabelFontPx}px`
      }
      this.runtimeByNodeId.set(id, {
        el,
        bodyEl: null,
        contentRenderer: null,
        contentView: null,
        contentMarkdown: null,
        contentSourcePath: null,
        releaseContent: null,
        webFrameUrl: null,
        missingFile: false,
        noteText: null,
      })
      return
    }

    // A card whose content comes from outside the board carries its title in
    // chrome rather than in its text: a file card shows its file name
    // (Obsidian's convention is that a note's name *is* its title, so a note
    // dragged onto the board would otherwise arrive as a body with nothing
    // naming it), and a web card its URL — the only thing about a page we can
    // know without asking the page.
    //
    // Drawn *above* the card, not in it (style.css), and there through edit
    // mode. Obsidian Canvas shows the same name twice: a label above the node
    // and, inside it, the embed's own inline title — which disappears the
    // moment the embed is swapped for an editor (measured). One title that
    // never moves beats two that take turns, and outside is where it belongs,
    // because a name that came from outside the content is a label on the box
    // rather than a line of it.
    //
    // A text card gets none: its first line is its own title, and repeating
    // it above the card would be the duplication this arrangement exists to
    // avoid.
    //
    // Canvas replaces a link node's URL with the page's own title once the
    // webview reports one; a sandboxed cross-origin iframe never will, so the
    // URL is what the card says. Also a drag handle — a focused web card's
    // body belongs to the page (see the content mask) and this does not, and
    // it stays one from outside the box because hit-testing walks the DOM
    // (`nodeIdFromEventTarget`), not the geometry.
    const chromeTitle =
      node.type === 'file'
        ? basenameWithoutExtension(node.file)
        : node.type === 'link'
          ? node.url
          : null
    if (chromeTitle !== null) {
      const title = doc.createElement('div')
      title.className = CARD_TITLE_CLASS
      title.textContent = chromeTitle
      el.appendChild(title)
    }

    const body = doc.createElement('div')
    body.className = CARD_BODY_CLASS
    el.appendChild(body)

    // Title block: always built — it is a line of text, and it is what the
    // card shows for as long as its body holds nothing, which is every card
    // between mounting and its content build. Which of the two is laid out is
    // the stylesheet's answer to whether the body is empty; nothing here
    // toggles it. Computed once from card data at mount time; card
    // title-affecting fields (file/markdown) never change post-mount in M1,
    // only position does.
    const titleBlock = doc.createElement('div')
    titleBlock.className = CARD_TITLE_BLOCK_CLASS
    titleBlock.textContent = nodeTitleText(node)
    el.appendChild(titleBlock)

    // Click-to-edit vs. drag-to-move is disambiguated centrally in
    // onPointerDown/Move/Up (DRAG_THRESHOLD_PX) rather than a per-card
    // `click` listener, so the same gesture can also drive dragging.

    this.worldEl.appendChild(el)
    this.runtimeByNodeId.set(id, {
      el,
      bodyEl: body,
      contentRenderer: null,
      contentView: null,
      contentMarkdown: null,
      contentSourcePath: null,
      releaseContent: null,
      webFrameUrl: null,
      missingFile: false,
      noteText: existing?.noteText ?? null,
    })

    void this.renderCardPreview(id)
  }

  unmountNode(id: NodeId): void {
    const runtime = this.runtimeByNodeId.get(id)
    if (!runtime?.el) return
    // A pinned (editing) card is never queued for unmount by the
    // virtualization engine, but stay defensive: only the commit path
    // (finishEdit) ever destroys a live editor.
    if (this.callbacks.isEditing(id)) return
    // A group being renamed is pinned for the same reason: its label holds
    // the caret, and unmounting would take the text being typed with it.
    if (this.callbacks.isRenamingGroup(id)) return
    // Two kinds of card are hidden rather than destroyed, for the same reason
    // at two scales: putting them back costs more than keeping them.
    //
    //   - a web card would reload its page (WEB_FRAME_POOL_CAPACITY);
    //   - a card showing rendered markdown would re-parse the whole note
    //     behind it — ~2ms for a five-line card but ~25ms for a 160-line one
    //     (2026-08-31 baseline), and a pan that pushes a card off one edge
    //     very often brings it back moments later: half the mounts in one
    //     measured pan were cards that had just left. This is D13's verdict,
    //     taken on that measurement.
    //
    // Everything else — media (its "off-screen stops playing" is deliberate,
    // p3-canvas-parity §六), placeholders, groups — is torn down here, because
    // rebuilding it costs nothing worth keeping DOM for.
    if (
      runtime.webFrameUrl !== null ||
      runtime.contentRenderer !== null ||
      runtime.contentView !== null
    ) {
      this.parkCard(id, runtime)
      return
    }
    this.destroyCardContent(runtime)
    this.callbacks.dequeueContentSync(id)
    runtime.el.remove()
    runtime.el = null
    runtime.bodyEl = null
  }

  // -----------------------------------------------------------------------
  // Hidden card pool (p3-canvas-parity §六, and D13's verdict).
  //
  // Obsidian Canvas parks an off-screen node by detaching its content element
  // and keeping the instance in a cache. We park the whole card in place
  // instead: `display: none` stops layout, paint and hit-testing while
  // leaving everything attached, which is both simpler and the only thing
  // that works for an iframe (a detached frame loses its browsing context).
  //
  // Parking in place is also what keeps a pool from needing an invalidation
  // story of its own — the thing D13 was right to be wary of. A parked card
  // is still a card: it keeps its runtime entry, its element and its place in
  // `runtimeByNodeId`, so every path that updates a mounted card (an external
  // edit through `handleBackingFileModified`, an undo through
  // `applyHistoryBoard`, a delete through `purgeNodeRuntime`) reaches it
  // unchanged. There is no second copy of anything to go stale.
  // -----------------------------------------------------------------------

  private parkCard(id: NodeId, runtime: NodeRuntime): void {
    // A page has to leave layout to be suspended; a rendered note has to stay
    // in it to keep the measurements that make coming back free.
    runtime.el?.classList.add(
      runtime.webFrameUrl !== null ? CARD_POOLED_CLASS : CARD_PARKED_CLASS,
    )
    this.callbacks.dequeueContentSync(id)
    // Delete before adding so a re-parked card moves to the back of the queue:
    // insertion order is the LRU order (see `parkedCards`).
    this.parkedCards.delete(id)
    this.parkedCards.add(id)
    this.evictExcessParkedCards()
  }

  private revealParkedCard(id: NodeId): void {
    const runtime = this.runtimeByNodeId.get(id)
    const node = this.callbacks.getNode(id)
    this.parkedCards.delete(id)
    if (!runtime?.el) return
    runtime.el.classList.remove(CARD_POOLED_CLASS, CARD_PARKED_CLASS)
    // The card sat out however much moved while it was hidden: an undo, an
    // align, a colour change on a multi-selection. Its geometry and its
    // selection state are re-applied from the board rather than trusted.
    if (node) {
      runtime.el.style.left = `${node.x}px`
      runtime.el.style.top = `${node.y}px`
      runtime.el.style.width = `${node.w}px`
      runtime.el.style.height = `${node.h}px`
      applyColorToElement(runtime.el, node.color)
    }
    runtime.el.classList.toggle(
      CARD_SELECTED_CLASS,
      this.callbacks.isSelected(id),
    )
    runtime.el.classList.toggle(
      CARD_FOCUSED_CLASS,
      this.callbacks.isFocused(id),
    )
  }

  /**
   * Destroys the least-recently-seen parked cards until the pool is within
   * capacity. Eviction is a real teardown: the card is rebuilt from scratch
   * the next time it is on screen.
   *
   * Two capacities, because the two kinds of parked card cost different
   * things. A parked page is still running, so web cards answer to their own
   * small cap; everything else is inert DOM and is capped at **what the
   * screen itself holds** — the pool exists to catch the cards a gesture just
   * pushed off the edges, and a gesture cannot push off more than a screenful
   * before the ones it pushed first stop being worth keeping. Scaling with
   * the mounted set rather than a fixed number also means the cap follows the
   * zoom and the window size instead of being tuned for one of them.
   */
  private evictExcessParkedCards(): void {
    const livePages = [...this.parkedCards].filter(
      (id) => this.runtimeByNodeId.get(id)?.webFrameUrl != null,
    )
    for (const id of livePages.slice(
      0,
      Math.max(0, livePages.length - this.webFramePoolCapacity),
    )) {
      this.evictParkedCard(id)
    }
    while (this.parkedCards.size > this.parkedCapacity) {
      const oldest = this.parkedCards.values().next().value
      if (oldest === undefined) return
      this.evictParkedCard(oldest)
    }
  }

  private get parkedCapacity(): number {
    return this.frozenParkedCapacity ?? this.callbacks.getMountedCount()
  }

  private get webFramePoolCapacity(): number {
    return this.frozenWebFramePoolCapacity ?? WEB_FRAME_POOL_CAPACITY
  }

  /**
   * Pins the pool's capacity at what the board is holding right now, for as
   * long as the overview tier lasts (P4-D5).
   *
   * Entering that tier unmounts every card at once, which the ordinary rule
   * would read as "the mounted set is empty, so the pool should be too" and
   * answer by destroying everything the user is about to come back to. But
   * zooming out to find a region and back in to work in it is one action, not
   * two, and the far end of it must not be a screen rebuilding itself. The
   * pinned cards cost hidden DOM and no drawing — the trade the pool exists to
   * make, held for the length of one gesture.
   *
   * Pinned at what is mounted *plus* what is already parked, so the way in
   * throws nothing away either.
   *
   * Both pools, not just the big one. A web card answers to its own cap
   * (WEB_FRAME_POOL_CAPACITY) whatever the other says, so freezing only the
   * general capacity would leave a board with more than six web cards on
   * screen destroying the ones over the cap on the way in — and a destroyed
   * frame is a page reloaded from the top when it comes back, which is the one
   * thing this tier's pool exists to prevent. Frozen at the water mark, which
   * is never below what is currently held, so the freeze itself evicts
   * nothing; the tier mounts no new card, so nothing can be added to it while
   * it is held.
   */
  freezeParkedCapacity(): void {
    this.frozenParkedCapacity =
      this.parkedCards.size + this.callbacks.getMountedCount()
    let livePages = 0
    for (const runtime of this.runtimeByNodeId.values()) {
      if (runtime.webFrameUrl !== null) livePages += 1
    }
    this.frozenWebFramePoolCapacity = livePages
  }

  /**
   * Lets both capacities follow their usual rule again. Deliberately does not
   * evict on the spot: this runs as the camera comes back up, when the pool is
   * full of exactly the cards about to be asked for and the mounted set has
   * not caught up yet. The next card to park trims it.
   */
  unfreezeParkedCapacity(): void {
    this.frozenParkedCapacity = null
    this.frozenWebFramePoolCapacity = null
  }

  /**
   * Overrides the world-unit font size of every group's label, or clears the
   * override with `null` (see constants.ts's
   * OVERVIEW_GROUP_LABEL_MIN_SCREEN_PX).
   *
   * Written on the label elements themselves rather than as a custom property
   * on the world layer, which would be the shorter code and is the trap
   * cameraController.ts's `applyZoomScale` documents: a custom property written
   * on an element invalidates the style of its whole subtree, and the world's
   * subtree includes every edge path on the board. There are a few dozen group
   * labels; this touches exactly them.
   */
  setGroupLabelFontSize(worldPx: number | null): void {
    if (worldPx === this.groupLabelFontPx) return
    this.groupLabelFontPx = worldPx
    for (const [id, runtime] of this.runtimeByNodeId) {
      if (this.callbacks.getNode(id)?.type !== 'group') continue
      this.applyGroupLabelFontSize(runtime)
    }
  }

  /**
   * A group element's only child is its label — this class built it, so the
   * cast states what it already knows.
   *
   * Deliberately not `instanceof HTMLElement`: in an Obsidian popout the node
   * belongs to another window, whose `HTMLElement` is a different constructor,
   * and the check would answer false for every group on the board (CLAUDE.md,
   * Popout / Multi-window). Measured: it silently left every label at its
   * stylesheet size in a popped-out view.
   */
  private applyGroupLabelFontSize(runtime: NodeRuntime): void {
    const label = runtime.el?.firstElementChild as HTMLElement | null
    if (!label) return
    if (this.groupLabelFontPx === null) {
      label.style.removeProperty('font-size')
      return
    }
    label.style.fontSize = `${this.groupLabelFontPx}px`
  }

  private evictParkedCard(id: NodeId): void {
    this.parkedCards.delete(id)
    this.callbacks.purgeNode(id)
  }

  /**
   * Releases whatever the card's body currently holds, whichever kind it is —
   * the single teardown every path (unmount, re-render, edit) goes through,
   * so a new content kind cannot be added and leak from one of them.
   */
  destroyCardContent(runtime: NodeRuntime): void {
    runtime.contentRenderer?.unload()
    runtime.contentRenderer = null
    runtime.contentView?.destroy()
    runtime.contentView = null
    runtime.contentSourcePath = null
    runtime.contentMarkdown = null
    runtime.webFrameUrl = null
    const release = runtime.releaseContent
    runtime.releaseContent = null
    if (release) {
      try {
        release()
      } catch (error) {
        this.callbacks.reportError('card content release', error)
      }
    }
    runtime.bodyEl?.classList.remove(CARD_BODY_LIVE_CLASS)
    runtime.bodyEl?.classList.remove(CARD_BODY_SCROLLS_CLASS)
  }

  /**
   * Builds whatever a card shows below its title — rendered markdown, a media
   * element, an embedded page, or a placeholder for the cases that have none
   * of those.
   *
   * There is no zoom gate here any more: a card that is mounted at all is one
   * the camera is close enough to read, because below that threshold it has no
   * element (constants.ts's OVERVIEW_SCALE_THRESHOLD). What still paces the
   * work is the frame gate in `renderMarkdownInto`, which prices it where it
   * lands rather than by where the camera is.
   */
  async renderCardPreview(id: NodeId): Promise<void> {
    const node = this.callbacks.getNode(id)
    const runtime = this.runtimeByNodeId.get(id)
    // A group has no body: it is a frame, drawn once at mount.
    if (!node || node.type === 'group' || !runtime?.bodyEl) return

    if (node.type === 'link') {
      this.renderWebFrameInto(runtime, node.url)
      return
    }

    if (node.type === 'file') {
      // A JSON Canvas file node can point at anything in the vault, and its
      // extension is the only thing that says what to build for it
      // (domain/naming.ts's fileNodeKind). Existence is checked first for
      // every kind: "this file is gone" is the more useful thing to say about
      // a missing PDF than "no card for this type yet".
      const entry = this.host.vault.getEntry(node.file)
      if (!entry || entry.kind !== 'file') {
        runtime.missingFile = true
        runtime.noteText = null
        this.renderMissingFilePlaceholder(runtime, node.file)
        return
      }
      runtime.missingFile = false
      const kind = fileNodeKind(node.file)
      if (kind !== 'markdown') {
        // Only markdown has text an editor could be seeded from; leaving the
        // cache set from a previous identity would seed one with a stale note.
        runtime.noteText = null
        if (kind === 'unsupported') {
          this.renderUnsupportedFilePlaceholder(runtime, node.file)
        } else {
          this.renderMediaInto(runtime, node.file, kind)
        }
        return
      }
      let text: string
      try {
        text = await this.host.vault.readText(node.file)
      } catch (error) {
        this.callbacks.reportError('readText', error)
        if (this.runtimeByNodeId.get(id) === runtime) {
          runtime.missingFile = true
          this.renderMissingFilePlaceholder(runtime, node.file)
        }
        return
      }
      if (this.runtimeByNodeId.get(id) !== runtime) return // unmounted meanwhile
      runtime.missingFile = false
      runtime.noteText = text
      this.renderMarkdownInto(id, runtime, text, node.file)
      return
    }

    // text node: markdown lives directly in the board.
    this.renderMarkdownInto(
      id,
      runtime,
      node.text,
      this.callbacks.getSourcePath(),
    )
  }

  /**
   * Puts markdown on a card through the one content path both card types
   * share (p3-canvas-parity D2/D11): a one-pass render of as much of the
   * source as the card can show (`cardMarkdownWindow`).
   *
   * The prefix is the whole design. A card clips and does not scroll, so it
   * was only ever going to display its first screenful — but the renderer was
   * being handed the entire note, and paying a parse, an image decode and a
   * post-processor pass over all of it. The windowed preview this used to use
   * bounded what stayed *mounted*, not what got built: it measures every
   * section to know its own height, so a long note cost the whole document on
   * every remount anyway (measured 2026-09-01: 6.3ms a card against 1.06ms
   * for a short one, and 223k transient nodes on a 300-card board). Asking
   * for a prefix bounds the build itself, and makes a card's cost a property
   * of its own geometry rather than of the note behind it.
   *
   * `MarkdownRenderer.render` also happens to be the published API, where the
   * windowed preview reaches into shape Obsidian does not publish
   * (obsidianMarkdownContentView.ts). What the one-pass path does not carry is
   * a view's *behaviour* — an internal link renders but nothing wires its
   * click or its hover preview — which costs a card nothing: everything inside
   * a card that is not being edited is unhittable by design (style.css's
   * content mask, D7).
   *
   * This is the one expensive thing the canvas does per card, and so the one
   * place besides the drain that asks whether this frame may build. It has to
   * ask again here: a note card gets this far only after reading its file,
   * which is one or more frames after the drain that let it start. On a frame
   * that may not build, the card goes back on the queue — its frame is on
   * screen, its text arrives a frame or two later, which is what paying for a
   * long note looks like when the paying is paced.
   */
  /** Public: canvas.ts's content-freshness path (`refreshMountedNoteCard`)
   * calls this directly on an external file modify, without going through
   * `renderCardPreview`'s file-kind dispatch it has already done itself. */
  renderMarkdownInto(
    id: NodeId,
    runtime: NodeRuntime,
    markdown: string,
    sourcePath: string,
  ): void {
    const bodyEl = runtime.bodyEl
    // The card may have been unmounted or swapped into edit mode while the
    // text that got here was being read.
    if (!bodyEl || this.callbacks.isEditing(id)) {
      this.destroyCardContent(runtime)
      return
    }
    if (!this.callbacks.canBuildContent()) {
      this.callbacks.queueContentSync(id)
      return
    }
    // The focused card is the one card that can be scrolled, so it is the one
    // card that needs source outside its own window — see `scrollCardContent`.
    const focused = this.callbacks.isFocused(id)
    const node = this.callbacks.getNode(id)
    const startLine =
      node && (node.type === 'text' || node.type === 'file')
        ? (node.startLine ?? 0)
        : 0
    const wanted = focused
      ? markdown
      : cardMarkdownWindow(markdown, node?.h ?? 0, startLine)
    // Nothing to do when neither the visible source, what it resolves against,
    // nor which of the two surfaces should hold it has changed — which is
    // every edit made below an unfocused card's fold.
    if (
      (focused ? runtime.contentView : runtime.contentRenderer) &&
      runtime.contentSourcePath === sourcePath &&
      runtime.contentMarkdown === wanted
    ) {
      return
    }
    this.destroyCardContent(runtime)
    bodyEl.replaceChildren()
    runtime.contentSourcePath = sourcePath
    runtime.contentMarkdown = wanted
    if (focused) {
      // Obsidian's own windowed preview, which is what a scrollable document
      // wants and what a clipped card does not: it mounts only the sections
      // around its scroll position, so scrolling a long note stays a screenful
      // of DOM however far down it goes. Built for one card, on a deliberate
      // click — never for the hundred a pan brings past.
      try {
        const view = this.host.ui.createMarkdownContentView({
          container: bodyEl,
          value: wanted,
          sourcePath,
        })
        runtime.contentView = view
        // The whole note is mounted, so this body has somewhere to scroll to
        // — and the window the card was showing has to be found again by
        // scrolling to it.
        bodyEl.classList.add(CARD_BODY_SCROLLS_CLASS)
        if (startLine) view.scrollToLine(startLine)
      } catch (error) {
        this.callbacks.reportError('markdown render', error)
      }
      return
    }
    const doc = bodyEl.ownerDocument
    const view = doc.createElement('div')
    view.className = PREVIEW_VIEW_CLASS
    const sizer = doc.createElement('div')
    sizer.className = PREVIEW_SIZER_CLASS
    view.appendChild(sizer)
    bodyEl.appendChild(view)
    let renderer: CardMarkdownRenderer
    try {
      renderer = this.host.ui.createMarkdownRenderer()
    } catch (error) {
      this.callbacks.reportError('markdown render', error)
      return
    }
    runtime.contentRenderer = renderer
    void renderer.render(wanted, sizer, sourcePath).catch((error: unknown) => {
      // A render that lost its card was cancelled, not failed: `unload()`
      // rejects whatever was in flight, and the card has already been torn
      // down or re-rendered by whoever called it.
      if (runtime.contentRenderer !== renderer) return
      this.callbacks.reportError('markdown render', error)
    })
  }

  /**
   * Scrolls a card's own content by a wheel delta, reporting whether it had
   * anywhere to go.
   *
   * The scroller is Obsidian's preview element, which both content surfaces
   * put inside the body (PREVIEW_VIEW_CLASS) — so this reads the same way for
   * the focused card's windowed view and for anything else that ends up
   * asking. Written rather than delegated to the browser because a card's
   * content is deliberately unhittable (style.css's content mask, D7): the
   * wheel never reaches the scroller on its own.
   *
   * False only when there is nothing to scroll at all, which is what hands the
   * gesture back to the board: a card that fits must not swallow a pan.
   *
   * A card that *can* scroll keeps the wheel even at either end of its
   * content, rather than passing the rest of the gesture on. Chaining reads
   * well with a mouse notch and badly with the trackpad this canvas is mostly
   * driven by: one flick has momentum enough to reach the end of a card and
   * then throw the board across the board, which is a gesture nobody asked
   * for. Panning from here is a matter of moving the pointer off a card that
   * takes up a few hundred pixels of a whole canvas.
   */
  /**
   * Where the focused card's preview is currently scrolled to, as a source
   * line, or null when this card has no scrollable surface — which is every
   * card but the focused one.
   */
  getContentScrollLine(id: NodeId): number | null {
    const view = this.runtimeByNodeId.get(id)?.contentView
    if (!view) return null
    const line = view.getScrollLine()
    return Number.isFinite(line) ? line : null
  }

  scrollCardContent(id: NodeId, deltaX: number, deltaY: number): boolean {
    const scroller = this.runtimeByNodeId
      .get(id)
      ?.bodyEl?.querySelector<HTMLElement>('.markdown-preview-view')
    if (!scroller) return false
    const room = scroller.scrollHeight - scroller.clientHeight
    if (room <= 0) return false
    scroller.scrollTop = Math.max(
      0,
      Math.min(room, scroller.scrollTop + deltaY),
    )
    scroller.scrollLeft += deltaX
    return true
  }

  private renderMissingFilePlaceholder(
    runtime: NodeRuntime,
    path: string,
  ): void {
    this.destroyCardContent(runtime)
    this.renderPlaceholder(
      runtime,
      CARD_MISSING_CLASS,
      this.callbacks.t('card.missingFile'),
      this.callbacks.t('card.missingFileHint').replace('{path}', path),
    )
  }

  /** What a file card shows while its file type has no card of its own — a
   * PDF (M2), anything else. Named after the file so the card still says
   * which one it is. */
  private renderUnsupportedFilePlaceholder(
    runtime: NodeRuntime,
    path: string,
  ): void {
    this.destroyCardContent(runtime)
    this.renderPlaceholder(
      runtime,
      CARD_UNSUPPORTED_PLACEHOLDER_CLASS,
      this.callbacks.t('card.unsupportedFile'),
      this.callbacks.t('card.unsupportedFileHint').replace('{path}', path),
    )
  }

  /**
   * Puts a vault image, audio or video file on a card, pointing the element at
   * the same `app://` resource URL Obsidian's own embeds use
   * (`vault.getResourceUrl`) so it streams and seeks exactly as it does in a
   * note (p3-canvas-parity D1).
   *
   * The element fills the card and keeps its aspect ratio without cropping
   * (style.css's `.yolo-whiteboard-card-media`). Obsidian Canvas instead
   * reshapes the *node* to the media's aspect ratio when its content loads,
   * and writes that back to the file — a load-time geometry mutation we
   * deliberately do not copy: our cards mount and unmount with the viewport,
   * so it would rewrite the board on every pan. Aspect-locked geometry belongs
   * with the resize interactions (P3 batch 3).
   *
   * Audio and video get a `releaseContent`: taking a media element out of the
   * DOM neither pauses it nor stops it streaming, so an off-screen card would
   * go on playing out of sight.
   */
  private renderMediaInto(
    runtime: NodeRuntime,
    path: string,
    kind: Exclude<FileNodeKind, 'markdown' | 'unsupported'>,
  ): void {
    this.destroyCardContent(runtime)
    const bodyEl = runtime.bodyEl
    if (!bodyEl) return
    const doc = this.context.getDocument()
    const url = this.host.vault.getResourceUrl(path)
    const frame = doc.createElement('div')
    frame.className = CARD_MEDIA_CLASS

    if (kind === 'image') {
      const image = doc.createElement('img')
      image.src = url
      // Obsidian Canvas sets this on its own image nodes: the card is what a
      // drag moves, and a native image drag would start a competing one.
      image.draggable = false
      frame.appendChild(image)
      bodyEl.replaceChildren(frame)
      return
    }

    // Element attributes copied from Obsidian's own media embed builder
    // (`app.js`'s audio/video embed helpers), so a card plays what a note
    // plays: `controlsList=nodownload` because the file is already in the
    // vault, `preload=metadata` because a board pans dozens of cards through
    // the viewport and only the transport bar has to be drawn until one is
    // played, and the `#t=0.001` fragment because a video with no poster
    // otherwise shows a black rectangle instead of its first frame.
    const media: HTMLMediaElement =
      kind === 'audio' ? doc.createElement('audio') : doc.createElement('video')
    media.controls = true
    media.setAttribute('controlsList', 'nodownload')
    media.preload = 'metadata'
    media.src = kind === 'video' ? `${url}#t=0.001` : url
    frame.appendChild(media)
    bodyEl.replaceChildren(frame)
    bodyEl.classList.add(CARD_BODY_LIVE_CLASS)
    runtime.releaseContent = () => {
      media.pause()
      // Dropping the source is what actually stops the download; `load()` is
      // what makes the element act on it.
      media.removeAttribute('src')
      media.load()
    }
  }

  /**
   * Puts a web page on a card.
   *
   * A sandboxed `<iframe>` — see WEB_FRAME_SANDBOX for why this and not the
   * Electron `<webview>` Obsidian Canvas uses on desktop. Only http(s) loads,
   * exactly as in Canvas's own `setFrameUrl`; anything else is a card that
   * says what it points at rather than a frame pointed somewhere it should
   * not be.
   */
  private renderWebFrameInto(runtime: NodeRuntime, url: string): void {
    // Already showing this exact page: leave it alone. Without this, a
    // re-render of a card whose body already holds the right page — a parked
    // web card revealed again, a content resync — would tear it down and
    // reload it, the reload the hidden pool exists to avoid, arrived at from
    // the other direction.
    if (runtime.webFrameUrl === url) return
    this.destroyCardContent(runtime)
    const bodyEl = runtime.bodyEl
    if (!bodyEl) return
    if (!WEB_URL_PATTERN.test(url)) {
      this.renderPlaceholder(
        runtime,
        CARD_UNSUPPORTED_PLACEHOLDER_CLASS,
        this.callbacks.t('card.linkNotWeb'),
        this.callbacks.t('card.linkNotWebHint').replace('{url}', url),
      )
      return
    }
    const doc = this.context.getDocument()
    const frame = doc.createElement('iframe')
    frame.className = CARD_WEB_FRAME_CLASS
    frame.setAttribute('sandbox', WEB_FRAME_SANDBOX)
    frame.setAttribute('allow', 'fullscreen')
    frame.src = url
    bodyEl.replaceChildren(frame)
    bodyEl.classList.add(CARD_BODY_LIVE_CLASS)
    runtime.webFrameUrl = url
    // A detached frame keeps its page (and its timers, media and sockets)
    // running until it is collected; navigating it away first is what ends
    // them. Reached only on a real teardown now — the node was deleted, the
    // board closed, or the card was evicted from the pool — because an
    // ordinary unmount parks the card instead.
    runtime.releaseContent = () => {
      frame.src = 'about:blank'
      frame.remove()
    }
  }

  private renderPlaceholder(
    runtime: NodeRuntime,
    className: string,
    titleText: string,
    hintText: string,
  ): void {
    if (!runtime.bodyEl) return
    const doc = this.context.getDocument()
    const placeholder = doc.createElement('div')
    placeholder.className = className
    const title = doc.createElement('div')
    title.textContent = titleText
    const hint = doc.createElement('div')
    hint.className = CARD_HINT_CLASS
    hint.textContent = hintText
    placeholder.append(title, hint)
    runtime.bodyEl.replaceChildren(placeholder)
  }
}
