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
import { BAKED_PLUGIN_VERSION } from './constants/bakedVersion'
import { createAgentConversationPersistence } from './core/agent/conversationPersistence'
import { ensureDefaultAssistantInSettings } from './core/agent/default-assistant'
import { AgentConversationRunSummary, AgentService } from './core/agent/service'
import {
  clearChatGPTOAuthService,
  getChatGPTOAuthService as getChatGPTOAuthServiceRuntime,
  initializeChatGPTOAuthRuntime,
} from './core/auth/chatgptOAuthRuntime'
import {
  clearGeminiOAuthService,
  getGeminiOAuthService as getGeminiOAuthServiceRuntime,
  initializeGeminiOAuthRuntime,
} from './core/auth/geminiOAuthRuntime'
import {
  clearQwenOAuthService,
  getQwenOAuthService as getQwenOAuthServiceRuntime,
  initializeQwenOAuthRuntime,
} from './core/auth/qwenOAuthRuntime'
import {
  BackgroundActivity,
  BackgroundActivityAction,
  BackgroundActivityRegistry,
} from './core/background/backgroundActivityRegistry'
import { clearRequestTransportMemory } from './core/llm/requestTransport'
import { McpCoordinator } from './core/mcp/mcpCoordinator'
import type { McpManager } from './core/mcp/mcpManager'
import { AgentNotificationCoordinator } from './core/notifications/agentNotificationCoordinator'
import { NotificationService } from './core/notifications/notificationService'
import {
  type YoloDataMeta,
  extractYoloDataMeta,
  getVaultDataJsonResolvedPath,
  readVaultDataJson,
  relocateYoloManagedData,
  removeVaultDataJson,
  stampYoloDataMeta,
  writeVaultDataJson,
} from './core/paths/yoloManagedData'
import { getYoloSyncPointerPath } from './core/paths/yoloPaths'
import { RagAutoUpdateService } from './core/rag/ragAutoUpdateService'
import { RagCoordinator } from './core/rag/ragCoordinator'
import type { RAGEngine } from './core/rag/ragEngine'
import {
  RagIndexBusyError,
  RagIndexRunSnapshot,
  RagIndexService,
} from './core/rag/ragIndexService'
import {
  type UpdateCheckResult,
  checkForUpdate,
} from './core/update/updateChecker'
import { DatabaseManager } from './database/DatabaseManager'
import { PGLiteAbortedException } from './database/exception'
import { ChatManager } from './database/json/chat/ChatManager'
import { pruneImageCache } from './database/json/chat/imageCacheStore'
import { prunePdfTextCache } from './database/json/chat/pdfTextCacheStore'
import type { VectorManager } from './database/modules/vector/VectorManager'
import { PGliteRuntimeManager } from './database/runtime/PGliteRuntimeManager'
import { PGLITE_RUNTIME_VERSION } from './database/runtime/pgliteRuntimeMetadata'
import {
  ChatLeafPlacement,
  ChatLeafSessionManager,
} from './features/chat/chatLeafSessionManager'
import { ChatViewNavigator } from './features/chat/chatViewNavigator'
import { NewTabEmptyStateEnhancer } from './features/chat/newTabEmptyStateEnhancer'
import { enablePdfScreenshotFeature } from './features/pdf-screenshot'
import { DiffReviewController } from './features/editor/diff-review/diffReviewController'
import {
  buildFullReviewBlocks,
  countModifiedBlocks,
} from './features/editor/diff-review/review-model'
import type { InlineSuggestionGhostPayload } from './features/editor/inline-suggestion/inlineSuggestion'
import { InlineSuggestionController } from './features/editor/inline-suggestion/inlineSuggestionController'
import type { QuickAskSelectionScope } from './features/editor/quick-ask/quickAsk.types'
import type { QuickAskLaunchMode } from './features/editor/quick-ask/quickAsk.types'
import { QuickAskController } from './features/editor/quick-ask/quickAskController'
import { SelectionChatController } from './features/editor/selection-chat/selectionChatController'
import { selectionHighlightController } from './features/editor/selection-highlight/selectionHighlightController'
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
import {
  normalizeSmartComposerSettingsReferences,
  parseSmartComposerSettings,
} from './settings/schema/settings'
import { SmartComposerSettingTab } from './settings/SettingTab'
import type { ApplyViewState } from './types/apply-view.types'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import type { Mentionable, MentionableBlockData, MentionableImage } from './types/mentionable'
import { MentionableFile, MentionableFolder } from './types/mentionable'
import { applyKnownMaxContextTokensToChatModels } from './utils/llm/model-capability-registry'
import { getMentionableBlockData } from './utils/obsidian'
import { ensureBufferByteLengthCompat } from './utils/runtime/ensureBufferByteLengthCompat'

