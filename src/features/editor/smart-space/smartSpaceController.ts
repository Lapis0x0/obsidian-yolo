import type { Extension } from '@codemirror/state'
import { EditorSelection, StateEffect, StateField } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView } from '@codemirror/view'
import type { SerializedEditorState } from 'lexical'
import type { Editor, MarkdownView } from 'obsidian'

import { SmartSpaceWidget } from '../../../components/panels/SmartSpacePanel'
import type SmartComposerPlugin from '../../../main'
import type { SmartComposerSettings } from '../../../settings/schema/setting.types'
import type { SerializedMentionable } from '../../../types/mentionable'

export type SmartSpaceDraftState = {
  instructionText?: string
  mentionables?: SerializedMentionable[]
  editorState?: SerializedEditorState
} | null

type SmartSpaceWidgetPayload = {
  pos: number
  options: {
    plugin: SmartComposerPlugin
    editor: Editor
    view: EditorView
    onClose: () => void
    showQuickActions?: boolean
  }
}

type SmartSpaceWidgetState = {
  view: EditorView
  pos: number
  close: () => void
} | null

type SmartSpaceLastTrigger = {
  view: EditorView
  pos: number
  timestamp: number
} | null

type SmartSpaceControllerDeps = {
  plugin: SmartComposerPlugin
  getSettings: () => SmartComposerSettings
  getActiveMarkdownView: () => MarkdownView | null
  getEditorView: (editor: Editor) => EditorView | null
  clearPendingSelectionRewrite: () => void
}

const smartSpaceWidgetEffect =
  StateEffect.define<SmartSpaceWidgetPayload | null>()

