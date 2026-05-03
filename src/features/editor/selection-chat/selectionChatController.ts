import { EditorView } from '@codemirror/view'
import {
  App,
  Editor,
  type EventRef,
  MarkdownView,
  Notice,
  type WorkspaceLeaf,
} from 'obsidian'

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
import { pdfSelectionHighlightController } from '../selection-highlight/pdfSelectionHighlightController'
import { selectionHighlightController } from '../selection-highlight/selectionHighlightController'
import { PdfSelectionManager } from './PdfSelectionManager'

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
  openChatWithSelectionAndSend: (
    selectedBlock: MentionableBlockData,
    text: string,
  ) => Promise<void>
  isSmartSpaceOpen: () => boolean
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
  private readonly openChatWithSelectionAndSend: (
    selectedBlock: MentionableBlockData,
    text: string,
  ) => Promise<void>
  private readonly isSmartSpaceOpen: () => boolean

  private selectionManager: SelectionManager | null = null
  private pdfSelectionManager: PdfSelectionManager | null = null
  private selectionChatWidget: SelectionChatWidget | null = null
  private pendingSelectionRewrite: PendingSelectionRewrite | null = null
  private enableSelectionChat = true
  private layoutChangeEventRef: EventRef | null = null

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
    this.openChatWithSelectionAndSend = deps.openChatWithSelectionAndSend
    this.isSmartSpaceOpen = deps.isSmartSpaceOpen
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

    if (this.pdfSelectionManager) {
      this.pdfSelectionManager.destroy()
      this.pdfSelectionManager = null
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (view) {
      const editorContainer = view.containerEl.querySelector('.cm-editor')
      if (editorContainer) {
        this.selectionManager = new SelectionManager(
          editorContainer as HTMLElement,
          {
            enabled: true,
            minSelectionLength: 0,
            debounceDelay: 150,
          },
        )

        this.selectionManager.init((selection: SelectionInfo | null) => {
          this.handleSelectionChange(selection, view.editor)
        })
      }
    }

    // PDF selection sync — works on both desktop and mobile.
    this.pdfSelectionManager = new PdfSelectionManager(this.app, {
      enabled: enableSelectionChat,
      debounceDelay: 150,
    })
    this.pdfSelectionManager.init((result) => {
      this.handlePdfSelectionChange(result)
    })

    // Prune highlight entries for PDF leaves that get closed. initialize() can
    // be called multiple times (settings reload), so unregister the previous
    // listener before adding a new one to avoid accumulating callbacks.
    if (this.layoutChangeEventRef) {
      this.app.workspace.offref(this.layoutChangeEventRef)
      this.layoutChangeEventRef = null
    }
    this.layoutChangeEventRef = this.app.workspace.on('layout-change', () => {
      pdfSelectionHighlightController.pruneDetachedLeaves(this.app)
    })
    this.plugin.registerEvent(this.layoutChangeEventRef)
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
    if (this.pdfSelectionManager) {
      this.pdfSelectionManager.destroy()
      this.pdfSelectionManager = null
    }
    if (this.layoutChangeEventRef) {
      this.app.workspace.offref(this.layoutChangeEventRef)
      this.layoutChangeEventRef = null
    }
    // Drop all highlights and detach PDF eventBus listeners.  Reconcile in
    // Chat.tsx only clears 'chat' owner; here we want everything gone.
    selectionHighlightController.clearAll()
    pdfSelectionHighlightController.clearAll()
  }

  // Kept for the public API surface; selection highlight reconcile is now driven
  // entirely by the chat mention list, so leaf changes need no special handling here.
  handleActiveLeafChange(_leaf: WorkspaceLeaf | null) {
    // no-op
  }

  private handleSelectionChange(
    selection: SelectionInfo | null,
    editor: Editor,
  ) {
    if (
      !selection &&
      this.selectionChatWidget?.shouldPreserveOnSelectionLoss()
    ) {
      return
    }

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

    if (mode === 'chat-send') {
      await this.addToChatAndSend(editor, instruction)
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

    // Stamp a highlightId and pin the sync highlight immediately.
    const highlightId = crypto.randomUUID()
    const editorView = this.getEditorView(editor)
    if (editorView && this.shouldPersistSelectionHighlight()) {
      const selection = editorView.state.selection.main
      if (!selection.empty) {
        selectionHighlightController.addHighlight(
          editorView,
          highlightId,
          { from: selection.from, to: selection.to },
          'sync',
          'chat',
        )
      }
    }

    chatView.syncSelectionToChat({ ...data, highlightId })
  }

  /**
   * Called by PdfSelectionManager when the user's selection inside a PDF view
   * changes.
   */
  private handlePdfSelectionChange(
    result: import('./getPdfSelectionData').PdfSelectionResult,
  ): void {
    // null means the selection is not inside any PDF at all.
    if (result === null) return

    const enableSelectionChat =
      this.getSettings().continuationOptions?.enableSelectionChat ?? true
    if (!enableSelectionChat) return

    const targetLeaf = this.plugin
      .getChatLeafSessionManager()
      .resolveTargetLeaf()
    if (!(targetLeaf?.view instanceof ChatView)) return
    const chatView = targetLeaf.view

    if (result.kind === 'empty') {
      chatView.clearSelectionFromChat()
      return
    }

    // result.kind === 'data'
    const highlightId = crypto.randomUUID()

    if (this.shouldPersistSelectionHighlight()) {
      pdfSelectionHighlightController.addHighlight(
        result.leaf,
        highlightId,
        {
          range: result.range,
          pageNumber: result.pageNumber,
          file: result.file,
        },
        'sync',
        'chat',
      )
    }

    const blockData: MentionableBlockData = {
      content: result.content,
      file: result.file,
      startLine: 0,
      endLine: 0,
      pageNumber: result.pageNumber,
      source: 'selection-sync',
      highlightId,
    }
    chatView.syncSelectionToChat(blockData)
  }

  private async rewriteSelection(
    editor: Editor,
    _selection: SelectionInfo,
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
    const highlightId = crypto.randomUUID()

    if (editorView && this.shouldPersistSelectionHighlight()) {
      const sel = editorView.state.selection.main
      if (!sel.empty) {
        selectionHighlightController.addHighlight(
          editorView,
          highlightId,
          { from: sel.from, to: sel.to },
          'pinned',
          'chat',
        )
      }
    }

    const resolvedPrompt = prompt?.trim() ?? ''
    await this.openChatWithSelectionAndPrefill(
      { ...data, source: 'selection-pinned', highlightId },
      resolvedPrompt,
    )
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

    const editorView = this.getEditorView(editor)
    const highlightId = crypto.randomUUID()

    if (editorView && this.shouldPersistSelectionHighlight()) {
      const sel = editorView.state.selection.main
      if (!sel.empty) {
        selectionHighlightController.addHighlight(
          editorView,
          highlightId,
          { from: sel.from, to: sel.to },
          'pinned',
          'chat',
        )
      }
    }

    await this.addSelectionToSidebarChat({
      ...data,
      source: 'selection-pinned',
      highlightId,
    })
  }

  private async addToChatAndSend(editor: Editor, prompt?: string) {
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
    const highlightId = crypto.randomUUID()

    if (editorView && this.shouldPersistSelectionHighlight()) {
      const sel = editorView.state.selection.main
      if (!sel.empty) {
        selectionHighlightController.addHighlight(
          editorView,
          highlightId,
          { from: sel.from, to: sel.to },
          'pinned',
          'chat',
        )
      }
    }

    await this.openChatWithSelectionAndSend(
      { ...data, source: 'selection-pinned', highlightId },
      prompt?.trim() ?? '',
    )
  }

  private shouldPersistSelectionHighlight(): boolean {
    return (
      this.getSettings().continuationOptions.persistSelectionHighlight ?? true
    )
  }
}
