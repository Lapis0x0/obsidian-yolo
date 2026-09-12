import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AssistantRenderStreamValue } from '../../core/agent/assistantRenderStreamStore'
import { getNodeWindow } from '../../utils/dom/window-context'

import { useAssistantRenderStreamAccess } from './assistant-render-stream-context'

/**
 * 命令式文本源：token 到达只改写目标值并通知播放器，不进入 React。
 * 唯一的可见帧由消费者（StreamingMarkdown 的 rAF 播放循环）决定。
 */
export type StreamingContentSource = {
  getContent: () => string
  subscribe: (listener: () => void) => () => void
}

/**
 * `<think>` / `<yolo_block>` 会把一条消息切成多个块，块结构本身就是 React 结构，
 * 无法用命令式文本源驱动。只要正文里出现过标签，这条消息就退回逐次渲染的慢路径。
 * 普通聊天回复不含标签，走的是完全不进 React 的快路径。
 */
export const hasParsableTagMarkers = (content: string): boolean =>
  content.includes('<think>') || content.includes('<yolo_block')

/**
 * 与 `parseTagContents` 对块内容做的首尾换行修剪保持一致，这样快路径与慢路径
 * 渲染的是同一段文本，二者切换时不会跳字。
 */
export const trimBlockEdges = (content: string): string =>
  content.replace(/^\n|\n$/g, '')

type StreamedContent = {
  /** 渲染用的正文。`contentSource` 非 null 时它只是初值/回退值。 */
  content: string
  /** 非 null 表示正文由命令式源实时驱动。 */
  contentSource: StreamingContentSource | null
}

/**
 * 订阅一条生成中 assistant 消息的正文流。
 *
 * - 快路径（正文无标签、无 annotations）：token 到达只写目标值并通知播放器，
 *   完全不触发 React 渲染。
 * - 慢路径（出现标签 / 有 annotations / 生成世代切换）：退回按增量渲染，仍然
 *   只影响这一条消息的子树，不再牵动整份会话快照。
 */
export function useAssistantStreamedContent({
  conversationId,
  messageId,
  isStreaming,
  content,
  allowLiveSource,
}: {
  conversationId: string
  messageId: string
  isStreaming: boolean
  /** 会话快照里的折回值：最近一次结构事件时的正文。 */
  content: string
  /** annotations 等会重写正文的字段存在时必须关闭命令式源。 */
  allowLiveSource: boolean
}): StreamedContent {
  const access = useAssistantRenderStreamAccess()
  const enabled = isStreaming && access !== null

  const latestContentRef = useRef(content)
  const listenersRef = useRef(new Set<() => void>())
  // 快路径是否仍然成立。一旦正文里出现标签就关闭，直到生成世代切换。
  const liveSourceActiveRef = useRef(false)
  // 最近一次进入 React 的世代号。放在 ref 而不是依赖 state，避免每次渲染都
  // 重建订阅，也避免 setState 到 effect 重跑之间的陈旧闭包窗口。
  const renderedRevisionRef = useRef(0)
  const [rendered, setRendered] = useState<{
    content: string
    revision: number
    live: boolean
  }>(() => ({ content, revision: 0, live: false }))

  const getContent = useCallback(
    () => trimBlockEdges(latestContentRef.current),
    [],
  )
  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])
  const contentSource = useMemo<StreamingContentSource>(
    () => ({ getContent, subscribe }),
    [getContent, subscribe],
  )

  useEffect(() => {
    if (!enabled || !access) {
      liveSourceActiveRef.current = false
      return
    }

    const apply = (value: AssistantRenderStreamValue) => {
      latestContentRef.current = value.content
      const canStayLive =
        allowLiveSource &&
        liveSourceActiveRef.current &&
        value.revision === renderedRevisionRef.current &&
        !hasParsableTagMarkers(value.content)
      if (canStayLive) {
        for (const listener of [...listenersRef.current]) {
          listener()
        }
        return
      }

      renderedRevisionRef.current = value.revision
      liveSourceActiveRef.current =
        allowLiveSource && !hasParsableTagMarkers(value.content)
      const live = liveSourceActiveRef.current
      setRendered((previous) =>
        previous.content === value.content &&
        previous.revision === value.revision &&
        previous.live === live
          ? previous
          : { content: value.content, revision: value.revision, live },
      )
    }

    // 同步读一次当前值，关闭 render → effect 之间的丢更新窗口。
    const current = access.getAssistantRenderStream(conversationId, messageId)
    if (current) {
      apply(current)
    }
    return access.subscribeAssistantRenderStream(
      conversationId,
      messageId,
      apply,
    )
  }, [access, allowLiveSource, conversationId, enabled, messageId])

  if (!enabled) {
    return { content, contentSource: null }
  }
  // 流一旦承载了这条消息就以流为准；否则用快照里的结构折回值。
  const streamed = rendered.revision > 0 ? rendered.content : content
  return rendered.live
    ? { content: trimBlockEdges(streamed), contentSource }
    : { content: streamed, contentSource: null }
}