const smartSpaceWidgetField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    let updated = decorations.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(smartSpaceWidgetEffect)) {
        updated = Decoration.none
        const payload = effect.value
        if (payload) {
          updated = Decoration.set([
            Decoration.widget({
              widget: new SmartSpaceWidget(payload.options),
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

export class SmartSpaceController {
  private smartSpaceWidgetState: SmartSpaceWidgetState = null
  private lastSmartSpaceSlash: SmartSpaceLastTrigger = null
  private lastSmartSpaceSpace: SmartSpaceLastTrigger = null

  constructor(private readonly deps: SmartSpaceControllerDeps) {}

  isOpen(): boolean {
    return Boolean(this.smartSpaceWidgetState)
  }

  close() {
    const state = this.smartSpaceWidgetState
    if (!state) return

    // 先清除状态，避免重复关闭
    this.smartSpaceWidgetState = null

    // Clear pending selection rewrite if user closes without submitting
    this.deps.clearPendingSelectionRewrite()

    // 尝试触发关闭动画
    const hasAnimation = SmartSpaceWidget.closeCurrentWithAnimation()

    if (!hasAnimation) {
      // 如果没有动画实例，直接分发关闭效果
      state.view.dispatch({ effects: smartSpaceWidgetEffect.of(null) })
    }

    state.view.focus()
  }

  show(editor: Editor, view: EditorView, showQuickActions = true) {
    const selection = view.state.selection.main
    // Use the end of selection (max of head and anchor) to always position at the visual end
    // This ensures the widget appears below the selection regardless of selection direction
    const pos = Math.max(selection.head, selection.anchor)

    this.close()

    const close = () => {
      // 检查是否是当前的 widget（允许状态为 null，因为可能在动画期间被清除）
      if (this.smartSpaceWidgetState && this.smartSpaceWidgetState.view !== view) {
        return
      }
      this.smartSpaceWidgetState = null
      view.dispatch({ effects: smartSpaceWidgetEffect.of(null) })
      view.focus()
    }

    view.dispatch({
      effects: [
        smartSpaceWidgetEffect.of(null),
        smartSpaceWidgetEffect.of({
          pos,
          options: {
            plugin: this.deps.plugin,
            editor,
            view,
            onClose: close,
            showQuickActions,
          },
        }),
      ],
    })

    this.smartSpaceWidgetState = { view, pos, close }
  }

  createTriggerExtension(): Extension {
    return [
      smartSpaceWidgetField,
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          const smartSpaceEnabled =
            this.deps.getSettings().continuationOptions?.enableSmartSpace ?? true
          if (!smartSpaceEnabled) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }
          if (event.defaultPrevented) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }

          const isSlash = event.key === '/' || event.code === 'Slash'
          const isSpace =
            event.key === ' ' ||
            event.key === 'Spacebar' ||
            event.key === 'Space' ||
            event.code === 'Space'
          const handledKey = isSlash || isSpace

          if (!handledKey) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }
          if (event.altKey || event.metaKey || event.ctrlKey) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }

          const selection = view.state.selection.main
          if (!selection.empty) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }

          const markdownView = this.deps.getActiveMarkdownView()
          const editor = markdownView?.editor
          if (!editor) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }
          const activeView = this.deps.getEditorView(editor)
          if (activeView && activeView !== view) {
            this.lastSmartSpaceSlash = null
            this.lastSmartSpaceSpace = null
            return false
          }

          if (isSlash) {
            this.lastSmartSpaceSlash = {
              view,
              pos: selection.head,
              timestamp: Date.now(),
            }
            this.lastSmartSpaceSpace = null
            return false
          }

          // Space handling (either legacy single-space trigger, or slash + space)
          const now = Date.now()
          const triggerMode =
            this.deps.getSettings().continuationOptions?.smartSpaceTriggerMode ??
            'single-space'
          const lastSlash = this.lastSmartSpaceSlash
          let selectionAfterRemoval = selection
          let triggeredBySlashCombo = false
          if (lastSlash && lastSlash.view === view && now - lastSlash.timestamp <= 600) {
            const slashChar = view.state.doc.sliceString(
              lastSlash.pos,
              lastSlash.pos + 1,
            )
            if (slashChar === '/') {
              view.dispatch({
                changes: { from: lastSlash.pos, to: lastSlash.pos + 1 },
                selection: EditorSelection.cursor(lastSlash.pos),
              })
              selectionAfterRemoval = view.state.selection.main
              triggeredBySlashCombo = true
            }
            this.lastSmartSpaceSlash = null
          } else {
            this.lastSmartSpaceSlash = null
            selectionAfterRemoval = view.state.selection.main
          }

          if (!triggeredBySlashCombo) {
            const line = view.state.doc.lineAt(selectionAfterRemoval.head)
            if (line.text.trim().length > 0) {
              this.lastSmartSpaceSpace = null
              return false
            }

            if (triggerMode === 'off') {
              this.lastSmartSpaceSpace = null
              return false
            }

            if (triggerMode === 'double-space') {
              const lastSpace = this.lastSmartSpaceSpace
              const isDoublePress =
                lastSpace &&
                lastSpace.view === view &&
                now - lastSpace.timestamp <= 600 &&
                lastSpace.pos + 1 === selectionAfterRemoval.head &&
                view.state.doc.sliceString(lastSpace.pos, lastSpace.pos + 1) ===
                  ' '
              if (!isDoublePress || !lastSpace) {
                this.lastSmartSpaceSpace = {
                  view,
                  pos: selectionAfterRemoval.head,
                  timestamp: now,
                }
                return false
              }

              view.dispatch({
                changes: {
                  from: lastSpace.pos,
                  to: Math.min(lastSpace.pos + 1, view.state.doc.length),
                },
                selection: EditorSelection.cursor(lastSpace.pos),
              })
              selectionAfterRemoval = view.state.selection.main
              this.lastSmartSpaceSpace = null
            } else {
              this.lastSmartSpaceSpace = null
            }
          } else {
            this.lastSmartSpaceSpace = null
          }

          event.preventDefault()
          event.stopPropagation()

          this.show(editor, view)
          return true
        },
      }),
      EditorView.updateListener.of((update) => {
        const state = this.smartSpaceWidgetState
        if (!state || state.view !== update.view) return

        if (update.docChanged) {
          state.pos = update.changes.mapPos(state.pos)
        }

        if (update.selectionSet) {
          const head = update.state.selection.main
          if (!head.empty || head.head !== state.pos) {
            this.close()
          }
        }
      }),
    ]
  }
}
