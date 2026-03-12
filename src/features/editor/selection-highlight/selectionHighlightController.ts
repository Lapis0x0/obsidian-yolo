import type { Extension } from '@codemirror/state'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view'

type SelectionHighlightRange = {
  from: number
  to: number
  variant?: 'selection' | 'updated'
}

type ActiveHighlight = {
  view: EditorView
  timeoutId: number | null
}

const setSelectionHighlightEffect = StateEffect.define<
  SelectionHighlightRange[] | null
>()

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

      const payload = effect.value?.filter((range) => range.from < range.to)
      if (!payload || payload.length === 0) {
        nextDecorations = Decoration.none
        continue
      }

      const builder = new RangeSetBuilder<Decoration>()
      for (const range of payload) {
        builder.add(
          range.from,
          range.to,
          Decoration.mark({
            class: [
              'smtcmp-selection-persisted-inline',
              range.variant === 'updated'
                ? 'smtcmp-selection-persisted-inline-updated'
                : '',
            ]
              .filter(Boolean)
              .join(' '),
          }),
        )
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

    this.setHighlight(view, [
      {
        from,
        to,
        variant: 'selection',
      },
    ])
  }

  highlightRange(
    view: EditorView,
    payload: SelectionHighlightRange,
    autoClearMs?: number,
  ) {
    this.setHighlight(view, [payload], autoClearMs)
  }

  highlightRanges(
    view: EditorView,
    payload: SelectionHighlightRange[],
    autoClearMs?: number,
  ) {
    this.setHighlight(view, payload, autoClearMs)
  }

  clearHighlight(view?: EditorView) {
    if (!this.activeHighlight) {
      if (view?.dom.isConnected) {
        view.dispatch({
          effects: setSelectionHighlightEffect.of(null),
        })
      }
      return
    }

    if (view && this.activeHighlight.view !== view) {
      if (view.dom.isConnected) {
        view.dispatch({
          effects: setSelectionHighlightEffect.of(null),
        })
      }
      return
    }

    const { view: activeView, timeoutId } = this.activeHighlight

    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }

    if (activeView.dom.isConnected) {
      activeView.dispatch({
        effects: setSelectionHighlightEffect.of(null),
      })
    }

    this.activeHighlight = null
  }

  private isActiveView(view: EditorView): boolean {
    return this.activeHighlight?.view === view
  }

  private setHighlight(
    view: EditorView,
    payload: SelectionHighlightRange[],
    autoClearMs?: number,
  ) {
    const ranges = payload.filter((range) => range.from < range.to)
    if (ranges.length === 0) {
      this.clearHighlight(view)
      return
    }

    if (this.activeHighlight && this.activeHighlight.view !== view) {
      this.clearHighlight(this.activeHighlight.view)
    } else if (this.activeHighlight?.timeoutId != null) {
      window.clearTimeout(this.activeHighlight.timeoutId)
    }

    view.dispatch({
      effects: setSelectionHighlightEffect.of(ranges),
    })

    const timeoutId =
      typeof autoClearMs === 'number' && autoClearMs > 0
        ? window.setTimeout(() => {
            if (this.activeHighlight?.view === view) {
              this.clearHighlight(view)
            }
          }, autoClearMs)
        : null

    this.activeHighlight = { view, timeoutId }
  }

  private shouldIgnoreTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false
    }

    return Boolean(target.closest(INTERACTIVE_OVERLAY_SELECTOR))
  }
}

export const selectionHighlightController = new SelectionHighlightController()
