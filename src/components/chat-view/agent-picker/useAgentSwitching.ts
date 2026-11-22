import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { ChatRuntimeId } from '../../../core/cli-runtime'

import {
  type AgentRef,
  getAgentRuntimeId,
  resolveCurrentAgentRef,
} from './agentRef'

type PendingAgentAction = { ref: AgentRef; newChat: boolean }

/**
 * 「换到某个 Agent」与「用某个 Agent 开新对话」的唯一实现，头部的 Agent
 * 选择器、侧边栏的新对话菜单和钉住的 Agent 都走这里。
 *
 * 同一运行时内直接生效：YOLO Agent 原地切换（`selectAssistant`），Hermes
 * profile 切换本身就会开新对话。跨运行时分两步：先切运行时，等
 * `activeRuntimeId` 真的变过来，再在新运行时里选具体的 Agent / 开新对话。
 * 运行时切换内部有异步的 CLI 会话交接，没法在同一个调用里接着做第二步。
 *
 * 待办的第二步放在 ref 里、执行前先清空：第二步（开新对话）本身会触发重渲染，
 * 而 effect 依赖的回调每次渲染都是新的。如果待办是 state，清空与重渲染的先后
 * 一旦错开，effect 就会拿着同一个待办反复开新对话，主线程卡死。
 */
export function useAgentSwitching({
  activeRuntimeId,
  conversationAssistantId,
  hermesProfileId,
  canUseCliRuntime,
  handleRuntimeChange,
  handleNewChat,
  selectAssistant,
  switchHermesProfile,
}: {
  activeRuntimeId: ChatRuntimeId
  conversationAssistantId: string
  hermesProfileId: string | undefined
  /** 本机 CLI 运行时可用；不可用时切到 CLI Agent 的请求直接忽略 */
  canUseCliRuntime: boolean
  handleRuntimeChange: (runtimeId: ChatRuntimeId) => void
  handleNewChat: () => void
  selectAssistant: (assistantId: string) => void
  switchHermesProfile: (profileId: string | undefined) => void
}) {
  const pendingRef = useRef<PendingAgentAction | null>(null)

  const currentAgent = useMemo(
    () =>
      resolveCurrentAgentRef({
        runtimeId: activeRuntimeId,
        assistantId: conversationAssistantId,
        hermesProfileId,
      }),
    [activeRuntimeId, conversationAssistantId, hermesProfileId],
  )

  /** 前提：当前运行时已经是这个 Agent 的运行时。 */
  const applyWithinRuntime = useCallback(
    ({ ref, newChat }: PendingAgentAction) => {
      switch (ref.kind) {
        case 'assistant':
          if (newChat) handleNewChat()
          selectAssistant(ref.assistantId)
          return
        case 'hermes':
          // 换 profile 本身就开一个该 profile 下的新对话
          if (ref.profileId !== hermesProfileId) {
            switchHermesProfile(ref.profileId)
            return
          }
          if (newChat) handleNewChat()
          return
        case 'cli':
          if (newChat) handleNewChat()
          return
      }
    },
    [handleNewChat, hermesProfileId, selectAssistant, switchHermesProfile],
  )

  const run = useCallback(
    (action: PendingAgentAction) => {
      const runtimeId = getAgentRuntimeId(action.ref)
      if (runtimeId === activeRuntimeId) {
        applyWithinRuntime(action)
        return
      }
      if (runtimeId !== 'yolo' && !canUseCliRuntime) return
      pendingRef.current = action
      handleRuntimeChange(runtimeId)
    },
    [
      activeRuntimeId,
      applyWithinRuntime,
      canUseCliRuntime,
      handleRuntimeChange,
    ],
  )

  // 运行时切换必然改变 activeRuntimeId，以它为触发即可
  useEffect(() => {
    const pending = pendingRef.current
    if (!pending) return
    if (activeRuntimeId !== getAgentRuntimeId(pending.ref)) return
    pendingRef.current = null
    applyWithinRuntime(pending)
  }, [activeRuntimeId, applyWithinRuntime])

  const switchAgent = useCallback(
    (ref: AgentRef) => run({ ref, newChat: false }),
    [run],
  )
  const startNewChatWithAgent = useCallback(
    (ref: AgentRef) => run({ ref, newChat: true }),
    [run],
  )

  return { currentAgent, switchAgent, startNewChatWithAgent }
}
