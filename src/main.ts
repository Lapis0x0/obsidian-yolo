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

import { ChatView } from './ChatView'
import { InstallerUpdateRequiredModal } from './components/modals/InstallerUpdateRequiredModal'
import { CHAT_VIEW_TYPE } from './constants'
import {
  clearChatGPTOAuthService,
  getChatGPTOAuthService as getChatGPTOAuthServiceRuntime,
  initializeChatGPTOAuthRuntime,
} from './core/auth/chatgptOAuthRuntime'
import { ensureDefaultAssistantInSettings } from './core/agent/default-assistant'
import {
  AgentConversationRunSummary,
  AgentService,
} from './core/agent/service'
import { createAgentConversationPersistence } from './core/agent/conversationPersistence'
import { AgentNotificationCoordinator } from './core/notifications/agentNotificationCoordinator'
import { NotificationService } from './core/notifications/notificationService'
import { McpCoordinator } from './core/mcp/mcpCoordinator'
import type { McpManager } from './core/mcp/mcpManager'
import { RagAutoUpdateService } from './core/rag/ragAutoUpdateService'
import { RagCoordinator } from './core/rag/ragCoordinator'
import type { RAGEngine } from './core/rag/ragEngine'
import { DatabaseManager } from './database/DatabaseManager'
import { ChatManager } from './database/json/chat/ChatManager'
import { PGLiteAbortedException } from './database/exception'
import type { VectorManager } from './database/modules/vector/VectorManager'
import { ChatViewNavigator } from './features/chat/chatViewNavigator'
import {
  ChatLeafPlacement,
  ChatLeafSessionManager,
} from './features/chat/chatLeafSessionManager'
import { NewTabEmptyStateEnhancer } from './features/chat/newTabEmptyStateEnhancer'
import { DiffReviewController } from './features/editor/diff-review/diffReviewController'
import type { InlineSuggestionGhostPayload } from './features/editor/inline-suggestion/inlineSuggestion'
import { InlineSuggestionController } from './features/editor/inline-suggestion/inlineSuggestionController'
import { QuickAskController } from './features/editor/quick-ask/quickAskController'
import { SelectionChatController } from './features/editor/selection-chat/selectionChatController'
import { selectionHighlightController } from './features/editor/selection-highlight/selectionHighlightController'
import type { QuickAskSelectionScope } from './features/editor/quick-ask/quickAsk.types'
import type { QuickAskLaunchMode } from './features/editor/quick-ask/quickAsk.types'
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
import type { ApplyViewState } from './types/apply-view.types'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import type { Mentionable, MentionableBlockData } from './types/mentionable'
import { MentionableFile, MentionableFolder } from './types/mentionable'
import { getMentionableBlockData } from './utils/obsidian'
import { ensureBufferByteLengthCompat } from './utils/runtime/ensureBufferByteLengthCompat'

export default class SmartComposerPlugin extends Plugin {
  settings: SmartComposerSettings
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
  private diffReviewController: DiffReviewController | null = null
  private smartSpaceDraftState: SmartSpaceDraftState = null
  private smartSpaceController: SmartSpaceController | null = null
  // Selection chat state
  private selectionChatController: SelectionChatController | null = null
  private chatViewNavigator: ChatViewNavigator | null = null
  private chatLeafSessionManager: ChatLeafSessionManager | null = null
  private newTabEmptyStateEnhancer: NewTabEmptyStateEnhancer | null = null
  private ragAutoUpdateService: RagAutoUpdateService | null = null
  private ragCoordinator: RagCoordinator | null = null
  private mcpCoordinator: McpCoordinator | null = null
  private writeAssistController: WriteAssistController | null = null
  // Model list cache for provider model fetching
  private modelListCache: Map<string, { models: string[]; timestamp: number }> =
    new Map()
  // Quick Ask state
  private quickAskController: QuickAskController | null = null
  private agentService: AgentService | null = null
  private agentNotificationCoordinator: AgentNotificationCoordinator | null = null
  private agentStatusBarItem: HTMLElement | null = null
  private agentStatusBarRing: HTMLElement | null = null
  private agentStatusBarLabel: HTMLElement | null = null
  private agentStatusPanel: HTMLElement | null = null
  private agentStatusPanelList: HTMLElement | null = null
  private agentStatusPanelEmpty: HTMLElement | null = null
  private latestAgentRunSummaries = new Map<string, AgentConversationRunSummary>()
  private agentStatusPanelRenderVersion = 0
  private agentStatusPanelItems = new Map<
    string,
    {
      item: HTMLElement
      title: HTMLElement
      indicator: HTMLElement
    }
  >()

