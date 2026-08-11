import { useCallback, useRef, useSyncExternalStore } from 'react'

import type {
  AgentConversationState,
  AgentService,
} from '../../core/agent/service'

/**
 * `useSyncExternalStore` 适配器：订阅单个会话在 `AgentService`（插件级
 * 单例，权威状态源）中的状态，不在 React 侧维护 `useState` 镜像。
 *
 * `AgentService.getState`/`subscribe` 在每次调用/发布时都会克隆出一个新的
 * 顶层 `AgentConversationState` 对象（`messages`/`compaction` 数组也是新
 * 数组），但数组内部未变化的消息对象引用保持不变——这是仓库不变式
 * （见 CLAUDE.md「消息对象引用变 ⟺ 内容变」）在克隆层面的体现。
 *
 * 因此本 hook 把「最近一次拿到的克隆」缓存在 ref 里：`getSnapshot` 只读
 * 缓存，从不在渲染期间重新调用 `getState` 构造新对象；只有
 * `conversationId` 变化（重新订阅）或 `subscribe` 的回调真正触发（一次
 * AgentService publish）时才刷新缓存。这样同一渲染 epoch 内多次调用
 * `getSnapshot` 返回同一引用，满足 `useSyncExternalStore` 的稳定性要求。
 */
export function useAgentConversationState(
  agentService: Pick<AgentService, 'subscribe' | 'getState'>,
  conversationId: string,
): AgentConversationState {
  const cacheRef = useRef<{
    conversationId: string
    state: AgentConversationState
  } | null>(null)

  const getSnapshot = useCallback((): AgentConversationState => {
    if (
      !cacheRef.current ||
      cacheRef.current.conversationId !== conversationId
    ) {
      cacheRef.current = {
        conversationId,
        state: agentService.getState(conversationId),
      }
    }
    return cacheRef.current.state
  }, [agentService, conversationId])

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      agentService.subscribe(
        conversationId,
        (state) => {
          cacheRef.current = { conversationId, state }
          onStoreChange()
        },
        // 上面的 getSnapshot 已经在 id 变化时同步取过一次最新状态，这里
        // 不需要 AgentService 再补发一次当前值。
        { emitCurrent: false },
      ),
    [agentService, conversationId],
  )

  return useSyncExternalStore(subscribe, getSnapshot)
}
