import { EditorView } from '@codemirror/view'
import { App, Editor, MarkdownView, Notice, type WorkspaceLeaf } from 'obsidian'

import { ChatView } from '../../../ChatView'
import type {
  SelectionActionMode,
  SelectionActionRewriteBehavior,
} from '../../../components/selection/SelectionActionsMenu'
import { SelectionChatWidget } from '../../../components/selection/SelectionChatWidget'
import {
  SelectionInfo,
  SelectionManager,
} from '../../../components/selection/SelectionManager'
import { CHAT_VIEW_TYPE } from '../../../constants'
import type SmartComposerPlugin from '../../../main'
import { SmartComposerSettings } from '../../../settings/schema/setting.types'
import type {
  Mentionable,
  MentionableBlock,
  MentionableBlockData,
} from '../../../types/mentionable'
import { getMentionableBlockData } from '../../../utils/obsidian'
import type { QuickAskSelectionScope } from '../quick-ask/quickAsk.types'
import type { QuickAskLaunchMode } from '../quick-ask/quickAsk.types'

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
  showQuickAskWithOptions: (
    editor: Editor,
    view: EditorView,
    options: {
      initialPrompt?: string
      initialMentionables?: Mentionable[]
      initialMode?: QuickAskLaunchMode
      initialInput?: string
      editContextText?: string
      editSelectionFrom?: { line: number; ch: number }
      selectionScope?: QuickAskSelectionScope
      autoSend?: boolean
    },
  ) => void
  showQuickAskWithAutoSend: (
    editor: Editor,
    view: EditorView,
    options: {
      prompt: string
      mentionables: Mentionable[]
      selectionScope?: QuickAskSelectionScope
    },
  ) => void
  openChatWithSelectionAndPrefill: (
    selectedBlock: MentionableBlockData,
    text: string,
  ) => Promise<void>
  addSelectionToSidebarChat: (
    selectedBlock: MentionableBlockData,
  ) => Promise<void>
  isSmartSpaceOpen: () => boolean
  pinSelectionHighlight: (view: EditorView) => void
  clearSelectionHighlight: (view?: EditorView) => void
}

export class SelectionChatController {
  private readonly plugin: SmartComposerPlugin
  private readonly app: App
  private readonly getSettings: () => SmartComposerSettings
  private readonly t: (key: string, fallback?: string) => string
  private readonly getEditorView: (editor: Editor) => EditorView | null
  private readonly showQuickAskWithOptions: (
    editor: Editor,
    view: EditorView,
    options: {
      initialPrompt?: string
      initialMentionables?: Mentionable[]
      initialMode?: QuickAskLaunchMode
      initialInput?: string
      editContextText?: string
      editSelectionFrom?: { line: number; ch: number }
      selectionScope?: QuickAskSelectionScope
      autoSend?: boolean
    },
  ) => void
  private readonly showQuickAskWithAutoSend: (
    editor: Editor,
    view: EditorView,
    options: {
      prompt: string
      mentionables: Mentionable[]
      selectionScope?: QuickAskSelectionScope
    },
  ) => void
  private readonly openChatWithSelectionAndPrefill: (
    selectedBlock: MentionableBlockData,
    text: string,
  ) => Promise<void>
  private readonly addSelectionToSidebarChat: (
    selectedBlock: MentionableBlockData,
  ) => Promise<void>
  private readonly isSmartSpaceOpen: () => boolean
  private readonly pinSelectionHighlight: (view: EditorView) => void
  private readonly clearSelectionHighlight: (view?: EditorView) => void

  private selectionManager: SelectionManager | null = null
  private selectionChatWidget: SelectionChatWidget | null = null
  private pendingSelectionRewrite: PendingSelectionRewrite | null = null
  private enableSelectionChat = true
  private lastActiveMarkdownLeaf: WorkspaceLeaf | null = null
  private lastActiveLeafWasMarkdown = false
  private highlightTakeoverToken = 0