// 思考正文走命令式源，不再按节拍进 React。剩下要进 React 的只有「预览轨道要
// 显示哪段文字」和 stage 状态机读的那份文本——它们是 React 结构，无法用命令式
// 源驱动，因此仍按固定节拍采样，把 token 频率与渲染频率解耦。
const REASONING_STREAM_SAMPLE_MS = 64

type StreamedReasoning = {
  /**
   * 供 React 结构使用的思考文本：预览轨道的文字、stage 判定、是否可展开。
   * 按 REASONING_STREAM_SAMPLE_MS 采样，markdown 主体不读它。
   */
  reasoning: string
  /** 非 null 表示思考正文由命令式源实时驱动。 */
  reasoningSource: StreamingContentSource | null
}

/**
 * 订阅一条生成中 assistant 消息的思考流。
 *
 * 思考文本比正文简单：`<think>` / `<yolo_block>` 只出现在正文里，思考内容内部
 * 不会再嵌套它们，所以这里没有"出现标签就退回慢路径"的分支——生成期间命令式源
 * 恒为非 null，markdown 主体完全不进 React。世代切换（retry / resume）同样不必
 * 在这里判定：重写会让播放器读到的目标不再以当前可见文本为前缀，
 * `StreamingMarkdown` 自己就会放弃播放缓冲直接落位。
 *
 * `ownerNodeRef` 用于取节点所属窗口的定时器：popout 与主窗口是不同的
 * BrowserWindow，被遮挡窗口的 timer 会被节流。
 */
export function useAssistantStreamedReasoning({
  conversationId,
  messageId,
  isStreaming,
  reasoning,
  ownerNodeRef,
}: {
  conversationId?: string
  messageId?: string
  isStreaming: boolean
  /** 会话快照里的折回值：最近一次结构事件时的思考文本。 */
  reasoning: string
  ownerNodeRef: React.RefObject<HTMLElement>
}): StreamedReasoning {
  const access = useAssistantRenderStreamAccess()
  const enabled =
    isStreaming && access !== null && !!conversationId && !!messageId
  const latestReasoningRef = useRef(reasoning)
  const listenersRef = useRef(new Set<() => void>())
  const [sampled, setSampled] = useState<string | null>(null)

  const getContent = useCallback(() => latestReasoningRef.current, [])
  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])
  const reasoningSource = useMemo<StreamingContentSource>(
    () => ({ getContent, subscribe }),
    [getContent, subscribe],
  )

  useEffect(() => {
    if (!enabled || !access || !conversationId || !messageId) {
      setSampled(null)
      return
    }

    let timer: number | null = null
    let timerWindow: Window | null = null

    const flush = () => {
      timer = null
      setSampled(latestReasoningRef.current)
    }

    const apply = (value: AssistantRenderStreamValue) => {
      latestReasoningRef.current = value.reasoning
      // 命令式通道：只改写目标值并通知播放器，可见帧由播放器自己的 rAF 决定。
      for (const listener of [...listenersRef.current]) {
        listener()
      }
      if (timer !== null) {
        return
      }
      timerWindow = getNodeWindow(ownerNodeRef.current)
      timer = timerWindow.setTimeout(flush, REASONING_STREAM_SAMPLE_MS)
    }

    const current = access.getAssistantRenderStream(conversationId, messageId)
    if (current) {
      apply(current)
    }
    const unsubscribe = access.subscribeAssistantRenderStream(
      conversationId,
      messageId,
      apply,
    )

    return () => {
      unsubscribe()
      if (timer !== null) {
        ;(timerWindow ?? getNodeWindow(ownerNodeRef.current)).clearTimeout(
          timer,
        )
      }
    }
  }, [access, conversationId, enabled, messageId, ownerNodeRef])

  if (!enabled) {
    return { reasoning, reasoningSource: null }
  }
  return { reasoning: sampled ?? reasoning, reasoningSource }
}
