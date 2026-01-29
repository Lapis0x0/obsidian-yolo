import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { parseTagContents } from '../../utils/chat/parse-tag-content'
import DotLoader from '../common/DotLoader'

import { ObsidianMarkdown } from './ObsidianMarkdown'

const AssistantMessageReasoning = memo(function AssistantMessageReasoning({
  reasoning,
  content,
  generationState,
  MarkdownComponent = ObsidianMarkdown,
}: {
  reasoning: string
  content: string
  generationState?: 'streaming' | 'completed' | 'aborted'
  MarkdownComponent?: React.ComponentType<{
    content: string
    scale?: 'xs' | 'sm' | 'base'
  }>
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const hasUserInteracted = useRef(false)

  const hasAnswerContent = useMemo(() => {
    const blocks = parseTagContents(content)
    return blocks.some((block) => {
      if (block.type === 'think') return false
      if (block.type === 'smtcmp_block') {
        return block.content.trim().length > 0
      }
      return block.content.trim().length > 0
    })
  }, [content])

  const hasReasoningText = useMemo(
    () => reasoning.trim().length > 0,
    [reasoning],
  )
  const previousHasReasoningText = useRef(hasReasoningText)
  const previousReasoning = useRef(reasoning)
  const isStreaming = generationState ? generationState === 'streaming' : true
  const [showLoader, setShowLoader] = useState(() =>
    generationState ? isStreaming && !hasAnswerContent : !hasAnswerContent,
  )

  useEffect(() => {
    if (generationState && generationState !== 'streaming') {
      setShowLoader(false)
    }
  }, [generationState])

  useEffect(() => {
    if (
      !hasUserInteracted.current &&
      !previousHasReasoningText.current &&
      hasReasoningText
    ) {
      setIsExpanded(true)
    }
    previousHasReasoningText.current = hasReasoningText
  }, [hasReasoningText])

  useEffect(() => {
    if (previousReasoning.current === reasoning) {
      return
    }

    const previousLength = previousReasoning.current.trim().length
    const currentLength = reasoning.trim().length
    previousReasoning.current = reasoning

    if (currentLength > previousLength && !showLoader && isStreaming) {
      setShowLoader(true)
    }
  }, [reasoning, showLoader, isStreaming])

  useEffect(() => {
    if (!hasAnswerContent && isStreaming) {
      if (!showLoader) {
        setShowLoader(true)
      }
      return
    }

    if (!showLoader) {
      return
    }

    const timer = setTimeout(() => {
      setShowLoader(false)
      if (!hasUserInteracted.current) {
        setIsExpanded(false)
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [hasAnswerContent, showLoader])

  const handleToggle = () => {
    hasUserInteracted.current = true
    setIsExpanded(!isExpanded)
  }

  return (
    <div className="smtcmp-assistant-message-metadata">
      <div
        className="smtcmp-assistant-message-metadata-toggle"
        onClick={handleToggle}
      >
        <span>
          {showLoader ? 'Reasoning' : 'Reasoned'}{' '}
          {showLoader && <DotLoader variant="dots" />}
        </span>
        {isExpanded ? (
          <ChevronUp className="smtcmp-assistant-message-metadata-toggle-icon" />
        ) : (
          <ChevronDown className="smtcmp-assistant-message-metadata-toggle-icon" />
        )}
      </div>
      {isExpanded && (
        <div className="smtcmp-assistant-message-metadata-content">
          <MarkdownComponent content={reasoning} scale="xs" />
        </div>
      )}
    </div>
  )
})

export default AssistantMessageReasoning
