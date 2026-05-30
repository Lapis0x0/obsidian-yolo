import { type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  Editor,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  getLanguage,
  normalizePath,
} from 'obsidian'

import { ChatView } from './ChatView'
import { InstallerUpdateRequiredModal } from './components/modals/InstallerUpdateRequiredModal'
import { CHAT_VIEW_TYPE } from './constants'
import { BAKED_PLUGIN_VERSION } from './constants/bakedVersion'
import { createAgentConversationPersistence } from './core/agent/conversationPersistence'
import { ensureDefaultAssistantInSettings } from './core/agent/default-assistant'
import { AgentConversationRunSummary, AgentService } from './core/agent/service'
import {
  hasConfiguredAsrConfig,
  hasConfiguredAudioFileAsrConfig,
} from './core/asr/configStatus'
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
import { setLLMDebugCaptureEnabled } from './core/llm/debugCapture'
import { clearRequestTransportMemory } from './core/llm/requestTransport'
import { McpCoordinator } from './core/mcp/mcpCoordinator'
import type { McpManager } from './core/mcp/mcpManager'
import { AgentNotificationCoordinator } from './core/notifications/agentNotificationCoordinator'
import { NotificationService } from './core/notifications/notificationService'
import {
  type YoloDataMeta,
  extractYoloDataMeta,
  readVaultDataJson,
  relocateYoloManagedData,
  removeVaultDataJson,
  stampYoloDataMeta,
} from './core/paths/yoloManagedData'
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
import { ExportConfigModal } from './features/config-transfer/components/ExportConfigModal'
import { ImportConfigModal } from './features/config-transfer/components/ImportConfigModal'
import {
  type AudioFileSource,
  createBlobAudioFileSource,
  createVaultAudioFileSource,
} from './features/editor/context-voice-input/audioFileSource'
import type { ContextVoiceInputController } from './features/editor/context-voice-input/contextVoiceInputController'
import type { DocumentSummaryManager } from './features/editor/context-voice-input/documentSummaryManager'
import type { VoiceFloatingIslandController } from './features/editor/context-voice-input/voiceFloatingIslandController'
import type { VoicePrefixCacheManager } from './features/editor/context-voice-input/voicePrefixCacheManager'
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
import { resolveSelectionChatActions } from './features/editor/selection-chat/resolveSelectionChatActions'
import { SelectionChatController } from './features/editor/selection-chat/selectionChatController'
import { selectionHighlightController } from './features/editor/selection-highlight/selectionHighlightController'
import {
  SmartSpaceController,
  SmartSpaceDraftState,
} from './features/editor/smart-space/smartSpaceController'
import { TabCompletionController } from './features/editor/tab-completion/tabCompletionController'
import { WriteAssistController } from './features/editor/write-assist/writeAssistController'
import { enablePdfScreenshotFeature } from './features/pdf-screenshot'
import { isUntitledConversationTitle } from './hooks/useChatHistory'
import { Language, createTranslationFunction } from './i18n'
import {
  YoloSettings,
  yoloSettingsSchema,
} from './settings/schema/setting.types'
import {
  normalizeYoloSettingsReferences,
  parseYoloSettings,
} from './settings/schema/settings'
import { YoloSettingTab } from './settings/SettingTab'
import type { ApplyViewState } from './types/apply-view.types'
import { ConversationOverrideSettings } from './types/conversation-settings.types'
import type {
  Mentionable,
  MentionableBlockData,
  MentionableImage,
} from './types/mentionable'
import { MentionableFile, MentionableFolder } from './types/mentionable'
import { applyKnownMaxContextTokensToChatModels } from './utils/llm/model-capability-registry'
import { getMentionableBlockData } from './utils/obsidian'
import { ensureBufferByteLengthCompat } from './utils/runtime/ensureBufferByteLengthCompat'

const STARTUP_GRACE_MS = 30 * 1000

type VoiceModules = {
  ContextVoiceInputController: typeof import('./features/editor/context-voice-input/contextVoiceInputController').ContextVoiceInputController
  DocumentSummaryManager: typeof import('./features/editor/context-voice-input/documentSummaryManager').DocumentSummaryManager
  VoiceFloatingIslandController: typeof import('./features/editor/context-voice-input/voiceFloatingIslandController').VoiceFloatingIslandController
  VoicePrefixCacheManager: typeof import('./features/editor/context-voice-input/voicePrefixCacheManager').VoicePrefixCacheManager
}

type AudioDropSource = { file: File } | { vaultFile: TFile }
type AudioDropInput = File | AudioFileSource
type AudioFileDragKind = 'audio' | 'maybe-audio' | 'unsupported'

