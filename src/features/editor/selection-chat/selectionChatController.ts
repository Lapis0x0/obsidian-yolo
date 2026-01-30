import { EditorView } from '@codemirror/view'
import { App, Editor, MarkdownView, Notice } from 'obsidian'

import { ChatView } from '../../../ChatView'
import { ChatProps } from '../../../components/chat-view/Chat'
import { SelectionChatWidget } from '../../../components/selection/SelectionChatWidget'
import {
  SelectionInfo,
  SelectionManager,
} from '../../../components/selection/SelectionManager'
import { CHAT_VIEW_TYPE } from '../../../constants'
import type SmartComposerPlugin from '../../../main'
import { SmartComposerSettings } from '../../../settings/schema/setting.types'
import { getMentionableBlockData } from '../../../utils/obsidian'

export type PendingSelectionRewrite = {
  editor: Editor
  selectedText: string
  from: { line: number; ch: number }
  to: { line: number; ch: number }
}

type SelectionChatControllerDeps = {
  plugin: SmartComposerPlugin
  app: App
  getSettings: () => SmartComposerSettings
  t: (key: string, fallback?: string) => string
  getEditorView: (editor: Editor) => EditorView | null
  showSmartSpace: (
    editor: Editor,
    view: EditorView,
    showQuickActions: boolean,
  ) => void
  activateChatView: (chatProps?: ChatProps) => Promise<void>
  isSmartSpaceOpen: () => boolean
}

export class SelectionChatController {
  private readonly plugin: SmartComposerPlugin
  private readonly app: App
  private readonly getSettings: () => SmartComposerSettings
  private readonly t: (key: string, fallback?: string) => string
  private readonly getEditorView: (editor: Editor) => EditorView | null
  private readonly showSmartSpace: (
    editor: Editor,
    view: EditorView,
    showQuickActions: boolean,
  ) => void
  private readonly activateChatView: (chatProps?: ChatProps) => Promise<void>
  private readonly isSmartSpaceOpen: () => boolean

  private selectionManager: SelectionManager | null = null
  private selectionChatWidget: SelectionChatWidget | null = null
  private pendingSelectionRewrite: PendingSelectionRewrite | null = null

  constructor(deps: SelectionChatControllerDeps) {
    this.plugin = deps.plugin
    this.app = deps.app
    this.getSettings = deps.getSettings
    this.t = deps.t
    this.getEditorView = deps.getEditorView
    this.showSmartSpace = deps.showSmartSpace
    this.activateChatView = deps.activateChatView
    this.isSmartSpaceOpen = deps.isSmartSpaceOpen
  }

  isActive(): boolean {
    return this.selectionManager !== null
  }

  clearPendingSelectionRewrite() {
    this.pendingSelectionRewrite = null
  }

  consumePendingSelectionRewrite(): PendingSelectionRewrite | null {
    const pending = this.pendingSelectionRewrite
    this.pendingSelectionRewrite = null
    return pending
  }

  initialize() {
    const enableSelectionChat =
      this.getSettings().continuationOptions?.enableSelectionChat ?? true

    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }

    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }

    if (!enableSelectionChat) {
      return
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    const editorContainer = view.containerEl.querySelector('.cm-editor')
    if (!editorContainer) return

    this.selectionManager = new SelectionManager(
      editorContainer as HTMLElement,
      {
        enabled: true,
        minSelectionLength: 6,
        debounceDelay: 300,
      },
    )

    this.selectionManager.init((selection: SelectionInfo | null) => {
      this.handleSelectionChange(selection, view.editor)
    })
  }

  destroy() {
    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }
    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }
  }

  private handleSelectionChange(
    selection: SelectionInfo | null,
    editor: Editor,
  ) {
    this.syncSelectionBadge(selection, editor)

    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }

    if (this.isSmartSpaceOpen()) {
      return
    }

    if (selection) {
      const currentView = this.app.workspace.getActiveViewOfType(MarkdownView)
      const editorContainer =
        currentView?.containerEl.querySelector('.cm-editor')
      if (!editorContainer) {
        return
      }

      this.selectionChatWidget = new SelectionChatWidget({
        plugin: this.plugin,
        editor,
        selection,
        editorContainer: editorContainer as HTMLElement,
        onClose: () => {
          if (this.selectionChatWidget) {
            this.selectionChatWidget.destroy()
            this.selectionChatWidget = null
          }
        },
        onAction: (actionId: string, sel: SelectionInfo) => {
          void this.handleSelectionAction(actionId, sel, editor)
        },
      })
      this.selectionChatWidget.mount()
    }
  }

  private async handleSelectionAction(
    actionId: string,
    selection: SelectionInfo,
    editor: Editor,
  ) {
    const selectedText = selection.text

    switch (actionId) {
      case 'rewrite':
        this.rewriteSelection(editor, selectedText)
        break
      case 'explain':
        await this.explainSelection(editor)
        break
      default:
        console.warn('Unknown selection action:', actionId)
    }
  }

  private syncSelectionBadge(selection: SelectionInfo | null, editor: Editor) {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      return
    }

    const chatView = leaves[0].view

    if (!selection) {
      const activeMarkdownView =
        this.app.workspace.getActiveViewOfType(MarkdownView)
      if (!activeMarkdownView) {
        return
      }
      chatView.clearSelectionFromChat()
      return
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) {
      return
    }

    const data = getMentionableBlockData(editor, view)
    if (!data) {
      return
    }

    chatView.syncSelectionToChat(data)
  }

  private rewriteSelection(editor: Editor, selectedText: string) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    const cmEditor = this.getEditorView(editor)
    if (!cmEditor) return

    const from = editor.getCursor('from')
    const to = editor.getCursor('to')

    this.pendingSelectionRewrite = {
      editor,
      selectedText,
      from,
      to,
    }

    this.showSmartSpace(editor, cmEditor, true)
  }

  private async explainSelection(editor: Editor) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const data = getMentionableBlockData(editor, view)
    if (!data) {
      new Notice('无法创建选区数据')
      return
    }

    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({
        selectedBlock: data,
      })
      const newLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      if (newLeaves.length > 0 && newLeaves[0].view instanceof ChatView) {
        const chatView = newLeaves[0].view
        chatView.insertTextToInput(
          this.t('selection.actions.explain', '请深入解释') + '：',
        )
        chatView.focusMessage()
      }
      return
    }

    await this.app.workspace.revealLeaf(leaves[0])
    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.insertTextToInput(
      this.t('selection.actions.explain', '请深入解释') + '：',
    )
    chatView.focusMessage()
  }
}
