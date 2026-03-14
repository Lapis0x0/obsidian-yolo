import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import DotLoader from '../common/DotLoader'

import { ObsidianMarkdown } from './ObsidianMarkdown'
import StreamingMarkdown from './StreamingMarkdown'

type ReasoningStage =
  | 'requesting'
  | 'thinking'
  | 'generating'
  | 'error'
  | 'settled'

const AssistantMessageReasoning = memo(function AssistantMessageReasoning({
  reasoning,
  hasAnswerContent,
  generationState,
  MarkdownComponent,
}: {
  reasoning: string
  hasAnswerContent: boolean
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
  MarkdownComponent?: React.ComponentType<{
    content: string
    scale?: 'xs' | 'sm' | 'base'
    animateIncrementalText?: boolean
  }>
}) {
  const { t } = useLanguage()
  const EffectiveMarkdownComponent =
    MarkdownComponent ??
    (generationState === 'streaming' ? StreamingMarkdown : ObsidianMarkdown)
  const [isExpanded, setIsExpanded] = useState(false)
  const hasUserInteracted = useRef(false)

  const hasReasoningText = useMemo(
    () => reasoning.trim().length > 0,
    [reasoning],
  )
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
    if (generationState === 'error') {
      return 'error'
    }
    return 'settled'
  }, [generationState, hasAnswerContent, hasReasoningText, isStreaming])

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
    if (stage === 'error') {
      return t('quickAsk.error', 'Failed to generate response')
    }
    return t('chat.reasoning', 'Reasoning')
  }, [stage, t])

  const isToggleable = hasReasoningText
  const showBody = hasReasoningText && isExpanded
  const showDots = showActivity
  const visibleStageLabel = useMemo(() => {
    if (!showDots) {
      return stageLabel
    }

    return stageLabel.replace(/\.\.\.$/, '')
  }, [showDots, stageLabel])
  const reasoningPreview = useMemo(() => {
    const previewLine = reasoning
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)

    if (!previewLine) {
      return ''
    }

    return previewLine.replace(/^[-*#>\s`]+/, '').slice(0, 120)
  }, [reasoning])
  const showPreview =
    reasoningPreview.length > 0 &&
    !showBody &&
    (stage === 'thinking' || (stage === 'generating' && showActivity))

  useEffect(() => {
    if (!isStreaming) {
      setShowActivity(false)
    }
  }, [isStreaming])

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
      className={`smtcmp-assistant-message-metadata smtcmp-assistant-message-metadata--${stage}${showBody ? ' is-expanded' : ''}${showActivity ? ' is-active' : ''}${showPreview ? ' has-preview' : ''}`}
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
            {visibleStageLabel}
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
      <div className="smtcmp-assistant-message-metadata-preview" aria-hidden>
        <span>{reasoningPreview}</span>
      </div>
      <div className="smtcmp-assistant-message-metadata-body">
        <div className="smtcmp-assistant-message-metadata-content">
          <EffectiveMarkdownComponent
            content={reasoning}
            scale="xs"
            animateIncrementalText={generationState === 'streaming'}
          />
        </div>
      </div>
    </div>
  )
})

export default AssistantMessageReasoning