export default class SmartComposerPlugin extends Plugin {
  settings: SmartComposerSettings
  settingsChangeListeners: ((newSettings: SmartComposerSettings) => void)[] = []
  private deviceId: string | null = null
  private currentSettingsMeta: YoloDataMeta | null = null
  private lastWrittenVaultMirrorMeta: YoloDataMeta | null = null
  private vaultMirrorPath: string | null = null
  private vaultMirrorReloadTimer: ReturnType<typeof setTimeout> | null = null
  updateCheckResult: UpdateCheckResult | null = null
  private hasCheckedForUpdate = false
  private updateBannerDismissed = false
  private updateCheckListeners: (() => void)[] = []
  installationIncompleteDetail: {
    bakedVersion: string
    manifestVersion: string
  } | null = null
  private installationIncompleteBannerDismissed = false
  private installationIncompleteListeners: (() => void)[] = []
  mcpManager: McpManager | null = null
  dbManager: DatabaseManager | null = null
  private dbManagerInitPromise: Promise<DatabaseManager> | null = null
  private timeoutIds: ReturnType<typeof setTimeout>[] = [] // Use ReturnType instead of number
  private pgliteRuntimeManager: PGliteRuntimeManager | null = null
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
  private ragIndexService: RagIndexService | null = null
  private mcpCoordinator: McpCoordinator | null = null
  private writeAssistController: WriteAssistController | null = null
  // Model list cache for provider model fetching
  private modelListCache: Map<string, { models: string[]; timestamp: number }> =
    new Map()
  // Quick Ask state
  private quickAskController: QuickAskController | null = null
  private agentService: AgentService | null = null
  private agentNotificationCoordinator: AgentNotificationCoordinator | null =
    null
  private backgroundActivityRegistry: BackgroundActivityRegistry | null = null
  private backgroundStatusBarItem: HTMLElement | null = null
  private backgroundStatusBarRing: HTMLElement | null = null
  private backgroundStatusBarLabel: HTMLElement | null = null
  private backgroundStatusPanel: HTMLElement | null = null
  private backgroundStatusPanelList: HTMLElement | null = null
  private backgroundStatusPanelEmpty: HTMLElement | null = null
  private latestBackgroundActivities = new Map<string, BackgroundActivity>()
  private backgroundStatusPanelRenderVersion = 0
  private backgroundStatusPanelItems = new Map<
    string,
    {
      item: HTMLElement
      title: HTMLElement
      detail: HTMLElement
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

  private getModelListCacheKey(
    providerId: string,
    scope: 'chat' | 'embedding',
  ): string {
    return `${providerId}::${scope}`
  }

  // Get cached model list for a provider
  getCachedModelList(
    providerId: string,
    scope: 'chat' | 'embedding' = 'chat',
  ): string[] | null {
    const cached = this.modelListCache.get(
      this.getModelListCacheKey(providerId, scope),
    )
    if (cached) {
      return cached.models
    }
    return null
  }

  // Set model list cache for a provider
  setCachedModelList(
    providerId: string,
    models: string[],
    scope: 'chat' | 'embedding' = 'chat',
  ): void {
    this.modelListCache.set(this.getModelListCacheKey(providerId, scope), {
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

  getGeminiOAuthService(providerId = 'gemini-oauth') {
    return (
      getGeminiOAuthServiceRuntime(providerId) ??
      initializeGeminiOAuthRuntime(this.app, this.manifest.id, providerId)
    )
  }

  async getGeminiOAuthStatus(providerId = 'gemini-oauth'): Promise<{
    connected: boolean
    email?: string
    expiresAt?: number
    projectId?: string
  }> {
    const credential =
      await this.getGeminiOAuthService(providerId).getUsableCredential()
    if (!credential) {
      return { connected: false }
    }

    return {
      connected: true,
      ...(credential.email ? { email: credential.email } : {}),
      ...(credential.managedProjectId || credential.projectId
        ? {
            projectId: credential.managedProjectId ?? credential.projectId,
          }
        : {}),
      expiresAt: credential.expiresAt,
    }
  }

  async disconnectGeminiOAuthAccount(
    providerId = 'gemini-oauth',
  ): Promise<void> {
    await this.getGeminiOAuthService(providerId).clearCredential()
  }

  clearGeminiOAuthRuntime(providerId: string): void {
    clearGeminiOAuthService(providerId)
  }

  getQwenOAuthService(providerId = 'qwen-oauth') {
    return (
      getQwenOAuthServiceRuntime(providerId) ??
      initializeQwenOAuthRuntime(this.app, this.manifest.id, providerId)
    )
  }

  async getQwenOAuthStatus(providerId = 'qwen-oauth'): Promise<{
    connected: boolean
    expiresAt?: number
    resourceUrl?: string
  }> {
    const credential =
      await this.getQwenOAuthService(providerId).getUsableCredential()
    if (!credential) {
      return { connected: false }
    }

    return {
      connected: true,
      resourceUrl: credential.resourceUrl,
      expiresAt: credential.expiresAt,
    }
  }

  async disconnectQwenOAuthAccount(providerId = 'qwen-oauth'): Promise<void> {
    await this.getQwenOAuthService(providerId).clearCredential()
  }

  clearQwenOAuthRuntime(providerId: string): void {
    clearQwenOAuthService(providerId)
  }

  private syncOAuthRuntimesFromSettings(
    settings: Pick<SmartComposerSettings, 'providers'> = this.settings,
  ): void {
    for (const provider of settings.providers) {
      if (provider.presetType === 'chatgpt-oauth') {
        this.getChatGPTOAuthService(provider.id)
      }
      if (provider.presetType === 'gemini-oauth') {
        this.getGeminiOAuthService(provider.id)
      }
      if (provider.presetType === 'qwen-oauth') {
        this.getQwenOAuthService(provider.id)
      }
    }
  }

  getPGliteRuntimeManager(): PGliteRuntimeManager {
    if (!this.pgliteRuntimeManager) {
      this.pgliteRuntimeManager = new PGliteRuntimeManager({
        app: this.app,
        pluginId: this.manifest.id,
        pluginDir: this.manifest.dir
          ? normalizePath(this.manifest.dir)
          : undefined,
        runtimeVersion: PGLITE_RUNTIME_VERSION,
      })
    }

    return this.pgliteRuntimeManager
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
        openChatWithSelectionAndSend: async (selectedBlock, text) => {
          await this.getChatViewNavigator().openChatWithSelectionAndSend(
            selectedBlock,
            text,
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
        runIndex: (request) =>
          this.getRagIndexService().runIndex({
            mode: 'sync',
            scope: request,
            trigger: 'auto',
            retryPolicy: 'transient',
          }),
        markRetryScheduled: (input) =>
          this.getRagIndexService().markRetryScheduled({
            mode: 'sync',
            retryAt: input.retryAt,
            failureMessage: input.failureMessage,
          }),
        clearRetryScheduled: () =>
          this.getRagIndexService().clearRetryScheduled(),
      })
    }
    return this.ragAutoUpdateService
  }

  private getRagIndexService(): RagIndexService {
    if (!this.ragIndexService) {
      this.ragIndexService = new RagIndexService({
        app: this.app,
        getRagEngine: () => this.getRagCoordinator().getRagEngine(),
        activityRegistry: this.getBackgroundActivityRegistry(),
        isRagEnabled: () => !!this.settings?.ragOptions?.enabled,
        t: (key, fallback) => this.t(key, fallback),
      })
    }
    return this.ragIndexService
  }

  private getBackgroundActivityRegistry(): BackgroundActivityRegistry {
    if (!this.backgroundActivityRegistry) {
      this.backgroundActivityRegistry = new BackgroundActivityRegistry()
    }
    return this.backgroundActivityRegistry
  }

  private getRagCoordinator(): RagCoordinator {
    if (!this.ragCoordinator) {
      this.ragCoordinator = new RagCoordinator({
        app: this.app,
        getSettings: () => this.settings,
        ensureRuntimeReady: () => this.getPGliteRuntimeManager().ensureReady(),
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
        getRagEngine: () => this.getRAGEngine(),
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

    return { temperature, topP, stream }
  }

  private resolveObsidianLanguage(): Language {
    const rawLanguage = String(getLanguage() ?? '')
      .trim()
      .toLowerCase()
    if (rawLanguage.startsWith('zh')) return 'zh'
    if (rawLanguage.startsWith('it')) return 'it'
    return 'en'
  }

  private warnIfInstallationIncomplete() {
    const baked = BAKED_PLUGIN_VERSION
    const runtime = this.manifest.version
    if (baked && runtime && baked !== runtime) {
      console.error(
        `[Smart Composer] Version mismatch: main.js=${baked}, manifest=${runtime}. ` +
          `Likely an incomplete update download.`,
      )
      this.installationIncompleteDetail = {
        bakedVersion: baked,
        manifestVersion: runtime,
      }
      this.notifyInstallationIncompleteListeners()
    }
  }

  isInstallationIncompleteBannerDismissed(): boolean {
    return this.installationIncompleteBannerDismissed
  }

  dismissInstallationIncompleteBanner(): void {
    this.installationIncompleteBannerDismissed = true
    this.notifyInstallationIncompleteListeners()
  }

  addInstallationIncompleteListener(listener: () => void): () => void {
    this.installationIncompleteListeners.push(listener)
    return () => {
      this.installationIncompleteListeners =
        this.installationIncompleteListeners.filter((l) => l !== listener)
    }
  }

  private notifyInstallationIncompleteListeners(): void {
    for (const listener of this.installationIncompleteListeners) {
      listener()
    }
  }

  /** Re-notify banner subscribers when chat opens (aligned with checkForUpdateOnce). */
  refreshInstallationIncompleteBanner(): void {
    this.notifyInstallationIncompleteListeners()
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
        createAgentConversationPersistence(this.app, () => this.settings)
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

  private setupBackgroundActivityStatusBar(): void {
    const statusBarItem = this.addStatusBarItem()
    statusBarItem.addClass('mod-clickable')
    statusBarItem.addClass('smtcmp-background-activity-status-bar')
    statusBarItem.hide()

    const ring = document.createElement('span')
    ring.className = 'smtcmp-background-activity-status-bar-ring'

    const label = document.createElement('span')
    label.className = 'smtcmp-background-activity-status-bar-label'

    const panel = document.createElement('div')
    panel.className = 'smtcmp-background-activity-status-panel'
    panel.setAttribute('aria-hidden', 'true')
    panel.hidden = true

    const panelHeader = document.createElement('div')
    panelHeader.className = 'smtcmp-background-activity-status-panel-header'
    panelHeader.setText(
      this.t('statusBar.backgroundStatusPanelTitle', '后台任务'),
    )

    const panelList = document.createElement('div')
    panelList.className = 'smtcmp-background-activity-status-panel-list'

    const panelEmpty = document.createElement('div')
    panelEmpty.className = 'smtcmp-background-activity-status-panel-empty'
    panelEmpty.setText(
      this.t(
        'statusBar.backgroundStatusPanelEmpty',
        '当前没有正在运行的后台任务',
      ),
    )

    panel.append(panelHeader, panelList, panelEmpty)
    statusBarItem.append(label, ring, panel)

    this.backgroundStatusBarItem = statusBarItem
    this.backgroundStatusBarRing = ring
    this.backgroundStatusBarLabel = label
    this.backgroundStatusPanel = panel
    this.backgroundStatusPanelList = panelList
    this.backgroundStatusPanelEmpty = panelEmpty

    this.registerDomEvent(statusBarItem, 'click', (event) => {
      if (
        this.backgroundStatusPanel &&
        event.target instanceof Node &&
        this.backgroundStatusPanel.contains(event.target)
      ) {
        return
      }
      void this.toggleBackgroundStatusPanel()
    })

    this.registerDomEvent(document, 'click', (event) => {
      if (
        !this.isBackgroundStatusPanelOpen() ||
        !this.backgroundStatusBarItem ||
        !(event.target instanceof Node)
      ) {
        return
      }

      if (!this.backgroundStatusBarItem.contains(event.target)) {
        this.closeBackgroundStatusPanel()
      }
    })

    this.registerDomEvent(document, 'keydown', (event) => {
      if (event.key === 'Escape') {
        this.closeBackgroundStatusPanel()
      }
    })

    const unsubscribeActivities =
      this.getBackgroundActivityRegistry().subscribe((activities) => {
        this.updateBackgroundStatusBar(activities)
      })
    const unsubscribeAgentSummaries =
      this.getAgentService().subscribeToRunSummaries((summaries) => {
        this.syncAgentBackgroundActivities(summaries)
      })

    this.register(() => {
      unsubscribeActivities()
      unsubscribeAgentSummaries()
      this.backgroundStatusBarItem = null
      this.backgroundStatusBarRing = null
      this.backgroundStatusBarLabel = null
      this.backgroundStatusPanel = null
      this.backgroundStatusPanelList = null
      this.backgroundStatusPanelEmpty = null
      this.backgroundStatusPanelRenderVersion += 1
      this.backgroundStatusPanelItems.clear()
      this.latestBackgroundActivities.clear()
      this.backgroundActivityRegistry?.clear()
      this.backgroundActivityRegistry = null
    })
  }

  private syncAgentBackgroundActivities(
    summaries: Map<string, AgentConversationRunSummary>,
  ): void {
    const registry = this.getBackgroundActivityRegistry()
    const nextActivityIds = new Set<string>()

    for (const summary of summaries.values()) {
      if (!summary.isRunning && !summary.isWaitingApproval) {
        continue
      }

      const id = `agent:${summary.conversationId}`
      nextActivityIds.add(id)
      registry.upsert({
        id,
        kind: 'agent',
        title: this.t(
          'statusBar.agentStatusFallbackConversationTitle',
          '运行中的对话',
        ),
        detail: summary.isWaitingApproval
          ? this.t('statusBar.agentStatusWaitingApproval', '待审批')
          : this.t('statusBar.agentStatusRunning', '运行中'),
        status: summary.isWaitingApproval ? 'waiting' : 'running',
        updatedAt: Date.now(),
        action: {
          type: 'open-agent-conversation',
          conversationId: summary.conversationId,
        },
      })
    }

    for (const activityId of this.latestBackgroundActivities.keys()) {
      if (!activityId.startsWith('agent:')) {
        continue
      }
      if (nextActivityIds.has(activityId)) {
        continue
      }
      registry.remove(activityId)
    }
  }

  private updateBackgroundStatusBar(
    activities: Map<string, BackgroundActivity>,
  ): void {
    if (
      !this.backgroundStatusBarItem ||
      !this.backgroundStatusBarRing ||
      !this.backgroundStatusBarLabel
    ) {
      return
    }

    this.latestBackgroundActivities = new Map(activities)
    const visibleActivities = Array.from(activities.values()).filter(
      (activity) =>
        activity.status === 'running' ||
        activity.status === 'waiting' ||
        activity.status === 'failed',
    )

    if (visibleActivities.length === 0) {
      this.clearBackgroundStatusPanelItems()
      this.closeBackgroundStatusPanel()
      this.backgroundStatusBarItem.hide()
      this.backgroundStatusBarLabel.setText('')
      this.backgroundStatusBarItem.removeAttribute('aria-label')
      this.backgroundStatusBarItem.removeAttribute('title')
      return
    }

    const label = this.buildBackgroundStatusBarLabel(visibleActivities)
    const statusBarTone = visibleActivities.some(
      (activity) =>
        activity.status === 'running' || activity.status === 'waiting',
    )
      ? visibleActivities.some((activity) => activity.status === 'waiting') &&
        !visibleActivities.some((activity) => activity.status === 'running')
        ? 'is-waiting'
        : 'is-running'
      : 'is-failed'

    this.backgroundStatusBarLabel.setText(label)
    this.backgroundStatusBarItem.removeAttribute('title')
    this.backgroundStatusBarItem.setAttribute(
      'aria-label',
      this.t(
        'statusBar.backgroundStatusAriaLabel',
        '后台任务状态，点击查看详情',
      ),
    )
    this.backgroundStatusBarRing.classList.remove(
      'is-running',
      'is-waiting',
      'is-failed',
    )
    this.backgroundStatusBarRing.classList.add(statusBarTone)
    this.backgroundStatusBarItem.show()

    if (this.isBackgroundStatusPanelOpen()) {
      void this.renderBackgroundStatusPanel()
    }
  }

  private buildBackgroundStatusBarLabel(
    activities: BackgroundActivity[],
  ): string {
    const runningActivities = activities.filter(
      (activity) =>
        activity.status === 'running' || activity.status === 'waiting',
    )
    const failedActivities = activities.filter(
      (activity) => activity.status === 'failed',
    )
    const agentActivities = runningActivities.filter(
      (activity) => activity.kind === 'agent',
    )
    const waitingApprovalCount = runningActivities.filter(
      (activity) => activity.status === 'waiting',
    ).length

    if (
      runningActivities.length > 0 &&
      agentActivities.length === runningActivities.length
    ) {
      return waitingApprovalCount > 0
        ? this.t(
            'statusBar.agentRunningWithApproval',
            '当前有 {count} 个 agent 正在运行（{approvalCount} 个待审批）',
          )
            .replace('{count}', String(agentActivities.length))
            .replace('{approvalCount}', String(waitingApprovalCount))
        : this.t(
            'statusBar.agentRunning',
            '当前有 {count} 个 agent 正在运行',
          ).replace('{count}', String(agentActivities.length))
    }

    if (runningActivities.length === 1 && failedActivities.length === 0) {
      const [activity] = runningActivities
      if (activity.kind === 'rag-index') {
        return this.t('statusBar.ragAutoUpdateRunning', '知识库正在后台更新')
      }
    }

    if (runningActivities.length > 0) {
      return this.t(
        'statusBar.backgroundTasksRunning',
        '当前有 {count} 个后台任务正在运行',
      ).replace('{count}', String(runningActivities.length))
    }

    return this.t(
      'statusBar.backgroundTasksNeedAttention',
      '有后台任务需要关注',
    )
  }

  private isBackgroundStatusPanelOpen(): boolean {
    return this.backgroundStatusPanel?.hidden === false
  }

  private openBackgroundStatusPanel(): void {
    if (!this.backgroundStatusPanel || this.isBackgroundStatusPanelOpen()) {
      return
    }

    this.backgroundStatusPanel.hidden = false
    this.backgroundStatusPanel.setAttribute('aria-hidden', 'false')

    window.requestAnimationFrame(() => {
      this.backgroundStatusPanel?.addClass('is-open')
    })
  }

  private closeBackgroundStatusPanel(): void {
    if (!this.backgroundStatusPanel || !this.isBackgroundStatusPanelOpen()) {
      return
    }

    this.backgroundStatusPanel.removeClass('is-open')
    this.backgroundStatusPanel.setAttribute('aria-hidden', 'true')
    window.setTimeout(() => {
      if (this.backgroundStatusPanel?.hasClass('is-open')) {
        return
      }
      if (this.backgroundStatusPanel) {
        this.backgroundStatusPanel.hidden = true
      }
    }, 180)
  }

  private async toggleBackgroundStatusPanel(): Promise<void> {
    if (this.isBackgroundStatusPanelOpen()) {
      this.closeBackgroundStatusPanel()
      return
    }

    const hasEntries = await this.renderBackgroundStatusPanel()
    if (!hasEntries) {
      return
    }

    this.openBackgroundStatusPanel()
  }

  private async renderBackgroundStatusPanel(): Promise<boolean> {
    if (!this.backgroundStatusPanelList || !this.backgroundStatusPanelEmpty) {
      return false
    }

    const renderVersion = ++this.backgroundStatusPanelRenderVersion
    const activities = Array.from(this.latestBackgroundActivities.values())
      .filter(
        (activity) =>
          activity.status === 'running' ||
          activity.status === 'waiting' ||
          activity.status === 'failed',
      )
      .sort((left, right) => {
        const priority = (activity: BackgroundActivity) => {
          if (activity.status === 'waiting') return 0
          if (activity.status === 'running') return 1
          if (activity.status === 'failed') return 2
          return 3
        }
        const priorityDelta = priority(left) - priority(right)
        if (priorityDelta !== 0) {
          return priorityDelta
        }
        return left.id.localeCompare(right.id)
      })

    if (activities.length === 0) {
      this.clearBackgroundStatusPanelItems()
      this.backgroundStatusPanelEmpty.hidden = false
      return false
    }

    const chatManager = new ChatManager(this.app, this.settings)
    const metadataList = await chatManager.listChats()
    if (
      renderVersion !== this.backgroundStatusPanelRenderVersion ||
      !this.backgroundStatusPanelList ||
      !this.backgroundStatusPanelEmpty
    ) {
      return this.latestBackgroundActivities.size > 0
    }

    const metadataById = new Map<string, { title?: string }>(
      metadataList.map((item) => [item.id, { title: item.title }]),
    )
    const nextActivityIds = new Set<string>()
    let insertBeforeNode = this.backgroundStatusPanelList.firstChild

    for (const activity of activities) {
      nextActivityIds.add(activity.id)
      const title = this.resolveBackgroundActivityTitle(activity, metadataById)
      const detail = this.resolveBackgroundActivityDetail(activity)
      const itemRecord =
        this.backgroundStatusPanelItems.get(activity.id) ??
        this.createBackgroundStatusPanelItem(activity.id, activity.action)

      if (itemRecord.title.getText() !== title) {
        itemRecord.title.setText(title)
      }
      if (itemRecord.title.getAttribute('title') !== title) {
        itemRecord.title.setAttribute('title', title)
      }
      if (itemRecord.detail.getText() !== detail) {
        itemRecord.detail.setText(detail)
      }
      itemRecord.detail.hidden = detail.length === 0
      itemRecord.indicator.classList.remove(
        'is-running',
        'is-waiting',
        'is-failed',
      )
      itemRecord.indicator.classList.add(`is-${activity.status}`)

      if (itemRecord.item !== insertBeforeNode) {
        this.backgroundStatusPanelList.insertBefore(
          itemRecord.item,
          insertBeforeNode,
        )
      }
      insertBeforeNode = itemRecord.item.nextSibling
    }

    for (const [activityId, itemRecord] of this.backgroundStatusPanelItems) {
      if (nextActivityIds.has(activityId)) {
        continue
      }
      itemRecord.item.remove()
      this.backgroundStatusPanelItems.delete(activityId)
    }

    this.backgroundStatusPanelEmpty.hidden = true
    return true
  }

  private createBackgroundStatusPanelItem(
    activityId: string,
    action?: BackgroundActivityAction,
  ): {
    item: HTMLElement
    title: HTMLElement
    detail: HTMLElement
    indicator: HTMLElement
  } {
    const item = createDiv({
      cls: 'smtcmp-background-activity-status-panel-item',
    })
    item.setAttribute('role', 'button')
    item.setAttribute('tabindex', '0')

    const row = item.createDiv({
      cls: 'smtcmp-background-activity-status-panel-item-row',
    })
    const copy = row.createDiv({
      cls: 'smtcmp-background-activity-status-panel-item-copy',
    })
    const title = copy.createDiv({
      cls: 'smtcmp-background-activity-status-panel-item-title',
    })
    const detail = copy.createDiv({
      cls: 'smtcmp-background-activity-status-panel-item-detail',
    })
    const indicator = row.createDiv({
      cls: 'smtcmp-background-activity-status-panel-item-indicator',
    })

    const openAction = () => {
      this.closeBackgroundStatusPanel()
      if (!action) {
        return
      }
      if (action.type === 'open-agent-conversation') {
        void this.openChatView({
          placement: 'split',
          initialConversationId: action.conversationId,
          forceNewLeaf: true,
        })
        return
      }
      if (action.type === 'open-knowledge-settings') {
        this.openKnowledgeSettings()
      }
    }

    this.registerDomEvent(item, 'click', (event) => {
      event.stopPropagation()
      openAction()
    })

    this.registerDomEvent(item, 'keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        openAction()
      }
    })

    const record = {
      item,
      title,
      detail,
      indicator,
    }
    this.backgroundStatusPanelItems.set(activityId, record)
    return record
  }

  private clearBackgroundStatusPanelItems(): void {
    this.backgroundStatusPanelList?.empty()
    this.backgroundStatusPanelItems.clear()
  }

  private resolveBackgroundActivityTitle(
    activity: BackgroundActivity,
    metadataById: Map<string, { title?: string }>,
  ): string {
    if (
      activity.action?.type === 'open-agent-conversation' &&
      activity.action.conversationId
    ) {
      const metadata = metadataById.get(activity.action.conversationId)
      return this.resolveAgentConversationTitle(metadata?.title)
    }
    return activity.title
  }

  private resolveBackgroundActivityDetail(
    activity: BackgroundActivity,
  ): string {
    return activity.detail?.trim() ?? ''
  }

  private openKnowledgeSettings(): void {
    // @ts-expect-error: setting property exists in Obsidian's App but is not typed
    this.app.setting.open()
    // @ts-expect-error: setting property exists in Obsidian's App but is not typed
    this.app.setting.openTabById(this.manifest.id)
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
    // If the diff that the overlay would display has zero modified blocks,
    // skip the overlay entirely — otherwise the UI renders "0/0" with every
    // button disabled and no auto-close path, stranding the user.
    const reviewBlocks = buildFullReviewBlocks(
      state.originalContent,
      state.newContent,
    )
    if (countModifiedBlocks(reviewBlocks) === 0) {
      if (state.originalContent !== state.newContent) {
        await this.app.vault.modify(state.file, state.newContent)
      }
      state.callbacks?.onComplete?.({ finalContent: state.newContent })
      return true
    }

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
    clearRequestTransportMemory()

    await this.loadSettings()
    this.warnIfInstallationIncomplete()
    this.syncOAuthRuntimesFromSettings()
    this.registerVaultMirrorWatcher()

    // Prune stale image cache entries (>30 days) on startup
    void pruneImageCache(this.app, 30, this.settings)
    void prunePdfTextCache(this.app, 30, this.settings)
    await this.getRagIndexService().initialize()
    const initialRagIndexSnapshot = this.getRagIndexSnapshot()
    if (
      this.settings?.ragOptions?.enabled &&
      initialRagIndexSnapshot.status === 'retry_scheduled' &&
      initialRagIndexSnapshot.retryPolicy === 'transient'
    ) {
      const hasValidEmbeddingModel =
        !!this.settings?.embeddingModelId &&
        this.settings.embeddingModels.some(
          (m) => m.id === this.settings.embeddingModelId,
        )
      if (
        hasValidEmbeddingModel &&
        this.settings?.ragOptions?.autoUpdateEnabled &&
        initialRagIndexSnapshot.trigger === 'auto'
      ) {
        this.getRagAutoUpdateService().restoreRetryScheduled(
          initialRagIndexSnapshot.retryAt,
        )
      } else if (
        hasValidEmbeddingModel &&
        initialRagIndexSnapshot.trigger === 'manual'
      ) {
        this.getRagIndexService().restoreRetryScheduledRun()
      }
    }

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this))

    this.newTabEmptyStateEnhancer = new NewTabEmptyStateEnhancer(this)
    this.newTabEmptyStateEnhancer.enable()

    enablePdfScreenshotFeature(this)

    this.registerEditorExtension(selectionHighlightController.createExtension())
    this.registerEditorExtension(this.createSmartSpaceTriggerExtension())
    this.registerEditorExtension(this.createQuickAskTriggerExtension())
    this.registerEditorExtension(
      this.getInlineSuggestionController().createExtension(),
    )
    this.registerEditorExtension(
      this.getTabCompletionController().createTriggerExtension(),
    )

    // This creates an icon in the left ribbon.
    this.addRibbonIcon('wand-sparkles', this.t('commands.openChat'), () => {
      void this.openChatView({ placement: 'sidebar' })
    })

    this.setupBackgroundActivityStatusBar()
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
        this.getRagAutoUpdateService().onVaultFileChanged(file, 'create'),
      ),
    )
    this.registerEvent(
      this.app.vault.on('modify', (file) =>
        this.getRagAutoUpdateService().onVaultFileChanged(file, 'modify'),
      ),
    )
    this.registerEvent(
      this.app.vault.on('delete', (file) =>
        this.getRagAutoUpdateService().onVaultFileChanged(file, 'delete'),
      ),
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const service = this.getRagAutoUpdateService()
        service.onVaultFileChanged(file, 'rename')
        if (oldPath)
          service.onVaultPathChanged(oldPath, {
            requiresFullScan: file instanceof TFolder,
          })
      }),
    )
    this.registerDomEvent(window, 'blur', () => {
      this.getRagAutoUpdateService().onWindowBlur()
    })