  constructor(deps: SelectionChatControllerDeps) {
    this.plugin = deps.plugin
    this.app = deps.app
    this.getSettings = deps.getSettings
    this.t = deps.t
    this.getEditorView = deps.getEditorView
    this.showQuickAskWithOptions = deps.showQuickAskWithOptions
    this.showQuickAskWithAutoSend = deps.showQuickAskWithAutoSend
    this.openChatWithSelectionAndPrefill = deps.openChatWithSelectionAndPrefill
    this.addSelectionToSidebarChat = deps.addSelectionToSidebarChat
    this.isSmartSpaceOpen = deps.isSmartSpaceOpen
    this.pinSelectionHighlight = deps.pinSelectionHighlight
    this.clearSelectionHighlight = deps.clearSelectionHighlight
  }

  isActive(): boolean {
    return this.enableSelectionChat
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
    const activeLeaf =
      this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null
    this.lastActiveLeafWasMarkdown = !!(
      activeLeaf?.view instanceof MarkdownView
    )
    if (this.lastActiveLeafWasMarkdown && activeLeaf) {
      this.lastActiveMarkdownLeaf = activeLeaf
    }

    const enableSelectionChat =
      this.getSettings().continuationOptions?.enableSelectionChat ?? true
    this.enableSelectionChat = enableSelectionChat

    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }

    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    const editorContainer = view.containerEl.querySelector('.cm-editor')
    if (!editorContainer) return

