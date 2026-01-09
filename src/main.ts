import { type Extension, Prec, StateEffect } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { minimatch } from 'minimatch'
import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
} from 'obsidian'
import { getLanguage } from 'obsidian'

import { ApplyView, ApplyViewState } from './ApplyView'
import { ChatView } from './ChatView'
import { ChatProps } from './components/chat-view/Chat'
import { InstallerUpdateRequiredModal } from './components/modals/InstallerUpdateRequiredModal'
import { SelectionChatWidget } from './components/selection/SelectionChatWidget'
import { SelectionManager } from './components/selection/SelectionManager'
import type { SelectionInfo } from './components/selection/SelectionManager'
import { APPLY_VIEW_TYPE, CHAT_VIEW_TYPE } from './constants'
import { getChatModelClient } from './core/llm/manager'
import { McpManager } from './core/mcp/mcpManager'
import { RAGEngine } from './core/rag/ragEngine'
import { DatabaseManager } from './database/DatabaseManager'
import { PGLiteAbortedException } from './database/exception'
import type { VectorManager } from './database/modules/vector/VectorManager'
import {
  InlineSuggestionGhostPayload,
  inlineSuggestionGhostEffect,
  inlineSuggestionGhostField,
  thinkingIndicatorEffect,
  thinkingIndicatorField,
} from './features/editor/inline-suggestion/inlineSuggestion'
import { QuickAskController } from './features/editor/quick-ask/quickAskController'
import {
  SmartSpaceController,
  SmartSpaceDraftState,
} from './features/editor/smart-space/smartSpaceController'
import { TabCompletionController } from './features/editor/tab-completion/tabCompletionController'
import { Language, createTranslationFunction } from './i18n'
import {
  SmartComposerSettings,
  smartComposerSettingsSchema,
} from './settings/schema/setting.types'
import { parseSmartComposerSettings } from './settings/schema/settings'
import { SmartComposerSettingTab } from './settings/SettingTab'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import { LLMRequestBase, RequestMessage } from './types/llm/request'
import { MentionableFile, MentionableFolder } from './types/mentionable'
import { escapeMarkdownSpecialChars } from './utils/markdown-escape'
import {
  getMentionableBlockData,
  getNestedFiles,
  readMultipleTFiles,
  readTFileContent,
} from './utils/obsidian'

const inlineSuggestionExtensionViews = new WeakSet<EditorView>()
const FIRST_TOKEN_TIMEOUT_MS = 12000

export default class SmartComposerPlugin extends Plugin {
  settings: SmartComposerSettings
  initialChatProps?: ChatProps // TODO: change this to use view state like ApplyView
  settingsChangeListeners: ((newSettings: SmartComposerSettings) => void)[] = []
  mcpManager: McpManager | null = null
  dbManager: DatabaseManager | null = null
  ragEngine: RAGEngine | null = null
  private dbManagerInitPromise: Promise<DatabaseManager> | null = null
  private ragEngineInitPromise: Promise<RAGEngine> | null = null
  private timeoutIds: ReturnType<typeof setTimeout>[] = [] // Use ReturnType instead of number
  private pgliteResourcePath?: string
  private isContinuationInProgress = false
  private autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private isAutoUpdating = false
  private activeAbortControllers: Set<AbortController> = new Set()
  private tabCompletionController: TabCompletionController | null = null
  private activeInlineSuggestion: {
    source: 'tab' | 'continuation'
    editor: Editor
    view: EditorView
    fromOffset: number
    text: string
  } | null = null
  private continuationInlineSuggestion: {
    editor: Editor
    view: EditorView
    text: string
    fromOffset: number
    startPos: ReturnType<Editor['getCursor']>
  } | null = null
  private smartSpaceDraftState: SmartSpaceDraftState = null
  private smartSpaceController: SmartSpaceController | null = null
  // Selection chat state
  private selectionManager: SelectionManager | null = null
  private selectionChatWidget: SelectionChatWidget | null = null
  private pendingSelectionRewrite: {
    editor: Editor
    selectedText: string
    from: { line: number; ch: number }
    to: { line: number; ch: number }
  } | null = null
  // Model list cache for provider model fetching
  private modelListCache: Map<string, { models: string[]; timestamp: number }> =
    new Map()
  // Quick Ask state
  private quickAskController: QuickAskController | null = null

  getSmartSpaceDraftState(): SmartSpaceDraftState {
    return this.smartSpaceDraftState
  }

  setSmartSpaceDraftState(state: SmartSpaceDraftState) {
    this.smartSpaceDraftState = state
  }

  // Get cached model list for a provider
  getCachedModelList(providerId: string): string[] | null {
    const cached = this.modelListCache.get(providerId)
    if (cached) {
      return cached.models
    }
    return null
  }

  // Set model list cache for a provider
  setCachedModelList(providerId: string, models: string[]): void {
    this.modelListCache.set(providerId, {
      models,
      timestamp: Date.now(),
    })
  }

  // Clear all model list cache (called when settings modal closes)
  clearModelListCache(): void {
    this.modelListCache.clear()
  }

  private resolvePgliteResourcePath(): string {
    if (!this.pgliteResourcePath) {
      // manifest.dir 已经包含完整的插件目录路径（相对于 vault）
      // 例如：.obsidian/plugins/obsidian-smart-composer 或 .obsidian/plugins/yolo
      const pluginDir = this.manifest.dir
      if (pluginDir) {
        this.pgliteResourcePath = normalizePath(`${pluginDir}/vendor/pglite`)
      } else {
        // 如果 manifest.dir 不存在，使用 manifest.id 作为后备
        const configDir = this.app.vault.configDir
        this.pgliteResourcePath = normalizePath(
          `${configDir}/plugins/${this.manifest.id}/vendor/pglite`,
        )
      }
    }
    return this.pgliteResourcePath
  }

  // Compute a robust panel anchor position just below the caret line
  private getCaretPanelPosition(
    editor: Editor,
    dy = 8,
  ): { x: number; y: number } | undefined {
    try {
      const view = this.getEditorView(editor)
      if (!view) return undefined
      const head = view.state.selection.main.head
      const rect = view.coordsAtPos(head)
      if (!rect) return undefined
      const base = typeof rect.bottom === 'number' ? rect.bottom : rect.top
      if (typeof base !== 'number') return undefined
      const y = base + dy
      return { x: rect.left, y }
    } catch {
      // ignore
    }
    return undefined
  }

  private getSmartSpaceController(): SmartSpaceController {
    if (!this.smartSpaceController) {
      this.smartSpaceController = new SmartSpaceController({
        plugin: this,
        getSettings: () => this.settings,
        getActiveMarkdownView: () =>
          this.app.workspace.getActiveViewOfType(MarkdownView),
        getEditorView: (editor) => this.getEditorView(editor),
        clearPendingSelectionRewrite: () => {
          this.pendingSelectionRewrite = null
        },
      })
    }
    return this.smartSpaceController
  }

  private getQuickAskController(): QuickAskController {
    if (!this.quickAskController) {
      this.quickAskController = new QuickAskController({
        plugin: this,
        getSettings: () => this.settings,
        getActiveMarkdownView: () =>
          this.app.workspace.getActiveViewOfType(MarkdownView),
        getEditorView: (editor) => this.getEditorView(editor),
        getActiveFileTitle: () =>
          this.app.workspace.getActiveFile()?.basename?.trim() ?? '',
        closeSmartSpace: () => this.closeSmartSpace(),
      })
    }
    return this.quickAskController
  }

