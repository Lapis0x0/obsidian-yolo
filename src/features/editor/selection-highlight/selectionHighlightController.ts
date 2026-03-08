import type { Extension } from '@codemirror/state'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view'

type SelectionHighlightPayload = {
  from: number
  to: number
}

type HighlightMode = 'inline' | 'block'

type HighlightLineRole =
  | 'is-single'
  | 'is-block-start'
  | 'is-block-middle'
  | 'is-block-end'

type ActiveHighlight = {
  view: EditorView
}

const setSelectionHighlightEffect =
  StateEffect.define<SelectionHighlightPayload | null>()

const selectionHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    let nextDecorations = decorations.map(tr.changes)

    for (const effect of tr.effects) {
      if (!effect.is(setSelectionHighlightEffect)) {
        continue
      }

      const payload = effect.value
      if (!payload || payload.from === payload.to) {
        nextDecorations = Decoration.none
        continue
      }

      const builder = new RangeSetBuilder<Decoration>()
      const mode = resolveHighlightMode(tr.state.doc, payload.from, payload.to)

      if (mode === 'inline') {
        builder.add(
          payload.from,
          payload.to,
          Decoration.mark({
            class: 'smtcmp-selection-persisted-inline',
          }),
        )
      } else {
        const startLine = tr.state.doc.lineAt(payload.from).number
        const endPos = Math.max(payload.from, payload.to - 1)
        const endLine = tr.state.doc.lineAt(endPos).number
        const groups = [
          Array.from(
            { length: endLine - startLine + 1 },
            (_, index) => startLine + index,
          ),
        ]

        for (const group of groups) {
          group.forEach((lineNumber, index) => {
            const line = tr.state.doc.line(lineNumber)
            const role = resolveLineRole(index, group.length)

            builder.add(
              line.from,
              line.from,
              Decoration.line({
                class: `smtcmp-selection-persisted-block ${role}`,
              }),
            )
          })
        }
      }

      nextDecorations = builder.finish()
    }

    return nextDecorations
  },
  provide: (field) => EditorView.decorations.from(field),
})

const INTERACTIVE_OVERLAY_SELECTOR = [
  '.smtcmp-quick-ask-overlay-root',
  '.smtcmp-quick-ask-overlay',
  '.smtcmp-selection-chat-overlay-root',
  '.smtcmp-selection-chat-overlay',
].join(', ')

function resolveLineRole(index: number, size: number): HighlightLineRole {
  if (size <= 1) return 'is-single'
  if (index === 0) return 'is-block-start'
  if (index === size - 1) return 'is-block-end'
  return 'is-block-middle'
}

function resolveHighlightMode(
  doc: EditorView['state']['doc'],
  from: number,
  to: number,
): HighlightMode {
  const startLine = doc.lineAt(from)
  const endPos = Math.max(from, to - 1)
  const endLine = doc.lineAt(endPos)

  if (startLine.number !== endLine.number) {
    return 'block'
  }

  return isEffectivelyFullLineSelected(startLine, from, to) ? 'block' : 'inline'
}

function isEffectivelyFullLineSelected(
  line: ReturnType<EditorView['state']['doc']['lineAt']>,
  from: number,
  to: number,
): boolean {
  const lineText = line.text
  const firstNonWhitespace = lineText.search(/\S/)

  if (firstNonWhitespace === -1) {
    return false
  }

  const lastNonWhitespace = lineText.length - lineText.trimEnd().length
  const contentFrom = line.from + firstNonWhitespace
  const contentTo = line.to - lastNonWhitespace

  return from <= contentFrom && to >= contentTo
}

export class SelectionHighlightController {
  private activeHighlight: ActiveHighlight | null = null

  createExtension(): Extension {
    const isActiveView = (view: EditorView) => this.isActiveView(view)
    const clearHighlight = (view: EditorView) => this.clearHighlight(view)

    return [
      selectionHighlightField,
      EditorView.domEventHandlers({
        mousedown: (event, _view) => {
          if (this.shouldIgnoreTarget(event.target)) {
            return false
          }
          if (!this.activeHighlight) {
            return false
          }
          this.clearHighlight()
          return false
        },
        beforeinput: (_event, _view) => {
          if (!this.activeHighlight) {
            return false
          }
          this.clearHighlight()
          return false
        },
        compositionstart: (_event, _view) => {
          if (!this.activeHighlight) {
            return false
          }
          this.clearHighlight()
          return false
        },
      }),
      ViewPlugin.fromClass(
        class {
          constructor(private readonly view: EditorView) {}

          update(update: ViewUpdate) {
            if (!isActiveView(this.view)) {
              return
            }

            if (update.selectionSet && update.state.selection.main.empty) {
              clearHighlight(this.view)
            }
          }

          destroy() {
            if (isActiveView(this.view)) {
              clearHighlight(this.view)
            }
          }
        },
      ),
    ]
  }

  pinCurrentSelection(view: EditorView) {
    const selection = view.state.selection.main
    const from = Math.min(selection.from, selection.to)
    const to = Math.max(selection.from, selection.to)

    if (from === to) {
      this.clearHighlight(view)
      return
    }

    if (this.activeHighlight && this.activeHighlight.view !== view) {
      this.clearHighlight(this.activeHighlight.view)
    }

    view.dispatch({
      effects: setSelectionHighlightEffect.of({ from, to }),
    })
    this.activeHighlight = { view }
  }

  clearHighlight(view?: EditorView) {
    if (!this.activeHighlight) {
      return
    }

    if (view && this.activeHighlight.view !== view) {
      return
    }

    const activeView = this.activeHighlight.view
    this.activeHighlight = null

    if (!activeView.dom.isConnected) {
      return
    }

    activeView.dispatch({
      effects: setSelectionHighlightEffect.of(null),
    })
  }

  private isActiveView(view: EditorView): boolean {
    return this.activeHighlight?.view === view
  }

  private shouldIgnoreTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false
    }

    return Boolean(target.closest(INTERACTIVE_OVERLAY_SELECTOR))
  }
}

export const selectionHighlightController = new SelectionHighlightController()
