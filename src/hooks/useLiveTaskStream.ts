// 订阅实时任务流事件的 React hook。
// 先通过 getSnapshot 补齐历史，再订阅后续 push；50ms 节流避免每 chunk 一次 setState。

import { useCallback, useEffect, useRef, useState } from 'react'

import type { LiveTaskStreamSnapshot } from '../core/agent/live-stream/taskStreamBus'
import { liveTaskStreamBus } from '../core/agent/live-stream/taskStreamBus'

const THROTTLE_MS = 50

export type LiveTaskViewSnapshot =
  | (LiveTaskStreamSnapshot & { source: 'live' })
  | {
      stderr: string
      stdout: ''
      status: 'done'
      source: 'historical'
      truncated?: { totalBytes: number; omittedBytes: number }
    }

export function useLiveTaskStream(
  toolCallId: string,
): LiveTaskViewSnapshot | null {
  const [snapshot, setSnapshot] = useState<LiveTaskViewSnapshot | null>(() => {
    const live = liveTaskStreamBus.getSnapshot(toolCallId)
    if (live !== null) return { ...live, source: 'live' }
    return null
  })

  const pendingRef = useRef<LiveTaskStreamSnapshot | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    timerRef.current = null
    if (pendingRef.current !== null) {
      setSnapshot({ ...pendingRef.current, source: 'live' })
      pendingRef.current = null
    }
  }, [])

  useEffect(() => {
    pendingRef.current = null
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const initial = liveTaskStreamBus.getSnapshot(toolCallId)
    if (initial !== null) {
      setSnapshot({ ...initial, source: 'live' })
    } else {
      setSnapshot(null)
    }

    const unsubscribe = liveTaskStreamBus.subscribe(toolCallId, () => {
      pendingRef.current = liveTaskStreamBus.getSnapshot(toolCallId)
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