export default class YoloPlugin extends Plugin {
  settings: YoloSettings
  settingsChangeListeners: ((newSettings: YoloSettings) => void)[] = []
  private deviceId: string | null = null
  private currentSettingsMeta: YoloDataMeta | null = null
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
  private isVoiceInputInProgress = false
  private activeAbortControllers: Set<AbortController> = new Set()
  private tabCompletionController: TabCompletionController | null = null
  private inlineSuggestionController: InlineSuggestionController | null = null
  private contextVoiceInputController: ContextVoiceInputController | null = null
  private voiceFloatingIslandController: VoiceFloatingIslandController | null =
    null
  private documentSummaryManager: DocumentSummaryManager | null = null
  private voicePrefixCacheManager: VoicePrefixCacheManager | null = null
  private voiceModules: VoiceModules | null = null
  private voiceModulesPromise: Promise<VoiceModules> | null = null
  private diffReviewController: DiffReviewController | null = null
  private smartSpaceDraftState: SmartSpaceDraftState = null
  private smartSpaceController: SmartSpaceController | null = null
  // Selection chat state
  private selectionChatController: SelectionChatController | null = null
  // Obsidian command IDs (un-namespaced) registered for selection-chat shortcuts.
  // Tracked so we can drop stale commands when the user edits the action list.
  private registeredSelectionChatCommandIds: string[] = []
  private selectionChatCommandsFingerprint: string | null = null
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
    settings: Pick<YoloSettings, 'providers'> = this.settings,
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
      initialAssistantId?: string
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
      initialAssistantId?: string
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
        showQuickAskFromPdf: (args) =>
          this.getQuickAskController().showFromPdf(args),
        pruneOrphanedQuickAskPdfInstance: (activePdfLeaves) =>
          this.getQuickAskController().pruneOrphanedPdfInstance(
            activePdfLeaves,
          ),
        openChatWithSelectionAndPrefill: async (
          selectedBlock,
          text,
          assistantId,
        ) => {
          await this.getChatViewNavigator().openChatWithSelectionAndPrefill(
            selectedBlock,
            text,
            assistantId,
          )
        },
        addSelectionToSidebarChat: async (selectedBlock) => {
          await this.getChatViewNavigator().addSelectionBlockToChat(
            selectedBlock,
          )
        },
        openChatWithSelectionAndSend: async (
          selectedBlock,
          text,
          assistantId,
        ) => {
          await this.getChatViewNavigator().openChatWithSelectionAndSend(
            selectedBlock,
            text,
            assistantId,
          )
        },
        isSmartSpaceOpen: () => this.smartSpaceController?.isOpen() ?? false,
      })
    }
    return this.selectionChatController
  }

  private initializeSelectionChat() {
    this.getSelectionChatController().initialize()
  }

  /**
   * Mirror the user's Cursor Chat 快捷指令 list into Obsidian commands so they
   * can be assigned hotkeys or surfaced by third-party menu/launcher plugins.
   * Each call fully rebuilds the set: previously-registered command IDs are
   * removed first, then the current resolved list is re-registered. Action IDs
   * are uuid-stable, so user-bound hotkeys persist across label/instruction
   * edits.
   */
  private syncSelectionChatCommands() {
    const actions = resolveSelectionChatActions(
      this.settings,
      (key, fallback) => this.t(key, fallback),
    )
    const fingerprint = JSON.stringify(
      actions.map((a) => [
        a.id,
        a.label,
        a.instruction,
        a.mode,
        a.rewriteBehavior,
        a.assistantId,
      ]),
    )
    if (fingerprint === this.selectionChatCommandsFingerprint) {
      return
    }
    this.selectionChatCommandsFingerprint = fingerprint

    const commandsApi = (
      this.app as unknown as {
        commands: { removeCommand: (id: string) => void }
      }
    ).commands
    const pluginId = this.manifest.id

    for (const id of this.registeredSelectionChatCommandIds) {
      commandsApi.removeCommand(`${pluginId}:${id}`)
    }
    this.registeredSelectionChatCommandIds = []

    for (const action of actions) {
      const commandId = `selection-chat-action:${action.id}`
      this.addCommand({
        id: commandId,
        name: `[Cursor Chat] ${action.label}`,
        editorCallback: (editor: Editor) => {
          const selected = editor.getSelection()
          if (!selected || selected.trim().length === 0) {
            new Notice('请先选中文本')
            return
          }
          void this.getSelectionChatController().executeAction(
            action.id,
            editor,
            action.instruction,
            action.mode,
            action.rewriteBehavior,
            action.assistantId,
          )
        },
      })
      this.registeredSelectionChatCommandIds.push(commandId)
    }
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
          listener: (settings: YoloSettings) => void,
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
        `[YOLO] Version mismatch: main.js=${baked}, manifest=${runtime}. ` +
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
    if (this.contextVoiceInputController?.isBusy()) {
      this.contextVoiceInputController.cancelActiveSession('user-cancel')
    }
    if (this.activeAbortControllers.size === 0) {
      this.isContinuationInProgress = false
      this.isVoiceInputInProgress = false
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
    this.isVoiceInputInProgress = false
    this.tabCompletionController?.cancelRequest()
    this.agentService?.abortAll()
  }

  getAgentService(): AgentService {
    if (!this.agentService) {
      const { persistConversationMessages } =
        createAgentConversationPersistence(this.app, () => this.settings)
      this.agentService = new AgentService({
        getSettings: () => this.settings,
        persistConversationMessages,
      })
      // Start listening for async external agent task-completed events (desktop-only, no-op on mobile)
      this.agentService.startExternalAgentResultListener()
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

  /**
   * Lazy-load the voice-input modules on first use. ~5K lines of code
   * (audio transcode, WebSocket ASR, floating-island UI) stay out of the
   * plugin's startup module graph until the user actually toggles voice
   * input or has it configured + enabled, at which point the dynamic
   * import resolves once and is cached.
   */
  private loadVoiceModules(): Promise<VoiceModules> {
    if (this.voiceModules) return Promise.resolve(this.voiceModules)
    if (!this.voiceModulesPromise) {
      this.voiceModulesPromise = (async () => {
        const [ctrl, summary, island, prefix] = await Promise.all([
          import(
            './features/editor/context-voice-input/contextVoiceInputController'
          ),
          import(
            './features/editor/context-voice-input/documentSummaryManager'
          ),
          import(
            './features/editor/context-voice-input/voiceFloatingIslandController'
          ),
          import(
            './features/editor/context-voice-input/voicePrefixCacheManager'
          ),
        ])
        const modules: VoiceModules = {
          ContextVoiceInputController: ctrl.ContextVoiceInputController,
          DocumentSummaryManager: summary.DocumentSummaryManager,
          VoiceFloatingIslandController: island.VoiceFloatingIslandController,
          VoicePrefixCacheManager: prefix.VoicePrefixCacheManager,
        }
        this.voiceModules = modules
        return modules
      })()
    }
    return this.voiceModulesPromise
  }

  /**
   * The voice input mic lives as a floating island at the bottom of the
   * active editor. Status text + waveform + timer + interaction-mode toggle
   * all surface inside that single bar, so the user has one place to look.
   */
  private async ensureVoiceFloatingIsland(): Promise<VoiceFloatingIslandController> {
    if (this.voiceFloatingIslandController) {
      return this.voiceFloatingIslandController
    }
    const modules = await this.loadVoiceModules()
    if (this.voiceFloatingIslandController) {
      return this.voiceFloatingIslandController
    }
    const island = new modules.VoiceFloatingIslandController({
      getController: () => this.contextVoiceInputController,
      getActiveMarkdownView: () =>
        this.app.workspace.getActiveViewOfType(MarkdownView),
      t: (key, fallback) => this.t(key, fallback),
      isFeatureReady: () => {
        const opts = this.settings?.contextVoiceInputOptions
        return !!opts && opts.enabled && hasConfiguredAsrConfig(opts)
      },
      isAudioFileModeEnabled: () => {
        return this.isAudioFileTranscriptionFeatureReady()
      },
      getAudioFileDragKind: (event) => this.getAudioFileDragKind(event),
      resolveAudioFileFromDrop: (event) =>
        this.resolveAudioInputFromDrop(event),
      getInteractionMode: () => this.getVoiceInteractionMode(),
      setInteractionMode: async (mode) => {
        const nextMode =
          mode === 'audio-file' && !this.isAudioFileTranscriptionFeatureReady()
            ? 'toggle-listen'
            : mode
        await this.setSettings({
          ...this.settings,
          contextVoiceInputOptions: {
            ...this.settings.contextVoiceInputOptions,
            interactionMode: nextMode,
          },
        })
      },
      getVadOptions: () => {
        const voice = this.settings.contextVoiceInputOptions
        return {
          speechStartDecibels: voice.vadSpeechStartDecibels,
          silenceDecibels: voice.vadSilenceDecibels,
          speechRequiredMs: voice.vadSpeechRequiredMs,
          silenceHoldMs: voice.vadSilenceHoldMs,
        }
      },
      getBottomOffsetVh: () =>
        this.settings.contextVoiceInputOptions.floatingIslandBottomOffsetVh,
    })
    this.voiceFloatingIslandController = island
    return island
  }

  private isContextVoiceInputFeatureReady(): boolean {
    const opts = this.settings?.contextVoiceInputOptions
    return !!opts && opts.enabled && hasConfiguredAsrConfig(opts)
  }

  private getVoiceInteractionMode():
    | 'toggle-listen'
    | 'hold-to-talk'
    | 'audio-file' {
    const mode =
      this.settings.contextVoiceInputOptions.interactionMode ?? 'toggle-listen'
    if (mode === 'audio-file' && !this.isAudioFileTranscriptionFeatureReady()) {
      return 'toggle-listen'
    }
    return mode
  }

  private syncVoiceFloatingIsland(): void {
    if (!this.isContextVoiceInputFeatureReady()) {
      if (!this.contextVoiceInputController?.isBusy()) {
        this.voiceFloatingIslandController?.destroy()
        this.voiceFloatingIslandController = null
      }
      return
    }
    void this.attachVoiceFloatingIsland()
  }

  private registerVoiceAudioDragReveal(): void {
    const options: AddEventListenerOptions = { capture: true }
    this.registerDomEvent(
      document,
      'dragenter',
      (event) => this.handleVoiceAudioDragReveal(event),
      options,
    )
    this.registerDomEvent(
      document,
      'dragover',
      (event) => this.handleVoiceAudioDragReveal(event),
      options,
    )
    this.registerDomEvent(
      document,
      'drop',
      (event) => {
        this.clearVoiceAudioDragReveal()
        this.handleVoiceAudioDrop(event)
      },
      options,
    )
    this.registerDomEvent(
      document,
      'dragend',
      () => this.clearVoiceAudioDragReveal(),
      options,
    )
    this.registerDomEvent(
      document,
      'dragleave',
      (event) => this.handleVoiceAudioDragLeave(event),
      options,
    )
    this.registerDomEvent(window, 'blur', () =>
      this.clearVoiceAudioDragReveal(),
    )
  }

  private handleVoiceAudioDragReveal(event: DragEvent): void {
    if (!this.isAudioFileTranscriptionFeatureReady()) return
    const dragKind = this.getAudioFileDragKind(event)
    if (!dragKind) return
    const markdownView = this.resolveMarkdownViewFromEventTarget(event.target)
    if (!markdownView) return
    void this.revealVoiceFloatingIslandForAudioDrag(markdownView, dragKind)
  }

  private handleVoiceAudioDrop(event: DragEvent): void {
    if (!this.isAudioFileTranscriptionFeatureReady()) return
    const markdownView = this.resolveMarkdownViewFromEventTarget(event.target)
    if (!markdownView) return
    const source = this.resolveAudioDropSource(event)
    if (!source) return

    event.preventDefault()
    event.stopPropagation()
    void this.startVoiceAudioDropTranscription(markdownView, source)
  }

  private handleVoiceAudioDragLeave(event: DragEvent): void {
    if (event.relatedTarget !== null) return
    this.clearVoiceAudioDragReveal()
  }

  private clearVoiceAudioDragReveal(): void {
    this.voiceFloatingIslandController?.clearAudioDropTargetReveal()
  }

  private async revealVoiceFloatingIslandForAudioDrag(
    markdownView: MarkdownView,
    dragKind: AudioFileDragKind,
  ): Promise<void> {
    try {
      await this.ensureContextVoiceInputController()
      const island = await this.ensureVoiceFloatingIsland()
      island.revealAudioDropTargetForView(markdownView, dragKind)
    } catch (error) {
      console.warn('Voice audio drag reveal failed:', error)
    }
  }

  private async startVoiceAudioDropTranscription(
    markdownView: MarkdownView,
    source: AudioDropSource,
  ): Promise<void> {
    try {
      await this.ensureContextVoiceInputController()
      const audioInput = this.createAudioInputFromDropSource(source)
      const island = await this.ensureVoiceFloatingIsland()
      island.attachToView(markdownView)
      await this.contextVoiceInputController?.startAudioFileTranscription(
        audioInput,
        markdownView.editor,
      )
    } catch (error) {
      console.warn('Voice audio drop transcription failed:', error)
    }
  }

  private async attachVoiceFloatingIsland(): Promise<void> {
    try {
      await this.ensureContextVoiceInputController()
      const island = await this.ensureVoiceFloatingIsland()
      island.attachToActiveView()
    } catch (error) {
      console.error('Voice floating island attach failed:', error)
    }
  }

  private isAudioFileTranscriptionFeatureReady(): boolean {
    const opts = this.settings?.contextVoiceInputOptions
    return (
      !!opts &&
      opts.enabled &&
      opts.audioFileTranscriptionEnabled &&
      hasConfiguredAudioFileAsrConfig(opts)
    )
  }

  private getAudioFileDragKind(event: DragEvent): AudioFileDragKind | null {
    const dataTransfer = event.dataTransfer
    if (!dataTransfer) return null
    const files = Array.from(dataTransfer.files ?? [])
    if (files.length > 0) {
      return files.some((file) => this.isLikelyAudioDragFile(file))
        ? 'audio'
        : 'unsupported'
    }

    const items = Array.from(dataTransfer.items ?? [])
    const fileItems = items.filter((item) => item.kind === 'file')
    if (fileItems.length > 0) {
      if (
        fileItems.some((item) => item.type.toLowerCase().startsWith('audio/'))
      ) {
        return 'audio'
      }
      if (fileItems.some((item) => item.type === '')) return 'maybe-audio'
      return 'unsupported'
    }

    const textCandidateKind =
      this.getAudioFileDragKindFromDataTransferText(dataTransfer)
    if (textCandidateKind) return textCandidateKind

    return Array.from(dataTransfer.types ?? []).some((type) => {
      const lower = type.toLowerCase()
      return (
        lower === 'files' ||
        lower === 'text/uri-list' ||
        lower.includes('file') ||
        lower.includes('obsidian')
      )
    })
      ? 'maybe-audio'
      : null
  }

  private getAudioFileDragKindFromDataTransferText(
    dataTransfer: DataTransfer,
  ): AudioFileDragKind | null {
    let sawFileLikeCandidate = false
    for (const type of Array.from(dataTransfer.types ?? [])) {
      const text = this.safeReadDropData(dataTransfer, type)
      for (const candidate of this.extractVaultPathCandidates(text)) {
        const fileLike =
          candidate.includes('/') || /\.[a-z0-9]{2,8}$/i.test(candidate)
        if (!fileLike) continue
        if (this.resolveAudioVaultFileCandidate(candidate)) return 'audio'
        if (this.isLikelyAudioPath(candidate)) return 'audio'
        sawFileLikeCandidate = true
      }
    }
    return sawFileLikeCandidate ? 'unsupported' : null
  }

  private async resolveAudioInputFromDrop(
    event: DragEvent,
  ): Promise<AudioDropInput | null> {
    const source = this.resolveAudioDropSource(event)
    return source ? this.createAudioInputFromDropSource(source) : null
  }

  private resolveAudioDropSource(event: DragEvent): AudioDropSource | null {
    const dataTransfer = event.dataTransfer
    if (!dataTransfer) return null

    const file = Array.from(dataTransfer.files ?? []).find((candidate) =>
      this.isLikelyAudioDragFile(candidate),
    )
    if (file) return { file }

    const vaultFile = this.resolveAudioVaultFileFromDataTransfer(dataTransfer)
    return vaultFile ? { vaultFile } : null
  }

  private createAudioInputFromDropSource(
    source: AudioDropSource,
  ): AudioDropInput {
    if ('file' in source) return createBlobAudioFileSource(source.file)

    return createVaultAudioFileSource({
      app: this.app,
      file: source.vaultFile,
      mimeType: this.getAudioMimeType(source.vaultFile.path),
      materializeLimitMessage: this.t(
        'voiceInput.audioFileErrorLocalDecodeTooLarge',
        'This audio file is too large for local processing. Use a long-audio provider.',
      ),
    })
  }

  private resolveAudioVaultFileFromDataTransfer(
    dataTransfer: DataTransfer,
  ): TFile | null {
    const candidates = new Set<string>()
    for (const type of Array.from(dataTransfer.types ?? [])) {
      const text = this.safeReadDropData(dataTransfer, type)
      for (const candidate of this.extractVaultPathCandidates(text)) {
        candidates.add(candidate)
      }
    }
    for (const candidate of candidates) {
      const file = this.resolveAudioVaultFileCandidate(candidate)
      if (file) return file
    }
    return null
  }

  private safeReadDropData(dataTransfer: DataTransfer, type: string): string {
    try {
      return dataTransfer.getData(type) || ''
    } catch {
      return ''
    }
  }

  private extractVaultPathCandidates(text: string): string[] {
    if (!text.trim()) return []
    const candidates: string[] = []
    const add = (value: string) => {
      const normalized = this.normalizeDroppedVaultPath(value)
      if (normalized) candidates.push(normalized)
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      add(trimmed)
    }

    const wikiLinkPattern = /!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g
    for (const match of text.matchAll(wikiLinkPattern)) {
      add(match[1] ?? '')
    }

    const markdownLinkPattern = /!?\[[^\]]*]\(([^)]+)\)/g
    for (const match of text.matchAll(markdownLinkPattern)) {
      add(match[1] ?? '')
    }

    return candidates
  }

  private normalizeDroppedVaultPath(value: string): string | null {
    let candidate = value.trim()
    if (!candidate) return null

    candidate = candidate.replace(/^["'<]+|[">'）]+$/g, '').trim()
    if (!candidate) return null

    try {
      candidate = decodeURIComponent(candidate)
    } catch {
      // Keep the raw string when it is not a URI-encoded path.
    }

    if (candidate.startsWith('file://')) {
      candidate = candidate.replace(/^file:\/+/, '')
    }

    const queryIndex = candidate.indexOf('?')
    if (candidate.startsWith('obsidian://') && queryIndex !== -1) {
      const params = new URLSearchParams(candidate.slice(queryIndex + 1))
      candidate = params.get('file') ?? params.get('path') ?? candidate
    }

    candidate = candidate.replace(/^!?\[\[|\]\]$/g, '')
    const aliasIndex = candidate.indexOf('|')
    if (aliasIndex !== -1) candidate = candidate.slice(0, aliasIndex)
    const headingIndex = candidate.indexOf('#')
    if (headingIndex !== -1) candidate = candidate.slice(0, headingIndex)
    candidate = candidate.trim()
    if (!candidate) return null

    return normalizePath(candidate.replace(/^\/+/, ''))
  }

  private resolveAudioVaultFileCandidate(candidate: string): TFile | null {
    const linked = this.app.metadataCache.getFirstLinkpathDest(candidate, '')
    if (linked instanceof TFile && this.isLikelyAudioPath(linked.path)) {
      return linked
    }

    const direct = this.app.vault.getAbstractFileByPath(candidate)
    if (direct instanceof TFile && this.isLikelyAudioPath(direct.path)) {
      return direct
    }

    if (candidate.includes('/')) return null
    return (
      this.app.vault
        .getFiles()
        .find(
          (file) =>
            file.name.toLowerCase() === candidate.toLowerCase() &&
            this.isLikelyAudioPath(file.path),
        ) ?? null
    )
  }

  private isLikelyAudioDragFile(file: File): boolean {
    if (file.type.toLowerCase().startsWith('audio/')) return true
    return this.isLikelyAudioPath(file.name)
  }

  private isLikelyAudioPath(path: string): boolean {
    return /\.(mp3|m4a|mp4|wav|webm|ogg|opus|flac|aac|amr)$/i.test(path)
  }

  private getAudioMimeType(path: string): string {
    const extension = path.split('.').pop()?.toLowerCase()
    switch (extension) {
      case 'mp3':
        return 'audio/mpeg'
      case 'm4a':
      case 'mp4':
        return 'audio/mp4'
      case 'wav':
        return 'audio/wav'
      case 'webm':
        return 'audio/webm'
      case 'ogg':
      case 'opus':
        return 'audio/ogg'
      case 'flac':
        return 'audio/flac'
      case 'aac':
        return 'audio/aac'
      case 'amr':
        return 'audio/amr'
      default:
        return 'application/octet-stream'
    }
  }

  private resolveMarkdownViewFromEventTarget(
    target: EventTarget | null,
  ): MarkdownView | null {
    if (!(target instanceof Node)) return null
    const markdownLeaves = this.app.workspace.getLeavesOfType('markdown')
    for (const leaf of markdownLeaves) {
      const view = leaf.view
      if (!(view instanceof MarkdownView)) continue
      if (view.contentEl.contains(target)) return view
    }
    return null
  }

  private setupBackgroundActivityStatusBar(): void {
    const statusBarItem = this.addStatusBarItem()
    statusBarItem.addClass('mod-clickable')
    statusBarItem.addClass('yolo-background-activity-status-bar')
    statusBarItem.hide()

    const ring = document.createElement('span')
    ring.className = 'yolo-background-activity-status-bar-ring'

    const label = document.createElement('span')
    label.className = 'yolo-background-activity-status-bar-label'

    const panel = document.createElement('div')
    panel.className = 'yolo-background-activity-status-panel'
    panel.setAttribute('aria-hidden', 'true')
    panel.hidden = true

    const panelHeader = document.createElement('div')
    panelHeader.className = 'yolo-background-activity-status-panel-header'
    panelHeader.setText(
      this.t('statusBar.backgroundStatusPanelTitle', '后台任务'),
    )

    const panelList = document.createElement('div')
    panelList.className = 'yolo-background-activity-status-panel-list'

    const panelEmpty = document.createElement('div')
    panelEmpty.className = 'yolo-background-activity-status-panel-empty'
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
    // 异步派遣的子进程是 desktop-only，懒加载注册表后再订阅。
    let unsubscribeAsyncTasks: (() => void) | null = null
    if (Platform.isDesktopApp) {
      void import('./core/agent/external-cli/async-task-registry').then(
        ({ asyncTaskRegistry }) => {
          unsubscribeAsyncTasks = asyncTaskRegistry.subscribe((records) => {
            this.syncAsyncExternalAgentBackgroundActivities(records)
          })
        },
      )
    }

    this.register(() => {
      unsubscribeActivities()
      unsubscribeAgentSummaries()
      unsubscribeAsyncTasks?.()
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

  private syncAsyncExternalAgentBackgroundActivities(
    records: import('./core/agent/external-cli/async-task-registry').AsyncTaskRecord[],
  ): void {
    const registry = this.getBackgroundActivityRegistry()
    const nextActivityIds = new Set<string>()

    for (const record of records) {
      if (record.status !== 'running') continue
      const id = `external-agent:${record.taskId}`
      nextActivityIds.add(id)
      registry.upsert({
        id,
        kind: 'agent',
        title: record.title,
        detail: record.provider,
        status: 'running',
        updatedAt: record.createdAt,
        ...(record.conversationId
          ? {
              action: {
                type: 'open-agent-conversation',
                conversationId: record.conversationId,
              },
            }
          : {}),
      })
    }

    for (const activityId of this.latestBackgroundActivities.keys()) {
      if (!activityId.startsWith('external-agent:')) continue
      if (nextActivityIds.has(activityId)) continue
      registry.remove(activityId)
    }
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
      cls: 'yolo-background-activity-status-panel-item',
    })
    item.setAttribute('role', 'button')
    item.setAttribute('tabindex', '0')

    const row = item.createDiv({
      cls: 'yolo-background-activity-status-panel-item-row',
    })
    const copy = row.createDiv({
      cls: 'yolo-background-activity-status-panel-item-copy',
    })
    const title = copy.createDiv({
      cls: 'yolo-background-activity-status-panel-item-title',
    })
    const detail = copy.createDiv({
      cls: 'yolo-background-activity-status-panel-item-detail',
    })
    const indicator = row.createDiv({
      cls: 'yolo-background-activity-status-panel-item-indicator',
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
    if (!isUntitledConversationTitle(title)) {
      return title!.trim()
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
        showTabLoadingDots: (view, from) =>
          inlineSuggestionController.showTabLoadingDots(view, from),
        hideTabLoadingDots: (view) =>
          inlineSuggestionController.hideTabLoadingDots(view),
        clearInlineSuggestion: () =>
          inlineSuggestionController.clearInlineSuggestion(),
        setActiveInlineSuggestion: (suggestion) =>
          inlineSuggestionController.setActiveInlineSuggestion(suggestion),
        addAbortController: (controller) =>
          this.activeAbortControllers.add(controller),
        removeAbortController: (controller) =>
          this.activeAbortControllers.delete(controller),
        isContinuationInProgress: () => this.isContinuationInProgress,
        isVoiceInputInProgress: () => this.isVoiceInputInProgress,
      })
    }
    return this.tabCompletionController
  }

  private getInlineSuggestionController(): InlineSuggestionController {
    if (!this.inlineSuggestionController) {
      this.inlineSuggestionController = new InlineSuggestionController({
        getEditorView: (editor) => this.getEditorView(editor),
        getTabCompletionController: () => this.getTabCompletionController(),
        getContextVoiceInputController: () => this.contextVoiceInputController,
      })
    }
    return this.inlineSuggestionController
  }

  private async ensureContextVoiceInputController(): Promise<ContextVoiceInputController> {
    if (this.contextVoiceInputController) {
      return this.contextVoiceInputController
    }
    const modules = await this.loadVoiceModules()
    if (this.contextVoiceInputController) {
      return this.contextVoiceInputController
    }
    const inlineSuggestionController = this.getInlineSuggestionController()
    const controller = new modules.ContextVoiceInputController({
      getSettings: () => this.settings,
      setSettings: (next) => this.setSettings(next),
      getEditorView: (editor) => this.getEditorView(editor),
      getActiveMarkdownView: () =>
        this.app.workspace.getActiveViewOfType(MarkdownView),
      setInlineSuggestionGhost: (view, payload) =>
        inlineSuggestionController.setInlineSuggestionGhost(view, payload),
      setActiveVoiceSuggestion: (suggestion) =>
        inlineSuggestionController.setVoiceSuggestion(suggestion),
      clearInlineSuggestion: () =>
        inlineSuggestionController.clearInlineSuggestion(),
      addAbortController: (controller) =>
        this.activeAbortControllers.add(controller),
      removeAbortController: (controller) =>
        this.activeAbortControllers.delete(controller),
      cancelPendingTabCompletion: () => {
        this.tabCompletionController?.clearTimer()
        this.tabCompletionController?.cancelRequest()
      },
      setVoiceInputInProgress: (inProgress) => {
        this.isVoiceInputInProgress = inProgress
      },
      createFallbackMarkdownFile: (desiredPath, content) =>
        this.createVoiceFallbackMarkdownFile(desiredPath, content),
      appendToMarkdownFile: (path, content) =>
        this.appendToVoiceFallbackMarkdownFile(path, content),
      t: (key, fallback) => this.t(key, fallback),
    })
    controller.setSummaryManager(this.ensureDocumentSummaryManager(modules))
    controller.setPrefixCacheManager(
      this.ensureVoicePrefixCacheManager(modules),
    )
    this.contextVoiceInputController = controller
    return controller
  }

  private async createVoiceFallbackMarkdownFile(
    desiredPath: string,
    content: string,
  ): Promise<string> {
    const path = await this.reserveVoiceFallbackMarkdownPath(desiredPath)
    await this.ensureVaultFolderForPath(path)
    const file = await this.app.vault.create(path, content)
    return file.path
  }

  private async appendToVoiceFallbackMarkdownFile(
    path: string,
    content: string,
  ): Promise<void> {
    const normalized = this.normalizeMarkdownPath(path)
    const existing = this.app.vault.getAbstractFileByPath(normalized)
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing)
      await this.app.vault.modify(existing, `${current}${content}`)
      return
    }
    if (existing) {
      throw new Error(
        `Cannot write transcription to folder path: ${normalized}`,
      )
    }
    await this.ensureVaultFolderForPath(normalized)
    await this.app.vault.create(normalized, content)
  }

  private async reserveVoiceFallbackMarkdownPath(
    desiredPath: string,
  ): Promise<string> {
    const normalized = this.normalizeMarkdownPath(desiredPath)
    if (!this.app.vault.getAbstractFileByPath(normalized)) return normalized

    const dot = normalized.toLowerCase().endsWith('.md')
      ? normalized.length - 3
      : normalized.length
    const stem = normalized.slice(0, dot)
    const ext = normalized.slice(dot)
    let counter = 2
    while (true) {
      const candidate = `${stem} ${counter}${ext}`
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate
      counter += 1
    }
  }

  private normalizeMarkdownPath(path: string): string {
    const trimmed =
      path.trim().replace(/[\\:*?"<>|]/g, '-') || 'Transcriptions/audio'
    const withExtension = trimmed.toLowerCase().endsWith('.md')
      ? trimmed
      : `${trimmed}.md`
    return normalizePath(withExtension || 'Transcriptions/audio.md')
  }

  private async ensureVaultFolderForPath(path: string): Promise<void> {
    const parts = path.split('/').slice(0, -1)
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      const existing = this.app.vault.getAbstractFileByPath(current)
      if (existing instanceof TFolder) continue
      if (existing) {
        throw new Error(`Cannot create folder for transcription: ${current}`)
      }
      await this.app.vault.createFolder(current)
    }
  }

  /**
   * Lazy singleton for the per-document summary cache shared by voice input.
   * Lives only in memory; created on first use, dropped on plugin unload.
   */
  private ensureDocumentSummaryManager(
    modules: VoiceModules,
  ): DocumentSummaryManager {
    if (!this.documentSummaryManager) {
      this.documentSummaryManager = new modules.DocumentSummaryManager({
        getSettings: () => this.settings,
        setSettings: (next) => this.setSettings(next),
      })
    }
    return this.documentSummaryManager
  }

  /**
   * Lazy singleton for the per-file anchored prefix cache used by voice
   * input polish. Like the summary manager, lives only in memory.
   */
  private ensureVoicePrefixCacheManager(
    modules: VoiceModules,
  ): VoicePrefixCacheManager {
    if (!this.voicePrefixCacheManager) {
      this.voicePrefixCacheManager = new modules.VoicePrefixCacheManager()
    }
    return this.voicePrefixCacheManager
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
    await this.migrateLegacyVaultMirrorIfNeeded()
    this.warnIfInstallationIncomplete()
    this.syncOAuthRuntimesFromSettings()

    // Prune stale image cache entries (>30 days) on startup
    void pruneImageCache(this.app, 30, this.settings)
    void prunePdfTextCache(this.app, 30, this.settings)
    await this.getRagIndexService().initialize()
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings?.ragOptions?.enabled) return
      const snapshot = this.getRagIndexSnapshot()
      if (
        snapshot.status !== 'retry_scheduled' ||
        snapshot.retryPolicy !== 'transient'
      ) {
        return
      }
      const hasValidEmbeddingModel =
        !!this.settings?.embeddingModelId &&
        this.settings.embeddingModels.some(
          (m) => m.id === this.settings.embeddingModelId,
        )
      if (
        hasValidEmbeddingModel &&
        this.settings.ragOptions.autoUpdateEnabled &&
        snapshot.trigger === 'auto'
      ) {
        this.getRagAutoUpdateService().restoreRetryScheduled(
          snapshot.retryAt,
          STARTUP_GRACE_MS,
        )
      } else if (hasValidEmbeddingModel && snapshot.trigger === 'manual') {
        this.getRagIndexService().restoreRetryScheduledRun(STARTUP_GRACE_MS)
      }
    })

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
    // Soft-restart voice-input session at the new cursor position whenever
    // the user clicks / arrow-keys away during the recording phase. Listener
    // is global but cheap (early-exits when there's no active voice session)
    // — see ContextVoiceInputController.handleEditorSelectionChange for the
    // full guard list (toggle-listen only, same editor, etc).
    this.registerEditorExtension(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          this.contextVoiceInputController?.handleEditorDocumentChange(
            update.view,
            update.changes,
          )
        }
        if (!update.selectionSet) return
        this.contextVoiceInputController?.handleEditorSelectionChange(
          update.view,
        )
      }),
    )

    // This creates an icon in the left ribbon.
    this.addRibbonIcon('wand-sparkles', this.t('commands.openChat'), () => {
      void this.openChatView({ placement: this.resolveRibbonPlacement() })
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

    this.addCommand({
      id: 'toggle-context-voice-input',
      name:
        this.t('commands.toggleVoiceInput') ??
        'Toggle context-aware voice input',
      editorCallback: (editor: Editor) => {
        void (async () => {
          try {
            const controller = await this.ensureContextVoiceInputController()
            this.syncVoiceFloatingIsland()
            await controller.toggle(editor)
          } catch (error) {
            console.error('Voice input toggle failed:', error)
            new Notice('Voice input failed to start.')
          }
        })()
      },
    })

    this.addCommand({
      id: 'cancel-context-voice-input',
      name:
        this.t('commands.cancelVoiceInput') ??
        'Cancel context-aware voice input',
      callback: () => {
        if (this.contextVoiceInputController?.isBusy()) {
          this.contextVoiceInputController.cancelActiveSession('user-cancel')
        }
      },
    })

    this.syncVoiceFloatingIsland()
    this.registerVoiceAudioDragReveal()

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
      this.app.vault.on('delete', (file) => {
        this.getRagAutoUpdateService().onVaultFileChanged(file, 'delete')
        // Voice-input caches are keyed by file path. `forget` also clears
        // child paths when `file` is a deleted folder.
        this.documentSummaryManager?.forget(file.path)
        this.voicePrefixCacheManager?.forget(file.path)
      }),
    )
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const service = this.getRagAutoUpdateService()
        service.onVaultFileChanged(file, 'rename')
        if (oldPath)
          service.onVaultPathChanged(oldPath, {
            requiresFullScan: file instanceof TFolder,
          })
        // Voice-input caches: forget the OLD path so the renamed file
        // gets a fresh entry next time. Handles A↔B file-swap correctly
        // since both rename events fire.
        if (oldPath) {
          this.documentSummaryManager?.forget(oldPath)
          this.voicePrefixCacheManager?.forget(oldPath)
        }
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

    this.addCommand({
      id: 'export-settings',
      name: this.t('commands.exportSettings', '导出插件配置'),
      callback: () => {
        new ExportConfigModal(this.app, this).open()
      },
    })

    this.addCommand({
      id: 'import-settings',
      name: this.t('commands.importSettings', '导入插件配置'),
      callback: () => {
        new ImportConfigModal(this.app, this).open()
      },
    })

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new YoloSettingTab(this.app, this))

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
          // Cancel an in-progress voice session if the user switched to a
          // different file — recording / polish would otherwise complete
          // against the old file silently and either insert into the wrong
          // place or be lost when the bar re-attaches to the new view.
          this.contextVoiceInputController?.cancelIfFileChanged()
          // Re-attach the voice floating island to whichever markdown view is
          // now active. No-op unless voice input is configured and enabled.
          this.syncVoiceFloatingIsland()
        } catch (err) {
          console.error('Editor change handler error:', err)
        }
      }),
    )

    // Initialize selection chat
    this.initializeSelectionChat()
    this.syncSelectionChatCommands()

    // Listen for settings changes to reinitialize Selection Chat
    this.addSettingsChangeListener((newSettings) => {
      const enableSelectionChat =
        newSettings.continuationOptions?.enableSelectionChat ?? true
      const wasEnabled = this.selectionChatController?.isActive() ?? false

      if (enableSelectionChat !== wasEnabled) {
        // Re-initialize when the setting changes
        this.initializeSelectionChat()
      }
      this.syncSelectionChatCommands()
      // Voice feature gating may have flipped (enable toggled, ASR configured);
      // re-render the island so it shows/hides accordingly.
      this.syncVoiceFloatingIsland()
    })
  }

  onunload() {
    this.closeSmartSpace()

    // Selection chat cleanup
    this.selectionChatController?.destroy()
    this.selectionChatController = null
    this.chatViewNavigator = null
    this.newTabEmptyStateEnhancer = null
    this.contextVoiceInputController?.destroy()
    this.contextVoiceInputController = null
    this.voiceFloatingIslandController?.destroy()
    this.voiceFloatingIslandController = null
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
    this.agentService?.stopExternalAgentResultListener()
    this.agentService?.abortAll()
    this.agentService = null
    // 终止所有活跃的外部 CLI 子进程（desktop-only，mobile 为空操作）
    void import('./core/agent/external-cli/index').then(
      ({ killAllActiveExternalCli }) => killAllActiveExternalCli(),
    )
    // 终止所有异步派遣任务，标记为 killed_by_shutdown
    void import('./core/agent/external-cli/async-task-registry').then(
      ({ asyncTaskRegistry }) => asyncTaskRegistry.abortAll(),
    )
    // Ensure all in-flight requests are aborted on unload
    this.cancelAllAiTasks()
    this.clearTabCompletionTimer()
    this.cancelTabCompletionRequest()
    this.clearInlineSuggestion()

    // Release the pdfjs worker Blob URL we may have created during this
    // session. Outstanding workers already spawned keep running; this only
    // prevents future fetches and lets the GC collect the source string.
    void import('./utils/pdf/pdfjsLoader').then(({ disposePdfjsWorker }) =>
      disposePdfjsWorker(),
    )
  }

  async loadSettings() {
    // Read-only loader. The on-disk `data.json` in the plugin directory is
    // the single source of truth for settings; `this.settings` is just a
    // process-local view of it. Cross-device sync is delegated to whatever
    // tool the user is using (Obsidian Sync, remotely-save, syncthing, git,
    // …) — they all replicate the plugin-dir file directly. We never write
    // back during load, so a backup pasted into `data.json` while the
    // plugin was off can't be silently overwritten by startup
    // normalization, and a Sync push that lands during boot can't be
    // clobbered by a stale in-memory snapshot.
    const rawPluginData = (await this.loadData()) as unknown
    const pluginExtract = extractYoloDataMeta(rawPluginData)
    const sourceRaw = pluginExtract?.raw ?? null
    const sourceMeta = pluginExtract?.meta ?? null

    const parsedSettings = parseYoloSettings(sourceRaw)
    const settingsWithDefaultAssistant =
      ensureDefaultAssistantInSettings(parsedSettings)
    const { chatModels, changed } = applyKnownMaxContextTokensToChatModels(
      settingsWithDefaultAssistant.chatModels,
    )
    const normalizedSettings = changed
      ? { ...settingsWithDefaultAssistant, chatModels }
      : settingsWithDefaultAssistant

    this.settings = normalizedSettings
    this.currentSettingsMeta = sourceMeta
    setLLMDebugCaptureEnabled(
      this.settings.debug?.captureRawRequestDebug ?? false,
    )
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

  /**
   * Total ordering on `YoloDataMeta`. Returns true iff `b` beats `a`.
   *   - Strictly newer `updatedAt` wins.
   *   - Equal `updatedAt` ties are broken by lexically larger `deviceId`,
   *     so all devices observing a millisecond-coincident race converge
   *     on the same winner deterministically.
   * `metaBeats(self, self)` is false.
   */
  private metaBeats(a: YoloDataMeta, b: YoloDataMeta): boolean {
    if (b.updatedAt > a.updatedAt) return true
    if (b.updatedAt < a.updatedAt) return false
    return b.deviceId > a.deviceId
  }

  /**
   * Builds a fresh `__meta` for our own writes. Monotonic against the
   * meta we last observed in memory: prevents a device whose clock lags
   * behind a freshly-synced peer from emitting a write whose `updatedAt`
   * is below `currentSettingsMeta`, which other devices would then
   * legitimately reject as stale.
   */
  private buildSettingsMeta(): YoloDataMeta {
    const baseTime = Date.now()
    const monotonic = this.currentSettingsMeta
      ? Math.max(baseTime, this.currentSettingsMeta.updatedAt + 1)
      : baseTime
    return {
      updatedAt: monotonic,
      deviceId: this.getDeviceId(),
    }
  }

  private async persistPluginDirSettings(
    settings: YoloSettings,
    meta: YoloDataMeta = this.buildSettingsMeta(),
  ): Promise<YoloDataMeta> {
    await this.saveData(stampYoloDataMeta(settings, meta))
    this.currentSettingsMeta = meta
    return meta
  }

  /**
   * Adopt an externally-written `data.json` payload into in-memory state.
   *
   * Called from two places:
   *   - `onExternalSettingsChange()` — Obsidian's official hook fires when
   *     it detects the plugin's `data.json` was modified by something
   *     other than `saveData` (Obsidian Sync push, remotely-save replay,
   *     manual paste, git pull, …).
   *   - `setSettings()` conflict path — when a write-attempt detects the
   *     on-disk file is newer than what we last committed in memory.
   *
   * Protocol invariant:
   *   Every legitimate write to `data.json` MUST stamp it with a
   *   `__meta.updatedAt` strictly greater than the last meta this client
   *   observed (or, on a millisecond-coincident race from another
   *   device, a different `deviceId` so the lex tie-break in
   *   `metaBeats` resolves the winner). `buildSettingsMeta` enforces
   *   monotonicity for our own writes; cross-device sync naturally
   *   satisfies it via `Date.now()` advancement. A user who hand-edits
   *   `data.json` without bumping `__meta.updatedAt` falls outside the
   *   protocol — we accept that such an edit may be missed until the
   *   next external-change event re-reads the file.
   */
  private async applyExternalSettingsUpdate(
    raw: Record<string, unknown>,
    incomingMeta: YoloDataMeta | null,
  ): Promise<void> {
    // Self-write echo: same device + same updatedAt means this event is
    // the reflection of our own most recent saveData. Suppress.
    if (
      incomingMeta &&
      this.currentSettingsMeta &&
      incomingMeta.deviceId === this.currentSettingsMeta.deviceId &&
      incomingMeta.updatedAt === this.currentSettingsMeta.updatedAt
    ) {
      return
    }
    // Meta-less incoming with a meta-stamped local copy: refuse, per
    // protocol — we can't compare freshness so preferring local avoids
    // stale replays clobbering newer settings.
    if (!incomingMeta && this.currentSettingsMeta) {
      return
    }
    // Reject anything our current in-memory state already beats under
    // the total `metaBeats` ordering (older OR equal-and-loser).
    if (
      this.currentSettingsMeta &&
      incomingMeta &&
      !this.metaBeats(this.currentSettingsMeta, incomingMeta)
    ) {
      return
    }

    const parsedSettings = parseYoloSettings(raw)
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

    if (baseDirChanged) {
      // External payload references a different `baseDir`. Don't call
      // `relocateYoloManagedData` here — the on-disk YOLO/ folder either
      // already lives at the new path because Sync replicated it, or (in
      // the manual paste case) corresponds to the user's pre-restore
      // state and would be wrong to move. Tear down the active runtime
      // and let the next access re-init against the new paths.
      if (this.dbManager) {
        await this.dbManager.cleanup()
        this.dbManager = null
        this.dbManagerInitPromise = null
      }
      new Notice(
        'YOLO: detected a `baseDir` change in data.json. Reloaded settings against the new path.',
      )
    }

    this.syncOAuthRuntimesFromSettings(normalizedSettings)
    this.ragCoordinator?.updateSettings(normalizedSettings)
    this.settingsChangeListeners.forEach((listener) => {
      listener(normalizedSettings)
    })
  }

  /**
   * Obsidian's official hook for "data.json was modified outside of
   * saveData()". Fires for Obsidian Sync pushes, remotely-save replays,
   * manual user pastes, etc. — platform-agnostic and reliable, no
   * fs.watch needed. https://docs.obsidian.md/Reference/TypeScript+API/Plugin/onExternalSettingsChange
   */
  async onExternalSettingsChange(): Promise<void> {
    let raw: unknown
    try {
      raw = await this.loadData()
    } catch (error) {
      console.warn(
        '[YOLO] Failed to re-read data.json after external change.',
        error,
      )
      return
    }
    const extract = extractYoloDataMeta(raw)
    if (!extract) {
      return
    }
    await this.applyExternalSettingsUpdate(extract.raw, extract.meta)
  }

  /**
   * Returns the on-disk settings + meta when the plugin-dir file has
   * been mutated externally since we last wrote/loaded it; otherwise
   * null. Used by `setSettings` to refuse stale full-object writes.
   */
  private async detectExternalSettingsConflict(): Promise<{
    raw: Record<string, unknown>
    meta: YoloDataMeta
  } | null> {
    let raw: unknown
    try {
      raw = await this.loadData()
    } catch (error) {
      console.warn('[YOLO] Failed to read data.json before write.', error)
      return null
    }
    const extract = extractYoloDataMeta(raw)
    if (!extract?.meta) {
      return null
    }
    const diskMeta = extract.meta
    const currentMeta = this.currentSettingsMeta
    // Self-write: same device + same updatedAt is the write we just made.
    if (
      currentMeta &&
      diskMeta.deviceId === currentMeta.deviceId &&
      diskMeta.updatedAt === currentMeta.updatedAt
    ) {
      return null
    }
    // Conflict iff disk beats current memory (newer OR equal-but-foreign
    // by deviceId tie-break).
    if (currentMeta && !this.metaBeats(currentMeta, diskMeta)) {
      return null
    }
    return { raw: extract.raw, meta: diskMeta }
  }

  /**
   * One-shot migration of the deprecated "vault mirror" feature. Earlier
   * versions optionally mirrored `data.json` into a vault-visible folder
   * so that Obsidian Sync (which historically didn't sync plugin configs)
   * could carry the settings. Modern Obsidian Sync replicates
   * `.obsidian/plugins/<id>/data.json` natively, and the mirror was the
   * source of considerable concurrency pain — so we removed it.
   *
   * Trigger: presence of the legacy mirror file (or its pointer) on disk.
   * The legacy `experimental.storeDataInVault` flag has already been
   * dropped from the schema, so it gets stripped on parse and isn't a
   * reliable signal anymore — the file's existence is.
   *
   * Steps:
   *   1. Read mirror via the pointer (which honors a custom baseDir).
   *   2. If the mirror beats plugin-dir under `metaBeats`, adopt mirror
   *      payload into memory + plugin-dir (verified via re-stamp).
   *   3. Best-effort delete pointer + mirror file.
   *   4. Notify the user once.
   *
   * Idempotent: a second run finds no mirror and exits silently.
   */
  private async migrateLegacyVaultMirrorIfNeeded(): Promise<void> {
    let mirrorRead
    try {
      // Pass current settings so the reader can fall back to the
      // default mirror path ONLY when the pointer file is genuinely
      // absent — this covers the partial legacy state where a user
      // manually deleted the pointer but left `YOLO/.yolo_data.json`
      // behind. A pointer that exists but is corrupt is treated as
      // authoritative and yields null, deferring to the next launch
      // rather than risking a stale default-path mirror.
      mirrorRead = await readVaultDataJson(this.app, this.settings)
    } catch (error) {
      console.warn('[YOLO] Legacy mirror read failed during migration.', error)
      return
    }
    if (!mirrorRead) {
      return
    }

    const mirrorMeta = mirrorRead.meta
    const currentMeta = this.currentSettingsMeta
    // Adopt mirror only when it strictly beats plugin-dir under the
    // total `metaBeats` ordering. Both meta-less or local-meta-only =>
    // keep plugin-dir (it's the new source of truth).
    const shouldAdoptMirror = !!(
      mirrorMeta &&
      (!currentMeta || this.metaBeats(currentMeta, mirrorMeta))
    )

    if (shouldAdoptMirror && mirrorMeta) {
      await this.applyExternalSettingsUpdate(mirrorRead.raw, mirrorMeta)
      try {
        await this.saveData(stampYoloDataMeta(this.settings, mirrorMeta))
        this.currentSettingsMeta = mirrorMeta
      } catch (error) {
        console.warn(
          '[YOLO] Failed to persist plugin-dir during legacy mirror migration; aborting cleanup so the mirror remains as the canonical copy.',
          error,
        )
        return
      }
      // Read-after-write verify before deleting the canonical mirror
      // copy. Catches half-committed FS state where `saveData` reported
      // success but the file isn't actually persisted as expected. On
      // verification failure, leave the mirror in place so the next
      // launch retries the migration.
      try {
        const verify = extractYoloDataMeta(await this.loadData())
        if (
          !verify?.meta ||
          verify.meta.deviceId !== mirrorMeta.deviceId ||
          verify.meta.updatedAt !== mirrorMeta.updatedAt
        ) {
          console.warn(
            '[YOLO] Plugin-dir verification failed after legacy mirror migration write; leaving mirror in place for next launch.',
          )
          return
        }
      } catch (error) {
        console.warn(
          '[YOLO] Plugin-dir verification read failed during legacy mirror migration; leaving mirror in place.',
          error,
        )
        return
      }
    }

    // Best-effort cleanup of mirror + pointer. Failures are logged but
    // never block startup.
    try {
      await removeVaultDataJson(this.app, this.settings)
    } catch (error) {
      console.warn('[YOLO] Failed to remove legacy mirror files.', error)
    }

    new Notice(
      'YOLO: migrated legacy vault-mirror settings. Cross-device sync now uses Obsidian Sync (or your sync tool of choice) on the plugin data file directly.',
    )
  }

  async setSettings(newSettings: YoloSettings) {
    const normalizedSettings = ensureDefaultAssistantInSettings(
      normalizeYoloSettingsReferences(newSettings),
    )
    const validationResult = yoloSettingsSchema.safeParse(normalizedSettings)

    if (!validationResult.success) {
      new Notice(`Invalid settings:
${validationResult.error.issues.map((v) => v.message).join('\n')}`)
      return
    }

    // Read-before-write conflict check. If the file on disk has been
    // mutated externally (Sync push, third-party sync replay, manual
    // paste, …) since we last committed memory, the in-memory
    // `newSettings` was constructed against a stale base. Blindly
    // writing it back would silently revert whatever fields the external
    // writer changed. Adopt the disk version into memory and notify the
    // user to redo their edit. We intentionally don't auto-merge: most
    // call sites pass a full settings object via `{ ...this.settings,
    // foo: 'x' }` spreads, so we cannot tell which fields were the
    // user's actual intent and which are stale snapshot.
    const conflict = await this.detectExternalSettingsConflict()
    if (conflict) {
      await this.applyExternalSettingsUpdate(conflict.raw, conflict.meta)
      new Notice(
        'YOLO: settings were updated externally (sync, another device, or manual edit). Your last change was not saved — please redo it.',
      )
      return
    }

    const previousSettings = this.settings
    const yoloBaseDirChanged =
      previousSettings?.yolo?.baseDir !== normalizedSettings.yolo.baseDir

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
    await this.persistPluginDirSettings(normalizedSettings)
    setLLMDebugCaptureEnabled(
      this.settings.debug?.captureRawRequestDebug ?? false,
    )

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

  addSettingsChangeListener(listener: (newSettings: YoloSettings) => void) {
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

  resolveRibbonPlacement(): ChatLeafPlacement {
    const action = this.settings.chatOptions.ribbonClickAction ?? 'sidebar'
    if (action === 'last') {
      const last = this.settings.chatOptions.lastChatPlacement
      return last ?? 'sidebar'
    }
    return action
  }

  async openCurrentOrSidebarNewChat() {
    await this.getChatViewNavigator().openCurrentOrSidebarNewChat()
  }

  async addSelectionToChat(editor: Editor, view: MarkdownView) {
    const editorView = this.getEditorView(editor)
    const data = getMentionableBlockData(editor, view)
    if (!data) return

    const highlightId = crypto.randomUUID()
    if (editorView) {
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

    await this.getChatViewNavigator().addSelectionBlockToChat({
      ...data,
      source: 'selection-pinned',
      highlightId,
    })
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
}