  getSmartSpaceDraftState(): SmartSpaceDraftState {
    return this.smartSpaceDraftState
  }

  setSmartSpaceDraftState(state: SmartSpaceDraftState) {
    this.smartSpaceDraftState = state
  }

  getChatLeafSessionManager(): ChatLeafSessionManager {
    if (!this.chatLeafSessionManager) {
      this.chatLeafSessionManager = new ChatLeafSessionManager(this.app)
    }
    return this.chatLeafSessionManager
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

  getChatGPTOAuthService(providerId = 'chatgpt-oauth') {
    return (
      getChatGPTOAuthServiceRuntime(providerId) ??
      initializeChatGPTOAuthRuntime(this.app, this.manifest.id, providerId)
    )
  }

  async getChatGPTOAuthStatus(providerId = 'chatgpt-oauth'): Promise<{
    connected: boolean
    accountId?: string
    expiresAt?: number
  }> {
    const credential =
      await this.getChatGPTOAuthService(providerId).getUsableCredential()
    if (!credential) {
      return { connected: false }
    }

    return {
      connected: true,
      ...(credential.accountId ? { accountId: credential.accountId } : {}),
      expiresAt: credential.expiresAt,
    }
  }

  async disconnectChatGPTOAuthAccount(
    providerId = 'chatgpt-oauth',
  ): Promise<void> {
    await this.getChatGPTOAuthService(providerId).clearCredential()
  }

  clearChatGPTOAuthRuntime(providerId: string): void {
    clearChatGPTOAuthService(providerId)
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
        pinSelectionHighlight: (view) =>
          selectionHighlightController.pinCurrentSelection(view),
        clearSelectionHighlight: (view) =>
          selectionHighlightController.clearHighlight(view),
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
    const selectionOptions = this.getQuickAskSelectionOptions(editor)
    if (selectionOptions) {
      this.getQuickAskController().showWithOptions(
        editor,
        view,
        selectionOptions,
      )
      return
    }

    this.getQuickAskController().show(editor, view)
  }

  private getQuickAskSelectionOptions(editor: Editor) {
    const selectedText = editor.getSelection()
    if (!selectedText || selectedText.trim().length === 0) {
      return undefined
    }

    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!markdownView) {
      return undefined
    }

    const data = getMentionableBlockData(editor, markdownView)
    if (!data) {
      return undefined
    }

    const mentionable = {
      type: 'block',
      ...data,
      source: 'selection',
    } as const

    return {
      initialMentionables: [mentionable],
      editContextText: selectedText,
      editSelectionFrom: editor.getCursor('from'),
      selectionScope: {
        mentionable,
        selectionFrom: editor.getCursor('from'),
      } satisfies QuickAskSelectionScope,
    }
  }

  private showQuickAskWithAutoSend(
    editor: Editor,
    view: EditorView,
    options: {
      prompt: string
      mentionables: Mentionable[]
      selectionScope?: QuickAskSelectionScope
    },
  ) {
    this.getQuickAskController().showWithAutoSend(editor, view, options)
  }

