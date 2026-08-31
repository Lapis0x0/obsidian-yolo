import { resolveAssistantModelId } from '../../core/agent/assistant-model'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { ReasoningLevel } from '../../types/reasoning'

import {
  type BuiltinChatMode,
  type ChatMode,
  chatModeForSave,
  isAgentChatMode,
  isModuleChatMode,
} from './chat-input/ChatModeSelect'

/**
 * 与 React `Dispatch<SetStateAction<T>>` 同构——命令方法既能替换原
 * `useState` setter 直接下发给消费 hook 的 props（接受 updater 函数），
 * 也能接受一个字面值。
 */
export type SetStateActionLike<T> = T | ((prev: T) => T)

export type ConversationPreferencesSnapshot = {
  conversationModelId: string
  conversationAssistantId: string
  reasoningLevel: ReasoningLevel
  chatMode: ChatMode
  /** Persisted (never runtime-downgraded) chat mode — see `chatModeForSave`. */
  persistedChatMode: ChatMode
  yoloEnabled: boolean
  conversationOverrides: ConversationOverrideSettings | null
}

export type ConversationPreferencesControllerDeps = {
  /**
   * 长期存活对象必须经 getter 读取当前 settings，不缓存闭包——见
   * CLAUDE.md「Runtime Boundaries」。
   */
  getSettings: () => YoloSettings
  getReasoningLevelForModelId: (modelId?: string | null) => ReasoningLevel
  persistPreferredAssistantId: (assistantId: string) => void
  persistPreferredChatMode: (mode: BuiltinChatMode) => void
}

type Listener = () => void
type AssistantDefaultModelListener = (reasoningLevel: ReasoningLevel) => void

function resolveNext<T>(action: SetStateActionLike<T>, prev: T): T {
  return typeof action === 'function'
    ? (action as (prev: T) => T)(prev)
    : action
}

/**
 * 会话级偏好七件套（conversationModelId / conversationAssistantId /
 * reasoningLevel / chatMode / persistedChatMode / yoloEnabled /
 * conversationOverrides）及各自的每会话 Ref 缓存的唯一 owner。
 *
 * 见 docs/plans/2026-08-11-arch-governance-step3-chat-state-ownership.md
 * 「分期 B」。普通 TS class，零 React 依赖——由
 * `useChatRuntimePreferences` 经 `useSyncExternalStore` 订阅，每个 ChatView
 * 实例持有一个（随 Chat.tsx 组件创建/销毁，不是全局单例，保证多窗口隔离）。
 *
 * 对外分两层：
 * - 「原始字段 setter」（`setConversationModelId` 等，`SetStateActionLike`
 *   形态）：与原 `useState` setter 同构，供 `useYoloChatSession` /
 *   `useCliRuntimeOrchestration` / `useChatDomainActions` 等消费 hook 的
 *   会话生命周期逻辑（加载会话、新建会话、分支复制）直接替换原 setter 使用，
 *   不附带级联或持久化——这些调用点写的是「初始化/恢复到某个值」，不是
 *   「用户发起了一次偏好变更」。
 * - 「语义命令」（`selectAssistant` / `changeChatMode` / `toggleYolo` /
 *   `applyAssistantDefaultModel` / `switchConversation`）：对应今天
 *   `useChatRuntimePreferences` 里同名 handler 的完整语义（字段变更 + Ref
 *   缓存写入 + 覆盖项合并 + 持久化回调 + 级联），供真正的用户操作入口使用。
 */
export class ConversationPreferencesController {
  private snapshot: ConversationPreferencesSnapshot
  private currentConversationId: string
  private readonly listeners = new Set<Listener>()
  private readonly assistantDefaultModelListeners =
    new Set<AssistantDefaultModelListener>()

  readonly conversationModelIdRef: { current: Map<string, string> } = {
    current: new Map(),
  }
  readonly conversationReasoningLevelRef: {
    current: Map<string, ReasoningLevel>
  } = { current: new Map() }
  readonly conversationAssistantIdRef: { current: Map<string, string> } = {
    current: new Map(),
  }
  readonly conversationOverridesRef: {
    current: Map<string, ConversationOverrideSettings | null>
  } = { current: new Map() }

