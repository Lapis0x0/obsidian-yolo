import { memo, useCallback, useEffect, useRef, useState } from 'react'

import { CitationSource } from '../../core/agent/citationRegistry'

import { ObsidianMarkdown } from './ObsidianMarkdown'
import StreamingMarkdown from './StreamingMarkdown'

type GenerationState = 'streaming' | 'completed' | 'aborted' | 'error'

const TransitioningMarkdown = memo(function TransitioningMarkdown({
  content,
  scale = 'base',
  generationState,
  citationSources,
}: {
  content: string
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