  private closeSmartSpace() {
    this.getSmartSpaceController().close()
  }

  private showSmartSpace(
    editor: Editor,
    view: EditorView,
    showQuickActions = true,
  ) {
    this.getSmartSpaceController().show(editor, view, showQuickActions)
  }

  // Quick Ask methods
  private closeQuickAsk() {
    this.getQuickAskController().close()
  }

  private showQuickAsk(editor: Editor, view: EditorView) {
    this.getQuickAskController().show(editor, view)
  }

  private createQuickAskTriggerExtension(): Extension {
    return this.getQuickAskController().createTriggerExtension()
  }

  // Selection Chat methods
  private initializeSelectionManager() {
    // Check if Selection Chat is enabled
    const enableSelectionChat =
      this.settings.continuationOptions?.enableSelectionChat ?? true

    // Clean up existing manager
    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }

    // Don't initialize if disabled
    if (!enableSelectionChat) {
      return
    }

    // Get the active editor container
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    const editorContainer = view.containerEl.querySelector('.cm-editor')
    if (!editorContainer) return

    // Create new selection manager
    this.selectionManager = new SelectionManager(
      editorContainer as HTMLElement,
      {
        enabled: true,
        minSelectionLength: 6,
        debounceDelay: 300,
      },
    )

    // Initialize with callback
    this.selectionManager.init((selection: SelectionInfo | null) => {
      this.handleSelectionChange(selection, view.editor)
    })
  }

  private handleSelectionChange(
    selection: SelectionInfo | null,
    editor: Editor,
  ) {
    // Close existing widget
    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }

    // Don't show if Smart Space is active
    if (this.smartSpaceController?.isOpen()) {
      return
    }

    // Show new widget if selection is valid
    if (selection) {
      const currentView = this.app.workspace.getActiveViewOfType(MarkdownView)
      const editorContainer =
        currentView?.containerEl.querySelector('.cm-editor')
      if (!editorContainer) {
        return
      }

      this.selectionChatWidget = new SelectionChatWidget({
        plugin: this,
        editor,
        selection,
        editorContainer: editorContainer as HTMLElement,
        onClose: () => {
          if (this.selectionChatWidget) {
            this.selectionChatWidget.destroy()
            this.selectionChatWidget = null
          }
        },
        onAction: async (actionId: string, sel: SelectionInfo) => {
          await this.handleSelectionAction(actionId, sel, editor)
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
      case 'add-to-chat':
        // Add selected text to chat
        await this.addTextToChat(selectedText)
        break

      case 'rewrite':
        // Trigger rewrite with selected text
        this.rewriteSelection(editor, selectedText)
        break

      case 'explain':
        // Add selection as badge and pre-fill explanation prompt
        await this.explainSelection(editor)
        break

      default:
        console.warn('Unknown selection action:', actionId)
    }
  }

  private async addTextToChat(_text: string) {
    // Get current file and editor info for context
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor

    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    // Create mentionable block data from selection
    const data = getMentionableBlockData(editor, view)
    if (!data) {
      new Notice('无法创建选区数据')
      return
    }

    // Get or open chat view
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({
        selectedBlock: data,
      })
      return
    }

    // Use existing chat view
    await this.app.workspace.revealLeaf(leaves[0])
    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.focusMessage()
  }

  private rewriteSelection(editor: Editor, selectedText: string) {
    // Show Smart Space-like input for rewrite instruction
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    // Get CodeMirror view
    const cmEditor = this.getEditorView(editor)
    if (!cmEditor) return

    // Save selection positions before they get lost
    const from = editor.getCursor('from')
    const to = editor.getCursor('to')

    // Set pending rewrite state so continueWriting knows to call handleCustomRewrite
    this.pendingSelectionRewrite = {
      editor,
      selectedText,
      from,
      to,
    }

    // Show custom continue widget for user to input rewrite instruction
    this.showSmartSpace(editor, cmEditor, true)
  }

  private async explainSelection(editor: Editor) {
    // Add selection as badge to chat and pre-fill explanation prompt
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!editor || !view) {
      new Notice('无法获取当前编辑器')
      return
    }

    // Create mentionable block data from selection
    const data = getMentionableBlockData(editor, view)
    if (!data) {
      new Notice('无法创建选区数据')
      return
    }

    // Get or open chat view
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({
        selectedBlock: data,
      })
      // After opening, insert the prompt
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

    // Use existing chat view
    await this.app.workspace.revealLeaf(leaves[0])
    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.insertTextToInput(
      this.t('selection.actions.explain', '请深入解释') + '：',
    )
    chatView.focusMessage()
  }

  private createSmartSpaceTriggerExtension(): Extension {
    return this.getSmartSpaceController().createTriggerExtension()
  }

  private getActiveConversationOverrides():
    | ConversationOverrideSettings
    | undefined {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    for (const leaf of leaves) {
      const view = leaf.view
      if (
        view instanceof ChatView &&
        typeof view.getCurrentConversationOverrides === 'function'
      ) {
        return view.getCurrentConversationOverrides()
      }
    }
    return undefined
  }

  private getActiveConversationModelId(): string | undefined {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    for (const leaf of leaves) {
      const view = leaf.view
      if (
        view instanceof ChatView &&
        typeof view.getCurrentConversationModelId === 'function'
      ) {
        const modelId = view.getCurrentConversationModelId()
        if (modelId) return modelId
      }
    }
    return undefined
  }

  private resolveContinuationParams(overrides?: ConversationOverrideSettings): {
    temperature?: number
    topP?: number
    stream: boolean
    useVaultSearch: boolean
  } {
    const continuation = this.settings.continuationOptions ?? {}

    const temperature =
      typeof continuation.temperature === 'number'
        ? continuation.temperature
        : typeof overrides?.temperature === 'number'
          ? overrides.temperature
          : undefined

    const overrideTopP = overrides?.top_p
    const topP =
      typeof continuation.topP === 'number'
        ? continuation.topP
        : typeof overrideTopP === 'number'
          ? overrideTopP
          : undefined

    const stream =
      typeof continuation.stream === 'boolean'
        ? continuation.stream
        : typeof overrides?.stream === 'boolean'
          ? overrides.stream
          : true

    const useVaultSearch =
      typeof continuation.useVaultSearch === 'boolean'
        ? continuation.useVaultSearch
        : typeof overrides?.useVaultSearch === 'boolean'
          ? overrides.useVaultSearch
          : Boolean(this.settings.ragOptions?.enabled)

    return { temperature, topP, stream, useVaultSearch }
  }

  private resolveObsidianLanguage(): Language {
    const rawLanguage = getLanguage()
    const domLanguage =
      typeof document !== 'undefined'
        ? document.documentElement.lang || navigator.language || ''
        : ''
    const storedLanguage =
      typeof window !== 'undefined'
        ? window.localStorage.getItem('language') || ''
        : ''
    const candidates = [rawLanguage, domLanguage, storedLanguage]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
    const normalized =
      candidates.find((value) => value !== 'en') ?? candidates[0] ?? 'en'
    if (normalized.startsWith('zh')) return 'zh'
    if (normalized.startsWith('it')) return 'it'
    return 'en'
  }

  private resolvePreferredLanguage(): Language {
    const preference = this.settings.languagePreference
    if (preference && preference !== 'auto') {
      return preference
    }
    return this.resolveObsidianLanguage()
  }

  get t() {
    return createTranslationFunction(this.resolvePreferredLanguage())
  }

  private cancelAllAiTasks() {
    if (this.activeAbortControllers.size === 0) {
      this.isContinuationInProgress = false
      return
    }
    for (const controller of Array.from(this.activeAbortControllers)) {
      try {
        controller.abort()
      } catch {
        // Ignore abort errors; controllers may already be settled.
      }
    }
    this.activeAbortControllers.clear()
    this.isContinuationInProgress = false
    this.tabCompletionController?.cancelRequest()
  }

  private getEditorView(editor: Editor | null | undefined): EditorView | null {
    if (!editor) return null
    if (this.isEditorWithCodeMirror(editor)) {
      const { cm } = editor
      if (cm instanceof EditorView) {
        return cm
      }
    }
    return null
  }

  private isEditorWithCodeMirror(
    editor: Editor,
  ): editor is Editor & { cm?: EditorView } {
    if (typeof editor !== 'object' || editor === null || !('cm' in editor)) {
      return false
    }
    const maybeEditor = editor as Editor & { cm?: EditorView }
    return maybeEditor.cm instanceof EditorView
  }

  private ensureInlineSuggestionExtension(view: EditorView) {
    if (inlineSuggestionExtensionViews.has(view)) return
    view.dispatch({
      effects: StateEffect.appendConfig.of([
        inlineSuggestionGhostField,
        thinkingIndicatorField,
        Prec.high(
          keymap.of([
            {
              key: 'Tab',
              run: (v) => this.tryAcceptInlineSuggestionFromView(v),
            },
            {
              key: 'Shift-Tab',
              run: (v) => this.tryRejectInlineSuggestionFromView(v),
            },
            {
              key: 'Escape',
              run: (v) => this.tryRejectInlineSuggestionFromView(v),
            },
          ]),
        ),
      ]),
    })
    inlineSuggestionExtensionViews.add(view)
  }

  private setInlineSuggestionGhost(
    view: EditorView,
    payload: InlineSuggestionGhostPayload,
  ) {
    this.ensureInlineSuggestionExtension(view)
    view.dispatch({ effects: inlineSuggestionGhostEffect.of(payload) })
  }

  private showThinkingIndicator(
    view: EditorView,
    from: number,
    label: string,
    snippet?: string,
  ) {
    this.ensureInlineSuggestionExtension(view)
    view.dispatch({
      effects: thinkingIndicatorEffect.of({
        from,
        label,
        snippet,
      }),
    })
  }

  private hideThinkingIndicator(view: EditorView) {
    view.dispatch({ effects: thinkingIndicatorEffect.of(null) })
  }

  private getTabCompletionController(): TabCompletionController {
    if (!this.tabCompletionController) {
      this.tabCompletionController = new TabCompletionController({
        getSettings: () => this.settings,
        getEditorView: (editor) => this.getEditorView(editor),
        getActiveMarkdownView: () =>
          this.app.workspace.getActiveViewOfType(MarkdownView),
        getActiveConversationOverrides: () =>
          this.getActiveConversationOverrides(),
        resolveContinuationParams: (overrides) =>
          this.resolveContinuationParams(overrides),
        getActiveFileTitle: () =>
          this.app.workspace.getActiveFile()?.basename?.trim() ?? '',
        setInlineSuggestionGhost: (view, payload) =>
          this.setInlineSuggestionGhost(view, payload),
        clearInlineSuggestion: () => this.clearInlineSuggestion(),
        setActiveInlineSuggestion: (suggestion) => {
          this.activeInlineSuggestion = suggestion
        },
        addAbortController: (controller) =>
          this.activeAbortControllers.add(controller),
        removeAbortController: (controller) =>
          this.activeAbortControllers.delete(controller),
        isContinuationInProgress: () => this.isContinuationInProgress,
      })
    }
    return this.tabCompletionController
  }

  private cancelTabCompletionRequest() {
    this.tabCompletionController?.cancelRequest()
  }

  private clearTabCompletionTimer() {
    this.tabCompletionController?.clearTimer()
  }

  private clearInlineSuggestion() {
    this.tabCompletionController?.clearSuggestion()
    if (this.continuationInlineSuggestion) {
      const { view } = this.continuationInlineSuggestion
      if (view) {
        this.setInlineSuggestionGhost(view, null)
      }
      this.continuationInlineSuggestion = null
    }
    this.activeInlineSuggestion = null
  }

  private tryAcceptInlineSuggestionFromView(view: EditorView): boolean {
    const suggestion = this.activeInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) return false

    if (suggestion.source === 'tab') {
      return this.getTabCompletionController().tryAcceptFromView(view)
    }

    if (suggestion.source === 'continuation') {
      return this.tryAcceptContinuationFromView(view)
    }

    return false
  }

  private tryRejectInlineSuggestionFromView(view: EditorView): boolean {
    const suggestion = this.activeInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) return false
    this.clearInlineSuggestion()
    return true
  }

  private tryAcceptContinuationFromView(view: EditorView): boolean {
    const suggestion = this.continuationInlineSuggestion
    if (!suggestion) return false
    if (suggestion.view !== view) {
      this.clearInlineSuggestion()
      return false
    }

    const active = this.activeInlineSuggestion
    if (!active || active.source !== 'continuation') return false

    const { editor, text, startPos } = suggestion
    if (!text || text.length === 0) {
      this.clearInlineSuggestion()
      return false
    }

    if (this.getEditorView(editor) !== view) {
      this.clearInlineSuggestion()
      return false
    }

    if (editor.getSelection()?.length) {
      this.clearInlineSuggestion()
      return false
    }

    const insertionText = escapeMarkdownSpecialChars(text, {
      escapeAngleBrackets: true,
      preserveCodeBlocks: true,
    })
    this.clearInlineSuggestion()
    editor.replaceRange(insertionText, startPos, startPos)

    const parts = insertionText.split('\n')
    const endCursor =
      parts.length === 1
        ? { line: startPos.line, ch: startPos.ch + parts[0].length }
        : {
            line: startPos.line + parts.length - 1,
            ch: parts[parts.length - 1].length,
          }
    editor.setCursor(endCursor)
    return true
  }

  private handleTabCompletionEditorChange(editor: Editor) {
    this.getTabCompletionController().handleEditorChange(editor)
  }

  private async handleCustomRewrite(
    editor: Editor,
    customPrompt?: string,
    preSelectedText?: string,
    preSelectionFrom?: { line: number; ch: number },
  ) {
    // Use pre-selected text if provided (from Selection Chat), otherwise get current selection
    const selected = preSelectedText ?? editor.getSelection()
    if (!selected || selected.trim().length === 0) {
      new Notice('请先选择要改写的文本。')
      return
    }

    // Use pre-saved selection start position if provided, otherwise get current
    const from = preSelectionFrom ?? editor.getCursor('from')

    const notice = new Notice('正在生成改写...', 0)
    // 立即创建并注册 AbortController
    const controller = new AbortController()
    this.activeAbortControllers.add(controller)

    try {
      const sidebarOverrides = this.getActiveConversationOverrides()
      const {
        temperature,
        topP,
        stream: streamPreference,
      } = this.resolveContinuationParams(sidebarOverrides)

      const rewriteModelId =
        this.settings.continuationOptions?.continuationModelId ??
        this.settings.chatModelId

      const { providerClient, model } = getChatModelClient({
        settings: this.settings,
        modelId: rewriteModelId,
      })

      const systemPrompt =
        'You are an intelligent assistant that rewrites ONLY the provided markdown text according to the instruction. Preserve the original meaning, structure, and any markdown (links, emphasis, code) unless explicitly told otherwise. Output ONLY the rewritten text without code fences or extra explanations.'

      const instruction = (customPrompt ?? '').trim()
      const isBaseModel = Boolean(model.isBaseModel)
      const baseModelSpecialPrompt = (
        this.settings.chatOptions.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const requestMessages: RequestMessage[] = [
        ...(isBaseModel
          ? []
          : [
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ]),
        {
          role: 'user' as const,
          content: `${basePromptSection}Instruction:\n${instruction}\n\nSelected text:\n${selected}\n\nRewrite the selected text accordingly. Output only the rewritten text.`,
        },
      ]

      const rewriteRequestBase: LLMRequestBase = {
        model: model.model,
        messages: requestMessages,
      }
      if (typeof temperature === 'number') {
        rewriteRequestBase.temperature = temperature
      }
      if (typeof topP === 'number') {
        rewriteRequestBase.top_p = topP
      }

      const stripFences = (s: string) => {
        const lines = (s ?? '').split('\n')
        if (lines.length > 0 && lines[0].startsWith('```')) lines.shift()
        if (lines.length > 0 && lines[lines.length - 1].startsWith('```'))
          lines.pop()
        return lines.join('\n')
      }

      let rewritten = ''
      if (streamPreference) {
        const streamIterator = await providerClient.streamResponse(
          model,
          { ...rewriteRequestBase, stream: true },
          { signal: controller.signal },
        )
        let accumulated = ''
        for await (const chunk of streamIterator) {
          // 每次循环都检查是否已被中止
          if (controller.signal.aborted) {
            break
          }

          const delta = chunk?.choices?.[0]?.delta
          const piece = delta?.content ?? ''
          if (!piece) continue
          accumulated += piece
        }
        rewritten = stripFences(accumulated).trim()
      } else {
        const response = await providerClient.generateResponse(
          model,
          { ...rewriteRequestBase, stream: false },
          { signal: controller.signal },
        )
        rewritten = stripFences(
          response.choices?.[0]?.message?.content ?? '',
        ).trim()
      }
      if (!rewritten) {
        notice.setMessage('未生成改写内容。')
        this.registerTimeout(() => notice.hide(), 1200)
        return
      }

      // Open ApplyView with a preview diff and let user choose; ApplyView will close back to doc
      const activeFile = this.app.workspace.getActiveFile()
      if (!activeFile) {
        notice.setMessage('未找到当前文件。')
        this.registerTimeout(() => notice.hide(), 1200)
        return
      }

      const head = editor.getRange({ line: 0, ch: 0 }, from)
      const originalContent = await readTFileContent(activeFile, this.app.vault)
      const tail = originalContent.slice(head.length + selected.length)
      const newContent = head + rewritten + tail

      await this.app.workspace.getLeaf(true).setViewState({
        type: APPLY_VIEW_TYPE,
        active: true,
        state: {
          file: activeFile,
          originalContent,
          newContent,
        } satisfies ApplyViewState,
      })

      notice.setMessage('改写结果已生成。')
      this.registerTimeout(() => notice.hide(), 1200)
    } catch (error) {
      if (error?.name === 'AbortError') {
        notice.setMessage('已取消生成。')
        this.registerTimeout(() => notice.hide(), 1000)
      } else {
        console.error(error)
        notice.setMessage('改写失败。')
        this.registerTimeout(() => notice.hide(), 1200)
      }
    } finally {
      this.activeAbortControllers.delete(controller)
    }
  }

  async onload() {
    await this.loadSettings()

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.registerView(APPLY_VIEW_TYPE, (leaf) => new ApplyView(leaf, this))

    this.registerEditorExtension(this.createSmartSpaceTriggerExtension())
    this.registerEditorExtension(this.createQuickAskTriggerExtension())
    this.registerEditorExtension(
      this.getTabCompletionController().createTriggerExtension(),
    )

    // This creates an icon in the left ribbon.
    this.addRibbonIcon('wand-sparkles', this.t('commands.openChat'), () => {
      void this.openChatView()
    })

    // This adds a simple command that can be triggered anywhere
    this.addCommand({
      id: 'open-new-chat',
      name: this.t('commands.openChat'),
      callback: () => {
        void this.openChatView(true)
      },
    })

    // Global ESC to cancel any ongoing AI continuation/rewrite
    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Do not prevent default so other ESC behaviors (close modals, etc.) still work
        this.cancelAllAiTasks()
      }
    })

    this.addCommand({
      id: 'add-selection-to-chat',
      name: this.t('commands.addSelectionToChat'),
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.addSelectionToChat(editor, view)
      },
    })

    this.addCommand({
      id: 'trigger-smart-space',
      name: this.t('commands.triggerSmartSpace'),
      editorCallback: (editor: Editor) => {
        const cmView = this.getEditorView(editor)
        if (!cmView) return
        this.showSmartSpace(editor, cmView, true)
      },
    })

    this.addCommand({
      id: 'trigger-quick-ask',
      name: this.t('commands.triggerQuickAsk'),
      editorCallback: (editor: Editor) => {
        const cmView = this.getEditorView(editor)
        if (!cmView) return
        this.showQuickAsk(editor, cmView)
      },
    })

    this.addCommand({
      id: 'trigger-tab-completion',
      name: this.t('commands.triggerTabCompletion'),
      editorCallback: (editor: Editor) => {
        const cmView = this.getEditorView(editor)
        if (!cmView) return
        const cursorOffset = cmView.state.selection.main.head
        void this.getTabCompletionController().run(editor, cursorOffset)
      },
    })

    // Register file context menu for adding file/folder to chat
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile) {
          menu.addItem((item) => {
            item
              .setTitle(this.t('commands.addFileToChat'))
              .setIcon('message-square-plus')
              .onClick(async () => {
                await this.addFileToChat(file)
              })
          })
        } else if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle(this.t('commands.addFolderToChat'))
              .setIcon('message-square-plus')
              .onClick(async () => {
                await this.addFolderToChat(file)
              })
          })
        }
      }),
    )

    // Auto update: listen to vault file changes and schedule incremental index updates
    this.registerEvent(
      this.app.vault.on('create', (file) => this.onVaultFileChanged(file)),
    )
    this.registerEvent(
      this.app.vault.on('modify', (file) => this.onVaultFileChanged(file)),
    )
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.onVaultFileChanged(file)),
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.onVaultFileChanged(file)
        if (oldPath) this.onVaultPathChanged(oldPath)
      }),
    )

    this.addCommand({
      id: 'rebuild-vault-index',
      name: this.t('commands.rebuildVaultIndex'),
      callback: async () => {
        // 预检查 PGlite 资源
        try {
          const dbManager = await this.getDbManager()
          const resourceCheck = await dbManager.checkPGliteResources()

          if (!resourceCheck.available) {
            new Notice(
              this.t(
                'notices.pgliteUnavailable',
                'PGlite resources unavailable. Please reinstall the plugin.',
              ),
              5000,
            )
            return
          }
        } catch (error) {
          console.warn('Failed to check PGlite resources:', error)
          // 继续执行，让实际的加载逻辑处理错误
        }

        const notice = new Notice(this.t('notices.rebuildingIndex'), 0)
        try {
          const ragEngine = await this.getRAGEngine()
          await ragEngine.updateVaultIndex(
            { reindexAll: true },
            (queryProgress) => {
              if (queryProgress.type === 'indexing') {
                const { completedChunks, totalChunks } =
                  queryProgress.indexProgress
                notice.setMessage(
                  `Indexing chunks: ${completedChunks} / ${totalChunks}${
                    queryProgress.indexProgress.waitingForRateLimit
                      ? '\n(waiting for rate limit to reset)'
                      : ''
                  }`,
                )
              }
            },
          )
          notice.setMessage(this.t('notices.rebuildComplete'))
        } catch (error) {
          console.error(error)
          notice.setMessage(this.t('notices.rebuildFailed'))
        } finally {
          this.registerTimeout(() => {
            notice.hide()
          }, 1000)
        }
      },
    })

    this.addCommand({
      id: 'update-vault-index',
      name: this.t('commands.updateVaultIndex'),
      callback: async () => {
        const notice = new Notice(this.t('notices.updatingIndex'), 0)
        try {
          const ragEngine = await this.getRAGEngine()
          await ragEngine.updateVaultIndex(
            { reindexAll: false },
            (queryProgress) => {
              if (queryProgress.type === 'indexing') {
                const { completedChunks, totalChunks } =
                  queryProgress.indexProgress
                notice.setMessage(
                  `Indexing chunks: ${completedChunks} / ${totalChunks}${
                    queryProgress.indexProgress.waitingForRateLimit
                      ? '\n(waiting for rate limit to reset)'
                      : ''
                  }`,
                )
              }
            },
          )
          notice.setMessage(this.t('notices.indexUpdated'))
        } catch (error) {
          console.error(error)
          notice.setMessage(this.t('notices.indexUpdateFailed'))
        } finally {
          this.registerTimeout(() => {
            notice.hide()
          }, 1000)
        }
      },
    })
    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new SmartComposerSettingTab(this.app, this))

    // removed templates JSON migration

    // Handle tab completion trigger
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        try {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView)
          const editor = view?.editor
          if (!editor) return
          this.handleTabCompletionEditorChange(editor)
          // Update selection manager with new editor container
          this.initializeSelectionManager()
        } catch (err) {
          console.error('Editor change handler error:', err)
        }
      }),
    )

    // Initialize selection chat
    this.initializeSelectionManager()

    // Listen for settings changes to reinitialize Selection Chat
    this.addSettingsChangeListener((newSettings) => {
      const enableSelectionChat =
        newSettings.continuationOptions?.enableSelectionChat ?? true
      const wasEnabled = this.selectionManager !== null

      if (enableSelectionChat !== wasEnabled) {
        // Re-initialize when the setting changes
        this.initializeSelectionManager()
      }
    })
  }

  onunload() {
    this.closeSmartSpace()

    // Selection chat cleanup
    if (this.selectionChatWidget) {
      this.selectionChatWidget.destroy()
      this.selectionChatWidget = null
    }
    if (this.selectionManager) {
      this.selectionManager.destroy()
      this.selectionManager = null
    }

    // clear all timers
    this.timeoutIds.forEach((id) => clearTimeout(id))
    this.timeoutIds = []

    // RagEngine cleanup
    this.ragEngine?.cleanup()
    this.ragEngine = null

    // Promise cleanup
    this.dbManagerInitPromise = null
    this.ragEngineInitPromise = null

    // DatabaseManager cleanup
    if (this.dbManager) {
      void this.dbManager.cleanup()
    }
    this.dbManager = null

    // McpManager cleanup
    if (this.mcpManager) {
      this.mcpManager.cleanup()
    }
    this.mcpManager = null
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer)
      this.autoUpdateTimer = null
    }
    // Ensure all in-flight requests are aborted on unload
    this.cancelAllAiTasks()
    this.clearTabCompletionTimer()
    this.cancelTabCompletionRequest()
    this.clearInlineSuggestion()
  }

  async loadSettings() {
    this.settings = parseSmartComposerSettings(await this.loadData())
    await this.saveData(this.settings) // Save updated settings
  }

  async setSettings(newSettings: SmartComposerSettings) {
    const validationResult = smartComposerSettingsSchema.safeParse(newSettings)

    if (!validationResult.success) {
      new Notice(`Invalid settings:
${validationResult.error.issues.map((v) => v.message).join('\n')}`)
      return
    }

    this.settings = newSettings
    await this.saveData(newSettings)
    this.ragEngine?.setSettings(newSettings)
    this.settingsChangeListeners.forEach((listener) => listener(newSettings))
  }

  addSettingsChangeListener(
    listener: (newSettings: SmartComposerSettings) => void,
  ) {
    this.settingsChangeListeners.push(listener)
    return () => {
      this.settingsChangeListeners = this.settingsChangeListeners.filter(
        (l) => l !== listener,
      )
    }
  }

  async openChatView(openNewChat = false) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    const editor = view?.editor
    if (!view || !editor) {
      await this.activateChatView(undefined, openNewChat)
      return
    }
    const selectedBlockData = getMentionableBlockData(editor, view)
    await this.activateChatView(
      {
        selectedBlock: selectedBlockData ?? undefined,
      },
      openNewChat,
    )
  }

  async activateChatView(chatProps?: ChatProps, openNewChat = false) {
    // chatProps is consumed in ChatView.tsx
    this.initialChatProps = chatProps

    const leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]
    if (leaf && leaf.view instanceof ChatView) {
      leaf.view.setInitialChatProps(chatProps)
    }

    await (leaf ?? this.app.workspace.getRightLeaf(false))?.setViewState({
      type: CHAT_VIEW_TYPE,
      active: true,
    })

    if (openNewChat && leaf && leaf.view instanceof ChatView) {
      leaf.view.openNewChat(chatProps?.selectedBlock)
    }

    const leafToReveal =
      leaf ?? this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]
    if (leafToReveal) {
      await this.app.workspace.revealLeaf(leafToReveal)
    }
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const data = getMentionableBlockData(editor, view)
    if (!data) return

    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView({
        selectedBlock: data,
      })
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addSelectionToChat(data)
    chatView.focusMessage()
  }

  async addFileToChat(file: TFile) {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView()
      // Get the newly created chat view
      const newLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      if (newLeaves.length > 0 && newLeaves[0].view instanceof ChatView) {
        const chatView = newLeaves[0].view
        chatView.addFileToChat(file)
        chatView.focusMessage()
      }
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addFileToChat(file)
    chatView.focusMessage()
  }

  async addFolderToChat(folder: TFolder) {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      await this.activateChatView()
      // Get the newly created chat view
      const newLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
      if (newLeaves.length > 0 && newLeaves[0].view instanceof ChatView) {
        const chatView = newLeaves[0].view
        chatView.addFolderToChat(folder)
        chatView.focusMessage()
      }
      return
    }

    // bring leaf to foreground (uncollapse sidebar if it's collapsed)
    await this.app.workspace.revealLeaf(leaves[0])

    const chatView = leaves[0].view
    chatView.addFolderToChat(folder)
    chatView.focusMessage()
  }

  async getDbManager(): Promise<DatabaseManager> {
    if (this.dbManager) {
      return this.dbManager
    }

    if (!this.dbManagerInitPromise) {
      this.dbManagerInitPromise = (async () => {
        try {
          this.dbManager = await DatabaseManager.create(
            this.app,
            this.resolvePgliteResourcePath(),
          )
          return this.dbManager
        } catch (error) {
          this.dbManagerInitPromise = null
          if (error instanceof PGLiteAbortedException) {
            new InstallerUpdateRequiredModal(this.app).open()
          }
          throw error
        }
      })()
    }

    // if initialization is running, wait for it to complete instead of creating a new initialization promise
    return this.dbManagerInitPromise
  }

  async tryGetVectorManager(): Promise<VectorManager | null> {
    try {
      const dbManager = await this.getDbManager()
      return dbManager.getVectorManager()
    } catch (error) {
      console.warn(
        '[Smart Composer] Failed to initialize vector manager, skip vector-dependent operations.',
        error,
      )
      return null
    }
  }

  async getRAGEngine(): Promise<RAGEngine> {
    if (this.ragEngine) {
      return this.ragEngine
    }

    if (!this.ragEngineInitPromise) {
      this.ragEngineInitPromise = (async () => {
        try {
          const dbManager = await this.getDbManager()
          this.ragEngine = new RAGEngine(
            this.app,
            this.settings,
            dbManager.getVectorManager(),
          )
          return this.ragEngine
        } catch (error) {
          this.ragEngineInitPromise = null
          throw error
        }
      })()
    }

    return this.ragEngineInitPromise
  }

  async getMcpManager(): Promise<McpManager> {
    if (this.mcpManager) {
      return this.mcpManager
    }

    try {
      this.mcpManager = new McpManager({
        settings: this.settings,
        registerSettingsListener: (
          listener: (settings: SmartComposerSettings) => void,
        ) => this.addSettingsChangeListener(listener),
      })
      await this.mcpManager.initialize()
      return this.mcpManager
    } catch (error) {
      this.mcpManager = null
      throw error
    }
  }

  private registerTimeout(callback: () => void, timeout: number): void {
    const timeoutId = setTimeout(callback, timeout)
    this.timeoutIds.push(timeoutId)
  }

  // ===== Auto Update helpers =====
  private onVaultFileChanged(file: TAbstractFile) {
    try {
      // 使用严格类型判断，避免通过 any 访问 path
      if (file instanceof TFile || file instanceof TFolder) {
        this.onVaultPathChanged(file.path)
      }
    } catch {
      // Ignore unexpected file type changes during event handling.
    }
  }

  private onVaultPathChanged(path: string) {
    if (!this.settings?.ragOptions?.autoUpdateEnabled) return
    if (!this.isPathSelectedByIncludeExclude(path)) return
    // Check minimal interval
    const intervalMs =
      (this.settings.ragOptions.autoUpdateIntervalHours ?? 24) * 60 * 60 * 1000
    const last = this.settings.ragOptions.lastAutoUpdateAt ?? 0
    const now = Date.now()
    if (now - last < intervalMs) {
      // Still within cool-down; no action
      return
    }
    // Debounce multiple changes within a short window
    if (this.autoUpdateTimer) clearTimeout(this.autoUpdateTimer)
    this.autoUpdateTimer = setTimeout(() => void this.runAutoUpdate(), 3000)
  }

  private isPathSelectedByIncludeExclude(path: string): boolean {
    const { includePatterns = [], excludePatterns = [] } =
      this.settings?.ragOptions ?? {}
    // Exclude has priority
    if (excludePatterns.some((p) => minimatch(path, p))) return false
    if (!includePatterns || includePatterns.length === 0) return true
    return includePatterns.some((p) => minimatch(path, p))
  }

  private async runAutoUpdate() {
    if (this.isAutoUpdating) return
    this.isAutoUpdating = true
    try {
      const ragEngine = await this.getRAGEngine()
      await ragEngine.updateVaultIndex({ reindexAll: false }, undefined)
      await this.setSettings({
        ...this.settings,
        ragOptions: {
          ...this.settings.ragOptions,
          lastAutoUpdateAt: Date.now(),
        },
      })
      new Notice(this.t('notices.indexUpdated'))
    } catch (e) {
      console.error('Auto update index failed:', e)
      new Notice(this.t('notices.indexUpdateFailed'))
    } finally {
      this.isAutoUpdating = false
      this.autoUpdateTimer = null
    }
  }

  // Public wrapper for use in React modal
  async continueWriting(
    editor: Editor,
    customPrompt?: string,
    geminiTools?: { useWebSearch?: boolean; useUrlContext?: boolean },
    mentionables?: (MentionableFile | MentionableFolder)[],
  ) {
    // Check if this is actually a rewrite request from Selection Chat
    if (this.pendingSelectionRewrite) {
      const {
        editor: rewriteEditor,
        selectedText,
        from,
      } = this.pendingSelectionRewrite
      this.pendingSelectionRewrite = null // Clear the pending state

      // Pass the pre-saved selectedText and position directly to handleCustomRewrite
      // No need to re-select or check current selection
      await this.handleCustomRewrite(
        rewriteEditor,
        customPrompt,
        selectedText,
        from,
      )
      return
    }
    return this.handleContinueWriting(
      editor,
      customPrompt,
      geminiTools,
      mentionables,
    )
  }

  // Public wrapper for use in React panel
  async customRewrite(editor: Editor, customPrompt?: string) {
    return this.handleCustomRewrite(editor, customPrompt)
  }

  private async handleContinueWriting(
    editor: Editor,
    customPrompt?: string,
    geminiTools?: { useWebSearch?: boolean; useUrlContext?: boolean },
    mentionables?: (MentionableFile | MentionableFolder)[],
  ) {
    // 先取消所有进行中的任务，避免旧任务的流式响应覆盖新任务的状态
    this.cancelAllAiTasks()
    this.clearInlineSuggestion()

    // 立即创建并注册 AbortController，确保整个流程都能被中止
    const controller = new AbortController()
    this.activeAbortControllers.add(controller)
    let view: EditorView | null = null

    try {
      const notice = new Notice('Generating continuation...', 0)
      const cursor = editor.getCursor()
      const selected = editor.getSelection()
      const headText = editor.getRange({ line: 0, ch: 0 }, cursor)

      // Prefer selected text as context when available; otherwise use preceding content
      const hasSelection = !!selected && selected.trim().length > 0
      const baseContext = hasSelection ? selected : headText
      const fallbackInstruction = (customPrompt ?? '').trim()
      const fileTitleCandidate =
        this.app.workspace.getActiveFile()?.basename?.trim() ?? ''

      if (!baseContext || baseContext.trim().length === 0) {
        // 没有前文时，如果既没有自定义指令也没有文件标题，则提示无法续写；
        // 否则允许基于标题或自定义指令开始写作
        if (!fallbackInstruction && !fileTitleCandidate) {
          notice.setMessage('No preceding content to continue.')
          this.registerTimeout(() => notice.hide(), 1000)
          return
        }
      }

      const referenceRuleFolders =
        this.settings.continuationOptions?.referenceRuleFolders ??
        this.settings.continuationOptions?.manualContextFolders ??
        []

      let referenceRulesSection = ''
      if (referenceRuleFolders.length > 0) {
        try {
          const referenceFilesMap = new Map<string, TFile>()
          const isSupportedReferenceFile = (file: TFile) => {
            const ext = file.extension?.toLowerCase?.() ?? ''
            return ext === 'md' || ext === 'markdown' || ext === 'txt'
          }

          for (const rawPath of referenceRuleFolders) {
            const folderPath = rawPath.trim()
            if (!folderPath) continue
            const abstract = this.app.vault.getAbstractFileByPath(folderPath)
            if (abstract instanceof TFolder) {
              for (const file of getNestedFiles(abstract, this.app.vault)) {
                if (isSupportedReferenceFile(file)) {
                  referenceFilesMap.set(file.path, file)
                }
              }
            } else if (abstract instanceof TFile) {
              if (isSupportedReferenceFile(abstract)) {
                referenceFilesMap.set(abstract.path, abstract)
              }
            }
          }

          const referenceFiles = Array.from(referenceFilesMap.values())
          if (referenceFiles.length > 0) {
            const referenceContents = await readMultipleTFiles(
              referenceFiles,
              this.app.vault,
            )
            const referenceLabel = this.t(
              'sidebar.composer.referenceRulesTitle',
              'Reference rules',
            )
            const blocks = referenceFiles.map((file, index) => {
              const content = referenceContents[index] ?? ''
              return `File: ${file.path}\n${content}`
            })
            const combinedReference = blocks.join('\n\n')
            if (combinedReference.trim().length > 0) {
              referenceRulesSection = `${referenceLabel}:\n\n${combinedReference}\n\n`
            }
          }
        } catch (error) {
          console.warn(
            'Failed to load reference rule folders for continuation',
            error,
          )
        }
      }

      let mentionableContextSection = ''
      if (mentionables && mentionables.length > 0) {
        try {
          const fileMap = new Map<string, TFile>()
          for (const mentionable of mentionables) {
            if (mentionable.type === 'file') {
              fileMap.set(mentionable.file.path, mentionable.file)
            } else if (mentionable.type === 'folder') {
              for (const file of getNestedFiles(
                mentionable.folder,
                this.app.vault,
              )) {
                fileMap.set(file.path, file)
              }
            }
          }
          const files = Array.from(fileMap.values())
          if (files.length > 0) {
            const contents = await readMultipleTFiles(files, this.app.vault)
            const mentionLabel = this.t(
              'smartSpace.mentionContextLabel',
              'Mentioned files',
            )
            const combined = files
              .map((file, index) => {
                const content = contents[index] ?? ''
                return `File: ${file.path}\n${content}`
              })
              .join('\n\n')
            if (combined.trim().length > 0) {
              mentionableContextSection = `${mentionLabel}:\n\n${combined}\n\n`
            }
          }
        } catch (error) {
          console.warn(
            'Failed to include mentioned files for Smart Space continuation',
            error,
          )
        }
      }

      // Truncate context to avoid exceeding model limits (simple char-based cap)
      const continuationCharLimit = Math.max(
        0,
        this.settings.continuationOptions?.maxContinuationChars ?? 8000,
      )
      const limitedContext =
        continuationCharLimit > 0 && baseContext.length > continuationCharLimit
          ? baseContext.slice(-continuationCharLimit)
          : continuationCharLimit === 0
            ? ''
            : baseContext

      const continuationModelId =
        this.settings.continuationOptions?.continuationModelId ??
        this.settings.chatModelId

      const sidebarOverrides = this.getActiveConversationOverrides()
      const {
        temperature,
        topP,
        stream: streamPreference,
        useVaultSearch,
      } = this.resolveContinuationParams(sidebarOverrides)

      const { providerClient, model } = getChatModelClient({
        settings: this.settings,
        modelId: continuationModelId,
      })

      const userInstruction = (customPrompt ?? '').trim()
      const instructionSection = userInstruction
        ? `Instruction:\n${userInstruction}\n\n`
        : ''

      const systemPrompt = (this.settings.systemPrompt ?? '').trim()

      const activeFileForTitle = this.app.workspace.getActiveFile()
      const fileTitle = activeFileForTitle?.basename?.trim() ?? ''
      const titleLine = fileTitle ? `File title: ${fileTitle}\n\n` : ''
      const hasContext = (baseContext ?? '').trim().length > 0

      let ragContextSection = ''
      const knowledgeBaseRaw =
        this.settings.continuationOptions?.knowledgeBaseFolders ?? []
      const knowledgeBaseFolders: string[] = []
      const knowledgeBaseFiles: string[] = []
      for (const raw of knowledgeBaseRaw) {
        const trimmed = raw.trim()
        if (!trimmed) continue
        const abstract = this.app.vault.getAbstractFileByPath(trimmed)
        if (abstract instanceof TFolder) {
          knowledgeBaseFolders.push(abstract.path)
        } else if (abstract instanceof TFile) {
          knowledgeBaseFiles.push(abstract.path)
        }
      }
      const ragGloballyEnabled = Boolean(this.settings.ragOptions?.enabled)
      if (useVaultSearch && ragGloballyEnabled) {
        try {
          const querySource = (
            baseContext ||
            userInstruction ||
            fileTitle
          ).trim()
          if (querySource.length > 0) {
            const ragEngine = await this.getRAGEngine()
            const ragResults = await ragEngine.processQuery({
              query: querySource.slice(-4000),
              scope:
                knowledgeBaseFolders.length > 0 || knowledgeBaseFiles.length > 0
                  ? {
                      folders: knowledgeBaseFolders,
                      files: knowledgeBaseFiles,
                    }
                  : undefined,
            })
            const snippetLimit = Math.max(
              1,
              Math.min(this.settings.ragOptions?.limit ?? 10, 10),
            )
            const snippets = ragResults.slice(0, snippetLimit)
            if (snippets.length > 0) {
              const formatted = snippets
                .map((snippet, index) => {
                  const content = (snippet.content ?? '').trim()
                  const truncated =
                    content.length > 600
                      ? `${content.slice(0, 600)}...`
                      : content
                  return `Snippet ${index + 1} (from ${snippet.path}):\n${truncated}`
                })
                .join('\n\n')
              if (formatted.trim().length > 0) {
                ragContextSection = `Vault snippets:\n\n${formatted}\n\n`
              }
            }
          }
        } catch (error) {
          console.warn('Continuation RAG lookup failed:', error)
        }
      }

      // 检查是否已被中止（RAG 查询可能耗时较长）
      if (controller.signal.aborted) {
        return
      }

      const limitedContextHasContent = limitedContext.trim().length > 0
      const contextSection =
        hasContext && limitedContextHasContent
          ? `Context (up to recent portion):\n\n${limitedContext}\n\n`
          : ''
      const baseModelContextSection = `${
        referenceRulesSection
      }${mentionableContextSection}${
        hasContext && limitedContextHasContent ? `${limitedContext}\n\n` : ''
      }${ragContextSection}`
      const combinedContextSection = `${referenceRulesSection}${mentionableContextSection}${contextSection}${ragContextSection}`

      const isBaseModel = Boolean(model.isBaseModel)
      const baseModelSpecialPrompt = (
        this.settings.chatOptions.baseModelSpecialPrompt ?? ''
      ).trim()
      const basePromptSection =
        isBaseModel && baseModelSpecialPrompt.length > 0
          ? `${baseModelSpecialPrompt}\n\n`
          : ''
      const baseModelCoreContent = `${basePromptSection}${titleLine}${instructionSection}${baseModelContextSection}`

      const userMessageContent = isBaseModel
        ? `${baseModelCoreContent}`
        : `${basePromptSection}${titleLine}${instructionSection}${combinedContextSection}`

      const requestMessages: RequestMessage[] = [
        ...(!isBaseModel && systemPrompt.length > 0
          ? [
              {
                role: 'system' as const,
                content: systemPrompt,
              },
            ]
          : []),
        {
          role: 'user' as const,
          content: userMessageContent,
        },
      ]

      // Mark in-progress to avoid re-entrancy from keyword trigger during insertion
      this.isContinuationInProgress = true

      view = this.getEditorView(editor)
      if (!view) {
        notice.setMessage('Unable to access editor view.')
        this.registerTimeout(() => notice.hide(), 1200)
        return
      }

      this.ensureInlineSuggestionExtension(view)

      // 在光标位置显示思考指示器
      const currentCursor = editor.getCursor()
      const line = view.state.doc.line(currentCursor.line + 1)
      const cursorOffset = line.from + currentCursor.ch
      const thinkingText = this.t('chat.customContinueProcessing', 'Thinking')
      this.showThinkingIndicator(view, cursorOffset, thinkingText)

      let hasClosedSmartSpaceWidget = false
      const closeSmartSpaceWidgetOnce = () => {
        if (!hasClosedSmartSpaceWidget) {
          this.closeSmartSpace()
          hasClosedSmartSpaceWidget = true
        }
      }

      // 立即关闭 Smart Space 面板，避免与内联指示器重复显示
      closeSmartSpaceWidgetOnce()

      // Stream response and progressively update ghost suggestion
      const baseRequest: LLMRequestBase = {
        model: model.model,
        messages: requestMessages,
      }
      if (typeof temperature === 'number') {
        baseRequest.temperature = temperature
      }
      if (typeof topP === 'number') {
        baseRequest.top_p = topP
      }

      console.debug('Continuation request params', {
        overrides: sidebarOverrides,
        request: baseRequest,
        streamPreference,
        useVaultSearch,
      })

      // Insert at current cursor by default; if a selection exists, insert at selection end
      let insertStart = editor.getCursor()
      if (hasSelection) {
        const endPos = editor.getCursor('to')
        editor.setCursor(endPos)
        insertStart = endPos
      }
      const startLine = view.state.doc.line(insertStart.line + 1)
      const startOffset = startLine.from + insertStart.ch
      let suggestionText = ''
      let hasHiddenThinkingIndicator = false
      const nonNullView = view // TypeScript 类型细化
      let reasoningPreviewBuffer = ''
      let lastReasoningPreview = ''
      const MAX_REASONING_BUFFER = 400

      const formatReasoningPreview = (text: string) => {
        const normalized = text.replace(/\s+/g, ' ').trim()
        if (!normalized) return ''
        if (normalized.length <= 120) {
          return normalized
        }
        return normalized.slice(-120)
      }

      const updateThinkingReasoningPreview = () => {
        if (hasHiddenThinkingIndicator) return
        const preview = formatReasoningPreview(reasoningPreviewBuffer)
        if (!preview || preview === lastReasoningPreview) {
          return
        }
        lastReasoningPreview = preview
        this.showThinkingIndicator(
          nonNullView,
          cursorOffset,
          thinkingText,
          preview,
        )
      }

      const updateContinuationSuggestion = (text: string) => {
        // 首次接收到内容时隐藏思考指示器
        if (!hasHiddenThinkingIndicator) {
          this.hideThinkingIndicator(nonNullView)
          hasHiddenThinkingIndicator = true
        }
        this.setInlineSuggestionGhost(nonNullView, { from: startOffset, text })
        this.activeInlineSuggestion = {
          source: 'continuation',
          editor,
          view: nonNullView,
          fromOffset: startOffset,
          text,
        }
        this.continuationInlineSuggestion = {
          editor,
          view: nonNullView,
          text,
          fromOffset: startOffset,
          startPos: insertStart,
        }
      }

      const runNonStreaming = async () => {
        const response = await providerClient.generateResponse(
          model,
          { ...baseRequest, stream: false },
          { signal: controller.signal, geminiTools },
        )

        const fullText = response.choices?.[0]?.message?.content ?? ''
        if (fullText) {
          suggestionText = fullText
          closeSmartSpaceWidgetOnce()
          updateContinuationSuggestion(suggestionText)
        }
      }

      if (streamPreference) {
        const streamController = new AbortController()
        const handleAbort = () => streamController.abort()
        controller.signal.addEventListener('abort', handleAbort, { once: true })
        let firstTokenTimeoutId: ReturnType<typeof setTimeout> | null = null
        let didTimeout = false
        let hasReceivedFirstChunk = false
        const clearFirstTokenTimeout = () => {
          if (firstTokenTimeoutId) {
            clearTimeout(firstTokenTimeoutId)
            firstTokenTimeoutId = null
          }
        }
        try {
          firstTokenTimeoutId = setTimeout(() => {
            didTimeout = true
            streamController.abort()
          }, FIRST_TOKEN_TIMEOUT_MS)

          const streamIterator = await providerClient.streamResponse(
            model,
            { ...baseRequest, stream: true },
            { signal: streamController.signal, geminiTools },
          )

          for await (const chunk of streamIterator) {
            if (!hasReceivedFirstChunk) {
              hasReceivedFirstChunk = true
              clearFirstTokenTimeout()
            }
            // 每次循环都检查是否已被中止
            if (controller.signal.aborted) {
              break
            }

            const delta = chunk?.choices?.[0]?.delta
            const piece = delta?.content ?? ''
            const reasoningDelta = delta?.reasoning ?? ''
            if (reasoningDelta) {
              reasoningPreviewBuffer += reasoningDelta
              if (reasoningPreviewBuffer.length > MAX_REASONING_BUFFER) {
                reasoningPreviewBuffer =
                  reasoningPreviewBuffer.slice(-MAX_REASONING_BUFFER)
              }
              updateThinkingReasoningPreview()
            }
            if (!piece) continue

            suggestionText += piece
            closeSmartSpaceWidgetOnce()
            updateContinuationSuggestion(suggestionText)
          }
        } catch (error) {
          clearFirstTokenTimeout()
          if (didTimeout && !controller.signal.aborted) {
            await runNonStreaming()
          } else {
            throw error
          }
        } finally {
          clearFirstTokenTimeout()
          controller.signal.removeEventListener('abort', handleAbort)
        }
      } else {
        await runNonStreaming()
      }

      if (suggestionText.trim().length > 0) {
        notice.setMessage('Continuation suggestion ready. Press Tab to accept.')
      } else {
        this.clearInlineSuggestion()
        notice.setMessage('No continuation generated.')
      }
      this.registerTimeout(() => notice.hide(), 1200)
    } catch (error) {
      this.clearInlineSuggestion()
      if (error?.name === 'AbortError') {
        const n = new Notice('已取消生成。')
        this.registerTimeout(() => n.hide(), 1000)
      } else {
        console.error(error)
        new Notice('Failed to generate continuation.')
      }
    } finally {
      // 确保思考指示器被移除
      if (view) {
        this.hideThinkingIndicator(view)
      }
      this.isContinuationInProgress = false
      this.activeAbortControllers.delete(controller)
    }
  }

  // removed migrateToJsonStorage (templates)

  private async reloadChatView() {
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
    if (leaves.length === 0 || !(leaves[0].view instanceof ChatView)) {
      return
    }
    new Notice('Reloading "next-composer" due to migration', 1000)
    leaves[0].detach()
    await this.activateChatView()
  }
}
