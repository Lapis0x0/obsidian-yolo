import { MutableRefObject, useCallback, useEffect } from 'react'

import type { ChatRuntimeId, CliSessionRef } from '../../core/cli-runtime'
import type { ChatUserMessage } from '../../types/chat'
import type { ConversationOverrideSettings } from '../../types/conversation-settings.types'
import type { ReasoningLevel } from '../../types/reasoning'

import type { ChatRuntimeSnapshot } from './Chat'
import type { ChatMode } from './chat-input/ChatModeSelect'

export type UseChatRuntimeSnapshotParams = {
  /** 每当影响 ChatRuntimeSnapshot 的 state 变化时上报当前快照。 */
  onRuntimeSnapshotChange: ((snapshot: ChatRuntimeSnapshot) => void) | undefined

  activeRuntimeId: ChatRuntimeId
  cliSessionRef: CliSessionRef | null | undefined
  cliConversationId: string | null
  currentConversationId: string
  /** 未直接读取——只作为依赖项,驱动 buildRuntimeSnapshot 在草稿变化时刷新。 */
  inputMessage: ChatUserMessage
  getLatestInputMessage: () => ChatUserMessage
  inputDraftRevisionRef: MutableRefObject<number>
  conversationModelId: string
  conversationAssistantId: string
  chatMode: ChatMode
  persistedChatMode: ChatMode
  yoloEnabled: boolean
  reasoningLevel: ReasoningLevel
  conversationOverrides: ConversationOverrideSettings | null
}

/**
 * 一份足以让 Chat 在 host DOM 被替换后无缝重建的 React state 快照的组装
 * 与上报。横跨 useChatRuntimePreferences / useCliRuntimeOrchestration /
 * useChatInputController 的输出，必须在它们之后调用。
 *
 * `buildRuntimeSnapshot` 同时供内部的上报 effect 与 Chat.tsx
 * `useImperativeHandle` 的 `getRuntimeSnapshot` 复用——两者原先是完全相同
 * 的字面量，这里去重为单一实现。
 */
export function useChatRuntimeSnapshot({
  onRuntimeSnapshotChange,
  activeRuntimeId,
  cliSessionRef,
  cliConversationId,
  currentConversationId,
  inputMessage,
  getLatestInputMessage,
  inputDraftRevisionRef,
  conversationModelId,
  conversationAssistantId,
  chatMode,
  persistedChatMode,
  yoloEnabled,
  reasoningLevel,
  conversationOverrides,
}: UseChatRuntimeSnapshotParams) {
  const buildRuntimeSnapshot = useCallback(
    (): ChatRuntimeSnapshot => ({
      activeRuntimeId,
      cliSessionRef: cliSessionRef ?? null,
      cliConversationId,
      currentConversationId,
      inputMessage: getLatestInputMessage(),
      inputDraftRevision: inputDraftRevisionRef.current,
      conversationModelId,
      conversationAssistantId,
      chatMode,
      persistedChatMode,
      yoloEnabled,
      reasoningLevel,
      conversationOverrides,
    }),
    [
      activeRuntimeId,
      chatMode,
      persistedChatMode,
      cliConversationId,
      cliSessionRef,
      conversationAssistantId,
      conversationModelId,
      conversationOverrides,
      currentConversationId,
      getLatestInputMessage,
      inputDraftRevisionRef,
      // inputMessage 未在函数体内直接读取(改经 getLatestInputMessage() 读取
      // 最新草稿),但需要作为依赖项驱动本回调在草稿变化时换新引用,与迁移前
      // onRuntimeSnapshotChange effect 的依赖数组语义保持一致。
      inputMessage,
      reasoningLevel,
      yoloEnabled,
    ],
  )

  // 把当前可重建态实时上报给 ChatView，供 host DOM 被替换（pop-out / dock
  // back）时无缝重建 React tree。仅副作用：上报快照；不要在这里改 state。
  useEffect(() => {
    if (!onRuntimeSnapshotChange) return
    onRuntimeSnapshotChange(buildRuntimeSnapshot())
  }, [onRuntimeSnapshotChange, buildRuntimeSnapshot])

  return { buildRuntimeSnapshot }
}
