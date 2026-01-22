import type { Extension } from '@codemirror/state'
import { StateEffect } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view'
import type { Editor, MarkdownView } from 'obsidian'

import { QuickAskOverlay } from '../../../components/panels/quick-ask'
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
  close: (restoreFocus?: boolean) => void
} | null

type QuickAskControllerDeps = {
  plugin: SmartComposerPlugin
  getSettings: () => SmartComposerSettings
  getActiveMarkdownView: () => MarkdownView | null
  getEditorView: (editor: Editor) => EditorView | null
  getActiveFileTitle: () => string
  closeSmartSpace: (restoreFocus?: boolean) => void
}

const DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS = 5000
const DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS = 2000
const QUICK_ASK_CURSOR_MARKER = '<<CURSOR>>'

const quickAskWidgetEffect = StateEffect.define<QuickAskWidgetPayload | null>()

const quickAskOverlayPlugin = ViewPlugin.fromClass(
  class {
    private overlay: QuickAskOverlay | null = null
    private pos: number | null = null

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (!effect.is(quickAskWidgetEffect)) continue
          const payload = effect.value
          if (!payload) {
            this.overlay?.destroy()
            this.overlay = null
            this.pos = null
            continue
          }
          this.overlay?.destroy()
          this.pos = payload.pos
          this.overlay = new QuickAskOverlay(payload.options)
          this.overlay.mount(payload.pos)
        }
      }

      if (this.overlay && this.pos !== null && update.docChanged) {
        this.pos = update.changes.mapPos(this.pos)
        this.overlay.updatePosition(this.pos)
      }
    }

    destroy() {
      this.overlay?.destroy()
      this.overlay = null
      this.pos = null
    }
  },
)

export class QuickAskController {
  private quickAskWidgetState: QuickAskWidgetState = null

  constructor(private readonly deps: QuickAskControllerDeps) {}

  close(restoreFocus = true) {
    const state = this.quickAskWidgetState
    if (!state) {
      return
    }

    if (!restoreFocus) {
      this.quickAskWidgetState = null
      state.view.dispatch({ effects: quickAskWidgetEffect.of(null) })
      return
    }

    // Clear state to prevent duplicate close
    this.quickAskWidgetState = null

    // Try to trigger close animation
    const hasAnimation = QuickAskOverlay.closeCurrentWithAnimation()

    if (!hasAnimation) {
      // If no animation instance, dispatch close effect directly
      state.view.dispatch({ effects: quickAskWidgetEffect.of(null) })
      state.view.focus()
    }
  }

  show(editor: Editor, view: EditorView) {
    const selection = view.state.selection.main
    const pos = selection.head

    // Get context text around cursor with marker
    const continuationOptions = this.deps.getSettings().continuationOptions
    const beforeChars = Math.max(
      0,
      continuationOptions?.quickAskContextBeforeChars ??
        DEFAULT_QUICK_ASK_CONTEXT_BEFORE_CHARS,
    )
    const afterChars = Math.max(
      0,
      continuationOptions?.quickAskContextAfterChars ??
        DEFAULT_QUICK_ASK_CONTEXT_AFTER_CHARS,
    )
    const doc = view.state.doc
    const beforeStart = Math.max(0, pos - beforeChars)
    const afterEnd = Math.min(doc.length, pos + afterChars)
    const before = doc.sliceString(beforeStart, pos)
    const after = doc.sliceString(pos, afterEnd)
    const contextText =
      before.length > 0 || after.length > 0
        ? `${before}${QUICK_ASK_CURSOR_MARKER}${after}`
        : ''
    const fileTitle = this.deps.getActiveFileTitle()

    // Close any existing Quick Ask panel
    this.close(false)
    // Also close Smart Space if open
    this.deps.closeSmartSpace(false)

    const close = (restoreFocus = true) => {
      const isCurrentView =
        !this.quickAskWidgetState || this.quickAskWidgetState.view === view

      if (isCurrentView) {
        this.quickAskWidgetState = null
      }
      view.dispatch({ effects: quickAskWidgetEffect.of(null) })

      if (isCurrentView) {
        if (restoreFocus) {
          view.focus()
        }
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
            onClose: () => close(true),
          },
        }),
      ],
    })

    this.quickAskWidgetState = { view, pos, close }
  }

  createTriggerExtension(): Extension {
    return [
      quickAskOverlayPlugin,
      EditorView.domEventHandlers({
        beforeinput: (event, view) => {
          // Check if Quick Ask feature is enabled (default: true)
          const enableQuickAsk =
            this.deps.getSettings().continuationOptions?.enableQuickAsk ?? true
          if (!enableQuickAsk) {
            return false
          }

          if (event.defaultPrevented) {
            return false
          }

          // Get trigger string from settings (default: @)
          const triggerStr =
            this.deps.getSettings().continuationOptions?.quickAskTrigger ?? '@'

          const inputEvent = event
          if (inputEvent.inputType !== 'insertText') {
            return false
          }
          if (inputEvent.isComposing) {
            return false
          }

          // Determine what character the user is typing
          const typedChar = inputEvent.data ?? ''

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
    ]
  }
}
