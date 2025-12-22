import type { Extension } from '@codemirror/state'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView } from '@codemirror/view'
import type { Editor, MarkdownView } from 'obsidian'

import { QuickAskWidget } from '../../../components/panels/quick-ask'
import type SmartComposerPlugin from '../../../main'
import type { SmartComposerSettings } from '../../../settings/schema/setting.types'

type QuickAskWidgetPayload = {
  pos: number
  options: {
    plugin: SmartComposerPlugin
    editor: Editor
    view: EditorView
    contextText: string
    fileTitle: string
    onClose: () => void
  }
}

type QuickAskWidgetState = {
  view: EditorView
  pos: number
  close: () => void
} | null

type QuickAskControllerDeps = {
  plugin: SmartComposerPlugin
  getSettings: () => SmartComposerSettings
  getActiveMarkdownView: () => MarkdownView | null
  getEditorView: (editor: Editor) => EditorView | null
  getActiveFileTitle: () => string
  closeSmartSpace: () => void
}

const quickAskWidgetEffect = StateEffect.define<QuickAskWidgetPayload | null>()

const quickAskWidgetField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    let updated = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(quickAskWidgetEffect)) {
        updated = Decoration.none
        const payload = effect.value
        if (payload) {
          updated = Decoration.set([
            Decoration.widget({
              widget: new QuickAskWidget(payload.options),
              side: 1,
              block: false,
            }).range(payload.pos),
          ])
        }
      }
    }
    return updated
  },
  provide: (field) => EditorView.decorations.from(field),
})

export class QuickAskController {
  private quickAskWidgetState: QuickAskWidgetState = null

  constructor(private readonly deps: QuickAskControllerDeps) {}

  close() {
    const state = this.quickAskWidgetState
    if (!state) return

    // Clear state to prevent duplicate close
    this.quickAskWidgetState = null

    // Try to trigger close animation
    const hasAnimation = QuickAskWidget.closeCurrentWithAnimation()

    if (!hasAnimation) {
      // If no animation instance, dispatch close effect directly
      state.view.dispatch({ effects: quickAskWidgetEffect.of(null) })
    }

    state.view.focus()
  }

  show(editor: Editor, view: EditorView) {
    const selection = view.state.selection.main
    const pos = selection.head

    // Get context text (all text before cursor)
    const contextText = editor.getRange({ line: 0, ch: 0 }, editor.getCursor())
    const fileTitle = this.deps.getActiveFileTitle()

    // Close any existing Quick Ask panel
    this.close()
    // Also close Smart Space if open
    this.deps.closeSmartSpace()

    const close = () => {
      const isCurrentView =
        !this.quickAskWidgetState || this.quickAskWidgetState.view === view

      if (isCurrentView) {
        this.quickAskWidgetState = null
      }
      view.dispatch({ effects: quickAskWidgetEffect.of(null) })

      if (isCurrentView) {
        view.focus()
      }
    }

    view.dispatch({
      effects: [
        quickAskWidgetEffect.of(null),
        quickAskWidgetEffect.of({
          pos,
          options: {
            plugin: this.deps.plugin,
            editor,
            view,
            contextText,
            fileTitle,
            onClose: close,
          },
        }),
      ],
    })

    this.quickAskWidgetState = { view, pos, close }
  }

  createTriggerExtension(): Extension {
    return [
      quickAskWidgetField,
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          // Check if Quick Ask feature is enabled (default: true)
          const enableQuickAsk =
            this.deps.getSettings().continuationOptions?.enableQuickAsk ?? true
          if (!enableQuickAsk) {
            return false
          }

          if (event.defaultPrevented) {
            return false
          }

          // Don't trigger with modifier keys (except Shift for special chars like @)
          if (event.altKey || event.metaKey || event.ctrlKey) {
            return false
          }

          // Get trigger string from settings (default: @)
          const triggerStr =
            this.deps.getSettings().continuationOptions?.quickAskTrigger ?? '@'

          // Determine what character the user is typing
          let typedChar = event.key
          // Special handling for @ which may be Shift+2 on some keyboards
          if (event.key === '2' && event.shiftKey) {
            typedChar = '@'
          }

          // Only proceed if the typed character could be part of the trigger
          if (typedChar.length !== 1) {
            return false
          }

          const selection = view.state.selection.main
          if (!selection.empty) {
            return false
          }

          // Check if cursor is at an empty line or at line start
          const line = view.state.doc.lineAt(selection.head)
          const lineTextBeforeCursor = line.text.slice(
            0,
            selection.head - line.from,
          )

          // Build the potential trigger sequence: existing text + new character
          const potentialSequence = lineTextBeforeCursor + typedChar

          // Check if the potential sequence matches the trigger string
          if (potentialSequence !== triggerStr) {
            // Check if it could be a partial match (for multi-char triggers)
            if (
              triggerStr.length > 1 &&
              triggerStr.startsWith(potentialSequence)
            ) {
              // Allow the character to be typed, it might complete the trigger later
              return false
            }
            return false
          }

          const markdownView = this.deps.getActiveMarkdownView()
          const editor = markdownView?.editor
          if (!editor) {
            return false
          }

          const activeView = this.deps.getEditorView(editor)
          if (activeView && activeView !== view) {
            return false
          }

          // Prevent default input
          event.preventDefault()
          event.stopPropagation()

          // Clear the trigger characters from the line before showing panel
          if (lineTextBeforeCursor.length > 0) {
            // Delete the partial trigger that was already typed
            const deleteFrom = line.from
            const deleteTo = selection.head
            view.dispatch({
              changes: { from: deleteFrom, to: deleteTo },
              selection: { anchor: deleteFrom },
            })
          }

          // Show Quick Ask panel
          this.show(editor, view)
          return true
        },
      }),
      EditorView.updateListener.of((update) => {
        const state = this.quickAskWidgetState
        if (!state || state.view !== update.view) return

        if (update.docChanged) {
          state.pos = update.changes.mapPos(state.pos)
        }
      }),
    ]
  }
}
