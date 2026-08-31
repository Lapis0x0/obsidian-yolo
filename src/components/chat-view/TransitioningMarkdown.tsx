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
   * 生成中的命令式文本源。只在 streaming 分支下传给 StreamingMarkdown：
   * 流结束后源会被上游置空，`content` 恰好等于终态文本，播放缓冲无缝接管。
   */
  contentSource?: StreamingContentSource | null
  scale?: 'xs' | 'sm' | 'base'
  generationState?: GenerationState
  citationSources?: CitationSource[]
}) {
  const hasStreamed = useRef(false)
  const isStreaming = generationState === 'streaming'
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
