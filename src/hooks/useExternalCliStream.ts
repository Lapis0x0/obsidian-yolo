// 订阅外部 CLI 流式事件的 React hook
// 先通过 getSnapshot 补齐历史，再订阅后续 push；50ms 节流避免每 chunk 一次 setState

import { useCallback, useEffect, useRef, useState } from 'react'

import type { ExternalCliSnapshot } from '../core/agent/external-cli/streamBus'
import { externalCliStreamBus } from '../core/agent/external-cli/streamBus'

const THROTTLE_MS = 50

/**
 * 订阅指定 toolCallId 的流式输出。
 *
 * 返回语义：
 * - `null`  → 该 id 从未注册过，说明是历史会话消息，应走静态渲染路径
 * - 非 null → 当前正在运行或已结束的实时快照
 */
export function useExternalCliStream(
  toolCallId: string,
): ExternalCliSnapshot | null {
  const [snapshot, setSnapshot] = useState<ExternalCliSnapshot | null>(() =>
    // 挂载时先拿一次历史快照
    externalCliStreamBus.getSnapshot(toolCallId),
  )

  // 节流定时器 ref
  const pendingRef = useRef<ExternalCliSnapshot | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    timerRef.current = null
    if (pendingRef.current !== null) {
      setSnapshot({ ...pendingRef.current })
      pendingRef.current = null
    }
  }, [])

  useEffect(() => {
    // 每次 toolCallId 变化都重新同步快照
    const current = externalCliStreamBus.getSnapshot(toolCallId)
    setSnapshot(current)
    pendingRef.current = null
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    // 如果快照不存在（历史会话），不订阅
    if (current === null) return

    const unsubscribe = externalCliStreamBus.subscribe(toolCallId, () => {
      // 每次事件都拿最新快照，用节流批量 setState
      pendingRef.current = externalCliStreamBus.getSnapshot(toolCallId)
      if (!timerRef.current) {
        timerRef.current = setTimeout(flush, THROTTLE_MS)
      }
    })

    return () => {
      unsubscribe()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [toolCallId, flush])

  return snapshot
}