  constructor(
    initialConversationId: string,
    initialSnapshot: ConversationPreferencesSnapshot,
    private readonly deps: ConversationPreferencesControllerDeps,
  ) {
    this.currentConversationId = initialConversationId
    this.snapshot = initialSnapshot
  }

  getSnapshot = (): ConversationPreferencesSnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * `applyAssistantDefaultModel` 触达输入层（写回草稿 reasoningLevel）的
   * 一次性事件订阅点——取代原 `ChatRuntimePreferencesLateState.setInputMessage`
   * 反向依赖。由 Chat.tsx 在 `setInputMessage` 可用后连接。
   */
  onAssistantDefaultModelApplied = (
    listener: AssistantDefaultModelListener,
  ): (() => void) => {
    this.assistantDefaultModelListeners.add(listener)
    return () => {
      this.assistantDefaultModelListeners.delete(listener)
    }
  }

  /** 每次渲染同步——供后续命令正确地为 Ref 缓存定位会话 id。 */
  setActiveConversationId(conversationId: string): void {
    this.currentConversationId = conversationId
  }

  private commit(partial: Partial<ConversationPreferencesSnapshot>): void {
    const keys = Object.keys(
      partial,
    ) as (keyof ConversationPreferencesSnapshot)[]
    const changed = keys.some(
      (key) => !Object.is(this.snapshot[key], partial[key]),
    )
    if (!changed) return
    this.snapshot = { ...this.snapshot, ...partial }
    this.listeners.forEach((listener) => listener())
  }

  private emitAssistantDefaultModelApplied(level: ReasoningLevel): void {
    this.assistantDefaultModelListeners.forEach((listener) => listener(level))
  }

  // === 原始字段 setter：Dispatch<SetStateAction<T>> 同构，供其余消费 hook
  // 的会话生命周期逻辑直接替换原 useState setter。===

  setConversationModelId = (action: SetStateActionLike<string>): void => {
    this.commit({
      conversationModelId: resolveNext(
        action,
        this.snapshot.conversationModelId,
      ),
    })
  }

  setConversationAssistantId = (action: SetStateActionLike<string>): void => {
    this.commit({
      conversationAssistantId: resolveNext(
        action,
        this.snapshot.conversationAssistantId,
      ),
    })
  }

  setReasoningLevel = (action: SetStateActionLike<ReasoningLevel>): void => {
    this.commit({
      reasoningLevel: resolveNext(action, this.snapshot.reasoningLevel),
    })
  }

  setChatMode = (action: SetStateActionLike<ChatMode>): void => {
    this.commit({ chatMode: resolveNext(action, this.snapshot.chatMode) })
  }

  setPersistedChatMode = (action: SetStateActionLike<ChatMode>): void => {
    this.commit({
      persistedChatMode: resolveNext(action, this.snapshot.persistedChatMode),
    })
  }

  setYoloEnabled = (action: SetStateActionLike<boolean>): void => {
    this.commit({
      yoloEnabled: resolveNext(action, this.snapshot.yoloEnabled),
    })
  }

  applyOverrides = (
    action: SetStateActionLike<ConversationOverrideSettings | null>,
  ): void => {
    this.commit({
      conversationOverrides: resolveNext(
        action,
        this.snapshot.conversationOverrides,
      ),
    })
  }

  // === 语义命令：既有 handleXxx/applyXxx 的直接等价物 ===

  /**
   * 等价于原 `applyAssistantDefaultModel`：assistant 携带默认模型时，把该
   * 模型与其对应的 reasoningLevel 应用到当前会话，并写入 Ref 缓存。触发
   * `onAssistantDefaultModelApplied` 事件，供输入层同步草稿 reasoningLevel。
   */
  applyAssistantDefaultModel = (assistantModelId?: string | null): void => {
    if (!assistantModelId) return
    const settings = this.deps.getSettings()
    const matchedModel = settings.chatModels.find(
      (model) => model.id === assistantModelId,
    )
    if (!matchedModel) return

    this.setConversationModelId(assistantModelId)
    this.conversationModelIdRef.current.set(
      this.currentConversationId,
      assistantModelId,
    )
    const nextReasoningLevel =
      this.deps.getReasoningLevelForModelId(assistantModelId)
    this.setReasoningLevel(nextReasoningLevel)
    this.conversationReasoningLevelRef.current.set(
      this.currentConversationId,
      nextReasoningLevel,
    )
    this.emitAssistantDefaultModelApplied(nextReasoningLevel)
  }