  private showQuickAskWithOptions(
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
  ) {
    this.getQuickAskController().showWithOptions(editor, view, options)
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
        showQuickAskWithOptions: (editor, view, options) =>
          this.showQuickAskWithOptions(editor, view, options),
        showQuickAskWithAutoSend: (editor, view, options) =>
          this.showQuickAskWithAutoSend(editor, view, options),
        openChatWithSelectionAndPrefill: async (selectedBlock, text) => {
          await this.getChatViewNavigator().openChatWithSelectionAndPrefill(
            selectedBlock,
            text,
          )
        },
        addSelectionToSidebarChat: async (selectedBlock) => {
          await this.getChatViewNavigator().addSelectionBlockToChat(
            selectedBlock,
          )
        },
        isSmartSpaceOpen: () => this.smartSpaceController?.isOpen() ?? false,
        pinSelectionHighlight: (view) =>
          selectionHighlightController.pinCurrentSelection(view),
        clearSelectionHighlight: (view) =>
          selectionHighlightController.clearHighlight(view),
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
        app: this.app,
        getSettings: () => this.settings,
        openApplyReview: (state) => this.openApplyReview(state),
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
    const leaf = this.getChatViewNavigator().resolveTargetChatLeaf({
      allowCreate: false,
    })
    if (!(leaf?.view instanceof ChatView)) {
      return undefined
    }
    return leaf.view.getCurrentConversationOverrides()
  }

  private getActiveConversationModelId(): string | undefined {
    const leaf = this.getChatViewNavigator().resolveTargetChatLeaf({
      allowCreate: false,
    })
    if (!(leaf?.view instanceof ChatView)) {
      return undefined
    }
    return leaf.view.getCurrentConversationModelId()
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
    this.agentService?.abortAll()
  }

  getAgentService(): AgentService {
    if (!this.agentService) {
      const { persistConversationMessages } =
        createAgentConversationPersistence(this.app)
      this.agentService = new AgentService({
        persistConversationMessages,
      })
    }
    return this.agentService
  }

  private getAgentNotificationCoordinator(): AgentNotificationCoordinator {
    if (!this.agentNotificationCoordinator) {
      const notificationService = new NotificationService({
        getOptions: () => this.settings.notificationOptions,
      })
      this.agentNotificationCoordinator = new AgentNotificationCoordinator({
        agentService: this.getAgentService(),
        notificationService,
        translate: (key, fallback) => this.t(key, fallback),
      })
    }
    return this.agentNotificationCoordinator
  }

