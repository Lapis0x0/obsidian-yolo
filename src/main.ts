import { type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  TFolder,
  normalizePath,
} from 'obsidian'
import { getLanguage } from 'obsidian'

import { ApplyView } from './ApplyView'
import { ChatView } from './ChatView'
import { ChatProps } from './components/chat-view/Chat'
import { InstallerUpdateRequiredModal } from './components/modals/InstallerUpdateRequiredModal'
import { APPLY_VIEW_TYPE, CHAT_VIEW_TYPE } from './constants'
import { McpCoordinator } from './core/mcp/mcpCoordinator'
import type { McpManager } from './core/mcp/mcpManager'
import { RagAutoUpdateService } from './core/rag/ragAutoUpdateService'
import { RagCoordinator } from './core/rag/ragCoordinator'
import type { RAGEngine } from './core/rag/ragEngine'
import { DatabaseManager } from './database/DatabaseManager'
import { PGLiteAbortedException } from './database/exception'
import type { VectorManager } from './database/modules/vector/VectorManager'
import { ChatViewNavigator } from './features/chat/chatViewNavigator'
import type { InlineSuggestionGhostPayload } from './features/editor/inline-suggestion/inlineSuggestion'
import { InlineSuggestionController } from './features/editor/inline-suggestion/inlineSuggestionController'
import { QuickAskController } from './features/editor/quick-ask/quickAskController'
import { SelectionChatController } from './features/editor/selection-chat/selectionChatController'
import {
  SmartSpaceController,
  SmartSpaceDraftState,
} from './features/editor/smart-space/smartSpaceController'
import { TabCompletionController } from './features/editor/tab-completion/tabCompletionController'
import { WriteAssistController } from './features/editor/write-assist/writeAssistController'
import { Language, createTranslationFunction } from './i18n'
import {
  SmartComposerSettings,
  smartComposerSettingsSchema,
} from './settings/schema/setting.types'
import { parseSmartComposerSettings } from './settings/schema/settings'
import { SmartComposerSettingTab } from './settings/SettingTab'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import { MentionableFile, MentionableFolder } from './types/mentionable'

export default class SmartComposerPlugin extends Plugin {
  settings: SmartComposerSettings
  initialChatProps?: ChatProps // TODO: change this to use view state like ApplyView
  settingsChangeListeners: ((newSettings: SmartComposerSettings) => void)[] = []
  mcpManager: McpManager | null = null
  dbManager: DatabaseManager | null = null
  private dbManagerInitPromise: Promise<DatabaseManager> | null = null
  private timeoutIds: ReturnType<typeof setTimeout>[] = [] // Use ReturnType instead of number
  private pgliteResourcePath?: string
  private isContinuationInProgress = false
  private activeAbortControllers: Set<AbortController> = new Set()
  private tabCompletionController: TabCompletionController | null = null
  private inlineSuggestionController: InlineSuggestionController | null = null
  private smartSpaceDraftState: SmartSpaceDraftState = null
  private smartSpaceController: SmartSpaceController | null = null
  // Selection chat state
  private selectionChatController: SelectionChatController | null = null
  private chatViewNavigator: ChatViewNavigator | null = null
  private ragAutoUpdateService: RagAutoUpdateService | null = null
  private ragCoordinator: RagCoordinator | null = null
  private mcpCoordinator: McpCoordinator | null = null
  private writeAssistController: WriteAssistController | null = null
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
          this.selectionChatController?.clearPendingSelectionRewrite()
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
  private getSelectionChatController(): SelectionChatController {
    if (!this.selectionChatController) {
      this.selectionChatController = new SelectionChatController({
        plugin: this,
        app: this.app,
        getSettings: () => this.settings,
        t: (key, fallback) => this.t(key, fallback),
        getEditorView: (editor) => this.getEditorView(editor),
        showSmartSpace: (editor, view, showQuickActions) =>
          this.showSmartSpace(editor, view, showQuickActions),
        activateChatView: (chatProps) => this.activateChatView(chatProps),
        isSmartSpaceOpen: () => this.smartSpaceController?.isOpen() ?? false,
      })
    }
    return this.selectionChatController
  }

  private initializeSelectionChat() {
    this.getSelectionChatController().initialize()
  }

  private getChatViewNavigator(): ChatViewNavigator {
    if (!this.chatViewNavigator) {
      this.chatViewNavigator = new ChatViewNavigator({ plugin: this })
    }
    return this.chatViewNavigator
  }

  private getRagAutoUpdateService(): RagAutoUpdateService {
    if (!this.ragAutoUpdateService) {
      this.ragAutoUpdateService = new RagAutoUpdateService({
        getSettings: () => this.settings,
        setSettings: (settings) => this.setSettings(settings),
        getRagEngine: () => this.getRagCoordinator().getRagEngine(),
        t: (key, fallback) => this.t(key, fallback),
      })
    }
    return this.ragAutoUpdateService
  }