  /** 等价于原 `handleConversationAssistantSelect`。 */
  selectAssistant = (assistantId: string): void => {
    this.setConversationAssistantId(assistantId)
    this.conversationAssistantIdRef.current.set(
      this.currentConversationId,
      assistantId,
    )
    this.deps.persistPreferredAssistantId(assistantId)
    const settings = this.deps.getSettings()
    const assistant =
      settings.assistants.find((item) => item.id === assistantId) ?? null
    this.applyAssistantDefaultModel(
      resolveAssistantModelId(assistant?.modelId, settings.chatModelId),
    )
  }

  /**
   * 等价于原 `handleChatModeChange`（含 `applyChatModeChange`）：这是唯一
   * 会更新 `persistedChatMode` 的入口——用户驱动的选择按构造既是当前生效值
   * 也是应持久化的值。
   */
  changeChatMode = (nextMode: ChatMode): void => {
    this.setChatMode(nextMode)
    this.setPersistedChatMode(nextMode)
    const nextOverrides = {
      ...(this.snapshot.conversationOverrides ?? {}),
      chatMode: chatModeForSave(nextMode),
    }
    this.applyOverrides(nextOverrides)
    this.conversationOverridesRef.current.set(
      this.currentConversationId,
      nextOverrides,
    )

    // 全局 settings 永不学习 module chat mode——只有会话覆盖（上面已写入）
    // 会。module 可能被卸载，全局默认值不能指向它。
    if (!isModuleChatMode(nextMode)) {
      this.deps.persistPreferredChatMode(nextMode as BuiltinChatMode)
    }

    const settings = this.deps.getSettings()
    const assistant =
      settings.assistants.find(
        (item) => item.id === this.snapshot.conversationAssistantId,
      ) ?? null
    if (
      isAgentChatMode(nextMode) &&
      assistant?.modelId &&
      this.snapshot.conversationModelId === settings.chatModelId
    ) {
      this.applyAssistantDefaultModel(assistant.modelId)
    }
  }

  /**
   * 等价于原 `applyYoloChange`（不含确认弹窗——弹窗触达 Obsidian UI，留在
   * React/host 层的 `handleYoloChange` 包装器里）。
   */
  toggleYolo = (enabled: boolean): void => {
    this.setYoloEnabled(enabled)
    const nextOverrides = {
      ...(this.snapshot.conversationOverrides ?? {}),
      agentYoloEnabled: enabled,
    }
    this.applyOverrides(nextOverrides)
    this.conversationOverridesRef.current.set(
      this.currentConversationId,
      nextOverrides,
    )
  }

  /**
   * 会话切换（加载已有会话 / 新建会话 / 分支复制）时一次性提交七件套中被
   * 恢复的字段，并同步写入对应 Ref 缓存——取代调用方原先「setX + 手动
   * ref.set」的逐字段散落写法。只提交调用方实际给出的字段；未给出的字段
   * 保持不变（调用方通常一次性给出全部七个字段，但不强制）。
   */
  switchConversation = (
    conversationId: string,
    values: Partial<ConversationPreferencesSnapshot>,
  ): void => {
    this.currentConversationId = conversationId
    this.commit(values)
    if (values.conversationModelId !== undefined) {
      this.conversationModelIdRef.current.set(
        conversationId,
        values.conversationModelId,
      )
    }
    if (values.conversationAssistantId !== undefined) {
      this.conversationAssistantIdRef.current.set(
        conversationId,
        values.conversationAssistantId,
      )
    }
    if (values.reasoningLevel !== undefined) {
      this.conversationReasoningLevelRef.current.set(
        conversationId,
        values.reasoningLevel,
      )
    }
    if (values.conversationOverrides !== undefined) {
      this.conversationOverridesRef.current.set(
        conversationId,
        values.conversationOverrides,
      )
    }
  }
}
