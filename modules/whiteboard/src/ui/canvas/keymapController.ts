// The board's keys: the view's own keymap (undo/redo, the camera keys,
// Space), the selection's scope (Delete/Backspace, Enter, Escape) that is armed
// only while something is selected, and the layered chains behind Escape,
// Delete and undo/redo.
//
// A layered key is asked of each layer in rank order, and the first answer
// that is not `null` is the key's: `true` handles it, `false` declines it and
// lets it travel on (to a field, or to Obsidian). Each controller registers
// the layers that are its own — the PDF annotation toolbar, the reader, live
// content, the board's selection and history — so this class knows the order
// of the chain and nothing about what is in it.
//
// Split out of `../canvas.ts` (no behaviour change). `WhiteboardCanvas` is the
// only importer; this module must never import it back.

import type { NodeId } from '../../domain/fileFormat'
import { NUDGE_SHIFT_STEPS } from '../constants'

import type { CanvasCore } from './core'

/** The keys whose meaning depends on what is being acted on. */
export type LayeredKey = 'escape' | 'delete' | 'undo' | 'redo'

/** `true`: handled. `false`: declined — the key travels on. `null`: not
 * this layer's; ask the next. */
export type KeyLayer = () => boolean | null

/**
 * Where a layer sits in its key's chain, asked lowest first. `field` is the
 * layer this class adds itself: a key typed into a field (a label, a page or
 * search box, a comment) is the field's.
 */
export const KEY_LAYER_RANK = Object.freeze({
  /** Above the field: chrome whose own field the key is leaving (the PDF
   * annotation toolbar and its comment editor). */
  overField: 0,
  field: 10,
  /** A PDF reader's own modes: area framing, open search, annotations. */
  reader: 20,
  /** A card's live content, stepped out of before the card is let go. */
  content: 30,
  /** The board itself: its selection and its history. */
  board: 40,
})

/** What a controller registers its layers through. */
export type KeyLayers = Readonly<{
  addLayer: (key: LayeredKey, rank: number, layer: KeyLayer) => void
}>

export type KeymapControllerDeps = Readonly<{
  core: CanvasCore
  /** A card's editor has the caret: its keys are CodeMirror's. */
  isEditing: () => boolean
  /** A label is being typed, or a creation prompt is open: the selection's
   * keys belong to that field. */
  isRenaming: () => boolean
  isPromptOpen: () => boolean
  editCard: (id: NodeId) => boolean
  fitAll: () => boolean
  zoomToSelection: () => boolean
  resetCamera: () => void
  zoomStep: (direction: 1 | -1) => void
  resetZoom: () => void
  selectAll: () => boolean
  duplicateSelection: () => boolean
  /** Moves the selection by whole grid steps. */
  nudgeSelection: (stepsX: number, stepsY: number) => boolean
  armSpacePan: () => boolean
}>

/** Whether the keyboard is currently typing into something that takes text:
 * the card being edited, a label being renamed, a PDF card's page field, a
 * Quick Ask panel. */
export function isTypingIntoField(doc: Document): boolean {
  // Read off the element rather than tested with `instanceof HTMLElement`:
  // in a popout the element belongs to that window, whose constructor is a
  // different one, and the test would answer false there.
  const active = doc.activeElement as
    | (Element & { isContentEditable?: boolean })
    | null
  if (!active) return false
  return (
    active.isContentEditable === true ||
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA'
  )
}

type RankedLayer = Readonly<{ rank: number; layer: KeyLayer }>

export class KeymapController implements KeyLayers {
  private readonly core: CanvasCore
  private readonly layers: Record<LayeredKey, RankedLayer[]> = {
    escape: [],
    delete: [],
    undo: [],
    redo: [],
  }
  private viewKeymapDisposer: (() => void) | null = null
  private selectionScopeDisposer: (() => void) | null = null