  private getRagCoordinator(): RagCoordinator {
    if (!this.ragCoordinator) {
      this.ragCoordinator = new RagCoordinator({
        app: this.app,
        getSettings: () => this.settings,
        getDbManager: () => this.getDbManager(),
      })
    }
    return this.ragCoordinator
  }

  private getMcpCoordinator(): McpCoordinator {
    if (!this.mcpCoordinator) {
      this.mcpCoordinator = new McpCoordinator({
        getSettings: () => this.settings,
        registerSettingsListener: (
          listener: (settings: SmartComposerSettings) => void,
        ) => this.addSettingsChangeListener(listener),
      })
    }
    return this.mcpCoordinator
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
    const rawLanguage = String(getLanguage() ?? '')
      .trim()
      .toLowerCase()
    if (rawLanguage.startsWith('zh')) return 'zh'
    if (rawLanguage.startsWith('it')) return 'it'
    return 'en'
  }

  get t() {
    return createTranslationFunction(this.resolveObsidianLanguage())
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
    this.getInlineSuggestionController().ensureInlineSuggestionExtension(view)
  }

  private setInlineSuggestionGhost(
    view: EditorView,
    payload: InlineSuggestionGhostPayload,
  ) {
    this.getInlineSuggestionController().setInlineSuggestionGhost(view, payload)
  }

  private showThinkingIndicator(
    view: EditorView,
    from: number,
    label: string,
    snippet?: string,
  ) {
    this.getInlineSuggestionController().showThinkingIndicator(
      view,
      from,
      label,
      snippet,
    )
  }

  private hideThinkingIndicator(view: EditorView) {
    this.getInlineSuggestionController().hideThinkingIndicator(view)
  }

