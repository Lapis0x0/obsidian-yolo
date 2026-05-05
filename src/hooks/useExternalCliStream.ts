// 订阅外部 CLI 流式事件的 React hook
// 先通过 getSnapshot 补齐历史，再订阅后续 push；50ms 节流避免每 chunk 一次 setState

import { App } from 'obsidian'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { ExternalCliSnapshot } from '../core/agent/external-cli/streamBus'
import { externalCliStreamBus } from '../core/agent/external-cli/streamBus'
import { loadExternalAgentProgress } from '../database/json/chat/externalAgentProgressStore'
import type { SmartComposerSettings } from '../settings/schema/setting.types'

const THROTTLE_MS = 50

export type ExternalCliViewSnapshot =
  | (ExternalCliSnapshot & { source: 'live' })
  | {
      stderr: string
      stdout: ''
      status: 'done'
      source: 'historical'
      truncated?: { totalBytes: number; omittedBytes: number }
    }

/**
 * 订阅指定 toolCallId 的流式输出，支持历史会话从磁盘缓存加载进度日志。
 *
 * 返回语义：
 * - `null`  → 历史会话且磁盘无缓存，应走静态渲染路径
 * - source === 'live'       → 当前正在运行或已结束的实时快照
 * - source === 'historical' → 历史会话，从磁盘缓存加载的进度日志
 */
export function useExternalCliStream(
  toolCallId: string,
  opts: { app: App; settings?: SmartComposerSettings },
): ExternalCliViewSnapshot | null {
  const { app, settings } = opts

  const [snapshot, setSnapshot] = useState<ExternalCliViewSnapshot | null>(
    () => {
      const live = externalCliStreamBus.getSnapshot(toolCallId)
      if (live !== null) return { ...live, source: 'live' }
      return null
    },
  )

  // 节流定时器 ref
  const pendingRef = useRef<ExternalCliSnapshot | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    timerRef.current = null
    if (pendingRef.current !== null) {
      setSnapshot({ ...pendingRef.current, source: 'live' })
      pendingRef.current = null
    }
  }, [])

  useEffect(() => {
    // stale guard: prevents async load from updating state after unmount or toolCallId change
    let cancelled = false

    pendingRef.current = null
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const initial = externalCliStreamBus.getSnapshot(toolCallId)
    if (initial !== null) {
      setSnapshot({ ...initial, source: 'live' })
    } else {
      setSnapshot(null)
      // 历史会话：异步从磁盘缓存加载进度日志
      void loadExternalAgentProgress({ app, settings, toolCallId })
        .then((stored) => {
          if (cancelled) return
          // 防御：load 完成时若 bus 已出现 live snapshot，让 subscribe 回调驱动，不要被 historical 盖掉
          if (externalCliStreamBus.getSnapshot(toolCallId) !== null) return
          if (!stored) return
          setSnapshot({
            stderr: stored.progressText,
            stdout: '',
            status: 'done',
            source: 'historical',
            ...(stored.truncated ? { truncated: stored.truncated } : {}),
          })
        })
        .catch(() => {
          // load 失败保持 null
        })
    }

    // 始终订阅：即使初始无 snapshot，runner 后续也可能 push（防御历史 → live 的边角 race）
    const unsubscribe = externalCliStreamBus.subscribe(toolCallId, () => {
      pendingRef.current = externalCliStreamBus.getSnapshot(toolCallId)
      if (!timerRef.current) {
        timerRef.current = setTimeout(flush, THROTTLE_MS)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [toolCallId, app, settings, flush])

  return snapshot
}