  constructor(private readonly deps: KeymapControllerDeps) {
    this.core = deps.core
    // A field inside a card or the panel (a page or search box) handles its
    // own Escape, and a key typed into a field inside a selected card (a PDF
    // card's page number) is that field's, not a request to delete the card.
    const typing: KeyLayer = () => (this.isTypingIntoField() ? false : null)
    this.addLayer('escape', KEY_LAYER_RANK.field, typing)
    this.addLayer('delete', KEY_LAYER_RANK.field, typing)
    // While a card's editor has the caret, undo and redo belong to that
    // editor — CodeMirror has its own history, and the text being typed is
    // not a board change yet. A key typed into a field — a PDF reader's page
    // or search box — is the field's: Mod+Z undoes the typing.
    const busy: KeyLayer = () => (this.busy() ? false : null)
    this.addLayer('undo', KEY_LAYER_RANK.field, busy)
    this.addLayer('redo', KEY_LAYER_RANK.field, busy)
  }

  addLayer(key: LayeredKey, rank: number, layer: KeyLayer): void {
    const chain = this.layers[key]
    // Stable: layers of one rank are asked in the order they were added.
    const at = chain.findIndex((entry) => entry.rank > rank)
    chain.splice(at === -1 ? chain.length : at, 0, { rank, layer })
  }

  /** Runs a layered key's chain; true when a layer handled it. */
  run(key: LayeredKey): boolean {
    for (const { layer } of this.layers[key]) {
      const answer = layer()
      if (answer !== null) return answer
    }
    return false
  }

  isTypingIntoField(): boolean {
    return isTypingIntoField(this.core.context.getDocument())
  }

  private busy(): boolean {
    return this.deps.isEditing() || this.isTypingIntoField()
  }

  destroy(): void {
    this.viewKeymapDisposer?.()
    this.viewKeymapDisposer = null
  }

  /** Undo/redo live on the view's own keymap, so they are armed exactly
   * while this board is the leaf being looked at. */
  bindViewKeys(): void {
    // A key typed into a field is the field's: Shift+1 types "!".
    const busy = () => this.busy()
    // Obsidian Canvas's camera keys. Zoom-to-selection declines (falls
    // through to Obsidian) when nothing is selected, same as Canvas.
    const fitAll = () => {
      if (busy()) return false
      return this.deps.fitAll()
    }
    const fitSelection = () => {
      if (busy()) return false
      return this.deps.zoomToSelection()
    }
    // Back to the origin at 1:1. Obsidian Canvas binds no key to its own
    // (weaker) reset — Shift+1 and Shift+2 are the only two camera keys it
    // has — so Shift+0 is ours to choose, and it belongs to the same Shift+digit
    // family as the two fits while reading as the "100%" that Mod+0 means in
    // every browser.
    const home = () => {
      if (busy()) return false
      this.deps.resetCamera()
      return true
    }
    // The browser's zoom keys, for the board: Mod+= / Mod+- step, Mod+0 back
    // to 100% — the same three the controls column labels its buttons with.
    // Consumed, so they zoom the board and not Obsidian's whole window.
    const zoom = (direction: 1 | -1) => () => {
      if (busy()) return false
      this.deps.zoomStep(direction)
      return true
    }
    const actualSize = () => {
      if (busy()) return false
      this.deps.resetZoom()
      return true
    }
    const selectAll = () => {
      if (busy()) return false
      return this.deps.selectAll()
    }
    const undo = () => this.run('undo')
    const redo = () => this.run('redo')
    this.viewKeymapDisposer = this.core.context.registerKeymap([
      { modifiers: ['Mod'], key: 'Z', handler: undo },
      { modifiers: ['Mod', 'Shift'], key: 'Z', handler: redo },
      // Windows' second redo binding, which Obsidian Canvas also carries.
      { modifiers: ['Mod'], key: 'Y', handler: redo },
      { modifiers: ['Shift'], key: '1', handler: fitAll },
      { modifiers: ['Shift'], key: '2', handler: fitSelection },
      { modifiers: ['Shift'], key: '0', handler: home },
      { modifiers: ['Mod'], key: '=', handler: zoom(1) },
      { modifiers: ['Mod'], key: '-', handler: zoom(-1) },
      { modifiers: ['Mod'], key: '0', handler: actualSize },
      { modifiers: ['Mod'], key: 'A', handler: selectAll },
      // Obsidian names Space by its character (measured: both `key` and
      // `vkey` are " "), not by 'Space'.
      { modifiers: [], key: ' ', handler: this.deps.armSpacePan },
    ])
  }

