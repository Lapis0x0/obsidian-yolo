import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { AgentConversationState } from '../../core/agent/service'
import type { ChatMessage } from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { YoloPluginInfo, YoloRuntime } from '../yoloRuntime.types'
import type { App } from './obsidianCompat'

type WebAgentServiceLike = {
  subscribe(
    conversationId: string,
    listener: (state: AgentConversationState) => void,
    options?: { emitCurrent?: boolean },
  ): () => void
  subscribeToRunSummaries(
    callback: Parameters<YoloRuntime['agent']['subscribeToRunSummaries']>[0],
  ): () => void
  subscribeToPendingExternalAgentResults(
    callback: Parameters<
      YoloRuntime['agent']['subscribeToPendingExternalAgentResults']
    >[0],
  ): () => void
  getState(conversationId: string): AgentConversationState
  getConversationRunSummary: YoloRuntime['agent']['getConversationRunSummary']
  replaceConversationMessages(
    conversationId: string,
    messages: ChatMessage[],
    compaction?: unknown,
    options?: { persistState?: boolean; reason?: string },
  ): void
  abortConversation(conversationId: string): void
  approveToolCall: YoloRuntime['agent']['approveToolCall']
  rejectToolCall: YoloRuntime['agent']['rejectToolCall']
  abortToolCall: YoloRuntime['agent']['abortToolCall']
  isRunning(conversationId: string): boolean
}

export function createWebCompatPlugin({
  app,
  pluginInfo,
  getRuntime,
}: {
  app: App
  pluginInfo: YoloPluginInfo
  getRuntime: () => YoloRuntime
}) {
  const updateCheckListeners = new Set<() => void>()
  const installationListeners = new Set<() => void>()
  let updateBannerDismissed = false
  let installationIncompleteBannerDismissed = false

  const agentService: WebAgentServiceLike = {
    subscribe: (conversationId, listener, options) => {
      if (options?.emitCurrent !== false) {
        listener(getRuntime().agent.getState(conversationId))
      }
      return getRuntime().agent.subscribe(conversationId, listener)
    },
    subscribeToRunSummaries: (callback) =>
      getRuntime().agent.subscribeToRunSummaries(callback),
    subscribeToPendingExternalAgentResults: (callback) =>
      getRuntime().agent.subscribeToPendingExternalAgentResults(callback),
    getState: (conversationId) => getRuntime().agent.getState(conversationId),
    getConversationRunSummary: (conversationId) =>
      getRuntime().agent.getConversationRunSummary(conversationId),
    replaceConversationMessages: (
      conversationId,
      messages,
      compaction,
      options,
    ) =>
      getRuntime().agent.replaceConversationMessages(
        conversationId,
        messages,
        compaction,
        options,
      ),
    abortConversation: (conversationId) => {
      void getRuntime().agent.abort(conversationId)
    },
    approveToolCall: (input) => getRuntime().agent.approveToolCall(input),
    rejectToolCall: (input) => getRuntime().agent.rejectToolCall(input),
    abortToolCall: (input) => getRuntime().agent.abortToolCall(input),
    isRunning: (conversationId) => getRuntime().agent.isRunning(conversationId),
  }

  return {
    app,
    manifest: {
      id: pluginInfo.id,
      name: pluginInfo.name,
      version: pluginInfo.version,
      dir: pluginInfo.dir,
    },
    updateCheckResult: null,
    installationIncompleteDetail: null,
    get settings(): SmartComposerSettings {
      return getRuntime().settings.get()
    },
    async setSettings(next: SmartComposerSettings): Promise<void> {
      await getRuntime().settings.update(next)
    },
    addSettingsChangeListener(
      listener: (newSettings: SmartComposerSettings) => void,
    ) {
      return getRuntime().settings.subscribe(listener)
    },
    getAgentService(): WebAgentServiceLike {
      return agentService
    },
    openApplyReview(state: unknown): Promise<boolean> {
      return getRuntime().ui.openApplyReview(state)
    },
    isUpdateBannerDismissed(): boolean {
      return updateBannerDismissed
    },
    dismissUpdateBanner(): void {
      updateBannerDismissed = true
      updateCheckListeners.forEach((listener) => listener())
    },
    addUpdateCheckListener(listener: () => void): () => void {
      updateCheckListeners.add(listener)
      return () => updateCheckListeners.delete(listener)
    },
    isInstallationIncompleteBannerDismissed(): boolean {
      return installationIncompleteBannerDismissed
    },
    dismissInstallationIncompleteBanner(): void {
      installationIncompleteBannerDismissed = true
      installationListeners.forEach((listener) => listener())
    },
    addInstallationIncompleteListener(listener: () => void): () => void {
      installationListeners.add(listener)
      return () => installationListeners.delete(listener)
    },
    getCurrentConversationOverrides():
      | ConversationOverrideSettings
      | undefined {
      return undefined
    },
  }
}