    this.addCommand({
      id: 'rebuild-vault-index',
      name: this.t('commands.rebuildVaultIndex'),
      callback: async () => {
        const notice = new Notice(this.t('notices.rebuildingIndex'), 0)
        try {
          await this.getRagIndexService().runIndex({
            mode: 'rebuild',
            scope: { kind: 'all' },
            trigger: 'manual',
            retryPolicy: 'transient',
            onProgress: (progress) => {
              notice.setMessage(
                `Indexing chunks: ${progress.completedChunks} / ${progress.totalChunks}${
                  progress.waitingForRateLimit
                    ? '\n(waiting for rate limit to reset)'
                    : ''
                }`,
              )
            },
          })
          notice.setMessage(this.t('notices.rebuildComplete'))
        } catch (error) {
          if (error instanceof RagIndexBusyError) {
            notice.setMessage(
              this.t('statusBar.ragAutoUpdateRunning', '知识库索引正在运行'),
            )
          } else {
            console.error(error)
            notice.setMessage(this.t('notices.rebuildFailed'))
          }
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
          await this.getRagIndexService().runIndex({
            mode: 'sync',
            scope: { kind: 'all' },
            trigger: 'manual',
            retryPolicy: 'none',
            onProgress: (progress) => {
              notice.setMessage(
                `Indexing chunks: ${progress.completedChunks} / ${progress.totalChunks}${
                  progress.waitingForRateLimit
                    ? '\n(waiting for rate limit to reset)'
                    : ''
                }`,
              )
            },
          })
          notice.setMessage(this.t('notices.indexUpdated'))
        } catch (error) {
          if (error instanceof RagIndexBusyError) {
            notice.setMessage(
              this.t('statusBar.ragAutoUpdateRunning', '知识库索引正在运行'),
            )
          } else {
            console.error(error)
            notice.setMessage(this.t('notices.indexUpdateFailed'))
          }
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
    this.ragIndexService?.cleanup()
    this.ragIndexService = null
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
    // Read both the plugin-dir copy and the optional vault-synced mirror, then
    // pick whichever has the newer `__meta.updatedAt`. This gives "newest wins"
    // semantics across devices instead of the older "mirror always wins" rule,
    // which could let a stale boot overwrite fresh settings the user changed
    // on another device.
    const [rawPluginData, vaultRead] = await Promise.all([
      this.loadData() as Promise<unknown>,
      readVaultDataJson(this.app),
    ])
    const pluginExtract = extractYoloDataMeta(rawPluginData)
    const pluginMeta = pluginExtract?.meta ?? null
    const pluginRaw = pluginExtract?.raw ?? null
    const vaultMeta = vaultRead?.meta ?? null
    const vaultRaw = vaultRead?.raw ?? null

    const vaultIsNewer =
      vaultRaw !== null &&
      (pluginMeta === null ||
        (vaultMeta !== null && vaultMeta.updatedAt > pluginMeta.updatedAt))
    const usedVaultSource = vaultIsNewer
    const sourceRaw = usedVaultSource ? vaultRaw : pluginRaw
    const sourceMeta = usedVaultSource ? vaultMeta : pluginMeta

    const parsedSettings = parseSmartComposerSettings(sourceRaw)

    const settingsWithDefaultAssistant =
      ensureDefaultAssistantInSettings(parsedSettings)
    const { chatModels, changed } = applyKnownMaxContextTokensToChatModels(
      settingsWithDefaultAssistant.chatModels,
    )
    const normalizedSettings = changed
      ? {
          ...settingsWithDefaultAssistant,
          chatModels,
        }
      : settingsWithDefaultAssistant

    this.settings = normalizedSettings
    this.currentSettingsMeta = sourceMeta
    if (vaultMeta) {
      this.lastWrittenVaultMirrorMeta = vaultMeta
    }
    this.vaultMirrorPath = await getVaultDataJsonResolvedPath(
      this.app,
      normalizedSettings,
    )

    const migrated = await relocateYoloManagedData({
      app: this.app,
      fromSettings: parsedSettings,
      toSettings: normalizedSettings,
    })
    if (!migrated) {
      new Notice(
        'Failed to migrate YOLO managed data during startup. Using existing data location.',
      )
    }

    const normalizationChanged =
      JSON.stringify(parsedSettings) !== JSON.stringify(normalizedSettings)

    // Persist to plugin-dir when: normalization changed anything, OR vault was
    // authoritative (so the local copy is refreshed and subsequent boots stay
    // consistent). Don't touch the vault mirror here — startup writes risk
    // racing with in-flight Obsidian Sync downloads. The mirror is only
    // refreshed via setSettings() once the user actually changes something.
    if (normalizationChanged || usedVaultSource) {
      await this.persistPluginDirSettings(normalizedSettings)
    }
  }

  private getDeviceId(): string {
    if (this.deviceId) {
      return this.deviceId
    }
    const storageKey = 'yolo.deviceId'
    let id: string | null = null
    try {
      id = window.localStorage.getItem(storageKey)
    } catch {
      // localStorage may be unavailable in some contexts; fall through to gen.
    }
    if (!id) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      try {
        window.localStorage.setItem(storageKey, id)
      } catch {
        // Best-effort persistence; a regenerated id on next boot is acceptable.
      }
    }
    this.deviceId = id
    return id
  }

  private buildSettingsMeta(): YoloDataMeta {
    return {
      updatedAt: Date.now(),
      deviceId: this.getDeviceId(),
    }
  }

  private async persistPluginDirSettings(
    settings: SmartComposerSettings,
    meta: YoloDataMeta = this.buildSettingsMeta(),
  ): Promise<YoloDataMeta> {
    await this.saveData(stampYoloDataMeta(settings, meta))
    this.currentSettingsMeta = meta
    return meta
  }

  private async persistVaultMirror(
    settings: SmartComposerSettings,
    meta: YoloDataMeta,
  ): Promise<void> {
    const ok = await writeVaultDataJson(this.app, settings, settings, meta)
    if (ok) {
      this.lastWrittenVaultMirrorMeta = meta
      this.vaultMirrorPath = await getVaultDataJsonResolvedPath(
        this.app,
        settings,
      )
    }
  }

  private registerVaultMirrorWatcher(): void {
    const pointerPath = getYoloSyncPointerPath()
    const scheduleReload = () => {
      if (this.vaultMirrorReloadTimer) {
        clearTimeout(this.vaultMirrorReloadTimer)
      }
      // Debounce: Sync may emit multiple `modify` events as it streams the
      // file. Wait briefly so we read the final content once.
      this.vaultMirrorReloadTimer = setTimeout(() => {
        this.vaultMirrorReloadTimer = null
        void this.handleExternalMirrorChange()
      }, 250)
    }
    const handle = (path: string) => {
      // Pointer changes must always trigger a reload, since they relocate the
      // mirror to a new file path (e.g. when another device changed
      // `yolo.baseDir`). Without this we'd only see modify events on the
      // stale path and miss the new mirror entirely.
      if (path === pointerPath) {
        scheduleReload()
        return
      }
      if (this.vaultMirrorPath && path === this.vaultMirrorPath) {
        scheduleReload()
      }
    }
    this.registerEvent(this.app.vault.on('modify', (file) => handle(file.path)))
    this.registerEvent(this.app.vault.on('create', (file) => handle(file.path)))
    this.register(() => {
      if (this.vaultMirrorReloadTimer) {
        clearTimeout(this.vaultMirrorReloadTimer)
        this.vaultMirrorReloadTimer = null
      }
    })
  }

  private async handleExternalMirrorChange(): Promise<void> {
    // Re-resolve via the pointer first, since the mirror may have moved to a
    // new path (remote `yolo.baseDir` change).
    const resolvedPath = await getVaultDataJsonResolvedPath(
      this.app,
      this.settings,
    )
    if (resolvedPath !== this.vaultMirrorPath) {
      this.vaultMirrorPath = resolvedPath
    }

    const vaultRead = await readVaultDataJson(this.app)
    if (!vaultRead) {
      return
    }
    const incomingMeta = vaultRead.meta
    // Skip self-triggered events: same device + same updatedAt is the write we
    // just made. A different deviceId means the change came from another
    // synced client and must propagate.
    if (
      incomingMeta &&
      this.lastWrittenVaultMirrorMeta &&
      incomingMeta.deviceId === this.lastWrittenVaultMirrorMeta.deviceId &&
      incomingMeta.updatedAt === this.lastWrittenVaultMirrorMeta.updatedAt
    ) {
      return
    }
    // Refuse to apply an incoming mirror that lacks `__meta` whenever we
    // already hold a meta-stamped version locally. A meta-less mirror is
    // either pre-upgrade legacy or written by a client that doesn't honor
    // the protocol, and we can't reason about its freshness — preferring
    // local avoids a stale Sync replay clobbering newer settings.
    if (!incomingMeta && this.currentSettingsMeta) {
      return
    }
    if (
      this.currentSettingsMeta &&
      incomingMeta &&
      incomingMeta.updatedAt <= this.currentSettingsMeta.updatedAt
    ) {
      return
    }

    const parsedSettings = parseSmartComposerSettings(vaultRead.raw)
    const settingsWithDefaultAssistant =
      ensureDefaultAssistantInSettings(parsedSettings)
    const { chatModels, changed } = applyKnownMaxContextTokensToChatModels(
      settingsWithDefaultAssistant.chatModels,
    )
    const normalizedSettings = changed
      ? { ...settingsWithDefaultAssistant, chatModels }
      : settingsWithDefaultAssistant

    const previousSettings = this.settings
    const baseDirChanged =
      previousSettings?.yolo?.baseDir !== normalizedSettings.yolo.baseDir

    this.settings = normalizedSettings
    this.currentSettingsMeta = incomingMeta
    if (incomingMeta) {
      this.lastWrittenVaultMirrorMeta = incomingMeta
    }

    if (baseDirChanged) {
      // Another device moved YOLO managed data to a new `baseDir`. Sync has
      // already replicated the files to the new path on disk, so we must
      // NOT call `relocateYoloManagedData` (that would treat the synced
      // copy as a source and try to move it again). Instead, tear down the
      // active runtime so the next access re-inits against the new paths.
      if (this.dbManager) {
        await this.dbManager.cleanup()
        this.dbManager = null
        this.dbManagerInitPromise = null
      }
      this.vaultMirrorPath = await getVaultDataJsonResolvedPath(
        this.app,
        normalizedSettings,
      )
      new Notice(
        'YOLO: detected a `baseDir` change synced from another device. Reloaded settings against the new path.',
      )
    }

    // Refresh the plugin-dir copy so the next cold start picks up the new
    // settings even if the mirror is missing.
    await this.saveData(
      stampYoloDataMeta(
        normalizedSettings,
        incomingMeta ?? this.buildSettingsMeta(),
      ),
    )

    this.syncOAuthRuntimesFromSettings(normalizedSettings)
    this.ragCoordinator?.updateSettings(normalizedSettings)
    this.settingsChangeListeners.forEach((listener) => {
      listener(normalizedSettings)
    })
  }

  async setSettings(newSettings: SmartComposerSettings) {
    const normalizedSettings = ensureDefaultAssistantInSettings(
      normalizeSmartComposerSettingsReferences(newSettings),
    )
    const validationResult =
      smartComposerSettingsSchema.safeParse(normalizedSettings)

    if (!validationResult.success) {
      new Notice(`Invalid settings:
${validationResult.error.issues.map((v) => v.message).join('\n')}`)
      return
    }

    const previousSettings = this.settings
    const yoloBaseDirChanged =
      previousSettings?.yolo?.baseDir !== normalizedSettings.yolo.baseDir
    const previousStoreDataInVault =
      previousSettings?.experimental?.storeDataInVault ?? false
    const nextStoreDataInVault =
      normalizedSettings.experimental?.storeDataInVault ?? false

    if (yoloBaseDirChanged) {
      if (this.dbManager) {
        await this.dbManager.save()
      }
      const migrated = await relocateYoloManagedData({
        app: this.app,
        fromSettings: previousSettings,
        toSettings: normalizedSettings,
      })
      if (!migrated) {
        new Notice(
          'Failed to move YOLO managed data. Keeping previous YOLO root folder.',
        )
        return
      }
      if (this.dbManager) {
        await this.dbManager.cleanup()
        this.dbManager = null
        this.dbManagerInitPromise = null
      }
    }

    this.settings = normalizedSettings
    const meta = await this.persistPluginDirSettings(normalizedSettings)

    if (nextStoreDataInVault) {
      await this.persistVaultMirror(normalizedSettings, meta)
    } else if (previousStoreDataInVault) {
      // Flag turned off: clean up the vault mirror so future loads use the
      // plugin-directory copy exclusively.
      await removeVaultDataJson(this.app, normalizedSettings)
      this.lastWrittenVaultMirrorMeta = null
    }
    this.syncOAuthRuntimesFromSettings(normalizedSettings)
    this.ragCoordinator?.updateSettings(normalizedSettings)

    // When RAG is disabled, stop all pending auto-update timers and clear
    // any retry_scheduled state so the background-activity UI disappears.
    const ragIsEnabled = normalizedSettings.ragOptions.enabled
    if (!ragIsEnabled) {
      this.ragAutoUpdateService?.cleanup()
      this.ragIndexService?.refreshActivity()
    }

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

  isUpdateBannerDismissed(): boolean {
    return this.updateBannerDismissed
  }

  addUpdateCheckListener(listener: () => void): () => void {
    this.updateCheckListeners.push(listener)
    return () => {
      this.updateCheckListeners = this.updateCheckListeners.filter(
        (l) => l !== listener,
      )
    }
  }

  private notifyUpdateCheckListeners(): void {
    for (const listener of this.updateCheckListeners) {
      listener()
    }
  }

  dismissUpdateBanner(): void {
    this.updateBannerDismissed = true
    this.notifyUpdateCheckListeners()
  }

  checkForUpdateOnce(): void {
    if (this.hasCheckedForUpdate) {
      return
    }
    this.hasCheckedForUpdate = true
    void (async () => {
      const fetched = await checkForUpdate(this.manifest.version)
      if (fetched?.hasUpdate) {
        this.updateCheckResult = fetched
        this.notifyUpdateCheckListeners()
      }
    })()
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

  /**
   * Inject a MentionableImage into the most recently active chat panel.
   * If no chat panel is open, a new sidebar chat is created automatically.
   * This is the typed public API used by the PDF screenshot feature.
   */
  async addImageToActiveChat(image: MentionableImage): Promise<void> {
    await this.getChatViewNavigator().addImageToChat(image)
  }

  async getDbManager(): Promise<DatabaseManager> {
    if (this.dbManager) {
      return this.dbManager
    }

    if (!this.dbManagerInitPromise) {
      this.dbManagerInitPromise = (async () => {
        try {
          const runtime = await this.getPGliteRuntimeManager().ensureReady()
          this.dbManager = await DatabaseManager.create(
            this.app,
            runtime.dir,
            this.settings,
            this.manifest.dir ? normalizePath(this.manifest.dir) : undefined,
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

  async runRagIndex(options: {
    mode: 'rebuild' | 'sync'
    scope: import('./core/rag/reconciler').ReconcileScope
    trigger: 'manual' | 'auto'
    retryPolicy: 'none' | 'transient'
    onProgress?: (
      progress: import('./components/chat-view/QueryProgress').IndexProgress,
    ) => void
  }): Promise<void> {
    await this.getRagIndexService().runIndex(options)
  }

  /** Re-issue the previously failed run. Falls back to a full sync reconcile. */
  async retryRagIndex(): Promise<void> {
    const snapshot = this.getRagIndexSnapshot()
    if (snapshot.mode === null) {
      return
    }
    await this.runRagIndex({
      mode: snapshot.mode,
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'transient',
    })
  }

  subscribeToRagIndexRuns(
    listener: (snapshot: RagIndexRunSnapshot) => void,
  ): () => void {
    return this.getRagIndexService().subscribe(listener)
  }

  getRagIndexSnapshot(): RagIndexRunSnapshot {
    return this.getRagIndexService().getSnapshot()
  }

  cancelRagIndex(): void {
    this.getRagIndexService().cancelActiveRun()
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