  // -- the selection's scope ----------------------------------------------
  // Pushed exactly when the selection transitions to/from empty, so
  // Delete/Backspace/Escape are only ever intercepted while there's something
  // to act on (and, by construction, never while a card is being edited — a
  // card being edited is never also selected).

  /** One scope for both kinds of selection, pushed while either is non-empty
   * and popped when both are. */
  syncSelectionScope(): void {
    const { core } = this
    const hasSelection =
      (core.getSelectedIds().size > 0 || core.getSelectedEdgeIds().size > 0) &&
      // While a label is being typed or a creation prompt is open,
      // Backspace/Delete/Escape belong to that field, not to the selection
      // behind it — the same rule that keeps the card editor and the selection
      // scope from ever being armed at once.
      !this.deps.isRenaming() &&
      !this.deps.isPromptOpen()
    if (hasSelection && !this.selectionScopeDisposer) {
      this.pushSelectionScope()
    } else if (!hasSelection && this.selectionScopeDisposer) {
      this.popSelectionScope()
    }
  }

  private pushSelectionScope(): void {
    // Arrow keys nudge what is selected — one grid step, or several with
    // Shift — as every design tool does. Declined into a field, where an
    // arrow moves the caret.
    const nudge = (x: number, y: number) => () => {
      if (this.isTypingIntoField()) return false
      return this.deps.nudgeSelection(x, y)
    }
    const arrows = (
      [
        ['ArrowLeft', -1, 0],
        ['ArrowRight', 1, 0],
        ['ArrowUp', 0, -1],
        ['ArrowDown', 0, 1],
      ] as const
    ).flatMap(([key, x, y]) => [
      { modifiers: [] as const, key, handler: nudge(x, y) },
      {
        modifiers: ['Shift'] as const,
        key,
        handler: nudge(x * NUDGE_SHIFT_STEPS, y * NUDGE_SHIFT_STEPS),
      },
    ])
    this.selectionScopeDisposer = this.core.context.registerKeymap([
      ...arrows,
      {
        modifiers: ['Mod'],
        key: 'D',
        handler: () =>
          !this.isTypingIntoField() && this.deps.duplicateSelection(),
      },
      {
        modifiers: [],
        key: 'Backspace',
        handler: () => this.run('delete'),
      },
      {
        modifiers: [],
        key: 'Delete',
        handler: () => this.run('delete'),
      },
      {
        modifiers: [],
        key: 'Enter',
        handler: () => {
          if (this.isTypingIntoField()) return false
          const selected = this.core.getSelectedIds()
          if (selected.size !== 1) return false
          const id = selected.values().next().value
          return id !== undefined && this.deps.editCard(id)
        },
      },
      {
        modifiers: [],
        key: 'Escape',
        // Escape, one layer at a time, the way it steps out of an editor:
        // first the PDF annotation toolbar (or its comment editor), then a
        // reader's area mode or open search, then out of the card's content,
        // and only a last press lets go of the card itself.
        //
        // Bound twice — on this scope, and while there is a PDF reader (the
        // reader keymap in ./pdfIntegration.ts) — because a panel can be read
        // with nothing selected. Obsidian's scope runs only the first binding
        // for a key, so both are this one chain and it does not matter which
        // runs.
        handler: () => this.run('escape'),
      },
    ])
  }

  popSelectionScope(): void {
    this.selectionScopeDisposer?.()
    this.selectionScopeDisposer = null
  }
}
