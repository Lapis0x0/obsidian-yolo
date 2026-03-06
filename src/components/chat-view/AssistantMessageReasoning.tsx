import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { parseTagContents } from '../../utils/chat/parse-tag-content'
import DotLoader from '../common/DotLoader'

import { ObsidianMarkdown } from './ObsidianMarkdown'

type ReasoningStage = 'requesting' | 'thinking' | 'generating' | 'settled'

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
  const { t } = useLanguage()
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
  const isStreaming = generationState === 'streaming'
  const [showActivity, setShowActivity] = useState(
    () => isStreaming && (!hasAnswerContent || !hasReasoningText),
  )

  const stage = useMemo<ReasoningStage>(() => {
    if (isStreaming && !hasReasoningText && !hasAnswerContent) {
      return 'requesting'
    }
    if (isStreaming && !hasAnswerContent && hasReasoningText) {
      return 'thinking'
    }
    if (isStreaming && hasAnswerContent) {
      return 'generating'
    }
    return 'settled'
  }, [hasAnswerContent, hasReasoningText, isStreaming])

  const stageLabel = useMemo(() => {
    if (stage === 'requesting') {
      return t('quickAsk.statusRequesting', 'Requesting...')
    }
    if (stage === 'thinking') {
      return t('quickAsk.statusThinking', 'Thinking...')
    }
    if (stage === 'generating') {
      return t('quickAsk.statusGenerating', 'Generating...')
    }
    return t('chat.reasoning', 'Reasoning')
  }, [stage, t])

  const isToggleable = hasReasoningText
  const showBody = hasReasoningText && isExpanded
  const showDots = showActivity

  useEffect(() => {
    if (!isStreaming) {
      setShowActivity(false)
    }
  }, [isStreaming])

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

    if (currentLength > previousLength && !showActivity && isStreaming) {
      setShowActivity(true)
    }
  }, [reasoning, showActivity, isStreaming])

  useEffect(() => {
    if (!isStreaming) {
      return
    }

    if (!hasAnswerContent || !hasReasoningText) {
      if (!showActivity) {
        setShowActivity(true)
      }
      return
    }

    if (!showActivity) {
      return
    }

    const timer = setTimeout(() => {
      setShowActivity(false)
      if (!hasUserInteracted.current) {
        setIsExpanded(false)
      }
    }, 420)

    return () => clearTimeout(timer)
  }, [hasAnswerContent, hasReasoningText, isStreaming, showActivity])

  const handleToggle = () => {
    if (!isToggleable) return
    hasUserInteracted.current = true
    setIsExpanded(!isExpanded)
  }

  return (
    <div
      className={`smtcmp-assistant-message-metadata smtcmp-assistant-message-metadata--${stage}${showBody ? ' is-expanded' : ''}${showActivity ? ' is-active' : ''}`}
      data-stage={stage}
    >
      <button
        type="button"
        className={`smtcmp-assistant-message-metadata-toggle${!isToggleable ? ' is-static' : ''}`}
        onClick={handleToggle}
        disabled={!isToggleable}
      >
        <span className="smtcmp-assistant-message-metadata-label">
          <span className="smtcmp-assistant-message-metadata-status-dot" />
          <span className="smtcmp-assistant-message-metadata-label-text">
            {stageLabel}
          </span>
          {showDots && (
            <DotLoader
              variant="dots"
              className="smtcmp-assistant-message-metadata-loader"
            />
          )}
        </span>
        {isToggleable && isExpanded ? (
          <ChevronUp className="smtcmp-assistant-message-metadata-toggle-icon" />
        ) : isToggleable ? (
          <ChevronDown className="smtcmp-assistant-message-metadata-toggle-icon" />
        ) : null}
      </button>
      <div className="smtcmp-assistant-message-metadata-body">
        <div className="smtcmp-assistant-message-metadata-content">
          <MarkdownComponent content={reasoning} scale="xs" />
        </div>
      </div>
    </div>
  )
})

export default AssistantMessageReasoning
