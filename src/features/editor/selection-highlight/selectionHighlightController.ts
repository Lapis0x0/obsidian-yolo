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

type HighlightVariant = 'sync' | 'pinned'

/** Visual style independent of the lifecycle variant. */
type HighlightVisual = 'selection' | 'updated'

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
type EffectPayload = Array<{
  id: string
  from: number
  to: number
  visual: HighlightVisual
}>

// ──────────────────────────────────────────────────────────────────────────────
// CSS class names (yolo- prefix per CLAUDE.md)
// ──────────────────────────────────────────────────────────────────────────────

const CLASS_SELECTION = 'yolo-selection-persisted-layer'
const CLASS_UPDATED = 'yolo-selection-persisted-layer-updated'

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
  '.smtcmp-quick-ask-overlay-root',
  '.smtcmp-quick-ask-overlay',
  '.smtcmp-selection-chat-overlay-root',
  '.smtcmp-selection-chat-overlay',
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
    return [
      selectionHighlightField,
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

          const markers: RectangleMarker[] = []
          const { from: vpFrom, to: vpTo } = view.viewport
          const doc = view.state.doc

          for (const entry of payload) {
            // Clamp to visible range — only generate markers for visible text.
            const from = Math.max(entry.from, vpFrom)
            const to = Math.min(entry.to, vpTo)
            if (from >= to) continue

            const className =
              entry.visual === 'updated'
                ? `${CLASS_SELECTION} ${CLASS_UPDATED}`
                : CLASS_SELECTION

            // Walk the range line-by-line so each line emits a text-tight
            // rectangle (single-line forRange == glyph-tight). Empty lines
            // yield from===to and are skipped, so blank lines between
            // paragraphs don't get painted.
            const startLine = doc.lineAt(from).number
            const endLine = doc.lineAt(to).number
            for (let n = startLine; n <= endLine; n++) {
              const line = doc.line(n)
              const segFrom = Math.max(from, line.from)
              const segTo = Math.min(to, line.to)
              if (segFrom >= segTo) continue
              const range = EditorSelection.range(segFrom, segTo)
              markers.push(...RectangleMarker.forRange(view, className, range))
            }
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
        constructor(private readonly view: EditorView) {}

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
        }

        destroy() {
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
        })
      }
    }
    return result
  }

  private shouldIgnoreTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false
    return Boolean(target.closest(INTERACTIVE_OVERLAY_SELECTOR))
  }
}

export const selectionHighlightController = new SelectionHighlightController()
