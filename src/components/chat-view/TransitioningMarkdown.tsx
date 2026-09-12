import { memo, useCallback, useEffect, useRef, useState } from 'react'

import { CitationSource } from '../../core/agent/citationRegistry'

import { ObsidianMarkdown } from './ObsidianMarkdown'
import StreamingMarkdown from './StreamingMarkdown'
import type { StreamingContentSource } from './useAssistantRenderStream'

type GenerationState = 'streaming' | 'completed' | 'aborted' | 'error'

const TransitioningMarkdown = memo(function TransitioningMarkdown({
  content,
  contentSource = null,
  scale = 'base',
  generationState,
  citationSources,
}: {
  content: string
  /**
   * 生成中的命令式文本源。非 null 就意味着文本还在增长，且 `content` 是落后的
   * 快照折回值——只有源被上游置空之后，`content` 才等于终态文本。
   */
  contentSource?: StreamingContentSource | null
  scale?: 'xs' | 'sm' | 'base'
  generationState?: GenerationState
  citationSources?: CitationSource[]
}) {
  const hasStreamed = useRef(false)
  /*
   * "文本还在增长"有两个独立来源，任一成立都必须留在播放器上：
   * - 挂着命令式源：文本从源里来，`content` 落后于它；
   * - 调用方把展示态标成 streaming：没有源时文本靠 `content` 一次次更新进来。
   *
   * 两者不能互相代替。思考块的 `generationState` 是它自己的展示态（正文一出字
   * 就翻成 settled，好让预览轨道停止脉动），但这时整条消息仍在生成、思考流仍然
   * 挂着源、文本仍可能继续来。只看展示态就会把实时源丢掉，展开的思考正文卡在
   * 快照值上，直到终态快照才一次跳到最终内容。
   */
  const isStreaming = generationState === 'streaming' || contentSource !== null
  const [drained, setDrained] = useState(false)
  const handleDrained = useCallback(() => setDrained(true), [])

  useEffect(() => {
    if (isStreaming) {
      setDrained(false)
    }
  }, [isStreaming])

  if (isStreaming) {
    hasStreamed.current = true
    return (
      <StreamingMarkdown
        content={content}
        contentSource={contentSource}
        scale={scale}
        animateIncrementalText
        citationSources={citationSources}
      />
    )
  }

  // The buffer still holds text the reader hasn't seen. Keep the same
  // StreamingMarkdown instance mounted so it can play the remainder out, rather
  // than swapping in the fully rendered message and making it appear at once.
  if (hasStreamed.current && !drained) {
    return (
      <StreamingMarkdown
        content={content}
        scale={scale}
        animateIncrementalText
        draining
        onDrained={handleDrained}
        citationSources={citationSources}
      />
    )
  }

  const initialFallback = hasStreamed.current ? (
    <StreamingMarkdown
      content={content}
      scale={scale}
      citationSources={citationSources}
    />
  ) : undefined

  return (
    <ObsidianMarkdown
      content={content}
      scale={scale}
      citationSources={citationSources}
      initialFallback={initialFallback}
    />
  )
})

export default TransitioningMarkdown
