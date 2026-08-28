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
  addIcon,
  getLanguage,
  normalizePath,
  setIcon,
} from 'obsidian'

import { ChatView } from './ChatView'
import {
  type ActionToastController,
  type ActionToastOptions,
  mountActionToast,
} from './components/ActionToast'
import { MarkdownInsertionTargetTracker } from './components/chat-view/markdownInsertionTarget'
import { ConfirmModal } from './components/modals/ConfirmModal'
import { mountUpdateToast } from './components/UpdateToast'
import { CHAT_VIEW_TYPE } from './constants'
import { BAKED_PLUGIN_VERSION } from './constants/bakedVersion'
import type { YoloAgentApi, YoloAgentApiService } from './core/agent/agent-api'
import type {
  AgentConversationRunSummary,
  AgentService,
} from './core/agent/service'
import {
  clearAllChatGPTOAuthServices,
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
  BackgroundActivity,
  BackgroundActivityAction,
  BackgroundActivityRegistry,
} from './core/background/backgroundActivityRegistry'
import { backgroundExecutionController } from './core/background/backgroundExecutionController'
import { buildBackgroundStatusModel } from './core/background/backgroundStatusModel'
import { noteWebviewLeafFocus } from './core/browser/activeWebviewProbe'
import { WebviewSelectionBridge } from './core/browser/webviewSelectionBridge'
import type {
  CliConversationRunSummary,
  CliRuntimeCoordinator,
  CliRuntimeScope,
} from './core/cli-runtime/coordinator'
import { getCliRuntimeDescriptor } from './core/cli-runtime/registry'
import type { CliActiveRunState } from './core/cli-runtime/types'
import { CLI_RUNTIME_IDS } from './core/cli-runtime/types'
import { DistributionFeedClient } from './core/distribution/distributionFeedClient'
import { localeStore } from './core/i18n/localeStore'
import {
  bindClaudeSdkHost,
  unbindClaudeSdkHost,
} from './core/llm/claude-sdk/host'
import {
  isLLMDebugCaptureEnabled,
  setLLMDebugCaptureEnabled,
} from './core/llm/debugCapture'
import { clearRequestTransportMemory } from './core/llm/requestTransport'
import type {
  LocalMcpServerRuntime,
  LocalMcpServerState,
} from './core/mcp/localMcpServerConfig'
import type { McpCoordinator } from './core/mcp/mcpCoordinator'
import type { McpManager } from './core/mcp/mcpManager'
import {
  CoreModuleAgentCapabilityProvider,
  CoreModuleChatCapabilityProvider,
  CoreModuleHostCapabilityProvider,
  DomBlobModuleScriptExecutor,
  IndexedDbDataAdapter,
  ManagedModulePathsCapabilityProvider,
  ModuleArtifactArrivalGrace,
  ModuleAssetsCapabilityProvider,
  ModuleChatModeRegistry,
  ModuleConfigCapabilityProvider,
  ModuleDeviceStateStore,
  ModuleIntentStore,
  ModuleLoader,
  ModulePrivateStorageCapabilityProvider,
  ModuleRuntime,
  ModuleRuntimeReservation,
  type ModuleService,
  ModuleSettingsCapabilityProvider,
  ModuleSettingsContributionRegistry,
  ModuleStore,
  OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS,
  ObsidianModuleContributionRegistrar,
  ObsidianModuleUiCapabilityProvider,
  ObsidianModuleVaultCapabilityProvider,
  createDevModuleCatalogOverlay,
  createModuleSkillMaterializer,
  createObsidianModuleConfigBackendFactory,
  createObsidianModuleConfigCreateIfAbsent,
  createObsidianModuleIntentBackend,
  createObsidianModuleSkillProjectionVault,
  createOfficialModuleArtifactDownloader,
  createOfficialModuleCatalogSource,
  createOfficialModuleCompatibilityProvider,
  createProductionModuleServices,
  handoffLearningLegacySettings,
  managedModuleDataNamespace,
  migrateLearningLegacyInstallIntent,
  parseModuleArtifactManifest,
  resolveModuleSkillVaultPath,
  runExclusive as runManagedModuleDataExclusive,
  selectModuleManifestVariant,
} from './core/modules'
import { normalizeModuleCatalogLocale } from './core/modules/moduleCatalogPresentation'
import { AgentNotificationCoordinator } from './core/notifications/agentNotificationCoordinator'
import { NotificationService } from './core/notifications/notificationService'
import { migrateHiddenYoloBaseDir } from './core/paths/yoloBaseDirMigration'
import { relocateYoloBaseDir } from './core/paths/yoloBaseDirRelocation'
import {
  type YoloDataMeta,
  ensureUserDataRootDir,
  extractYoloDataMeta,
  readVaultDataJson,
  removeVaultDataJson,
  stampYoloDataMeta,
} from './core/paths/yoloManagedData'
import {
  getYoloBaseDir,
  getYoloJsonDbRootDir,
  getYoloModuleDir,
  getYoloModuleSkillsDir,
  getYoloModulesRootDir,
  hasHiddenYoloBaseDirSegment,
  resolveExternalYoloBaseDir,
} from './core/paths/yoloPaths'
import { setLocalEmbeddingModelManager } from './core/rag/local-embedding/access'
import { LocalEmbeddingModelManager } from './core/rag/local-embedding/manager'
import type { RagKnowledgeAccess } from './core/rag/ragAccess'
import { RagAutoUpdateService } from './core/rag/ragAutoUpdateService'
import { RagCoordinator } from './core/rag/ragCoordinator'
import {
  RagIndexService,
  RagIndexServiceSnapshot,
} from './core/rag/ragIndexService'
import {
  BAKED_RUNTIME_COMPONENT_REGISTRY,
  RuntimeComponentDeviceStateStore,
  RuntimeComponentInstaller,
  RuntimeComponentIntentStore,
  RuntimeComponentLoader,
  RuntimeComponentRuntime,
  RuntimeComponentService,
  RuntimeComponentStore,
  createRuntimeComponentDownloader,
  resolveRuntimeComponentArtifactSources,
  resolveRuntimeComponentAssetSources,
  setRuntimeComponentService,
} from './core/runtime-components'
import {
  configureModuleChatModeSkillSource,
  initializeLiteSkillRegistryService,
  migrateVaultSkillFrontmatter,
  prewarmLiteSkillRegistry,
  updateLiteSkillRegistrySettings,
} from './core/skills/liteSkills'
import type { ToolContext } from './core/tools/types'
import {
  type InstallationIncompleteDetail,
  type ReleaseFileName,
  checkInstallationIntegrityLayer1And2,
} from './core/update/installationIntegrity'
import {
  ModuleUpdateController,
  type ModuleUpdateOffer,
} from './core/update/moduleUpdateController'
import {
  type PluginUpdateState,
  applyRepairFiles,
  applyStagedUpdate,
  canSelfUpdate,
  downloadReleaseToStaging,
  downloadRepairFilesToStaging,
  getRepairStagingStatus,
  getStagingDir,
  getStagingStatus,
} from './core/update/pluginUpdater'
import {
  type ReleaseAssets,
  type UpdateCheckResult,
  buildReleaseAssets,
  checkForUpdate,
  normalizePluginVersion,
} from './core/update/updateChecker'
import type { DatabaseManager } from './database/DatabaseManager'
import { ChatManager } from './database/json/chat/ChatManager'
import { pruneImageCache } from './database/json/chat/imageCacheStore'
import { prunePdfTextCache } from './database/json/chat/pdfTextCacheStore'
import type {
  ReconcileResult,
  VectorManager,
} from './database/modules/vector/VectorManager'
import {
  ChatLeafPlacement,
  ChatLeafSessionManager,
} from './features/chat/chatLeafSessionManager'
import { ChatViewNavigator } from './features/chat/chatViewNavigator'
import { NewTabEmptyStateEnhancer } from './features/chat/newTabEmptyStateEnhancer'
import type { ContinuationModelOverride } from './features/editor/continuation/continuationController'
import { ContinuationController } from './features/editor/continuation/continuationController'
import { DiffReviewController } from './features/editor/diff-review/diffReviewController'
import {
  buildReviewPlanFromEdits,
  buildSnapshotReviewPlan,
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
  SelectionRewriteController,
  type StartSelectionLengthAdjustmentOptions,
  type StartSelectionRewriteOptions,
} from './features/editor/selection-rewrite/selectionRewriteController'
import { TabCompletionController } from './features/editor/tab-completion/tabCompletionController'
import { enablePdfScreenshotFeature } from './features/pdf-screenshot'
import { type Language, createTranslationFunction, loadLocale } from './i18n'
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
import { isUntitledConversationTitle } from './utils/chat/conversationTitle'
import { stableStringify } from './utils/json/stableStringify'
import { applyKnownMaxContextTokensToChatModels } from './utils/llm/model-capability-registry'
import { getMentionableBlockData } from './utils/obsidian'
import { ensureBufferByteLengthCompat } from './utils/runtime/ensureBufferByteLengthCompat'
import { YOLO_ICON_ID, YOLO_ICON_SVG } from './yoloIcon'

export type {
  YoloAgentApi,
  YoloAgentContext,
  YoloAgentEvent,
  YoloAgentRunRequest,
  YoloAgentRunResult,
} from './core/agent/agent-api'

export type { PluginUpdateState } from './core/update/pluginUpdater'

const STARTUP_GRACE_MS = 30 * 1000
const MODULE_PRIVATE_STORAGE_DIR = 'module-private'
const MODULE_DEVICE_LOCAL_VIRTUAL_ROOT = 'module-private-device-local'
const MODULE_DEVICE_STATE_ROOT = 'module-device-state-v2'
type TranslateFn = (keyPath: string, fallback?: string) => string
type BackgroundStatusPanelAction = BackgroundActivityAction

/**
 * A staged module update can only be installed from the update toast, so
 * downloading one while the notice is off would never be applied.
 */
function isModuleAutoDownloadEnabled(settings: YoloSettings): boolean {
  return (
    settings.pluginUpdateNoticeEnabled &&
    settings.pluginUpdateAutoDownloadEnabled
  )
}

export default class YoloPlugin extends Plugin {
  settings: YoloSettings
  settingsChangeListeners: ((newSettings: YoloSettings) => void)[] = []
  private deviceId: string | null = null
  private currentSettingsMeta: YoloDataMeta | null = null
  updateCheckResult: UpdateCheckResult | null = null
  private hasCheckedForUpdates = false
  private updateCheckListeners: (() => void)[] = []
  pluginUpdateState: PluginUpdateState = { status: 'idle' }
  private pluginUpdateListeners: (() => void)[] = []
  private pluginUpdateDownloadPromise: Promise<void> | null = null
  private updateToastCleanup: (() => void) | null = null
  private actionToastController: ActionToastController | null = null
  private readonly moduleSettingsContributions =
    new ModuleSettingsContributionRegistry()
  private readonly moduleChatModeRegistry = new ModuleChatModeRegistry()
  installationIncompleteDetail: InstallationIncompleteDetail | null = null
  private installationIncompleteBannerDismissed = false
  private installationIncompleteListeners: (() => void)[] = []
  private installationIntegrityCheckStarted = false
  mcpManager: McpManager | null = null
  dbManager: DatabaseManager | null = null
  private dbManagerInitPromise: Promise<DatabaseManager> | null = null
  private timeoutIds: ReturnType<typeof setTimeout>[] = [] // Use ReturnType instead of number
  private isContinuationInProgress = false
  private activeAbortControllers: Set<AbortController> = new Set()
  private tabCompletionController: TabCompletionController | null = null
  private inlineSuggestionController: InlineSuggestionController | null = null
  private diffReviewController: DiffReviewController | null = null
  private selectionRewriteController: SelectionRewriteController | null = null
  // Selection chat state
  private selectionChatController: SelectionChatController | null = null
  // Obsidian command IDs (un-namespaced) registered for selection-chat shortcuts.
  // Tracked so we can drop stale commands when the user edits the action list.
  private registeredSelectionChatCommandIds: string[] = []
  private selectionChatCommandsFingerprint: string | null = null
  private chatViewNavigator: ChatViewNavigator | null = null
  private chatLeafSessionManager: ChatLeafSessionManager | null = null
  private markdownInsertionTargetTracker: MarkdownInsertionTargetTracker | null =
    null
  private newTabEmptyStateEnhancer: NewTabEmptyStateEnhancer | null = null
  private ragAutoUpdateService: RagAutoUpdateService | null = null
  private ragCoordinator: RagCoordinator | null = null
  private ragIndexService: RagIndexService | null = null
  private mcpCoordinator: McpCoordinator | null = null
  private moduleService: ModuleService | null = null
  private runtimeComponentService: RuntimeComponentService | null = null
  private localEmbeddingModelManager: LocalEmbeddingModelManager | null = null
  private distributionFeedClient: DistributionFeedClient | null = null
  private moduleUpdateController: ModuleUpdateController | null = null
  private moduleRuntime: ModuleRuntime | null = null
  private moduleRuntimeReservation: ModuleRuntimeReservation | null = null
  private learningModuleSettingsHandoff: (() => Promise<void>) | null = null
  private learningLegacyInstallMigration: (() => Promise<void>) | null = null
  private rawLearningLegacySettings: unknown = undefined
  private learningModuleSettingsHandoffReady = false
  private readonly managedModulePathChangeListeners = new Set<() => void>()
  private localMcpServer: LocalMcpServerRuntime | null = null
  private localMcpSettingsUnsubscribe: (() => void) | null = null
  private liteSkillRegistryDispose: (() => void) | null = null
  private webviewSelectionBridge: WebviewSelectionBridge | null = null
  private continuationController: ContinuationController | null = null
  // Model list cache for provider model fetching
  private modelListCache: Map<string, { models: string[]; timestamp: number }> =
    new Map()
  // Quick Ask state
  private quickAskController: QuickAskController | null = null
  private cliRuntimeCoordinatorPromise: Promise<CliRuntimeCoordinator | null> | null =
    null
  private cliRuntimeCapabilityError: unknown = null
  private cliRunSummaryUnsubscribe: (() => void) | null = null
  private agentService: AgentService | null = null
  private agentServiceReady: Promise<AgentService> | null = null
  private agentApiService: YoloAgentApiService | null = null
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
  private isUnloaded = false
  private backgroundStatusPanelItems = new Map<
    string,
    {
      item: HTMLElement
      title: HTMLElement
      badge: HTMLElement
      detail: HTMLElement
      indicator: HTMLElement
      action?: BackgroundStatusPanelAction
    }
  >()