    this.selectionManager = new SelectionManager(
      editorContainer as HTMLElement,
      {
        enabled: true,
        minSelectionLength: 0,
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

    this.lastActiveMarkdownLeaf = null
    this.lastActiveLeafWasMarkdown = false
    this.highlightTakeoverToken += 1
  }

  handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
    const prevWasMarkdown = this.lastActiveLeafWasMarkdown
    const nextType = leaf?.getViewState().type ?? null
    const nextIsMarkdown = !!(leaf?.view instanceof MarkdownView)

    this.lastActiveLeafWasMarkdown = nextIsMarkdown
    if (nextIsMarkdown && leaf) {
      this.lastActiveMarkdownLeaf = leaf
    }

    if (nextType === CHAT_VIEW_TYPE && prevWasMarkdown) {
      const editorView = this.getTrackedEditorView(true)
      if (editorView) {
        this.deferSelectionHighlightTakeover(editorView)
      }
      return
    }

    if (nextType !== CHAT_VIEW_TYPE) {
      this.highlightTakeoverToken += 1
      this.clearSelectionHighlight()
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

    const enableSelectionChat =
      this.getSettings().continuationOptions?.enableSelectionChat ?? true
    if (!enableSelectionChat) {
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
        onAction: (
          actionId: string,
          sel: SelectionInfo,
          instruction: string,
          mode: SelectionActionMode,
          rewriteBehavior?: SelectionActionRewriteBehavior,
        ) => {
          void this.handleSelectionAction(
            actionId,
            sel,
            editor,
            instruction,
            mode,
            rewriteBehavior,
          )
        },
      })
      this.selectionChatWidget.mount()
    }
  }

  private async handleSelectionAction(
    actionId: string,
    selection: SelectionInfo,
    editor: Editor,
    instruction: string,
    mode: SelectionActionMode,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) {
    if (mode === 'rewrite') {
      await this.rewriteSelection(
        editor,
        selection,
        instruction,
        rewriteBehavior,
      )
      return
    }

    if (mode === 'chat-input') {
      if (actionId === 'add-to-sidebar') {
        await this.addToSidebar(editor)
        return
      }
      await this.addToChatInput(editor, instruction)
      return
    }

    const prompt = instruction.trim()
    if (!prompt) {
      await this.openCustomAsk(editor)
      return
    }
    await this.explainSelection(editor, prompt)
  }

  private async openCustomAsk(editor: Editor) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const mentionable = this.createSelectionMentionable(editor, view)
    if (!mentionable) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    if (!editorView) {
      new Notice('无法获取编辑器视图')
      return
    }

    this.showQuickAskWithOptions(editor, editorView, {
      initialMode: 'chat',
      initialMentionables: [mentionable],
      selectionScope: this.createSelectionScope(mentionable, editor),
    })
  }

  private createSelectionMentionable(
    editor: Editor,
    view: MarkdownView,
  ): MentionableBlock | null {
    const data = getMentionableBlockData(editor, view)
    if (!data) {
      return null
    }

    return {
      type: 'block',
      ...data,
      source: 'selection',
    }
  }

  private createSelectionScope(
    mentionable: MentionableBlock,
    editor: Editor,
  ): QuickAskSelectionScope {
    return {
      mentionable,
      selectionFrom: editor.getCursor('from'),
    }
  }

  private syncSelectionBadge(selection: SelectionInfo | null, editor: Editor) {
    const targetLeaf = this.plugin
      .getChatLeafSessionManager()
      .resolveTargetLeaf()
    if (!(targetLeaf?.view instanceof ChatView)) {
      return
    }

    const chatView = targetLeaf.view

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

  private async rewriteSelection(
    editor: Editor,
    selection: SelectionInfo,
    instruction: string,
    rewriteBehavior?: SelectionActionRewriteBehavior,
  ) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const selectedText = editor.getSelection()
    if (!selectedText || selectedText.trim().length === 0) {
      new Notice('请先选择要改写的文本。')
      return
    }

    const mentionable = this.createSelectionMentionable(editor, view)
    if (!mentionable) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    if (!editorView) {
      new Notice('无法获取编辑器视图')
      return
    }

    const behavior = rewriteBehavior ?? 'custom'
    const prompt = instruction.trim()
    if (behavior === 'preset' && !prompt) {
      new Notice('未设置改写指令。')
      return
    }

    this.showQuickAskWithOptions(editor, editorView, {
      initialMode: 'edit',
      initialPrompt: behavior === 'preset' ? prompt : undefined,
      initialInput: behavior === 'custom' ? prompt : undefined,
      initialMentionables: [mentionable],
      editContextText: selectedText,
      editSelectionFrom: editor.getCursor('from'),
      selectionScope: this.createSelectionScope(mentionable, editor),
      autoSend: behavior === 'preset',
    })
  }

  private async explainSelection(editor: Editor, prompt?: string) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    const mentionable = this.createSelectionMentionable(editor, view)
    if (!mentionable) {
      new Notice('无法创建选区数据')
      return
    }

    const editorView = this.getEditorView(editor)
    if (!editorView) {
      new Notice('无法获取编辑器视图')
      return
    }

    const basePrompt =
      prompt?.trim() || this.t('selection.actions.explain', '请深入解释')
    this.showQuickAskWithAutoSend(editor, editorView, {
      prompt: basePrompt,
      mentionables: [mentionable],
      selectionScope: this.createSelectionScope(mentionable, editor),
    })
  }

  private async addToChatInput(editor: Editor, prompt?: string) {
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

    const editorView = this.getEditorView(editor)
    const resolvedPrompt =
      prompt?.trim() || this.t('selection.actions.explain', '请深入解释')
    await this.openChatWithSelectionAndPrefill(data, resolvedPrompt)

    if (editorView) {
      this.deferSelectionHighlightTakeover(editorView)
    }
  }

  private async addToSidebar(editor: Editor) {
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

    await this.addSelectionToSidebarChat(data)

    const editorView = this.getEditorView(editor)
    if (editorView) {
      this.deferSelectionHighlightTakeover(editorView)
    }
  }

  private shouldPersistSelectionHighlight(): boolean {
    return (
      this.getSettings().continuationOptions.persistSelectionHighlight ?? true
    )
  }

  private deferSelectionHighlightTakeover(view: EditorView) {
    if (!this.shouldPersistSelectionHighlight()) {
      return
    }

    const token = ++this.highlightTakeoverToken

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (token !== this.highlightTakeoverToken) {
          return
        }

        const selection = view.state.selection.main
        const targetLeaf = this.plugin
          .getChatLeafSessionManager()
          .resolveTargetLeaf()
        if (
          selection.empty ||
          view.hasFocus ||
          !targetLeaf ||
          this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf !==
            targetLeaf
        ) {
          return
        }

        this.pinSelectionHighlight(view)
      })
    })
  }

  private getTrackedEditorView(allowFallback: boolean): EditorView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (activeView?.editor) {
      return this.getEditorView(activeView.editor)
    }

    if (
      allowFallback &&
      this.lastActiveMarkdownLeaf?.view instanceof MarkdownView
    ) {
      return this.getEditorView(this.lastActiveMarkdownLeaf.view.editor)
    }

    return null
  }
}