  private setupAgentStatusBar(): void {
    const statusBarItem = this.addStatusBarItem()
    statusBarItem.addClass('mod-clickable')
    statusBarItem.addClass('smtcmp-agent-status-bar')
    statusBarItem.hide()

    const ring = document.createElement('span')
    ring.className = 'smtcmp-agent-status-bar-ring'

    const label = document.createElement('span')
    label.className = 'smtcmp-agent-status-bar-label'

    const panel = document.createElement('div')
    panel.className = 'smtcmp-agent-status-panel'
    panel.setAttribute('aria-hidden', 'true')
    panel.hidden = true

    const panelHeader = document.createElement('div')
    panelHeader.className = 'smtcmp-agent-status-panel-header'
    panelHeader.setText(
      this.t(
        'statusBar.agentStatusPanelTitle',
        '正在进行的 Agent 对话',
      ),
    )

    const panelList = document.createElement('div')
    panelList.className = 'smtcmp-agent-status-panel-list'

    const panelEmpty = document.createElement('div')
    panelEmpty.className = 'smtcmp-agent-status-panel-empty'
    panelEmpty.setText(
      this.t(
        'statusBar.agentStatusPanelEmpty',
        '当前没有可切换的运行中对话',
      ),
    )

    panel.append(panelHeader, panelList, panelEmpty)
    statusBarItem.append(label, ring, panel)

    this.agentStatusBarItem = statusBarItem
    this.agentStatusBarRing = ring
    this.agentStatusBarLabel = label
    this.agentStatusPanel = panel
    this.agentStatusPanelList = panelList
    this.agentStatusPanelEmpty = panelEmpty

    this.registerDomEvent(statusBarItem, 'click', (event) => {
      if (
        this.agentStatusPanel &&
        event.target instanceof Node &&
        this.agentStatusPanel.contains(event.target)
      ) {
        return
      }
      void this.toggleAgentStatusPanel()
    })

    this.registerDomEvent(document, 'click', (event) => {
      if (
        !this.isAgentStatusPanelOpen() ||
        !this.agentStatusBarItem ||
        !(event.target instanceof Node)
      ) {
        return
      }

      if (!this.agentStatusBarItem.contains(event.target)) {
        this.closeAgentStatusPanel()
      }
    })

    this.registerDomEvent(document, 'keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeAgentStatusPanel()
      }
    })

    const unsubscribe = this.getAgentService().subscribeToRunSummaries(
      (summaries) => {
        this.updateAgentStatusBar(summaries)
      },
    )

    this.register(() => {
      unsubscribe()
      this.agentStatusBarItem = null
      this.agentStatusBarRing = null
      this.agentStatusBarLabel = null
      this.agentStatusPanel = null
      this.agentStatusPanelList = null
      this.agentStatusPanelEmpty = null
      this.agentStatusPanelRenderVersion += 1
      this.agentStatusPanelItems.clear()
    })
  }

  private updateAgentStatusBar(
    summaries: Map<string, AgentConversationRunSummary>,
  ): void {
    if (
      !this.agentStatusBarItem ||
      !this.agentStatusBarRing ||
      !this.agentStatusBarLabel
    ) {
      return
    }

    this.latestAgentRunSummaries = new Map(summaries)

    let runningCount = 0
    let waitingApprovalCount = 0

    for (const summary of summaries.values()) {
      if (summary.isRunning) {
        runningCount += 1
      }
      if (summary.isWaitingApproval) {
        waitingApprovalCount += 1
      }
    }

    if (runningCount === 0 && waitingApprovalCount === 0) {
      this.clearAgentStatusPanelItems()
      this.closeAgentStatusPanel()
      this.agentStatusBarItem.hide()
      this.agentStatusBarLabel.setText('')
      this.agentStatusBarItem.removeAttribute('aria-label')
      this.agentStatusBarItem.removeAttribute('title')
      return
    }

    const label =
      waitingApprovalCount > 0
        ? this.t(
            'statusBar.agentRunningWithApproval',
            '当前有 {count} 个 agent 正在运行（{approvalCount} 个待审批）',
          )
            .replace('{count}', String(runningCount))
            .replace('{approvalCount}', String(waitingApprovalCount))
        : this.t(
            'statusBar.agentRunning',
            '当前有 {count} 个 agent 正在运行',
          ).replace('{count}', String(runningCount))

    this.agentStatusBarLabel.setText(label)
    this.agentStatusBarItem.removeAttribute('aria-label')
    this.agentStatusBarItem.removeAttribute('title')
    this.agentStatusBarItem.show()

    if (this.isAgentStatusPanelOpen()) {
      void this.renderAgentStatusPanel()
    }
  }

  private isAgentStatusPanelOpen(): boolean {
    return this.agentStatusPanel?.hidden === false
  }

  private openAgentStatusPanel(): void {
    if (!this.agentStatusPanel || this.isAgentStatusPanelOpen()) {
      return
    }

    this.agentStatusPanel.hidden = false
    this.agentStatusPanel.setAttribute('aria-hidden', 'false')

    window.requestAnimationFrame(() => {
      this.agentStatusPanel?.addClass('is-open')
    })
  }

  private closeAgentStatusPanel(): void {
    if (!this.agentStatusPanel || !this.isAgentStatusPanelOpen()) {
      return
    }

    this.agentStatusPanel.removeClass('is-open')
    this.agentStatusPanel.setAttribute('aria-hidden', 'true')
    window.setTimeout(() => {
      if (this.agentStatusPanel?.hasClass('is-open')) {
        return
      }
      if (this.agentStatusPanel) {
        this.agentStatusPanel.hidden = true
      }
    }, 180)
  }

  private async toggleAgentStatusPanel(): Promise<void> {
    if (this.isAgentStatusPanelOpen()) {
      this.closeAgentStatusPanel()
      return
    }

    const hasEntries = await this.renderAgentStatusPanel()
    if (!hasEntries) {
      await this.openChatView({ placement: 'sidebar' })
      return
    }

    this.openAgentStatusPanel()
  }

  private async renderAgentStatusPanel(): Promise<boolean> {
    if (!this.agentStatusPanelList || !this.agentStatusPanelEmpty) {
      return false
    }

    const renderVersion = ++this.agentStatusPanelRenderVersion
    const summaries = Array.from(this.latestAgentRunSummaries.values()).sort(
      (left, right) => {
        const leftPriority = left.isWaitingApproval ? 0 : 1
        const rightPriority = right.isWaitingApproval ? 0 : 1
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority
        }
        return left.conversationId.localeCompare(right.conversationId)
      },
    )

    if (summaries.length === 0) {
      this.clearAgentStatusPanelItems()
      this.agentStatusPanelEmpty.hidden = false
      return false
    }

    const chatManager = new ChatManager(this.app)
    const metadataList = await chatManager.listChats()
    if (
      renderVersion !== this.agentStatusPanelRenderVersion ||
      !this.agentStatusPanelList ||
      !this.agentStatusPanelEmpty
    ) {
      return this.latestAgentRunSummaries.size > 0
    }
    const metadataById = new Map(metadataList.map((item) => [item.id, item]))
    const nextConversationIds = new Set<string>()
    let insertBeforeNode = this.agentStatusPanelList.firstChild

    for (const summary of summaries) {
      nextConversationIds.add(summary.conversationId)
      const metadata = metadataById.get(summary.conversationId)
      const title = this.resolveAgentConversationTitle(metadata?.title)
      const itemRecord =
        this.agentStatusPanelItems.get(summary.conversationId) ??
        this.createAgentStatusPanelItem(summary.conversationId)

      if (itemRecord.title.getText() !== title) {
        itemRecord.title.setText(title)
      }
      if (itemRecord.title.getAttribute('title') !== title) {
        itemRecord.title.setAttribute('title', title)
      }
      itemRecord.indicator.toggleClass(
        'is-waiting-approval',
        summary.isWaitingApproval,
      )

      if (itemRecord.item !== insertBeforeNode) {
        this.agentStatusPanelList.insertBefore(itemRecord.item, insertBeforeNode)
      }
      insertBeforeNode = itemRecord.item.nextSibling
    }

    for (const [conversationId, itemRecord] of this.agentStatusPanelItems) {
      if (nextConversationIds.has(conversationId)) {
        continue
      }
      itemRecord.item.remove()
      this.agentStatusPanelItems.delete(conversationId)
    }

    this.agentStatusPanelEmpty.hidden = true
    return true
  }

  private createAgentStatusPanelItem(conversationId: string): {
    item: HTMLElement
    title: HTMLElement
    indicator: HTMLElement
  } {
    const item = createDiv({
      cls: 'smtcmp-agent-status-panel-item',
    })
    item.setAttribute('role', 'button')
    item.setAttribute('tabindex', '0')

    const row = item.createDiv({
      cls: 'smtcmp-agent-status-panel-item-row',
    })
    const title = row.createDiv({
      cls: 'smtcmp-agent-status-panel-item-title',
    })
    const indicator = row.createDiv({
      cls: 'smtcmp-agent-status-panel-item-indicator',
    })

    const openConversation = () => {
      this.closeAgentStatusPanel()
      void this.openChatView({
        placement: 'split',
        initialConversationId: conversationId,
        forceNewLeaf: true,
      })
    }

    this.registerDomEvent(item, 'click', (event) => {
      event.stopPropagation()
      openConversation()
    })

    this.registerDomEvent(item, 'keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        openConversation()
      }
    })

    const record = {
      item,
      title,
      indicator,
    }
    this.agentStatusPanelItems.set(conversationId, record)
    return record
  }

  private clearAgentStatusPanelItems(): void {
    this.agentStatusPanelList?.empty()
    this.agentStatusPanelItems.clear()
  }

  private resolveAgentConversationTitle(title: string | undefined): string {
    const normalizedTitle = title?.trim()
    if (normalizedTitle) {
      return normalizedTitle
    }

    return this.t(
      'statusBar.agentStatusFallbackConversationTitle',
      '运行中的对话',
    )
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
        setSettings: (newSettings) => this.setSettings(newSettings),
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

  private getDiffReviewController(): DiffReviewController {
    if (!this.diffReviewController) {
      this.diffReviewController = new DiffReviewController({
        plugin: this,
        getActiveMarkdownView: () =>
          this.app.workspace.getActiveViewOfType(MarkdownView),
        getEditorView: (editor) => this.getEditorView(editor),
      })
    }
    return this.diffReviewController
  }

  async openApplyReview(state: ApplyViewState): Promise<boolean> {
    const opened = this.getDiffReviewController().openReview(state)
    if (opened) return true

    const markdownLeaves = this.app.workspace.getLeavesOfType('markdown')
    const targetLeaf = markdownLeaves.find((leaf) => {
      const view = leaf.view
      if (!(view instanceof MarkdownView)) return false
      return view.file?.path === state.file.path
    })

    if (targetLeaf?.view instanceof MarkdownView) {
      this.app.workspace.setActiveLeaf(targetLeaf, { focus: true })
      const openedInTarget = this.getDiffReviewController().openReviewInView(
        targetLeaf.view,
        state,
      )
      if (openedInTarget) return true
    }

    const leaf = this.app.workspace.getLeaf(false)
    await leaf?.openFile(state.file, { active: true })
    const openedAfterFocus = this.getDiffReviewController().openReview(state)
    if (openedAfterFocus) return true

    new Notice('请先打开目标文件后再应用修改。')
    return false
  }

  private getWriteAssistController(): WriteAssistController {
    if (!this.writeAssistController) {
      this.writeAssistController = new WriteAssistController({
        app: this.app,
        getSettings: () => this.settings,
        setSettings: (newSettings) => this.setSettings(newSettings),
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
        openApplyReview: (state) => this.openApplyReview(state),
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
    ensureBufferByteLengthCompat()

    await this.loadSettings()
    this.getChatGPTOAuthService()

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this))

    this.newTabEmptyStateEnhancer = new NewTabEmptyStateEnhancer(this)
    this.newTabEmptyStateEnhancer.enable()

    this.registerEditorExtension(selectionHighlightController.createExtension())
    this.registerEditorExtension(this.createSmartSpaceTriggerExtension())
    this.registerEditorExtension(this.createQuickAskTriggerExtension())
    this.registerEditorExtension(
      this.getTabCompletionController().createTriggerExtension(),
    )

    // This creates an icon in the left ribbon.
    this.addRibbonIcon('wand-sparkles', this.t('commands.openChat'), () => {
      void this.openChatView({ placement: 'sidebar' })
    })

    this.setupAgentStatusBar()
    this.getAgentNotificationCoordinator().start()
    this.register(() => {
      this.agentNotificationCoordinator?.stop()
      this.agentNotificationCoordinator = null
    })

    this.addCommand({
      id: 'open-new-chat',
      name: this.t('commands.openChatSidebar'),
      callback: () => {
        void this.openChatView({ placement: 'sidebar' })
      },
    })

    this.addCommand({
      id: 'new-chat-current-view',
      name: this.t('commands.newChatCurrentView'),
      callback: () => {
        void this.openCurrentOrSidebarNewChat()
      },
    })

    this.addCommand({
      id: 'open-chat-tab',
      name: this.t('commands.openNewChatTab'),
      callback: () => {
        void this.openChatView({
          placement: 'tab',
          openNewChat: true,
          forceNewLeaf: true,
        })
      },
    })

    this.addCommand({
      id: 'open-chat-split',
      name: this.t('commands.openNewChatSplit'),
      callback: () => {
        void this.openChatView({
          placement: 'split',
          openNewChat: true,
          forceNewLeaf: true,
        })
      },
    })

    this.addCommand({
      id: 'open-chat-window',
      name: this.t('commands.openNewChatWindow'),
      callback: () => {
        void this.openChatView({
          placement: 'window',
          openNewChat: true,
          forceNewLeaf: true,
        })
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
      this.app.workspace.on('active-leaf-change', (leaf) => {
        try {
          if (leaf?.view instanceof ChatView) {
            this.getChatLeafSessionManager().touchLeafActive(leaf)
          }
          const view = this.app.workspace.getActiveViewOfType(MarkdownView)
          const editor = view?.editor
          if (editor) {
            this.handleTabCompletionEditorChange(editor)
          }
          this.selectionChatController?.handleActiveLeafChange(leaf ?? null)
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
    this.newTabEmptyStateEnhancer = null
    this.inlineSuggestionController?.clearInlineSuggestion()
    this.inlineSuggestionController?.destroy()
    this.inlineSuggestionController = null
    this.diffReviewController?.destroy()
    this.diffReviewController = null
    this.writeAssistController = null

    // clear all timers
    this.timeoutIds.forEach((id) => {
      clearTimeout(id)
    })
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
    this.agentService?.abortAll()
    this.agentService = null
    // Ensure all in-flight requests are aborted on unload
    this.cancelAllAiTasks()
    this.clearTabCompletionTimer()
    this.cancelTabCompletionRequest()
    this.clearInlineSuggestion()
  }

  async loadSettings() {
    const parsedSettings = parseSmartComposerSettings(await this.loadData())
    const normalizedSettings = ensureDefaultAssistantInSettings(parsedSettings)

    this.settings = normalizedSettings

    if (JSON.stringify(parsedSettings) !== JSON.stringify(normalizedSettings)) {
      await this.saveData(normalizedSettings)
    }
  }

  async setSettings(newSettings: SmartComposerSettings) {
    const normalizedSettings = ensureDefaultAssistantInSettings(newSettings)
    const validationResult =
      smartComposerSettingsSchema.safeParse(normalizedSettings)

    if (!validationResult.success) {
      new Notice(`Invalid settings:
${validationResult.error.issues.map((v) => v.message).join('\n')}`)
      return
    }

    this.settings = normalizedSettings
    await this.saveData(normalizedSettings)
    this.ragCoordinator?.updateSettings(normalizedSettings)
    this.settingsChangeListeners.forEach((listener) => {
      listener(normalizedSettings)
    })
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

  async openChatView(options?: {
    placement?: ChatLeafPlacement
    openNewChat?: boolean
    selectedBlock?: MentionableBlockData
    initialConversationId?: string
    prefillText?: string
    forceNewLeaf?: boolean
  }) {
    await this.getChatViewNavigator().openChatView(options)
  }

  async openCurrentOrSidebarNewChat() {
    await this.getChatViewNavigator().openCurrentOrSidebarNewChat()
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const editorView = this.getEditorView(editor)
    if (
      editorView &&
      (this.settings.continuationOptions.persistSelectionHighlight ?? true)
    ) {
      selectionHighlightController.pinCurrentSelection(editorView)
    }
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
        '[YOLO] Failed to initialize vector manager, skip vector-dependent operations.',
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
  async customRewrite(
    editor: Editor,
    customPrompt?: string,
    preSelectedText?: string,
    preSelectionFrom?: { line: number; ch: number },
  ) {
    return this.handleCustomRewrite(
      editor,
      customPrompt,
      preSelectedText,
      preSelectionFrom,
    )
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
    const records = this.getChatLeafSessionManager().getAllLeafRecords()
    if (records.length === 0) {
      return
    }
    new Notice('Reloading "next-composer" due to migration', 1000)
    const snapshots = records.map((record) => ({
      placement: record.placement,
      currentConversationId: record.currentConversationId,
    }))

    for (const record of records) {
      record.leaf.detach()
    }

    for (const snapshot of snapshots) {
      await this.openChatView({
        placement: snapshot.placement,
        initialConversationId: snapshot.currentConversationId,
        forceNewLeaf: snapshot.placement !== 'sidebar',
      })
    }
  }
}