  private getPromptSourceSettingsFingerprint(
    settings: YoloSettings | undefined,
  ): string {
    if (!settings) {
      return ''
    }
    return stableStringify({
      systemPrompt: settings.systemPrompt ?? '',
      baseDir: normalizePath(settings.yolo?.baseDir ?? ''),
      disabledSkillIds: [...(settings.skills?.disabledSkillIds ?? [])]
        .map((id) => id.trim())
        .sort(),
      assistants: (settings.assistants ?? [])
        .map((assistant) => ({
          id: assistant.id,
          name: assistant.name,
          systemPrompt: assistant.systemPrompt ?? '',
          skillPreferences: assistant.skillPreferences ?? null,
          enableProjectInstructions:
            assistant.enableProjectInstructions ?? false,
          workspaceScope: assistant.workspaceScope ?? null,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    })
  }

  private markPromptSourceSettingsChange(
    previousSettings: YoloSettings | undefined,
    nextSettings: YoloSettings,
  ): void {
    if (
      this.getPromptSourceSettingsFingerprint(previousSettings) ===
      this.getPromptSourceSettingsFingerprint(nextSettings)
    ) {
      return
    }
    this.agentService?.getPromptSourceWatcher().markExternalChange()
  }

  getChatLeafSessionManager(): ChatLeafSessionManager {
    if (!this.chatLeafSessionManager) {
      this.chatLeafSessionManager = new ChatLeafSessionManager(this.app)
    }
    return this.chatLeafSessionManager
  }

  /**
   * Lazily enters the desktop-only CLI boundary. Keeping the promise here
   * gives every ChatView one shared coordinator without loading provider
   * runtime paths on mobile.
   */
  getCliRuntimeCoordinator(): Promise<CliRuntimeCoordinator | null> {
    if (!Platform.isDesktop || this.isUnloaded) {
      return Promise.resolve(null)
    }
    this.cliRuntimeCoordinatorPromise ??= this.initializeCliRuntimeCoordinator()
    return this.cliRuntimeCoordinatorPromise
  }

  async createCliRuntimeScope(): Promise<CliRuntimeScope | null> {
    const coordinator = await this.getCliRuntimeCoordinator()
    if (!coordinator || this.isUnloaded) return null
    try {
      return coordinator.createScope()
    } catch (error) {
      this.reportCliRuntimeCapabilityError(error)
      return null
    }
  }

  getCliRuntimeCapabilityError(): unknown {
    return this.cliRuntimeCapabilityError
  }

  private async initializeCliRuntimeCoordinator(): Promise<CliRuntimeCoordinator | null> {
    try {
      const { createDesktopCliRuntimeCoordinator } = await import(
        './core/cli-runtime/coordinator'
      )
      if (this.isUnloaded) return null

      const coordinator = await createDesktopCliRuntimeCoordinator({
        app: this.app,
        getSettings: () => this.settings,
      })
      if (this.isUnloaded) {
        await coordinator.dispose()
        return null
      }

      const unsubscribe = coordinator.subscribeToRunSummaries((summaries) => {
        if (this.isUnloaded) return
        this.syncCliBackgroundActivities(summaries)
      })
      this.cliRunSummaryUnsubscribe = () => {
        unsubscribe()
        if (this.isUnloaded) return
        this.syncCliBackgroundActivities(new Map())
      }

      return coordinator
    } catch (error) {
      if (!this.isUnloaded) {
        this.reportCliRuntimeCapabilityError(error)
      }
      return null
    }
  }

  private reportCliRuntimeCapabilityError(error: unknown): void {
    this.cliRuntimeCapabilityError = error
    console.error('[YOLO] CLI runtime capability is unavailable', error)
  }

  private disposeCliRuntimeCoordinator(): void {
    const coordinatorPromise = this.cliRuntimeCoordinatorPromise
    this.cliRuntimeCoordinatorPromise = null
    this.cliRunSummaryUnsubscribe?.()
    this.cliRunSummaryUnsubscribe = null
    if (!coordinatorPromise) return
    void coordinatorPromise
      .then((coordinator) => coordinator?.dispose())
      .catch((error: unknown) => {
        console.error('[YOLO] CLI runtime coordinator cleanup failed', error)
      })
  }

  getMarkdownInsertionTarget(): MarkdownView | null {
    return this.markdownInsertionTargetTracker?.getTarget() ?? null
  }

  private publishManagedModulePathChange(): void {
    for (const listener of this.managedModulePathChangeListeners) {
      try {
        listener()
      } catch (error) {
        console.error('[YOLO] Managed module path publication failed', error)
      }
    }
  }

  showActionToast(toast: ActionToastOptions): void {
    this.actionToastController?.show(toast)
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
    }
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
      })
    }
    return this.quickAskController
  }

  private getSelectionRewriteController(): SelectionRewriteController {
    if (!this.selectionRewriteController) {
      this.selectionRewriteController = new SelectionRewriteController({
        t: (key, fallback) => this.t(key, fallback),
        addAbortController: (controller) =>
          this.activeAbortControllers.add(controller),
        removeAbortController: (controller) =>
          this.activeAbortControllers.delete(controller),
      })
    }
    return this.selectionRewriteController
  }

  startSelectionRewrite(options: StartSelectionRewriteOptions): void {
    this.getSelectionRewriteController().start(options)
  }

  startSelectionLengthAdjustment(
    options: StartSelectionLengthAdjustmentOptions,
  ): void {
    this.getSelectionRewriteController().startLengthAdjustment(options)
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
      selectionScope?: QuickAskSelectionScope
      isRewriteEntry?: boolean
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
        addPdfQuoteToChat: async (selectedBlock) =>
          await this.getChatViewNavigator().addPdfQuoteToChat(selectedBlock),
        updatePdfQuoteMention: (highlightId, patch) => {
          this.getChatViewNavigator().updatePdfQuoteMention(highlightId, patch)
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
        runIndex: async (kbId, request) => {
          // Background auto-update never surfaces partial failures (product
          // decision: settings page shows them durably via the snapshot). The
          // reconcile result is intentionally discarded here.
          const indexService = this.getRagIndexService()
          const snapshot = indexService.getRunSnapshot(kbId)
          await indexService.run(
            kbId,
            {
              mode: 'sync',
              scope: request,
              trigger: 'auto',
              // RagAutoUpdateService owns the finite automatic retry policy.
              retryPolicy: 'none',
            },
            snapshot.trigger === 'auto' && snapshot.retryCount > 0
              ? 'automatic-retry'
              : 'new',
          )
        },
        getRetryCount: (kbId) =>
          this.getRagIndexService().getRunSnapshot(kbId).retryCount,
        markRetryScheduled: (kbId, input) =>
          this.getRagIndexService().markRetryScheduled(kbId, {
            mode: 'sync',
            retryAt: input.retryAt,
            retryCount: input.retryCount,
            failureMessage: input.failureMessage,
          }),
        clearRetryScheduled: (kbId) =>
          this.getRagIndexService().clearRetryScheduled(kbId),
      })
    }
    return this.ragAutoUpdateService
  }

  private getRagIndexService(): RagIndexService {
    if (!this.ragIndexService) {
      this.ragIndexService = new RagIndexService({
        app: this.app,
        getRagEngine: (kbId) => this.getRagCoordinator().getRagEngine(kbId),
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
        getDbManager: () => this.getDbManager(),
      })
    }
    return this.ragCoordinator
  }

  /** The single DI surface retrieval consumers (MCP `vault_search`, `bash
   * search`, `$db.search`, agent tool context) use to reach knowledge bases —
   * see `core/rag/ragAccess.ts`. Public because the Sparkle panel's
   * similar-notes list is a retrieval consumer too — it reaches knowledge
   * bases through the same surface rather than the coordinator directly. */
  getRagAccess(): RagKnowledgeAccess {
    const coordinator = this.getRagCoordinator()
    return {
      listKnowledgeBases: () => coordinator.listKnowledgeBases(),
      getRagEngine: (kbId) => coordinator.getRagEngine(kbId),
    }
  }

  private async getMcpCoordinator(): Promise<McpCoordinator> {
    if (!this.mcpCoordinator) {
      const agentService = await this.warmupAgentService()
      const { McpCoordinator } = await import('./core/mcp/mcpCoordinator')
      this.mcpCoordinator = new McpCoordinator({
        app: this.app,
        pluginId: this.manifest.id,
        getSettings: () => this.settings,
        openApplyReview: (state) => this.openApplyReview(state),
        registerSettingsListener: (
          listener: (settings: YoloSettings) => void,
        ) => this.addSettingsChangeListener(listener),
        ragAccess: this.getRagAccess(),
        promptSourceWatcher: agentService.getPromptSourceWatcher(),
        runSubagent: async (input) => {
          const { runSubagent } = await import('./core/agent/subagent/runner')
          return (runSubagent as NonNullable<ToolContext['runSubagent']>)(input)
        },
        moduleChatModeRegistry: this.moduleChatModeRegistry,
      })
    }
    return this.mcpCoordinator
  }

  private async initializeLocalMcpServer(): Promise<void> {
    if (!Platform.isDesktop || this.localMcpServer) return
    const { DesktopLocalMcpServer } = await import(
      './core/mcp/desktopLocalMcpServer'
    )
    const runtime = new DesktopLocalMcpServer({
      app: this.app,
      getSettings: () => this.settings,
      getAgentService: () => this.warmupAgentService(),
      getMcpManager: () => this.getMcpManager(),
      ragAccess: this.getRagAccess(),
      openConversation: (conversationId) =>
        this.openChatView({ initialConversationId: conversationId }),
    })
    this.localMcpServer = runtime
    this.localMcpSettingsUnsubscribe = this.addSettingsChangeListener(
      (settings) => {
        void runtime.updateSettings(settings)
      },
    )
    await runtime.initialize()
    await runtime.updateSettings(this.settings)
  }

  getLocalMcpServerState(): LocalMcpServerState {
    return (
      this.localMcpServer?.getState() ?? {
        status: 'stopped',
        url: '',
      }
    )
  }

  subscribeLocalMcpServerState(
    listener: (state: LocalMcpServerState) => void,
  ): () => void {
    if (!this.localMcpServer) {
      listener(this.getLocalMcpServerState())
      return () => undefined
    }
    return this.localMcpServer.subscribe(listener)
  }

  private startWebviewSelectionBridge(): void {
    this.webviewSelectionBridge?.destroy()
    this.webviewSelectionBridge = new WebviewSelectionBridge(this.app, {
      isEnabled: () =>
        this.settings.continuationOptions?.enableSelectionChat ?? true,
      onSelection: (selection) => {
        const targetLeaf = this.getChatLeafSessionManager().resolveTargetLeaf()
        if (targetLeaf?.view instanceof ChatView) {
          targetLeaf.view.syncWebSelectionToInput(selection)
        }
      },
      onClear: () => {
        const targetLeaf = this.getChatLeafSessionManager().resolveTargetLeaf()
        if (targetLeaf?.view instanceof ChatView) {
          targetLeaf.view.clearSelectionFromChat()
        }
      },
    })
    this.webviewSelectionBridge.start()
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
    this.checkAndHandleInstallationIntegrity()
  }

  private checkAndHandleInstallationIntegrity(): void {
    if (this.installationIntegrityCheckStarted) {
      return
    }
    this.installationIntegrityCheckStarted = true

    void (async () => {
      const detail = await checkInstallationIntegrityLayer1And2(
        this,
        BAKED_PLUGIN_VERSION || null,
      )

      if (!detail) {
        return
      }

      console.error(
        `[YOLO] Installation integrity issue: target=${detail.targetVersion}, ` +
          `suspects=${detail.suspectFiles.join(', ')}`,
      )
      this.installationIncompleteDetail = detail
      this.notifyInstallationIncompleteListeners()

      if (canSelfUpdate(this)) {
        void this.autoRepairInstallation()
      }
    })()
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

  /** Re-notify banner subscribers when chat opens (aligned with checkForUpdatesOnce). */
  refreshInstallationIncompleteBanner(): void {
    this.notifyInstallationIncompleteListeners()
  }

  private _tCache?: { language: Language; fn: TranslateFn }

  get t(): TranslateFn {
    const language = this.resolveObsidianLanguage()
    if (this._tCache?.language !== language) {
      this._tCache = {
        language,
        fn: createTranslationFunction(language),
      }
    }
    return this._tCache.fn
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

  async warmupAgentService(): Promise<AgentService> {
    if (!this.agentServiceReady) {
      this.agentServiceReady = (async () => {
        try {
          const { AgentService } = await import('./core/agent/service')
          const { YoloAgentApiService } = await import('./core/agent/agent-api')
          const { createAgentConversationPersistence } = await import(
            './core/agent/conversationPersistence'
          )
          if (this.isUnloaded) {
            throw new Error('[YOLO] Plugin unloaded during agent warmup')
          }
          const { persistConversationMessages } =
            createAgentConversationPersistence(this.app, () => this.settings)
          const service = new AgentService({
            getSettings: () => this.settings,
            persistConversationMessages,
          })
          const watcher = service.getPromptSourceWatcher()
          const h = watcher.buildVaultHandlers()
          this.registerEvent(this.app.vault.on('create', h.create))
          this.registerEvent(this.app.vault.on('modify', h.modify))
          this.registerEvent(this.app.vault.on('delete', h.delete))
          this.registerEvent(this.app.vault.on('rename', h.rename))
          service.startBackgroundTaskResultListener()
          this.agentService = service
          this.agentApiService = new YoloAgentApiService({
            app: this.app,
            getSettings: () => this.settings,
            getAgentService: () => this.getAgentService(),
            getMcpManager: () => this.getMcpManager(),
          })
          return service
        } catch (error) {
          this.agentServiceReady = null
          throw error
        }
      })()
    }
    return this.agentServiceReady
  }

  getAgentService(): AgentService {
    if (!this.agentService) {
      throw new Error(
        '[YOLO] Agent service is not ready yet; await plugin.warmupAgentService() first.',
      )
    }
    return this.agentService
  }

  getAgentApi(): YoloAgentApi {
    if (!this.agentApiService) {
      throw new Error(
        '[YOLO] Agent API is not ready yet; await plugin.warmupAgentService() first.',
      )
    }
    return this.agentApiService
  }

  get agent(): YoloAgentApi {
    return this.getAgentApi()
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
      this.t('statusBar.backgroundStatusPanelTitle', '活动与提醒'),
    )

    const panelList = document.createElement('div')
    panelList.className = 'yolo-background-activity-status-panel-list'

    const panelEmpty = document.createElement('div')
    panelEmpty.className = 'yolo-background-activity-status-panel-empty'
    panelEmpty.setText(
      this.t('statusBar.backgroundStatusPanelEmpty', '当前没有活动或提醒'),
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
        this.latestBackgroundActivities = new Map(activities)
        this.updateBackgroundStatusBar()
      })
    let isActive = true
    let unsubscribeAgentSummaries: (() => void) | null = null
    void this.warmupAgentService()
      .then((agentService) => {
        if (!isActive) {
          return
        }
        unsubscribeAgentSummaries = agentService.subscribeToRunSummaries(
          (summaries) => {
            this.syncAgentBackgroundActivities(summaries)
          },
        )
      })
      .catch((error: unknown) => {
        console.error('[YOLO] Agent service warmup failed:', error)
      })
    this.register(() => {
      isActive = false
      unsubscribeActivities()
      unsubscribeAgentSummaries?.()
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
        kind: summary.activity?.kind ?? 'agent',
        title:
          summary.activity?.title ??
          this.t(
            'statusBar.agentStatusFallbackConversationTitle',
            '运行中的对话',
          ),
        detail:
          summary.activity?.detail ??
          (summary.isWaitingApproval
            ? this.t('statusBar.agentStatusWaitingApproval', '待审批')
            : this.t('statusBar.agentStatusRunning', '运行中')),
        status: summary.isWaitingApproval ? 'waiting' : 'running',
        updatedAt: Date.now(),
        action: summary.activity?.kind.startsWith('module:')
          ? undefined
          : {
              type: 'open-conversation',
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

  private syncCliBackgroundActivities(
    summaries: Map<string, CliConversationRunSummary>,
  ): void {
    const registry = this.getBackgroundActivityRegistry()
    const nextActivityIds = new Set<string>()

    for (const summary of summaries.values()) {
      const id = `cli:${summary.conversationId}`
      nextActivityIds.add(id)
      registry.upsert({
        id,
        kind: 'cli',
        title: this.t(
          'statusBar.agentStatusFallbackConversationTitle',
          '运行中的对话',
        ),
        detail: this.resolveCliActivityDetail(summary.runState),
        cliRuntimeId: summary.runtimeId,
        status: summary.runState === 'running' ? 'running' : 'waiting',
        updatedAt: Date.now(),
        action: {
          type: 'open-conversation',
          conversationId: summary.conversationId,
        },
      })
    }

    for (const activityId of this.latestBackgroundActivities.keys()) {
      if (!activityId.startsWith('cli:')) {
        continue
      }
      if (nextActivityIds.has(activityId)) {
        continue
      }
      registry.remove(activityId)
    }
  }

  private resolveCliActivityDetail(runState: CliActiveRunState): string {
    if (runState === 'waiting_for_approval') {
      return this.t('statusBar.cliStatusWaitingApproval', '待审批')
    }
    if (runState === 'waiting_for_user') {
      return this.t('statusBar.cliStatusWaitingUser', '等待输入')
    }
    return this.t('statusBar.cliStatusRunning', '运行中')
  }

  private updateBackgroundStatusBar(): void {
    if (
      !this.backgroundStatusBarItem ||
      !this.backgroundStatusBarRing ||
      !this.backgroundStatusBarLabel
    ) {
      return
    }
    this.backgroundStatusPanelRenderVersion += 1

    const model = buildBackgroundStatusModel(
      this.latestBackgroundActivities.values(),
    )

    if (!model.visible) {
      this.clearBackgroundStatusPanelItems()
      this.closeBackgroundStatusPanel()
      this.backgroundStatusBarItem.hide()
      this.backgroundStatusBarLabel.setText('')
      this.backgroundStatusBarItem.removeAttribute('aria-label')
      this.backgroundStatusBarItem.removeAttribute('title')
      return
    }

    const label = this.buildBackgroundStatusBarLabel(model.activities)

    this.backgroundStatusBarLabel.setText(label)
    this.backgroundStatusBarItem.removeAttribute('title')
    this.backgroundStatusBarRing.empty()
    this.backgroundStatusBarRing.classList.remove(
      'is-running',
      'is-waiting',
      'is-failed',
      'is-reminder',
    )
    if (model.tone) {
      this.backgroundStatusBarRing.classList.add(`is-${model.tone}`)
    }
    if (model.tone === 'reminder') {
      const reminderIcon =
        model.activities.find((activity) => activity.status === 'reminder')
          ?.icon ?? 'bell'
      setIcon(this.backgroundStatusBarRing, reminderIcon)
    }
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
    const reminderActivities = activities.filter(
      (activity) => activity.status === 'reminder',
    )
    const agentActivities = runningActivities.filter(
      (activity) => activity.kind === 'agent' || activity.kind === 'cli',
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

    if (failedActivities.length === 0 && reminderActivities.length === 1) {
      const [reminder] = reminderActivities
      return reminder.summary || reminder.detail || reminder.title
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
    const model = buildBackgroundStatusModel(
      this.latestBackgroundActivities.values(),
    )
    const activities = model.activities

    if (!model.visible) {
      this.clearBackgroundStatusPanelItems()
      this.backgroundStatusPanelEmpty.hidden = false
      return false
    }

    let metadataList: { id: string; title?: string }[] = []
    if (
      activities.some(
        (activity) => activity.action?.type === 'open-conversation',
      )
    ) {
      try {
        const chatManager = new ChatManager(this.app, this.settings)
        metadataList = await chatManager.listChats()
      } catch (error) {
        console.error(
          '[YOLO] Failed to load chat titles for status panel:',
          error,
        )
      }
    }
    if (
      renderVersion !== this.backgroundStatusPanelRenderVersion ||
      !this.backgroundStatusPanelList ||
      !this.backgroundStatusPanelEmpty
    ) {
      if (!this.backgroundStatusPanelList || !this.backgroundStatusPanelEmpty) {
        return false
      }
      return this.isBackgroundStatusPanelOpen()
        ? true
        : this.renderBackgroundStatusPanel()
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
      itemRecord.action = activity.action

      if (itemRecord.title.getText() !== title) {
        itemRecord.title.setText(title)
      }
      if (itemRecord.title.getAttribute('title') !== title) {
        itemRecord.title.setAttribute('title', title)
      }
      this.renderBackgroundActivityBadge(itemRecord.badge, activity)
      if (itemRecord.detail.getText() !== detail) {
        itemRecord.detail.setText(detail)
      }
      itemRecord.detail.hidden = detail.length === 0
      itemRecord.indicator.classList.remove(
        'is-running',
        'is-waiting',
        'is-failed',
        'is-reminder',
      )
      itemRecord.indicator.empty()
      itemRecord.indicator.classList.add(`is-${activity.status}`)
      const indicatorIcon =
        activity.icon ?? (activity.status === 'reminder' ? 'bell' : undefined)
      if (indicatorIcon) setIcon(itemRecord.indicator, indicatorIcon)

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
    action?: BackgroundStatusPanelAction,
  ): {
    item: HTMLElement
    title: HTMLElement
    badge: HTMLElement
    detail: HTMLElement
    indicator: HTMLElement
    action?: BackgroundStatusPanelAction
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
    const titleRow = copy.createDiv({
      cls: 'yolo-background-activity-status-panel-item-title-row',
    })
    const title = titleRow.createDiv({
      cls: 'yolo-background-activity-status-panel-item-title',
    })
    const badge = titleRow.createSpan({
      cls: 'yolo-runtime-badge',
    })
    badge.hidden = true
    const detail = copy.createDiv({
      cls: 'yolo-background-activity-status-panel-item-detail',
    })
    const indicator = row.createDiv({
      cls: 'yolo-background-activity-status-panel-item-indicator',
    })
    const record: {
      item: HTMLElement
      title: HTMLElement
      badge: HTMLElement
      detail: HTMLElement
      indicator: HTMLElement
      action?: BackgroundStatusPanelAction
    } = {
      item,
      title,
      badge,
      detail,
      indicator,
      action,
    }

    const openAction = () => {
      this.closeBackgroundStatusPanel()
      const currentAction = record.action
      if (!currentAction) return
      if (currentAction.type === 'callback') {
        currentAction.run()
        return
      }
      if (currentAction.type === 'open-conversation') {
        void this.openChatView({
          placement: 'split',
          initialConversationId: currentAction.conversationId,
          forceNewLeaf: true,
        })
        return
      }
      if (currentAction.type === 'open-knowledge-settings') {
        this.openKnowledgeSettings()
        return
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
      activity.action?.type === 'open-conversation' &&
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

  private renderBackgroundActivityBadge(
    badge: HTMLElement,
    activity: BackgroundActivity,
  ): void {
    const runtimeId = activity.cliRuntimeId
    badge.classList.remove(
      ...CLI_RUNTIME_IDS.map((id) => `yolo-runtime-badge--${id}`),
    )
    if (!runtimeId) {
      badge.hidden = true
      badge.setText('')
      badge.removeAttribute('data-runtime-id')
      badge.removeAttribute('aria-label')
      badge.removeAttribute('title')
      return
    }

    const descriptor = getCliRuntimeDescriptor(runtimeId)
    const fullLabel = this.t(
      descriptor.labelKey,
      runtimeId === 'claude-code' ? 'Claude Code' : 'Codex',
    )
    badge.classList.add(`yolo-runtime-badge--${runtimeId}`)
    badge.setText(
      descriptor.shortLabelKey
        ? this.t(descriptor.shortLabelKey, 'CC')
        : fullLabel,
    )
    badge.setAttribute('data-runtime-id', runtimeId)
    badge.setAttribute('aria-label', fullLabel)
    badge.setAttribute('title', fullLabel)
    badge.hidden = false
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
        setTabCompletionDisplay: (view, payload) =>
          inlineSuggestionController.setTabCompletionDisplay(view, payload),
        setInlineSuggestionGhost: (view, payload) =>
          inlineSuggestionController.setInlineSuggestionGhost(view, payload),
        showTabLoadingDots: (view, from) =>
          inlineSuggestionController.showTabLoadingDots(view, from),
        hideTabLoadingDots: (view) =>
          inlineSuggestionController.hideTabLoadingDots(view),
        getSwitchSuggestionHint: () =>
          this.t('common.switchSuggestion', '↑↓ 切换建议'),
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
    //
    // 这里必须和 overlay 构造时的取法一致，否则预检说「有改动」而 overlay 算出
    // 空计划（或反过来）。`fs_edit` 在打开评审前不写文件，所以此刻文件内容就是
    // `originalContent`，正是 overlay 用 `reviewEdits` 的前提条件。走这一支还
    // 顺带避开了一次全量 diff：`fs_edit` 每次走审批都会到这里，而 vscode-diff
    // 的行对齐在大文件上不接受 timeout（见 editSummary.ts 的
    // LINE_STATS_MAX_LINES），只为判断「有没有改动」就可能冻住主线程十几秒。
    const exactPlan =
      state.viewMode !== 'applied-review' && state.reviewEdits
        ? buildReviewPlanFromEdits(state.originalContent, state.reviewEdits)
        : null
    const reviewSuggestions = (
      exactPlan ??
      buildSnapshotReviewPlan(state.originalContent, state.newContent)
    ).suggestions
    if (reviewSuggestions.length === 0) {
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

  private getContinuationController(): ContinuationController {
    if (!this.continuationController) {
      this.continuationController = new ContinuationController({
        app: this.app,
        getSettings: () => this.settings,
        setSettings: (newSettings) => this.setSettings(newSettings),
        t: (key, fallback) => this.t(key, fallback),
        getActiveConversationOverrides: () =>
          this.getActiveConversationOverrides(),
        resolveContinuationParams: (overrides) =>
          this.resolveContinuationParams(overrides),
        getEditorView: (editor) => this.getEditorView(editor),
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
      })
    }
    return this.continuationController
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

  async onload() {
    this.isUnloaded = false
    this.cliRuntimeCapabilityError = null
    bindClaudeSdkHost(this.app)
    this.actionToastController = mountActionToast()
    this.initializeModuleSystem()
    this.initializeRuntimeComponentSystem()
    this.initializeLocalEmbedding()
    if (process.env.NODE_ENV === 'development') {
      this.addCommand({
        id: 'dev-activate-host-api-conformance-module',
        name: '[Development] Activate host API conformance module',
        callback: () => {
          void this.activateLocalConformanceModule()
        },
      })
    }
    ensureBufferByteLengthCompat()
    clearRequestTransportMemory()
    addIcon(YOLO_ICON_ID, YOLO_ICON_SVG)

    await this.loadSettings()
    this.liteSkillRegistryDispose = initializeLiteSkillRegistryService({
      app: this.app,
      settings: this.settings,
    })
    this.addSettingsChangeListener((settings) => {
      updateLiteSkillRegistrySettings(this.app, settings)
    })
    let moduleAutoDownloadEnabled = isModuleAutoDownloadEnabled(this.settings)
    this.addSettingsChangeListener((settings) => {
      const next = isModuleAutoDownloadEnabled(settings)
      if (next && !moduleAutoDownloadEnabled) {
        void this.moduleUpdateController?.refresh()
      }
      moduleAutoDownloadEnabled = next
    })
    await loadLocale(this.resolveObsidianLanguage())
    this._tCache = undefined
    await this.migrateLegacyVaultMirrorIfNeeded()
    await this.migrateHiddenYoloBaseDirIfNeeded()
    try {
      await this.learningModuleSettingsHandoff?.()
    } catch (error) {
      console.error('[YOLO] Learning module settings handoff failed', error)
    }
    try {
      await this.learningLegacyInstallMigration?.()
    } catch (error) {
      console.error('[YOLO] Learning legacy install migration failed', error)
    }
    try {
      // Must complete before `activateModules()`: the Learning module reads
      // and writes `learning-srs`/`anki-import-journals` directly under the
      // visible `data/` root (see `modules/learning/src/host/srsStorage.ts`)
      // and has no migration logic of its own for the hidden-root layout.
      await ensureUserDataRootDir(this.app, this.settings)
    } catch (error) {
      console.error('[YOLO] User data root migration failed', error)
    }
    this.warnIfInstallationIncomplete()
    this.activateModules()
    this.syncOAuthRuntimesFromSettings()
    await this.initializeLocalMcpServer().catch((error) => {
      console.error('[YOLO] Failed to initialize local MCP server', error)
    })

    // Prune stale image cache entries (>30 days) on startup
    void pruneImageCache(this.app, 30, this.settings)
    void prunePdfTextCache(this.app, 30, this.settings)
    await this.getRagIndexService().initialize()
    // One-time, idempotent migration of legacy skill frontmatter. Skill files
    // themselves remain at their user-chosen paths.
    this.app.workspace.onLayoutReady(() => {
      void migrateVaultSkillFrontmatter(this.app, this.settings)
        .catch((error) => {
          console.error(
            '[YOLO] Vault skill frontmatter migration failed',
            error,
          )
        })
        .finally(() => {
          prewarmLiteSkillRegistry(this.app, this.settings)
        })
    })
    this.app.workspace.onLayoutReady(() => {
      void this.runtimeComponentService?.start().catch((error) => {
        console.error('[YOLO] Runtime component startup failed', error)
      })
    })
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings?.ragOptions?.enabled) return
      const hasValidEmbeddingModel =
        !!this.settings?.embeddingModelId &&
        this.settings.embeddingModels.some(
          (m) => m.id === this.settings.embeddingModelId,
        )
      if (!hasValidEmbeddingModel) return
      const indexService = this.getRagIndexService()
      for (const kb of this.settings.knowledgeBases) {
        const snapshot = indexService.getRunSnapshot(kb.id)
        if (
          snapshot.status !== 'retry_scheduled' ||
          snapshot.retryPolicy !== 'transient'
        ) {
          continue
        }
        if (
          this.settings.ragOptions.autoUpdateEnabled &&
          snapshot.trigger === 'auto'
        ) {
          this.getRagAutoUpdateService().restoreRetryScheduled(
            kb.id,
            snapshot.retryAt,
            STARTUP_GRACE_MS,
          )
        } else if (snapshot.trigger === 'manual') {
          indexService.restoreRetryScheduledRun(kb.id, STARTUP_GRACE_MS)
        }
      }
    })

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this))
    this.startWebviewSelectionBridge()

    this.newTabEmptyStateEnhancer = new NewTabEmptyStateEnhancer(this)
    this.newTabEmptyStateEnhancer.enable()

    enablePdfScreenshotFeature(this)

    this.registerEditorExtension(selectionHighlightController.createExtension())
    this.registerEditorExtension(
      this.getSelectionRewriteController().createExtension(),
    )
    this.registerEditorExtension(this.createQuickAskTriggerExtension())
    this.registerEditorExtension(
      this.getInlineSuggestionController().createExtension(),
    )
    this.registerEditorExtension(
      this.getTabCompletionController().createTriggerExtension(),
    )

    // This creates an icon in the left ribbon.
    this.addRibbonIcon(YOLO_ICON_ID, 'YOLO Chat', () => {
      void this.openChatView({ placement: this.resolveRibbonPlacement() })
    })

    this.setupBackgroundActivityStatusBar()
    this.updateToastCleanup = mountUpdateToast(this)
    // The toast is anchored to the window (not a chat view), so trigger the
    // check at load time rather than waiting for a chat view to open.
    this.checkForUpdatesOnce()
    let shouldStartAgentNotifications = true
    void this.warmupAgentService()
      .then(() => {
        if (shouldStartAgentNotifications) {
          this.getAgentNotificationCoordinator().start()
        }
      })
      .catch((error: unknown) => {
        console.error('[YOLO] Agent service warmup failed:', error)
      })
    this.register(() => {
      shouldStartAgentNotifications = false
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

    // issue #567 Step 2：只在活动叶子是聊天视图时可用，让命令面板/快捷键/
    // Commander 能达到聊天内容区的历史弹层入口（该入口本身仍锚定在
    // ChatHeader 的 History 按钮上，命令只是多一条打开路径）。
    this.addCommand({
      id: 'open-chat-history',
      name: this.t('commands.openChatHistory'),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ChatView)
        if (!view) {
          return false
        }
        if (!checking) {
          view.openChatHistory()
        }
        return true
      },
    })

    // issue #567 Step 2：同上，导出仅在当前会话已持久化且活动运行时支持
    // vault 导出时可用——见 ChatView.canExportCurrentConversation。
    this.addCommand({
      id: 'export-current-conversation-to-vault',
      name: this.t('commands.exportCurrentConversationToVault'),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(ChatView)
        if (!view || !view.canExportCurrentConversation()) {
          return false
        }
        if (!checking) {
          view.exportCurrentConversation()
        }
        return true
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
      id: 'trigger-quick-ask-continue',
      name: this.t('commands.triggerQuickAskContinue'),
      editorCallback: (editor: Editor) => {
        const cmView = this.getEditorView(editor)
        if (!cmView) return
        this.showQuickAskWithOptions(editor, cmView, {
          initialMode: 'continue',
        })
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
    this.registerDomEvent(window, 'online', () => {
      this.getRagAutoUpdateService().onOnline()
      this.ragIndexService?.onOnline()
      void this.runtimeComponentService?.onOnline().catch((error) => {
        console.error('[YOLO] Failed to resume runtime component retry', error)
      })
    })

    this.addCommand({
      id: 'rebuild-vault-index',
      name: this.t('commands.rebuildVaultIndex'),
      callback: async () => {
        const knowledgeBases = this.settings.knowledgeBases
        if (knowledgeBases.length === 0) return
        const notice = new Notice(this.t('notices.rebuildingIndex'), 0)
        try {
          const indexService = this.getRagIndexService()
          const results = await Promise.all(
            knowledgeBases.map((kb) =>
              indexService.run(kb.id, {
                mode: 'rebuild',
                scope: { kind: 'all' },
                trigger: 'manual',
                retryPolicy: 'transient',
                onProgress: (progress) => {
                  notice.setMessage(
                    `${kb.name}: ${progress.completedFiles ?? 0} / ${progress.totalFiles} (chunks: ${progress.completedChunks})${
                      progress.waitingForRateLimit
                        ? '\n(waiting for rate limit to reset)'
                        : ''
                    }`,
                  )
                },
              }),
            ),
          )
          const skipped = results.reduce(
            (sum, r) => sum + r.permanentFailedPaths.length,
            0,
          )
          notice.setMessage(
            skipped > 0
              ? this.t(
                  'notices.indexedWithSkipped',
                  '索引完成，{{count}} 个文件无法索引',
                ).replace('{{count}}', String(skipped))
              : this.t('notices.rebuildComplete'),
          )
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
        const knowledgeBases = this.settings.knowledgeBases
        if (knowledgeBases.length === 0) return
        const notice = new Notice(this.t('notices.updatingIndex'), 0)
        try {
          const indexService = this.getRagIndexService()
          const results = await Promise.all(
            knowledgeBases.map((kb) =>
              indexService.run(kb.id, {
                mode: 'sync',
                scope: { kind: 'all' },
                trigger: 'manual',
                retryPolicy: 'none',
                onProgress: (progress) => {
                  notice.setMessage(
                    `${kb.name}: ${progress.completedFiles ?? 0} / ${progress.totalFiles} (chunks: ${progress.completedChunks})${
                      progress.waitingForRateLimit
                        ? '\n(waiting for rate limit to reset)'
                        : ''
                    }`,
                  )
                },
              }),
            ),
          )
          const skipped = results.reduce(
            (sum, r) => sum + r.permanentFailedPaths.length,
            0,
          )
          notice.setMessage(
            skipped > 0
              ? this.t(
                  'notices.indexedWithSkipped',
                  '索引完成，{{count}} 个文件无法索引',
                ).replace('{{count}}', String(skipped))
              : this.t('notices.indexUpdated'),
          )
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

    this.addCommand({
      id: 'export-settings',
      name: this.t('commands.exportSettings', '导出插件配置'),
      callback: async () => {
        try {
          const { ExportConfigModal } = await import(
            './features/config-transfer/components/ExportConfigModal'
          )
          new ExportConfigModal(this.app, this).open()
        } catch (error) {
          console.error('[YOLO] Failed to load ExportConfigModal:', error)
          new Notice('Failed to open export dialog')
        }
      },
    })

    this.addCommand({
      id: 'import-settings',
      name: this.t('commands.importSettings', '导入插件配置'),
      callback: async () => {
        try {
          const { ImportConfigModal } = await import(
            './features/config-transfer/components/ImportConfigModal'
          )
          new ImportConfigModal(this.app, this).open()
        } catch (error) {
          console.error('[YOLO] Failed to load ImportConfigModal:', error)
          new Notice('Failed to open import dialog')
        }
      },
    })

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new YoloSettingTab(this.app, this))

    // removed templates JSON migration

    this.markdownInsertionTargetTracker = new MarkdownInsertionTargetTracker(
      this.app.workspace,
    )
    this.markdownInsertionTargetTracker.captureCurrentLeaf()

    // Handle tab completion trigger
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        try {
          this.markdownInsertionTargetTracker?.trackActiveLeaf(leaf)
          if (leaf?.view instanceof ChatView) {
            this.getChatLeafSessionManager().touchLeafActive(leaf)
          }
          noteWebviewLeafFocus(this.app, leaf)
          this.webviewSelectionBridge?.noteWorkspaceChange()
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
    })
  }

  onunload() {
    this.isUnloaded = true
    clearAllChatGPTOAuthServices()
    unbindClaudeSdkHost()
    this.disposeCliRuntimeCoordinator()
    this.liteSkillRegistryDispose?.()
    this.liteSkillRegistryDispose = null
    configureModuleChatModeSkillSource(null)
    this.moduleUpdateController?.dispose()
    this.moduleUpdateController = null
    this.moduleService?.dispose()
    this.moduleService = null

    // RagEngine cleanup — must run before `runtimeComponentService.stop()`
    // below so the local embedding session's `embedding-engine` lease is
    // released before that component is marked quiescing.
    this.ragIndexService?.cleanup()
    this.ragIndexService = null
    this.ragCoordinator?.cleanup()
    this.ragCoordinator = null

    setRuntimeComponentService(null)
    this.runtimeComponentService?.stop()
    this.runtimeComponentService = null
    void this.localEmbeddingModelManager?.dispose()
    setLocalEmbeddingModelManager(null)
    this.localEmbeddingModelManager = null
    this.distributionFeedClient = null
    this.learningModuleSettingsHandoff = null
    this.learningLegacyInstallMigration = null
    this.rawLearningLegacySettings = undefined
    this.learningModuleSettingsHandoffReady = false
    this.managedModulePathChangeListeners.clear()
    this.moduleRuntimeReservation?.dispose()
    this.moduleRuntimeReservation = null
    this.moduleRuntime?.dispose()
    this.moduleRuntime = null
    this.updateToastCleanup?.()
    this.updateToastCleanup = null
    this.actionToastController?.destroy()
    this.actionToastController = null

    // Selection chat cleanup
    this.webviewSelectionBridge?.destroy()
    this.webviewSelectionBridge = null
    this.selectionChatController?.destroy()
    this.selectionChatController = null
    this.chatViewNavigator = null
    this.markdownInsertionTargetTracker = null
    this.newTabEmptyStateEnhancer = null
    this.inlineSuggestionController?.clearInlineSuggestion()
    this.inlineSuggestionController?.destroy()
    this.inlineSuggestionController = null
    this.diffReviewController?.destroy()
    this.diffReviewController = null
    this.selectionRewriteController?.destroy()
    this.selectionRewriteController = null
    this.continuationController = null

    // clear all timers
    this.timeoutIds.forEach((id) => {
      clearTimeout(id)
    })
    this.timeoutIds = []

    // Promise cleanup
    this.dbManagerInitPromise = null

    // DatabaseManager cleanup
    if (this.dbManager) {
      void this.dbManager.cleanup()
    }
    this.dbManager = null

    // McpManager cleanup
    this.localMcpSettingsUnsubscribe?.()
    this.localMcpSettingsUnsubscribe = null
    void this.localMcpServer?.close()
    this.localMcpServer = null
    this.mcpCoordinator?.cleanup()
    this.mcpCoordinator = null
    this.mcpManager = null
    this.ragAutoUpdateService?.cleanup()
    this.ragAutoUpdateService = null
    this.agentService?.stopBackgroundTaskResultListener()
    this.agentService?.abortAll()
    this.agentService?.flushAllConversationPersistence()
    this.agentService = null
    this.agentServiceReady = null
    this.agentApiService = null
    void import('./core/agent/bash/index').then(({ killAllBashSessions }) =>
      killAllBashSessions(),
    )
    void import('./core/agent/subagent/runner').then(
      ({ abortAllSubagentTasks }) => abortAllSubagentTasks(),
    )
    backgroundExecutionController.dispose()
    // Ensure all in-flight requests are aborted on unload
    this.cancelAllAiTasks()
    this.clearTabCompletionTimer()
    this.cancelTabCompletionRequest()
    this.clearInlineSuggestion()
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
    this.rawLearningLegacySettings = sourceRaw?.learningOptions
    const sourceMeta = pluginExtract?.meta ?? null

    const parsedSettings = parseYoloSettings(sourceRaw)
    const { ensureDefaultAssistantInSettings } = await import(
      './core/agent/default-assistant'
    )
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

  /** Migrate old hidden roots before any service can open files beneath them. */
  private async migrateHiddenYoloBaseDirIfNeeded(): Promise<void> {
    const previousSettings = this.settings
    let result
    try {
      result = await migrateHiddenYoloBaseDir({
        app: this.app,
        settings: previousSettings,
        persistTargetBaseDir: async (baseDir) => {
          const nextSettings: YoloSettings = {
            ...previousSettings,
            yolo: { ...previousSettings.yolo, baseDir },
          }
          await this.persistPluginDirSettings(nextSettings)
        },
      })
    } catch (error) {
      console.error('[YOLO] Hidden YOLO root migration crashed', error)
      new Notice(
        this.t(
          'settings.agent.yoloBaseDirMigrationFailed',
          'YOLO root could not be migrated. Your existing setting was kept.',
        ),
      )
      return
    }

    if (result.status === 'not-needed') return
    if (result.status === 'manual-repair') {
      new Notice(
        this.t(
          'settings.agent.yoloBaseDirMigrationManualRepair',
          'YOLO root {source} is hidden but cannot be migrated safely. Choose a visible YOLO root and move its YOLO files manually.',
        ).replace('{source}', result.source),
        0,
      )
      return
    }
    if (result.status === 'migrated' || result.status === 'source-missing') {
      this.settings = {
        ...previousSettings,
        yolo: { ...previousSettings.yolo, baseDir: result.target },
      }
      new Notice(
        this.t(
          'settings.agent.yoloBaseDirMigrated',
          'YOLO root now uses {target} so Obsidian can index it.',
        ).replace('{target}', result.target),
      )
      return
    }
    if (result.status === 'target-exists') {
      new Notice(
        this.t(
          'settings.agent.yoloBaseDirMigrationConflict',
          'YOLO root was not moved because {target} already exists. Your existing setting was kept.',
        ).replace('{target}', result.target),
      )
      return
    }

    if (result.status === 'failed') {
      console.error('[YOLO] Failed to migrate hidden YOLO root', result.error)
      if (result.rollbackFailed) {
        new Notice(
          this.t(
            'settings.agent.yoloBaseDirMigrationRollbackFailed',
            'YOLO moved from {source} to {target}, but its setting could not be updated and the move could not be rolled back. Move the folder back to {source} manually before continuing.',
          )
            .split('{source}')
            .join(result.source)
            .split('{target}')
            .join(result.target),
          0,
        )
        return
      }
      new Notice(
        this.t(
          'settings.agent.yoloBaseDirMigrationFailed',
          'YOLO root could not be migrated. Your existing setting was kept.',
        ),
      )
    }
  }

  private showYoloRootRelocationConflict(target: string): void {
    new ConfirmModal(this.app, {
      title: this.t(
        'settings.agent.yoloBaseDirConflictTitle',
        'YOLO root was not moved',
      ),
      message: this.t(
        'settings.agent.yoloBaseDirConflictMessage',
        '{target} already exists and contains files. Nothing was moved to avoid overwriting or merging data. Choose an empty or nonexistent folder.',
      ).replace('{target}', target),
      ctaText: this.t('common.confirm', 'OK'),
      showCancel: false,
      onConfirm: () => undefined,
    }).open()
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
    const { ensureDefaultAssistantInSettings } = await import(
      './core/agent/default-assistant'
    )
    const settingsWithDefaultAssistant =
      ensureDefaultAssistantInSettings(parsedSettings)
    const { chatModels, changed } = applyKnownMaxContextTokensToChatModels(
      settingsWithDefaultAssistant.chatModels,
    )
    let normalizedSettings = changed
      ? { ...settingsWithDefaultAssistant, chatModels }
      : settingsWithDefaultAssistant

    const previousSettings = this.settings
    const externalBaseDir = resolveExternalYoloBaseDir(
      previousSettings.yolo.baseDir,
      normalizedSettings.yolo.baseDir,
    )
    if (externalBaseDir !== normalizedSettings.yolo.baseDir) {
      normalizedSettings = {
        ...normalizedSettings,
        yolo: { ...normalizedSettings.yolo, baseDir: externalBaseDir },
      }
      new Notice(this.t('settings.agent.yoloBaseDirHiddenPath'))
    }
    const baseDirChanged =
      previousSettings?.yolo?.baseDir !== normalizedSettings.yolo.baseDir

    if (baseDirChanged) {
      await runManagedModuleDataExclusive(
        this.app.vault,
        managedModuleDataNamespace('learning', 'managed-data'),
        async () => {
          this.settings = normalizedSettings
          this.publishManagedModulePathChange()
        },
      )
    } else {
      this.settings = normalizedSettings
    }
    this.currentSettingsMeta = incomingMeta
    this.markPromptSourceSettingsChange(previousSettings, normalizedSettings)

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

  async setSettings(newSettings: YoloSettings): Promise<boolean> {
    const { ensureDefaultAssistantInSettings } = await import(
      './core/agent/default-assistant'
    )
    const normalizedSettings = ensureDefaultAssistantInSettings(
      normalizeYoloSettingsReferences(newSettings),
    )
    const validationResult = yoloSettingsSchema.safeParse(normalizedSettings)

    if (!validationResult.success) {
      new Notice(`Invalid settings:
${validationResult.error.issues.map((v) => v.message).join('\n')}`)
      return false
    }

    const previousBaseDir = this.settings?.yolo?.baseDir
    const nextBaseDir = normalizedSettings.yolo.baseDir
    if (
      nextBaseDir !== previousBaseDir &&
      hasHiddenYoloBaseDirSegment(nextBaseDir)
    ) {
      new Notice(
        this.t(
          'settings.agent.yoloBaseDirHiddenPath',
          'YOLO root cannot contain a folder name starting with a dot because Obsidian does not index hidden folders.',
        ),
      )
      return false
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
      return false
    }

    const previousSettings = this.settings
    const sourceBaseDir = getYoloBaseDir(previousSettings)
    const targetBaseDir = getYoloBaseDir(normalizedSettings)
    const yoloBaseDirChanged = sourceBaseDir !== targetBaseDir
    const settingsToApply = yoloBaseDirChanged
      ? {
          ...normalizedSettings,
          yolo: { ...normalizedSettings.yolo, baseDir: targetBaseDir },
        }
      : normalizedSettings

    if (yoloBaseDirChanged) {
      const relocation = await runManagedModuleDataExclusive(
        this.app.vault,
        managedModuleDataNamespace('learning', 'managed-data'),
        async () => {
          const result = await relocateYoloBaseDir({
            app: this.app,
            source: sourceBaseDir,
            target: targetBaseDir,
            persistTargetBaseDir: async () => {
              await this.persistPluginDirSettings(settingsToApply)
            },
          })
          if (
            result.status === 'migrated' ||
            result.status === 'adopted' ||
            result.status === 'created'
          ) {
            this.settings = settingsToApply
            this.publishManagedModulePathChange()
          }
          return result
        },
      )

      if (relocation.status === 'target-conflict') {
        this.showYoloRootRelocationConflict(relocation.target)
        return false
      }
      if (relocation.status === 'protected-source') {
        new Notice(
          this.t(
            'settings.agent.yoloBaseDirMigrationManualRepair',
            'The current YOLO root is a protected hidden folder and cannot be moved automatically. Move the YOLO files manually, then choose the new root.',
          ),
          0,
        )
        return false
      }
      if (relocation.status === 'failed') {
        console.error('[YOLO] Failed to relocate YOLO root', relocation.error)
        new Notice(
          relocation.rollbackFailed
            ? this.t(
                'settings.agent.yoloBaseDirMigrationRollbackFailed',
                'YOLO root moved, but the setting could not be saved and the move could not be rolled back. Restore the previous folder manually before continuing.',
              )
            : this.t(
                'settings.agent.yoloBaseDirMigrationFailed',
                'YOLO root could not be moved. Your existing setting was kept.',
              ),
          relocation.rollbackFailed ? 0 : undefined,
        )
        return false
      }
      if (this.dbManager) {
        await this.dbManager.cleanup()
        this.dbManager = null
        this.dbManagerInitPromise = null
      }
    }

    this.settings = settingsToApply
    if (!yoloBaseDirChanged) {
      await this.persistPluginDirSettings(settingsToApply)
    }
    this.markPromptSourceSettingsChange(previousSettings, settingsToApply)
    setLLMDebugCaptureEnabled(
      this.settings.debug?.captureRawRequestDebug ?? false,
    )

    this.syncOAuthRuntimesFromSettings(settingsToApply)
    this.ragCoordinator?.updateSettings(settingsToApply)

    // When RAG is disabled, stop all pending auto-update timers and clear
    // any retry_scheduled state (per knowledge base) so the
    // background-activity UI disappears.
    const ragIsEnabled = settingsToApply.ragOptions.enabled
    const autoUpdateWasEnabled = previousSettings.ragOptions.autoUpdateEnabled
    const autoUpdateIsEnabled = settingsToApply.ragOptions.autoUpdateEnabled
    if (!ragIsEnabled) {
      this.ragAutoUpdateService?.cleanup()
      if (this.ragIndexService) {
        const indexService = this.ragIndexService
        await Promise.all(
          settingsToApply.knowledgeBases.map((kb) =>
            indexService.resetRetryState(kb.id),
          ),
        )
        indexService.refreshActivity()
      }
    } else if (autoUpdateWasEnabled && !autoUpdateIsEnabled) {
      this.ragAutoUpdateService?.cleanup()
      if (this.ragIndexService) {
        const indexService = this.ragIndexService
        await Promise.all(
          settingsToApply.knowledgeBases
            .filter(
              (kb) => indexService.getRunSnapshot(kb.id).trigger === 'auto',
            )
            .map((kb) => indexService.resetRetryState(kb.id)),
        )
      }
    }

    this.settingsChangeListeners.forEach((listener) => {
      listener(settingsToApply)
    })
    return true
  }

  addSettingsChangeListener(listener: (newSettings: YoloSettings) => void) {
    this.settingsChangeListeners.push(listener)
    return () => {
      this.settingsChangeListeners = this.settingsChangeListeners.filter(
        (l) => l !== listener,
      )
    }
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

  addPluginUpdateListener(listener: () => void): () => void {
    this.pluginUpdateListeners.push(listener)
    return () => {
      this.pluginUpdateListeners = this.pluginUpdateListeners.filter(
        (l) => l !== listener,
      )
    }
  }

  private notifyPluginUpdateListeners(): void {
    for (const listener of this.pluginUpdateListeners) {
      listener()
    }
  }

  private setPluginUpdateState(state: PluginUpdateState): void {
    this.pluginUpdateState = state
    this.notifyPluginUpdateListeners()
  }

  canSelfUpdatePlugin(): boolean {
    return canSelfUpdate(this)
  }

  private async refreshPluginUpdateStaging(version: string): Promise<void> {
    if (!canSelfUpdate(this) || !this.manifest.dir) {
      return
    }
    const stagingDir = getStagingDir(this.manifest.dir, version)
    const status = await getStagingStatus(
      this.app.vault.adapter,
      stagingDir,
      version,
    )
    if (status.ready) {
      this.setPluginUpdateState({ status: 'ready', version })
    }
  }

  async startPluginUpdateDownload(): Promise<void> {
    const result = this.updateCheckResult
    if (
      !result?.hasUpdate ||
      !result.assets ||
      !canSelfUpdate(this) ||
      !this.manifest.dir
    ) {
      return
    }

    return this.downloadPluginRelease(result.latestVersion, result.assets)
  }

  private repairFilesMatch(
    left: ReleaseFileName[] | undefined,
    right: ReleaseFileName[],
  ): boolean {
    if (!left || left.length !== right.length) {
      return false
    }
    const sortedLeft = [...left].sort()
    const sortedRight = [...right].sort()
    return sortedLeft.every((file, index) => file === sortedRight[index])
  }

  private async downloadPluginRelease(
    version: string,
    assets: ReleaseAssets,
  ): Promise<void> {
    if (!canSelfUpdate(this) || !this.manifest.dir) {
      return
    }

    if (this.pluginUpdateDownloadPromise) {
      return this.pluginUpdateDownloadPromise
    }

    const normalized = normalizePluginVersion(version)
    if (
      this.pluginUpdateState.status === 'ready' &&
      this.pluginUpdateState.version === normalized
    ) {
      return
    }

    if (this.pluginUpdateState.status === 'downloading') {
      return
    }

    const stagingDir = getStagingDir(this.manifest.dir, normalized)
    const existing = await getStagingStatus(
      this.app.vault.adapter,
      stagingDir,
      normalized,
    )
    if (existing.ready) {
      this.setPluginUpdateState({ status: 'ready', version: normalized })
      return
    }

    this.setPluginUpdateState({
      status: 'downloading',
      version: normalized,
      progress: 0,
    })

    this.pluginUpdateDownloadPromise = (async () => {
      try {
        await downloadReleaseToStaging({
          adapter: this.app.vault.adapter,
          pluginDir: this.manifest.dir!,
          version: normalized,
          assets,
          onProgress: (progress) => {
            this.setPluginUpdateState({
              status: 'downloading',
              version: normalized,
              progress,
            })
          },
        })
        this.setPluginUpdateState({ status: 'ready', version: normalized })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.setPluginUpdateState({
          status: 'error',
          version: normalized,
          message,
        })
      } finally {
        this.pluginUpdateDownloadPromise = null
      }
    })()

    return this.pluginUpdateDownloadPromise
  }

  private async downloadPluginRepair(
    version: string,
    assets: ReleaseAssets,
    files: ReleaseFileName[],
  ): Promise<void> {
    if (!canSelfUpdate(this) || !this.manifest.dir || files.length === 0) {
      return
    }

    if (this.pluginUpdateDownloadPromise) {
      return this.pluginUpdateDownloadPromise
    }

    const normalized = normalizePluginVersion(version)
    const uniqueFiles = [...new Set(files)]
    if (
      this.pluginUpdateState.status === 'ready' &&
      this.pluginUpdateState.version === normalized &&
      this.repairFilesMatch(this.pluginUpdateState.repairFiles, uniqueFiles)
    ) {
      return
    }

    if (this.pluginUpdateState.status === 'downloading') {
      return
    }

    const stagingDir = getStagingDir(this.manifest.dir, normalized)
    const existing = await getRepairStagingStatus(
      this.app.vault.adapter,
      stagingDir,
      normalized,
    )
    if (existing.ready && this.repairFilesMatch(existing.files, uniqueFiles)) {
      this.setPluginUpdateState({
        status: 'ready',
        version: normalized,
        repairFiles: uniqueFiles,
      })
      return
    }

    this.setPluginUpdateState({
      status: 'downloading',
      version: normalized,
      progress: 0,
      repairFiles: uniqueFiles,
    })

    this.pluginUpdateDownloadPromise = (async () => {
      try {
        await downloadRepairFilesToStaging({
          adapter: this.app.vault.adapter,
          pluginDir: this.manifest.dir!,
          version: normalized,
          assets,
          files: uniqueFiles,
          onProgress: (progress) => {
            this.setPluginUpdateState({
              status: 'downloading',
              version: normalized,
              progress,
              repairFiles: uniqueFiles,
            })
          },
        })
        this.setPluginUpdateState({
          status: 'ready',
          version: normalized,
          repairFiles: uniqueFiles,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.setPluginUpdateState({
          status: 'error',
          version: normalized,
          message,
          repairFiles: uniqueFiles,
        })
      } finally {
        this.pluginUpdateDownloadPromise = null
      }
    })()

    return this.pluginUpdateDownloadPromise
  }

  async applyPluginUpdate(): Promise<void> {
    if (this.pluginUpdateState.status !== 'ready') {
      return
    }

    const version = this.pluginUpdateState.version
    const repairFiles = this.pluginUpdateState.repairFiles

    this.setPluginUpdateState({
      status: 'applying',
      version,
      repairFiles,
    })

    const applyResult = repairFiles?.length
      ? await applyRepairFiles(this.app, this, version)
      : await applyStagedUpdate(this.app, this, version)
    if (!applyResult.ok) {
      if (applyResult.reason === 'min_app_version') {
        const { InstallerUpdateRequiredModal } = await import(
          './components/modals/InstallerUpdateRequiredModal'
        )
        new InstallerUpdateRequiredModal(this.app).open()
      }
      this.setPluginUpdateState({
        status: 'error',
        version,
        message: applyResult.reason,
        repairFiles,
      })
      return
    }

    this.setPluginUpdateState({ status: 'idle' })
    this.updateCheckResult = null
    this.notifyUpdateCheckListeners()
  }

  private async autoRepairInstallation(): Promise<void> {
    const detail = this.installationIncompleteDetail
    if (!detail || !canSelfUpdate(this) || detail.suspectFiles.length === 0) {
      return
    }

    const version = normalizePluginVersion(detail.targetVersion)
    const files = [...new Set(detail.suspectFiles)]
    if (
      this.pluginUpdateState.status === 'ready' &&
      this.pluginUpdateState.version === version &&
      this.repairFilesMatch(this.pluginUpdateState.repairFiles, files)
    ) {
      return
    }

    const assets = buildReleaseAssets(version)
    if (!assets) {
      return
    }

    await this.downloadPluginRepair(version, assets, files)
  }

  async repairIncompleteInstallation(): Promise<void> {
    const detail = this.installationIncompleteDetail
    if (!detail || !canSelfUpdate(this)) {
      return
    }

    const version = normalizePluginVersion(detail.targetVersion)
    const files = [...new Set(detail.suspectFiles)]
    if (
      this.pluginUpdateState.status === 'ready' &&
      this.pluginUpdateState.version === version &&
      this.repairFilesMatch(this.pluginUpdateState.repairFiles, files)
    ) {
      await this.applyPluginUpdate()
      return
    }

    const assets = buildReleaseAssets(version)
    if (!assets) {
      return
    }

    await this.downloadPluginRepair(version, assets, files)
  }

  isUpdateVersionSoftDismissed(version: string): boolean {
    return this.settings.softDismissedUpdateVersion === version
  }

  isUpdateVersionMuted(version: string): boolean {
    const muted = normalizePluginVersion(this.settings.mutedUpdateVersion)
    if (!muted) {
      return false
    }
    return muted === normalizePluginVersion(version)
  }

  async muteUpdateVersion(version: string): Promise<void> {
    const normalized = normalizePluginVersion(version)
    await this.setSettings({
      ...this.settings,
      mutedUpdateVersion: normalized,
    })
    if (this.isUpdateVersionMuted(normalized)) {
      this.updateCheckResult = null
      this.notifyUpdateCheckListeners()
    }
  }

  async dismissUpdateVersion(version: string): Promise<void> {
    await this.setSettings({
      ...this.settings,
      softDismissedUpdateVersion: version,
    })
    // setSettings can no-op (e.g. external settings conflict). Only hide the
    // toast when the dismissal state actually persisted, so the user can retry.
    const persisted = this.isUpdateVersionSoftDismissed(version)
    if (persisted) {
      this.updateCheckResult = null
      this.notifyUpdateCheckListeners()
    }
  }

  dismissUpdateForSession(): void {
    this.updateCheckResult = null
    this.notifyUpdateCheckListeners()
  }

  checkForUpdatesOnce(): void {
    if (this.hasCheckedForUpdates) {
      return
    }
    this.hasCheckedForUpdates = true
    void Promise.allSettled([
      (async () => {
        if (!this.distributionFeedClient) return
        // The Feed load itself is never gated: it is also the module catalog's
        // data source, so `设置 → 模块` keeps offering updates even when the
        // update notice is off. Only the prompt and its download are gated.
        const fetched = await checkForUpdate(
          this.manifest.version,
          this.distributionFeedClient,
        )
        if (fetched?.hasUpdate) {
          if (
            !this.settings.pluginUpdateNoticeEnabled ||
            this.isUpdateVersionMuted(fetched.latestVersion)
          ) {
            return
          }
          this.updateCheckResult = fetched
          this.notifyUpdateCheckListeners()
          await this.refreshPluginUpdateStaging(fetched.latestVersion)
          if (
            this.settings.pluginUpdateAutoDownloadEnabled &&
            canSelfUpdate(this) &&
            fetched.assets
          ) {
            void this.startPluginUpdateDownload()
          }
        }
      })(),
      (async () => {
        // Catalog refresh always runs — it feeds the module list in settings.
        // Only the toast-facing offers (and their auto-download) are gated.
        await this.moduleService?.checkForUpdates()
        if (!this.settings.pluginUpdateNoticeEnabled) return
        await this.moduleUpdateController?.refresh()
      })(),
    ])
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
    if (
      editorView &&
      (this.settings.continuationOptions.persistSelectionHighlight ?? true)
    ) {
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
          const { DatabaseManager } = await import('./database/DatabaseManager')
          this.dbManager = await DatabaseManager.create(
            this.app,
            this.settings,
            this.manifest.dir ? normalizePath(this.manifest.dir) : undefined,
          )
          return this.dbManager
        } catch (error) {
          this.dbManagerInitPromise = null
          throw error
        }
      })()
    }

    // if initialization is running, wait for it to complete instead of creating a new initialization promise
    return this.dbManagerInitPromise
  }

  getModuleService(): ModuleService {
    if (!this.moduleService) {
      throw new Error('[YOLO] Module service is unavailable')
    }
    return this.moduleService
  }

  getRuntimeComponentService(): RuntimeComponentService {
    if (!this.runtimeComponentService) {
      throw new Error('[YOLO] Runtime component service is unavailable')
    }
    return this.runtimeComponentService
  }

  getModuleUpdateSnapshot = (): readonly ModuleUpdateOffer[] =>
    this.moduleUpdateController?.getSnapshot() ?? []

  subscribeModuleUpdates = (listener: () => void): (() => void) =>
    this.moduleUpdateController?.subscribe(listener) ?? (() => undefined)

  dismissModuleUpdateForSession(key: string): void {
    this.moduleUpdateController?.dismissForSession(key)
  }

  async muteModuleUpdate(key: string): Promise<void> {
    await this.moduleUpdateController?.mute(key)
  }

  async applyModuleUpdate(key: string): Promise<void> {
    await this.moduleUpdateController?.update(key)
  }

  getModuleSettingsContributionRegistry(): ModuleSettingsContributionRegistry {
    return this.moduleSettingsContributions
  }

  getModuleChatModeRegistry(): ModuleChatModeRegistry {
    return this.moduleChatModeRegistry
  }

  private initializeModuleSystem(): void {
    const store = new ModuleStore({
      adapter: this.app.vault.adapter,
      manifest: this.manifest,
      configDir: this.app.vault.configDir,
    })
    const artifactArrivalGrace = new ModuleArtifactArrivalGrace({
      adapter: store.adapter,
      pluginDir: store.pluginDir,
    })
    const createConfigBackend = createObsidianModuleConfigBackendFactory({
      app: this.app,
      getSettings: () => this.settings,
      subscribeSettingsChange: (listener) =>
        this.addSettingsChangeListener(() => listener()),
    })
    const createConfigIfAbsent = createObsidianModuleConfigCreateIfAbsent({
      app: this.app,
      getSettings: () => this.settings,
    })
    this.learningModuleSettingsHandoffReady = false
    this.learningModuleSettingsHandoff = async () => {
      this.learningModuleSettingsHandoffReady = false
      await handoffLearningLegacySettings(
        createConfigIfAbsent,
        this.rawLearningLegacySettings,
      )
      this.learningModuleSettingsHandoffReady = true
    }
    const deviceLocalAdapter = new IndexedDbDataAdapter(this.app)
    this.register(() => deviceLocalAdapter.close())
    const servicesReference: { current: ModuleService | null } = {
      current: null,
    }
    const runtime = new ModuleRuntime(
      new ObsidianModuleContributionRegistrar(this),
      new CoreModuleHostCapabilityProvider({
        agent: new CoreModuleAgentCapabilityProvider({
          isDebugCaptureEnabled: isLLMDebugCaptureEnabled,
          getAgentApi: async () => {
            await this.warmupAgentService()
            return this.getAgentApi()
          },
        }),
        assets: new ModuleAssetsCapabilityProvider({
          store,
          getVerifiedArtifact: (moduleId) =>
            servicesReference.current?.getVerifiedArtifact(moduleId),
        }),
        backgroundActivities: this.getBackgroundActivityRegistry(),
        chat: new CoreModuleChatCapabilityProvider({
          sink: this.moduleChatModeRegistry,
        }),
        config: new ModuleConfigCapabilityProvider({
          createBackend: (moduleId) => {
            if (
              moduleId === 'learning' &&
              !this.learningModuleSettingsHandoffReady
            ) {
              throw new Error('Learning module settings handoff is incomplete')
            }
            return createConfigBackend(moduleId)
          },
          reportCallbackError: (moduleId, error) => {
            console.error(
              `[YOLO] Module "${moduleId}" config callback failed`,
              error,
            )
          },
        }),
        paths: new ManagedModulePathsCapabilityProvider({
          vaultIdentity: this.app.vault,
          getBaseDir: () => getYoloBaseDir(this.settings),
          subscribe: (listener) => {
            this.managedModulePathChangeListeners.add(listener)
            return () => this.managedModulePathChangeListeners.delete(listener)
          },
          reportCallbackError: (moduleId, error) => {
            console.error(
              `[YOLO] Module "${moduleId}" managed-path callback failed`,
              error,
            )
          },
        }),
        privateStorage: new ModulePrivateStorageCapabilityProvider({
          synchronized: {
            adapter: this.app.vault.adapter,
            getRootPath: () =>
              normalizePath(
                `${getYoloJsonDbRootDir(this.settings)}/${MODULE_PRIVATE_STORAGE_DIR}`,
              ),
          },
          deviceLocal: {
            adapter: deviceLocalAdapter,
            getRootPath: () => MODULE_DEVICE_LOCAL_VIRTUAL_ROOT,
          },
        }),
        settings: new ModuleSettingsCapabilityProvider({
          sink: this.moduleSettingsContributions,
          createConfigAdapter: (moduleId) => {
            const backend = createConfigBackend(moduleId)
            return {
              read: () => backend.read(),
              replace: (next) => backend.write(next),
              subscribe: (listener) => backend.subscribe(listener),
            }
          },
          getModelSnapshot: () => ({
            defaultModelId: this.settings.chatModelId,
            models: this.settings.chatModels
              .filter((model) => model.enable ?? true)
              .map((model) => ({
                id: model.id,
                name: model.name ?? model.model,
                providerId: model.providerId,
              })),
          }),
          subscribeModels: (listener) =>
            this.addSettingsChangeListener(() => listener()),
        }),
        ui: new ObsidianModuleUiCapabilityProvider({
          app: this.app,
          createConfirmModal: (app, options) => new ConfirmModal(app, options),
          actionToasts: {
            show: (toast) => {
              if (!this.actionToastController) {
                throw new Error('[YOLO] Action toast host is unavailable')
              }
              this.actionToastController.show(toast)
            },
            dismiss: (id) => this.actionToastController?.dismiss(id),
          },
          reportCleanupError: (moduleId, error) => {
            console.error(
              `[YOLO] Module "${moduleId}" UI cleanup failed`,
              error,
            )
          },
        }),
        vault: new ObsidianModuleVaultCapabilityProvider(this.app),
      }),
    )
    const runtimeReservation = new ModuleRuntimeReservation({ runtime })
    this.moduleRuntime = runtime
    this.moduleRuntimeReservation = runtimeReservation
    const platform = Platform.isDesktop ? 'desktop' : 'mobile'
    const deviceStateStore = new ModuleDeviceStateStore({
      kind: 'device-local-runtime-state',
      adapter: deviceLocalAdapter,
      rootPath: MODULE_DEVICE_STATE_ROOT,
    })
    const intentStore = new ModuleIntentStore(
      createObsidianModuleIntentBackend({
        app: this.app,
        getSettings: () => this.settings,
        subscribeSettingsChange: (listener) =>
          this.addSettingsChangeListener(() => listener()),
      }),
    )
    this.learningLegacyInstallMigration = async () => {
      await migrateLearningLegacyInstallIntent({
        adapter: this.app.vault.adapter,
        settings: this.settings,
        legacySettings: this.rawLearningLegacySettings,
        enableIfAbsent: (moduleId) =>
          intentStore.setIfAbsent(moduleId, 'enabled'),
      })
    }
    const getCompatibility = createOfficialModuleCompatibilityProvider({
      platform,
      readDeviceState: async (moduleId) => {
        const state = await deviceStateStore.read(moduleId)
        return state
          ? {
              moduleId,
              platform: state.platform,
              activeVersion: state.active?.version ?? null,
            }
          : null
      },
    })
    const distributionFeedClient = new DistributionFeedClient({
      adapter: deviceLocalAdapter,
      cachePath: 'distribution/feed-v1.json',
      timeoutMs: 10_000,
    })
    this.distributionFeedClient = distributionFeedClient
    const moduleCatalogLocale = () =>
      normalizeModuleCatalogLocale(localeStore.getSnapshot().locale)
    // Development-only local install channel: layers module artifacts built
    // by `npm run module:build` (modules/bundled.json) on top of the
    // unmodified official catalog, so a dev vault can install and run an
    // unpublished local build. Never used in production — see
    // devModuleCatalogSource.ts for why bytes are always read locally.
    const devModuleCatalogOverlay =
      process.env.NODE_ENV === 'development'
        ? createDevModuleCatalogOverlay({
            readBundledIndexBytes: () => store.readBundledIndexBytes(),
            adapter: store.adapter,
            pluginDir: store.pluginDir,
            platform,
            locale: moduleCatalogLocale,
            getCompatibility,
            official: createOfficialModuleCatalogSource({
              distributionFeedClient,
              locale: moduleCatalogLocale,
              getCompatibility,
              platform,
            }),
            fallbackDownload: createOfficialModuleArtifactDownloader({
              timeoutMs: OFFICIAL_MODULE_ARTIFACT_TIMEOUT_MS,
            }),
          })
        : null
    // Skill packages a module ships live under the plugin directory, which
    // Obsidian does not index — nothing there is reachable by the agent's
    // Vault-backed read tools. Activation projects each declared package into
    // `<yolo base>/modules/<moduleId>/skills/<package>/`, after which module
    // skills are ordinary Vault skill packages with no special addressing.
    // Every path is resolved from current settings on each call so a base
    // directory change takes effect without a restart.
    const moduleSkillMaterializer = createModuleSkillMaterializer({
      vault: createObsidianModuleSkillProjectionVault(this.app),
      store,
      getSkillsDir: (moduleId) =>
        getYoloModuleSkillsDir(moduleId, this.settings),
      getModuleDir: (moduleId) => getYoloModuleDir(moduleId, this.settings),
      getModulesRootDir: () => getYoloModulesRootDir(this.settings),
    })
    const services = createProductionModuleServices({
      store,
      deviceStateStore,
      distributionFeedClient,
      platform,
      locale: moduleCatalogLocale,
      subscribeLocale: localeStore.subscribe,
      getCompatibility,
      isActive: (moduleId, version) => runtime.isActive(moduleId, version),
      runtimeReservation,
      intentStore,
      artifactArrivalGrace,
      skillProjection: {
        materialize: (moduleId, artifact, signal) =>
          moduleSkillMaterializer.materialize(
            moduleId,
            artifact,
            // A module's modes may share a package; the projection is
            // per-module, so declarations are unioned.
            [
              ...new Set(
                this.moduleChatModeRegistry
                  .getSnapshot()
                  .filter((entry) => entry.moduleId === moduleId)
                  .flatMap((entry) => entry.mode.skills ?? []),
              ),
            ],
            signal,
          ),
        remove: (moduleId) => moduleSkillMaterializer.remove(moduleId),
      },
      ...(devModuleCatalogOverlay
        ? {
            catalogSource: devModuleCatalogOverlay.catalogSource,
            artifactDownloader: devModuleCatalogOverlay.artifactDownloader,
            resolveDownloadSources:
              devModuleCatalogOverlay.resolveDownloadSources,
          }
        : {}),
      reportCleanupError: (error) => {
        console.error('[YOLO] Module artifact cleanup failed', error)
      },
      reportRefreshError: (error) => {
        console.error('[YOLO] Module manager refresh failed', error)
      },
      reportActivationError: (moduleId, error) => {
        console.error(`[YOLO] Module "${moduleId}" activation failed`, error)
      },
      reportSkillProjectionError: (moduleId, error) => {
        console.error(
          `[YOLO] Module "${moduleId}" skill projection failed; its modes are active without those skills`,
          error,
        )
      },
      reportStartupError: (error, moduleId) => {
        console.error(
          moduleId
            ? `[YOLO] Module "${moduleId}" startup reconciliation failed`
            : '[YOLO] Module startup reconciliation failed',
          error,
        )
      },
    })
    servicesReference.current = services
    this.moduleService = services
    this.moduleUpdateController = new ModuleUpdateController({
      service: services,
      getAutoDownloadEnabled: () => isModuleAutoDownloadEnabled(this.settings),
      getMutedVersions: () => this.settings.mutedModuleUpdateVersions,
      muteVersion: async (moduleId, version) => {
        await this.setSettings({
          ...this.settings,
          mutedModuleUpdateVersions: {
            ...this.settings.mutedModuleUpdateVersions,
            [moduleId]: version,
          },
        })
      },
    })

    // Bridges the module chat mode registry into the skills subsystem —
    // `LiteSkillRegistryService` reads `this.moduleChatModeRegistry`'s
    // snapshot fresh on every scoped list/get call (no separate cache), and
    // each declaration resolves to the Vault path the activation-time
    // projection wrote it to, derived by the same function the materializer
    // uses so read and write can never diverge.
    configureModuleChatModeSkillSource({
      getMode: (fullModeId) => {
        const entry = this.moduleChatModeRegistry
          .getSnapshot()
          .find((candidate) => candidate.fullModeId === fullModeId)
        if (!entry || entry.availability.status !== 'available') {
          return undefined
        }
        return {
          moduleId: entry.moduleId,
          skillPaths: entry.mode.skills ?? [],
        }
      },
      listModeIds: () =>
        this.moduleChatModeRegistry
          .getSnapshot()
          .map((entry) => entry.fullModeId),
      resolveSkillPath: (moduleId, declaredSkillPath) =>
        resolveModuleSkillVaultPath(
          getYoloModuleSkillsDir(moduleId, this.settings),
          declaredSkillPath,
        ),
    })
  }

  private initializeRuntimeComponentSystem(): void {
    const store = new RuntimeComponentStore(
      this.app.vault.adapter,
      this.manifest,
      this.app.vault.configDir,
    )
    const deviceAdapter = new IndexedDbDataAdapter(this.app)
    this.register(() => deviceAdapter.close())
    const platform = Platform.isDesktop ? 'desktop' : 'mobile'
    const intentStore = new RuntimeComponentIntentStore(
      createObsidianModuleIntentBackend({
        app: this.app,
        getSettings: () => this.settings,
        subscribeSettingsChange: (listener) =>
          this.addSettingsChangeListener(() => listener()),
        directoryName: 'component-intent-v1',
      }),
    )
    const deviceStateStore = new RuntimeComponentDeviceStateStore({
      kind: 'device-local-runtime-state',
      adapter: deviceAdapter,
      rootPath: 'component-device-state-v1',
    })
    const remoteDownload = createRuntimeComponentDownloader()
    const download = async ({
      descriptor,
      asset,
      source,
      signal,
    }: Parameters<typeof remoteDownload>[0]): Promise<Uint8Array> => {
      if (signal?.aborted) {
        throw new DOMException(
          'Runtime component download aborted',
          'AbortError',
        )
      }
      if (process.env.NODE_ENV !== 'production') {
        return new Uint8Array(
          await this.app.vault.adapter.readBinary(
            normalizePath(
              `${store.pluginDir}/${asset ? asset.path : descriptor.entry}`,
            ),
          ),
        )
      }
      return remoteDownload({
        descriptor,
        ...(asset ? { asset } : {}),
        source,
        ...(signal ? { signal } : {}),
      })
    }
    const installer = new RuntimeComponentInstaller({
      store,
      download,
      ...(process.env.NODE_ENV === 'production'
        ? {
            resolveDownloadSources: (
              descriptor: (typeof BAKED_RUNTIME_COMPONENT_REGISTRY.components)[number],
              asset?: NonNullable<(typeof descriptor)['assets']>[number],
            ) =>
              asset
                ? resolveRuntimeComponentAssetSources(
                    descriptor,
                    asset,
                    BAKED_PLUGIN_VERSION,
                  )
                : resolveRuntimeComponentArtifactSources(
                    descriptor,
                    BAKED_PLUGIN_VERSION,
                  ),
          }
        : {}),
      reportCleanupError: (error) => {
        console.error('[YOLO] Runtime component artifact cleanup failed', error)
      },
    })
    const service = new RuntimeComponentService({
      registry: BAKED_RUNTIME_COMPONENT_REGISTRY,
      platform,
      store,
      installer,
      loader: new RuntimeComponentLoader(),
      runtime: new RuntimeComponentRuntime(),
      intentStore,
      deviceStateStore,
      reportError: (id, error) => {
        console.error(`[YOLO] Runtime component "${id}" failed`, error)
      },
    })
    this.runtimeComponentService = service
    setRuntimeComponentService(service)
  }

  private initializeLocalEmbedding(): void {
    const manager = new LocalEmbeddingModelManager({
      adapter: this.app.vault.adapter,
      manifest: this.manifest,
      configDir: this.app.vault.configDir,
      getEndpoint: () => this.settings.localEmbedding.endpoint,
    })
    this.localEmbeddingModelManager = manager
    setLocalEmbeddingModelManager(manager)
    if (Platform.isDesktop) {
      void manager.scanInstalled().catch((error) => {
        console.error('[YOLO] Local embedding model scan failed', error)
      })
    }
  }

  getLocalEmbeddingModelManager(): LocalEmbeddingModelManager {
    if (!this.localEmbeddingModelManager) {
      throw new Error('Local embedding model manager not initialized')
    }
    return this.localEmbeddingModelManager
  }

  private activateModules(): void {
    void this.getModuleService()
      .start()
      .catch((error) => {
        console.error('[YOLO] Failed to start modules', error)
      })
  }

  private async activateLocalConformanceModule(): Promise<void> {
    const moduleId = 'host-api-conformance'
    const version = '1.0.0'
    try {
      const store = new ModuleStore({
        adapter: this.app.vault.adapter,
        manifest: this.manifest,
        configDir: this.app.vault.configDir,
      })
      const manifestBytes = await store.readManifestBytes(moduleId, version)
      const manifest = parseModuleArtifactManifest(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
        ),
      )
      if (manifest.id !== moduleId || manifest.version !== version) {
        throw new Error('Conformance module manifest identity mismatch')
      }
      const variant = selectModuleManifestVariant(
        manifest,
        Platform.isDesktop ? 'desktop' : 'mobile',
      )
      const entry = variant.files.find((file) => file.role === 'entry')!
      const entryBytes = await store.readEntryBytes(
        manifest.id,
        manifest.version,
        entry.path,
      )
      if (!this.moduleRuntimeReservation) {
        throw new Error('Module runtime reservation is unavailable')
      }
      const definition = await new ModuleLoader({
        executor: new DomBlobModuleScriptExecutor(),
      }).load(
        {
          id: manifest.id,
          byteSize: entry.byteSize,
          sha256: entry.sha256,
        },
        entryBytes,
      )
      await this.moduleRuntimeReservation.activate(definition, version)
      await this.moduleService?.refresh()
      new Notice('Host API conformance module activated')
    } catch (error) {
      console.error('[YOLO] Conformance module activation failed', error)
      new Notice(
        `Host API conformance module unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** One `VectorManager` per configured knowledge base, best-effort — a base
   * whose store fails to open is skipped (and logged) rather than failing
   * the whole call, since callers use this to sweep a deleted model/provider
   * id out of every base's vectors, not to open any one specific base. */
  async tryGetVectorManagers(): Promise<VectorManager[]> {
    try {
      const dbManager = await this.getDbManager()
      const results = await Promise.all(
        this.settings.knowledgeBases.map(async (kb) => {
          try {
            return await dbManager.getVectorManager(kb.id)
          } catch (error) {
            console.warn(
              `[YOLO] Failed to open vector manager for knowledge base "${kb.id}", skipping.`,
              error,
            )
            return null
          }
        }),
      )
      return results.filter((vm): vm is VectorManager => vm !== null)
    } catch (error) {
      console.warn(
        '[YOLO] Failed to initialize database manager, skip vector-dependent operations.',
        error,
      )
      return []
    }
  }

  /**
   * Cheap dry-run count of pending changes for one knowledge base — no
   * chunkify, no embed, no write. Returns `{ changed: 0, total: 0 }` if the
   * base's vector store can't be opened (mirrors `tryGetVectorManagers`'
   * fail-open behavior) so a broken base never crashes the status bar.
   */
  async countPendingChanges(
    kbId: string,
  ): Promise<{ changed: number; total: number }> {
    try {
      return await (
        await this.getRagCoordinator().getRagEngine(kbId)
      ).countPendingChanges()
    } catch (error) {
      console.warn(
        `[YOLO] Failed to count pending changes for knowledge base "${kbId}".`,
        error,
      )
      return { changed: 0, total: 0 }
    }
  }

  async runRagIndex(
    kbId: string,
    options: {
      mode: 'rebuild' | 'sync'
      scope: import('./core/rag/reconciler').ReconcileScope
      trigger: 'manual' | 'auto'
      retryPolicy: 'none' | 'transient'
      onProgress?: (
        progress: import('./components/chat-view/QueryProgress').IndexProgress,
      ) => void
    },
  ): Promise<ReconcileResult> {
    return await this.getRagIndexService().run(kbId, options)
  }

  /** Re-issue the previously failed run for one knowledge base. Falls back
   * to a full sync reconcile (path scopes are not persisted). */
  async retryRagIndex(kbId: string): Promise<void> {
    const snapshot = this.getRagIndexService().getRunSnapshot(kbId)
    if (snapshot.mode === null) {
      return
    }
    await this.runRagIndex(kbId, {
      mode: snapshot.mode,
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'transient',
    })
  }

  subscribeToRagIndexRuns(
    listener: (snapshot: RagIndexServiceSnapshot) => void,
  ): () => void {
    return this.getRagIndexService().subscribe(listener)
  }

  getRagIndexSnapshot(): RagIndexServiceSnapshot {
    return this.getRagIndexService().getSnapshot()
  }

  /** No `kbId`: cancel the active run and clear the whole queue. One
   * `kbId`: cancel/dequeue just that base's run. */
  cancelRagIndex(kbId?: string): void {
    this.getRagIndexService().cancel(kbId)
  }

  /** Removes one knowledge base: saves settings without it first (data
   * deletion never starts unless this succeeds — a save conflict/failure
   * must leave the base's data intact, not delete data behind a config that
   * failed to update), then cancels any active/queued index run for it and
   * permanently deletes its vector database. The only path that should ever
   * delete a knowledge base's data — settings changes alone never do this
   * (see `setSettings`). */
  async deleteKnowledgeBase(kbId: string): Promise<void> {
    const saved = await this.setSettings({
      ...this.settings,
      knowledgeBases: this.settings.knowledgeBases.filter(
        (kb) => kb.id !== kbId,
      ),
    })
    if (!saved) {
      throw new Error(
        `Failed to save settings before deleting knowledge base "${kbId}"`,
      )
    }
    await this.getRagIndexService().forgetKnowledgeBase(kbId)
    await this.getRagCoordinator().closeRagEngine(kbId)
    const dbManager = await this.getDbManager()
    await dbManager.deleteKnowledgeBase(kbId)
  }

  async getMcpManager(): Promise<McpManager> {
    const manager = await (await this.getMcpCoordinator()).getMcpManager()
    this.mcpManager = manager
    return manager
  }

  private registerTimeout(callback: () => void, timeout: number): void {
    const timeoutId = setTimeout(callback, timeout)
    this.timeoutIds.push(timeoutId)
  }

  // Public wrapper — currently used by Quick Ask's "continue" mode, which
  // always supplies its own resolved providerClient/model (the same one used
  // for its ask/agent path) as modelOverride.
  async continueWriting(
    editor: Editor,
    customPrompt: string | undefined,
    mentionables: (MentionableFile | MentionableFolder)[] | undefined,
    modelOverride: ContinuationModelOverride,
  ) {
    return this.handleContinueWriting(
      editor,
      customPrompt,
      mentionables,
      modelOverride,
    )
  }

  private async handleContinueWriting(
    editor: Editor,
    customPrompt: string | undefined,
    mentionables: (MentionableFile | MentionableFolder)[] | undefined,
    modelOverride: ContinuationModelOverride,
  ) {
    return this.getContinuationController().handleContinueWriting(
      editor,
      customPrompt,
      mentionables,
      modelOverride,
    )
  }
}
