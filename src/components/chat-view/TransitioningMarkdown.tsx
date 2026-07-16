import { memo, useRef } from 'react'

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