  private getTabCompletionController(): TabCompletionController {
    if (!this.tabCompletionController) {
      const inlineSuggestionController = this.getInlineSuggestionController()
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
          inlineSuggestionController.setInlineSuggestionGhost(view, payload),
        clearInlineSuggestion: () =>
          inlineSuggestionController.clearInlineSuggestion(),
        setActiveInlineSuggestion: (suggestion) =>
          inlineSuggestionController.setActiveInlineSuggestion(suggestion),
        addAbortController: (controller) =>
          this.activeAbortControllers.add(controller),
        removeAbortController: (controller) =>
          this.activeAbortControllers.delete(controller),
        isContinuationInProgress: () => this.isContinuationInProgress,
      })
    }
    return this.tabCompletionController
  }

  private getInlineSuggestionController(): InlineSuggestionController {
    if (!this.inlineSuggestionController) {
      this.inlineSuggestionController = new InlineSuggestionController({
        getEditorView: (editor) => this.getEditorView(editor),
        getTabCompletionController: () => this.getTabCompletionController(),
      })
    }
    return this.inlineSuggestionController
  }

  private getWriteAssistController(): WriteAssistController {
    if (!this.writeAssistController) {
      this.writeAssistController = new WriteAssistController({
        app: this.app,
        getSettings: () => this.settings,
        t: (key, fallback) => this.t(key, fallback),
        getActiveConversationOverrides: () =>
          this.getActiveConversationOverrides(),
        resolveContinuationParams: (overrides) =>
          this.resolveContinuationParams(overrides),
        getRagEngine: () => this.getRAGEngine(),
        getEditorView: (editor) => this.getEditorView(editor),
        closeSmartSpace: () => this.closeSmartSpace(),
        registerTimeout: (callback, timeout) =>
          this.registerTimeout(callback, timeout),
        addAbortController: (controller) =>
          this.activeAbortControllers.add(controller),
        removeAbortController: (controller) =>
          this.activeAbortControllers.delete(controller),
        setContinuationInProgress: (value) => {
          this.isContinuationInProgress = value
        },
        cancelAllAiTasks: () => this.cancelAllAiTasks(),
        clearInlineSuggestion: () => this.clearInlineSuggestion(),
        ensureInlineSuggestionExtension: (view) =>
          this.ensureInlineSuggestionExtension(view),
        setInlineSuggestionGhost: (view, payload) =>
          this.setInlineSuggestionGhost(view, payload),
        showThinkingIndicator: (view, from, label, snippet) =>
          this.showThinkingIndicator(view, from, label, snippet),
        hideThinkingIndicator: (view) => this.hideThinkingIndicator(view),
        setContinuationSuggestion: (params) =>
          this.getInlineSuggestionController().setContinuationSuggestion(
            params,
          ),
      })
    }
    return this.writeAssistController
  }

  private cancelTabCompletionRequest() {
    this.tabCompletionController?.cancelRequest()
  }

  private clearTabCompletionTimer() {
    this.tabCompletionController?.clearTimer()
  }

  private clearInlineSuggestion() {
    this.inlineSuggestionController?.clearInlineSuggestion()
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
    return this.getWriteAssistController().handleCustomRewrite(
      editor,
      customPrompt,
      preSelectedText,
      preSelectionFrom,
    )
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

    this.addCommand({
      id: 'accept-inline-suggestion',
      name: this.t('commands.acceptInlineSuggestion'),
      editorCallback: (editor: Editor) => {
        const cmView = this.getEditorView(editor)
        if (!cmView) return
        this.getInlineSuggestionController().tryAcceptInlineSuggestionFromView(
          cmView,
        )
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
      this.app.vault.on('create', (file) =>
        this.getRagAutoUpdateService().onVaultFileChanged(file),
      ),
    )
    this.registerEvent(
      this.app.vault.on('modify', (file) =>
        this.getRagAutoUpdateService().onVaultFileChanged(file),
      ),
    )
    this.registerEvent(
      this.app.vault.on('delete', (file) =>
        this.getRagAutoUpdateService().onVaultFileChanged(file),
      ),
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const service = this.getRagAutoUpdateService()
        service.onVaultFileChanged(file)
        if (oldPath) service.onVaultPathChanged(oldPath)
      }),
    )

    this.addCommand({
      id: 'rebuild-vault-index',
      name: this.t('commands.rebuildVaultIndex'),
      callback: async () => {
        // 预检查 PGlite 资源
        try {
          const dbManager = await this.getDbManager()
          const resourceCheck = dbManager.checkPGliteResources()

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
          this.initializeSelectionChat()
        } catch (err) {
          console.error('Editor change handler error:', err)
        }
      }),
    )

    // Initialize selection chat
    this.initializeSelectionChat()

    // Listen for settings changes to reinitialize Selection Chat
    this.addSettingsChangeListener((newSettings) => {
      const enableSelectionChat =
        newSettings.continuationOptions?.enableSelectionChat ?? true
      const wasEnabled = this.selectionChatController?.isActive() ?? false

      if (enableSelectionChat !== wasEnabled) {
        // Re-initialize when the setting changes
        this.initializeSelectionChat()
      }
    })
  }

  onunload() {
    this.closeSmartSpace()

    // Selection chat cleanup
    this.selectionChatController?.destroy()
    this.selectionChatController = null
    this.chatViewNavigator = null
    this.inlineSuggestionController?.clearInlineSuggestion()
    this.inlineSuggestionController?.destroy()
    this.inlineSuggestionController = null
    this.writeAssistController = null

    // clear all timers
    this.timeoutIds.forEach((id) => clearTimeout(id))
    this.timeoutIds = []

    // RagEngine cleanup
    this.ragCoordinator?.cleanup()
    this.ragCoordinator = null

    // Promise cleanup
    this.dbManagerInitPromise = null

    // DatabaseManager cleanup
    if (this.dbManager) {
      void this.dbManager.cleanup()
    }
    this.dbManager = null

    // McpManager cleanup
    this.mcpCoordinator?.cleanup()
    this.mcpCoordinator = null
    this.mcpManager = null
    this.ragAutoUpdateService?.cleanup()
    this.ragAutoUpdateService = null
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
    this.ragCoordinator?.updateSettings(newSettings)
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
    await this.getChatViewNavigator().openChatView(openNewChat)
  }

  async activateChatView(chatProps?: ChatProps, openNewChat = false) {
    await this.getChatViewNavigator().activateChatView(chatProps, openNewChat)
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    await this.getChatViewNavigator().addSelectionToChat(editor, view)
  }

  async addFileToChat(file: TFile) {
    await this.getChatViewNavigator().addFileToChat(file)
  }

  async addFolderToChat(folder: TFolder) {
    await this.getChatViewNavigator().addFolderToChat(folder)
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
    return this.getRagCoordinator().getRagEngine()
  }

  async getMcpManager(): Promise<McpManager> {
    const manager = await this.getMcpCoordinator().getMcpManager()
    this.mcpManager = manager
    return manager
  }

  private registerTimeout(callback: () => void, timeout: number): void {
    const timeoutId = setTimeout(callback, timeout)
    this.timeoutIds.push(timeoutId)
  }

  // Public wrapper for use in React modal
  async continueWriting(
    editor: Editor,
    customPrompt?: string,
    geminiTools?: { useWebSearch?: boolean; useUrlContext?: boolean },
    mentionables?: (MentionableFile | MentionableFolder)[],
  ) {
    // Check if this is actually a rewrite request from Selection Chat
    const pendingRewrite =
      this.selectionChatController?.consumePendingSelectionRewrite() ?? null
    if (pendingRewrite) {
      const { editor: rewriteEditor, selectedText, from } = pendingRewrite

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
    return this.getWriteAssistController().handleContinueWriting(
      editor,
      customPrompt,
      geminiTools,
      mentionables,
    )
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
