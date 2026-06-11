import type { ChangeSet, Extension } from '@codemirror/state'
import { EditorSelection, StateEffect, StateField } from '@codemirror/state'
import {
  EditorView,
  RectangleMarker,
  ViewPlugin,
  ViewUpdate,
  layer,
} from '@codemirror/view'

import type { HighlightOwner } from './pdfSelectionHighlightController'

// ──────────────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────────────

export type HighlightVariant = 'sync' | 'pinned'

/** Visual style independent of the lifecycle variant. */
type HighlightVisual = 'selection' | 'pending' | 'updated'

type HighlightEntry = {
  view: EditorView
  from: number
  to: number
  variant: HighlightVariant
  visual: HighlightVisual
  owner: HighlightOwner
  timeoutId: number | null
}

/**
 * Payload dispatched via the StateEffect.
 * Each EditorView receives only its own entries filtered from the global map.
 */
export type SelectionHighlightPayloadEntry = {
  id: string
  from: number
  to: number
  visual: HighlightVisual
  variant: HighlightVariant
}

type EffectPayload = SelectionHighlightPayloadEntry[]

const HIDE_NATIVE_SELECTION_CLASS = 'yolo-hide-native-selection'

/** Primary button held after pointerdown in a cm-editor — native CM selection stays visible. */
let isPointerSelecting = false
let pointerTrackingInstalled = false

export function setPointerSelectingForTests(value: boolean): void {
  isPointerSelecting = value
}

function syncHideNativeSelectionClass(view: EditorView): void {
  const hide = shouldHideNativeSelection(
    view.state.field(selectionHighlightField),
    view.state.selection,
  )
  view.dom.classList.toggle(HIDE_NATIVE_SELECTION_CLASS, hide)
}

/**
 * While the user is drag-selecting (primary button down), keep painting native
 * CM selection and skip persisted markers that would duplicate it.
 */
export function shouldPaintPersistedHighlight(
  entry: SelectionHighlightPayloadEntry,
  selection: EditorSelection,
  pointerSelecting = isPointerSelecting,
): boolean {
  if (!pointerSelecting) return true

  if (entry.variant === 'sync') return false

  const main = selection.main
  if (main.empty) return true

  return !(
    entry.variant === 'pinned' &&
    entry.from === main.from &&
    entry.to === main.to
  )
}

/**
 * When our persisted layer is already painting the selection, suppress
 * CodeMirror's native selection background to avoid double-stacked highlights.
 */
export function shouldHideNativeSelection(
  payload: EffectPayload,
  selection: EditorSelection,
  pointerSelecting = isPointerSelecting,
): boolean {
  if (pointerSelecting) return false

  if (payload.some((entry) => entry.variant === 'sync')) {
    return true
  }

  const main = selection.main
  if (main.empty) {
    return false
  }

  return payload.some(
    (entry) =>
      entry.variant === 'pinned' &&
      entry.from === main.from &&
      entry.to === main.to,
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// CSS class names (yolo- prefix per CLAUDE.md)
// ──────────────────────────────────────────────────────────────────────────────

const NATIVE_SELECTION_CLASS = 'cm-selectionBackground'
const CLASS_SELECTION = 'yolo-selection-persisted-layer'
const CLASS_UPDATED = 'yolo-selection-persisted-layer-updated'
const CLASS_PENDING = 'yolo-selection-persisted-layer-pending'

function buildMarkerClassName(visual: HighlightVisual): string {
  const parts = [NATIVE_SELECTION_CLASS, CLASS_SELECTION]
  if (visual === 'updated') parts.push(CLASS_UPDATED)
  else if (visual === 'pending') parts.push(CLASS_PENDING)
  return parts.join(' ')
}

/**
 * Paint only the glyphs on each non-empty line. Full-range forRange also draws
 * full-width "between" rectangles across blank lines in multi-line selections;
 * per-line segments match the tighter look users expect for persisted highlights.
 */
function markersForTextRange(
  view: EditorView,
  className: string,
  from: number,
  to: number,
): RectangleMarker[] {
  const doc = view.state.doc
  const startLine = doc.lineAt(from).number
  const endLine = doc.lineAt(to).number
  const markers: RectangleMarker[] = []

  for (let n = startLine; n <= endLine; n++) {
    const line = doc.line(n)
    if (!line.text.length) continue

    const segFrom = Math.max(from, line.from)
    const segTo = Math.min(to, line.to)
    if (segFrom >= segTo) continue

    markers.push(
      ...RectangleMarker.forRange(
        view,
        className,
        EditorSelection.range(segFrom, segTo),
      ),
    )
  }

  return markers
}

// ──────────────────────────────────────────────────────────────────────────────
// CodeMirror state primitives
// ──────────────────────────────────────────────────────────────────────────────

const setSelectionHighlightEffect = StateEffect.define<EffectPayload | null>()

/**
 * StateField stores the current highlight payload as plain data.
 * No longer stores a DecorationSet — rendering is done by the layer extension.
 */
const selectionHighlightField = StateField.define<EffectPayload>({
  create() {
    return []
  },
  update(state, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSelectionHighlightEffect)) {
        return effect.value ?? []
      }
    }
    // No effect this transaction — keep payload but map offsets through
    // any document changes so the layer renders at correct positions
    // until the controller dispatches a fresh payload.
    if (tr.docChanged && state.length > 0) {
      return state.map((e) => ({
        ...e,
        from: tr.changes.mapPos(e.from, 1),
        to: tr.changes.mapPos(e.to, -1),
      }))
    }
    return state
  },
})

