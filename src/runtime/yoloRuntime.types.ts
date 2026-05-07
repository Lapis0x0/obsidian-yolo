import type { SmartComposerSettings } from '../settings/schema/setting.types'
import type {
  AgentConversationRunSummary,
  AgentConversationState,
} from '../core/agent/service'
import type {
  ChatConversationCompactionLike,
  ChatMessage,
} from '../types/chat'
import type { ConversationOverrideSettings } from '../types/conversation-settings.types'
import type { ReasoningLevel } from '../types/reasoning'

export type YoloPluginInfo = {
  id: string
  name: string
  version: string
  dir?: string
}

export type YoloRuntimeMode = 'obsidian' | 'web'

export type YoloRuntimePlatform = {
  isMacOS: boolean
  isDesktopApp: boolean
  isPhone: boolean
  isIosApp: boolean
}

export type YoloFileStat = {
  ctime: number
  mtime: number
  size: number
}

export type YoloRuntimeCompatibilityBridge = {
  /** Raw Obsidian App reference. Only available in Obsidian runtime; undefined in web. */
  app?: any
  /** Raw plugin reference. Only available in Obsidian runtime; undefined in web. */
  plugin?: any
  /** Obsidian classes for instanceof checks. Web runtime provides compatibility shims. */
  TFile?: any
  TFolder?: any
  MarkdownView?: any
  /** Obsidian-only renderer surface. Web runtime provides a no-op bridge. */
  MarkdownRenderer?: any
  /** Transitional compatibility surface for shared UI that still inspects platform state. */
  platform: YoloRuntimePlatform
  keymap: {
    isModEvent(e: MouseEvent | KeyboardEvent): boolean | string
  }
  utils: {
    htmlToMarkdown(html: string): string
    normalizePath(path: string): string
  }
}

export type YoloFileRef = {
  path: string
  name: string
  basename: string
  extension: string
  stat?: YoloFileStat
}

export type YoloVaultIndexEntry = YoloFileRef & {
  kind: 'file' | 'folder'
}

export type YoloChatMetadata = {
  id: string
  title: string
  updatedAt: number
  schemaVersion: number
  isPinned?: boolean
  pinnedAt?: number
}

export type YoloChatRecord = {
  id: string
  title: string
  messages: ChatMessage[]
  overrides?: ConversationOverrideSettings | null
  conversationModelId?: string
  messageModelMap?: Record<string, string>
  activeBranchByUserMessageId?: Record<string, string>
  assistantGroupBoundaryMessageIds?: string[]
  reasoningLevel?: string
  compaction?: ChatConversationCompactionLike | null
  updatedAt: number
}

export type SaveYoloChatInput = {
  id: string
  messages: ChatMessage[]
  overrides?: ConversationOverrideSettings | null
  conversationModelId?: string
  messageModelMap?: Record<string, string>
  activeBranchByUserMessageId?: Record<string, string>
  assistantGroupBoundaryMessageIds?: string[]
  reasoningLevel?: string
  compaction?: ChatConversationCompactionLike | null
  touchUpdatedAt?: boolean
}

export type RunYoloAgentInput = {
  conversationId: string
  messages: ChatMessage[]
  requestMessages?: ChatMessage[]
  conversationMessages?: ChatMessage[]
  compaction?: ChatConversationCompactionLike | null
  modelId?: string
  modelIds?: string[]
  assistantId?: string
  reasoningLevel?: ReasoningLevel
  branchTarget?: {
    branchId: string
    sourceUserMessageId: string
    branchLabel?: string
  }
  overrides?: ConversationOverrideSettings | null
}

export type YoloRuntime = YoloRuntimeCompatibilityBridge & {
  mode: YoloRuntimeMode
  pluginInfo: YoloPluginInfo
  settings: {
    get(): SmartComposerSettings
    update(next: SmartComposerSettings): Promise<void>
    subscribe(listener: (settings: SmartComposerSettings) => void): () => void
  }
  chat: {
    list(): Promise<YoloChatMetadata[]>
    get(id: string): Promise<YoloChatRecord | null>
    save(input: SaveYoloChatInput): Promise<void>
    delete(id: string): Promise<void>
    togglePinned(id: string): Promise<void>
    updateTitle(
      id: string,
      title: string,
      options?: { touchUpdatedAt?: boolean },
    ): Promise<void>
    generateTitle(id: string, messages: ChatMessage[]): Promise<void>
  }
  agent: {
    run(input: RunYoloAgentInput): Promise<void>
    abort(conversationId: string): Promise<void>
    subscribe(
      conversationId: string,
      listener: (state: AgentConversationState) => void,
    ): () => void
    getState(conversationId: string): AgentConversationState
    getConversationRunSummary(conversationId: string): AgentConversationRunSummary
    getMessages(conversationId: string): ChatMessage[]
    approveToolCall(input: {
      conversationId: string
      toolCallId: string
      allowForConversation?: boolean
    }): Promise<boolean>
    rejectToolCall(input: {
      conversationId: string
      toolCallId: string
    }): boolean
    abortToolCall(input: {
      conversationId: string
      toolCallId: string
    }): boolean
    replaceConversationMessages(
      conversationId: string,
      messages: ChatMessage[],
      compaction?: unknown,
      options?: { persistState?: boolean },
    ): void
    isRunning(conversationId: string): boolean
    subscribeToRunSummaries(
      callback: (summaries: Map<string, AgentConversationRunSummary>) => void,
    ): () => void
    subscribeToPendingExternalAgentResults(
      fn: (result: unknown) => void,
    ): () => void
  }
  vault: {
    getActiveFile(): YoloFileRef | null
    read(file: any): Promise<string>
    readBinary?(file: any): Promise<ArrayBuffer>
    search(query: string): Promise<YoloFileRef[]>
    listIndex?(): Promise<YoloVaultIndexEntry[]>
    getAbstractFileByPath(path: string): YoloFileRef | null
    getFileByPath(path: string): any
    createFolder(path: string): Promise<void>
    modify(file: any, content: string): Promise<void>
    create(path: string, content: string): Promise<void>
    trashFile(file: any): Promise<void>
    getLeavesOfType(type: string): unknown[]
    getLeaf(split: boolean): any
  }
  ui: {
    notice(message: string, timeoutMs?: number): void
    openSettings(tabId?: string): void
    openApplyReview(state: any): Promise<boolean>
  }
}