const INTERACTIVE_OVERLAY_SELECTOR = [
  '.yolo-quick-ask-overlay-root',
  '.yolo-quick-ask-overlay',
  '.yolo-selection-chat-overlay-root',
  '.yolo-selection-chat-overlay',
].join(', ')

// ──────────────────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────────────────

export class SelectionHighlightController {
  /** Global registry keyed by highlight id. */
  private entries = new Map<string, HighlightEntry>()

  /** Counter used to generate unique ids for backward-compat wrappers. */
  private transientCounter = 0

  // ── Public API ───────────────────────────────────────────────────────────────

  createExtension(): Extension {
    this._ensurePointerTracking()

    return [
      selectionHighlightField,
      EditorView.theme({
        [`&.${HIDE_NATIVE_SELECTION_CLASS}`]: {
          '& ::selection, & *::selection': {
            background: 'transparent !important',
          },
          '& .cm-selectionLayer': {
            display: 'none',
          },
          '& .cm-line .cm-selection, & .cm-line .cm-inline-code .cm-selection':
            {
              backgroundColor: 'transparent !important',
            },
        },
      }),
      // Layer renders highlight rectangles using absolutely-positioned divs,
      // without touching the document DOM (no text-node splitting).
      layer({
        above: true,
        class: 'yolo-selection-highlight-layer',
        update(update: ViewUpdate): boolean {
          // Redraw whenever the stored payload changed or the viewport moved.
          for (const effect of update.transactions.flatMap(
            (tr) => tr.effects,
          )) {
            if (effect.is(setSelectionHighlightEffect)) return true
          }
          return update.geometryChanged || update.viewportChanged
        },
        markers(view: EditorView) {
          const payload = view.state.field(selectionHighlightField)
          if (!payload || payload.length === 0) return []

          const selection = view.state.selection
          const markers: RectangleMarker[] = []
          const { from: vpFrom, to: vpTo } = view.viewport

          for (const entry of payload) {
            if (!shouldPaintPersistedHighlight(entry, selection)) continue

            // Clamp to visible range — only generate markers for visible text.
            const from = Math.max(entry.from, vpFrom)
            const to = Math.min(entry.to, vpTo)
            if (from >= to) continue

            // Per-line glyph rects: cm-selectionBackground for theme styling,
            // without full-range between-rectangles that fill blank lines.
            markers.push(
              ...markersForTextRange(
                view,
                buildMarkerClassName(entry.visual),
                from,
                to,
              ),
            )
          }

          return markers
        },
      }),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          if (this.shouldIgnoreTarget(event.target)) return false
          // Fast-path: clear only sync entries for this view on mousedown.
          this.clearSyncForView(view)
          return false
        },
        beforeinput: (_event, view) => {
          this.clearSyncForView(view)
          return false
        },
        compositionstart: (_event, view) => {
          this.clearSyncForView(view)
          return false
        },
      }),
      this._makeViewPlugin(),
    ]
  }

  private _makeViewPlugin(): Extension {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- ViewPlugin requires an inner class; arrow functions cannot be used as class constructors
    const controller = this
    return ViewPlugin.fromClass(
      class {
        constructor(private readonly view: EditorView) {
          syncHideNativeSelectionClass(this.view)
        }

        update(update: ViewUpdate) {
          // Keep stored offsets in sync with document edits so future
          // reconcile / dispatch rebuilds use mapped positions, not stale ones.
          if (update.docChanged) {
            controller.mapOffsetsForView(this.view, update.changes)
          }
          if (update.selectionSet && update.state.selection.main.empty) {
            // Selection collapsed — clear sync entries for this view.
            controller.clearSyncForView(this.view)
          }
          syncHideNativeSelectionClass(this.view)
        }

        destroy() {
          this.view.dom.classList.remove(HIDE_NATIVE_SELECTION_CLASS)
          // Remove all entries for this view when it is torn down.
          controller.clearAllForView(this.view)
        }
      },
    )
  }

  /**
   * Add (or replace) a highlight identified by `id`.
   *
   * - variant 'sync': at most one sync entry per EditorView; adding a new sync
   *   entry for the same view first removes the previous one.
   * - variant 'pinned': entries accumulate; same id replaces, different id adds.
   * - owner 'chat': managed by the chat reconcile loop.
   * - owner 'quickask': managed by QuickAsk; reconcile never touches these.
   * - owner 'transient': fire-and-forget (e.g. diff review); reconcile never
   *   touches these.
   */
  addHighlight(
    view: EditorView,
    id: string,
    location: { from: number; to: number },
    variant: HighlightVariant,
    owner: HighlightOwner,
    options?: { autoClearMs?: number; visual?: HighlightVisual },
  ): void {
    if (location.from >= location.to) return

    if (variant === 'sync') {
      // Remove any existing sync entry for this view.
      for (const [existingId, entry] of this.entries) {
        if (entry.view === view && entry.variant === 'sync') {
          this._removeEntry(existingId, entry)
        }
      }
    } else {
      // Pinned: replace same id if it exists.
      const existing = this.entries.get(id)
      if (existing) {
        this._removeEntry(id, existing)
      }
    }

    const autoClearMs = options?.autoClearMs
    const timeoutId =
      typeof autoClearMs === 'number' && autoClearMs > 0
        ? window.setTimeout(() => this.clearById(id), autoClearMs)
        : null

    this.entries.set(id, {
      view,
      from: location.from,
      to: location.to,
      variant,
      visual: options?.visual ?? 'selection',
      owner,
      timeoutId,
    })

    this._dispatchToView(view)
  }

  /**
   * Remove every highlight matching `owner`, dispatching once per affected
   * view. Synchronous teardown that does not depend on owners cleaning up
   * their own id bookkeeping — useful when a feature surface (e.g. QuickAsk
   * panel) wants to drop its highlights immediately on a transition, without
   * waiting for the close-animation/controller-close chain.
   */
  clearByOwner(owner: HighlightOwner): void {
    const affectedViews = new Set<EditorView>()
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.owner === owner) {
        affectedViews.add(entry.view)
        this._removeEntry(id, entry)
      }
    }
    for (const view of affectedViews) this._dispatchToView(view)
  }

  /**
   * Switch the visual style of every highlight matching `owner` without
   * touching its range or lifecycle. Used to flip the QuickAsk-owned highlight
   * into a "pending" shimmer while the LLM is streaming and back to plain
   * selection when done.
   */
  updateVisualByOwner(owner: HighlightOwner, visual: HighlightVisual): void {
    const affectedViews = new Set<EditorView>()
    for (const entry of this.entries.values()) {
      if (entry.owner === owner && entry.visual !== visual) {
        entry.visual = visual
        affectedViews.add(entry.view)
      }
    }
    for (const view of affectedViews) this._dispatchToView(view)
  }

  clearById(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const view = entry.view
    this._removeEntry(id, entry)
    this._dispatchToView(view)
  }

  /**
   * Remove all highlights whose owner is 'chat' and whose id is NOT in `ids`.
   */
  reconcileActiveIds(ids: Set<string>): void {
    const affectedViews = new Set<EditorView>()
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.owner === 'chat' && !ids.has(id)) {
        affectedViews.add(entry.view)
        this._removeEntry(id, entry)
      }
    }
    for (const view of affectedViews) this._dispatchToView(view)
  }

  clearAll(): void {
    const affectedViews = new Set<EditorView>()
    for (const [id, entry] of Array.from(this.entries)) {
      affectedViews.add(entry.view)
      this._removeEntry(id, entry)
    }
    for (const view of affectedViews) this._dispatchToView(view)
  }

  // ── Transient API (used by diff-review etc.) ────────────────────────────────

  /**
   * Paint one or more transient highlights that auto-clear after `autoClearMs`.
   * Used by features (e.g. diff review) that need a "flash" highlight independent
   * of chat reconcile. owner is fixed to 'transient' so reconcile won't touch them.
   *
   * `visual: 'updated'` renders with the diff-review yellow style; default
   * `'selection'` matches the regular selection highlight.
   */
  highlightRanges(
    view: EditorView,
    payload: Array<{
      from: number
      to: number
      visual?: HighlightVisual
    }>,
    autoClearMs?: number,
  ): void {
    for (const p of payload) {
      const id = `__transient_${this.transientCounter++}__`
      this.addHighlight(view, id, p, 'pinned', 'transient', {
        autoClearMs,
        visual: p.visual,
      })
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private clearSyncForView(view: EditorView): void {
    let changed = false
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.view === view && entry.variant === 'sync') {
        this._removeEntry(id, entry)
        changed = true
      }
    }
    if (changed) this._dispatchToView(view)
  }

  /**
   * Map stored from/to offsets through a ChangeSet so they track document
   * edits.  The layer reads from the StateField which is rebuilt on each
   * dispatch, so keeping our controller's own offset copy in sync ensures
   * future dispatches use correct positions.
   */
  mapOffsetsForView(view: EditorView, changes: ChangeSet): void {
    for (const entry of this.entries.values()) {
      if (entry.view !== view) continue
      entry.from = changes.mapPos(entry.from, 1)
      entry.to = changes.mapPos(entry.to, -1)
    }
  }

  private clearAllForView(view: EditorView): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (entry.view === view) {
        this._removeEntry(id, entry)
      }
    }
  }

  private _removeEntry(id: string, entry: HighlightEntry): void {
    if (entry.timeoutId !== null) {
      window.clearTimeout(entry.timeoutId)
    }
    this.entries.delete(id)
  }

  private _dispatchToView(view: EditorView): void {
    if (!view.dom.isConnected) return
    const payload = this._buildPayloadForView(view)
    view.dispatch({ effects: setSelectionHighlightEffect.of(payload) })
    syncHideNativeSelectionClass(view)
  }

  private _buildPayloadForView(view: EditorView): EffectPayload {
    const result: EffectPayload = []
    for (const [id, entry] of this.entries) {
      if (entry.view === view) {
        result.push({
          id,
          from: entry.from,
          to: entry.to,
          visual: entry.visual,
          variant: entry.variant,
        })
      }
    }
    return result
  }

  private shouldIgnoreTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false
    return Boolean(target.closest(INTERACTIVE_OVERLAY_SELECTOR))
  }

  /** Re-sync hide-native class + layer after pointer-driven selection ends. */
  refreshNativeSelectionSuppression(): void {
    const views = new Set<EditorView>()
    for (const entry of this.entries.values()) {
      views.add(entry.view)
    }
    for (const view of views) {
      this._dispatchToView(view)
    }
  }

  private _ensurePointerTracking(): void {
    if (pointerTrackingInstalled) return
    pointerTrackingInstalled = true

    const endPointerSelect = (): void => {
      if (!isPointerSelecting) return
      isPointerSelecting = false
      this.refreshNativeSelectionSuppression()
    }

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button !== 0) return
        const target = event.target
        if (!(target instanceof Element)) return
        if (!target.closest('.cm-editor')) return
        if (this.shouldIgnoreTarget(target)) return
        isPointerSelecting = true
        this.refreshNativeSelectionSuppression()
      },
      true,
    )
    document.addEventListener('pointerup', endPointerSelect, true)
    document.addEventListener('pointercancel', endPointerSelect, true)
  }
}

export const selectionHighlightController = new SelectionHighlightController()
