import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  MOTION_DURATION_ENTER_S,
  MOTION_EASE_OUT_CSS,
} from '../../styles/tokens/motion'
import DotLoader from '../common/DotLoader'

import TransitioningMarkdown from './TransitioningMarkdown'

type ReasoningStage = 'requesting' | 'thinking' | 'settled'

const REASONING_PREVIEW_MAX_BUFFER_LENGTH = 4000
const REASONING_PREVIEW_TRIM_CHUNK_LENGTH = 2000
const REASONING_PREVIEW_UPDATE_INTERVAL_MS = 64
// WAAPI's `duration` wants milliseconds; the shared token is in seconds.
const REASONING_PREVIEW_TRANSITION_MS = MOTION_DURATION_ENTER_S * 1000
const useSafeLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

export const getReasoningRollText = (reasoning: string): string => {
  let start = 0
  if (reasoning.length > REASONING_PREVIEW_MAX_BUFFER_LENGTH) {
    start =
      Math.ceil(
        (reasoning.length - REASONING_PREVIEW_MAX_BUFFER_LENGTH) /
          REASONING_PREVIEW_TRIM_CHUNK_LENGTH,
      ) * REASONING_PREVIEW_TRIM_CHUNK_LENGTH
    const nearbyBoundary = reasoning.slice(start, start + 160).search(/\s/)
    if (nearbyBoundary >= 0) start += nearbyBoundary + 1
  }

  return reasoning
    .slice(start)
    .replace(/\r\n?/g, '\n')
    .replace(/^[\t ]*(?:[-*#>`]+|\d+[.)])[\t ]*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const getReasoningPreviewHoldOffset = (
  contentHeight: number,
  lineHeight: number,
): number =>
  lineHeight > 0 && contentHeight > lineHeight + 0.5 ? lineHeight : 0

export const formatReasoningDurationSeconds = (durationMs: number): number =>
  Math.max(1, Math.round(durationMs / 1000))

const useThrottledReasoningRollText = (value: string, enabled: boolean) => {
  const [displayed, setDisplayed] = useState(value)
  const latestRef = useRef(value)
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasEnabledRef = useRef(enabled)
  const lastUpdateRef = useRef(0)

  useEffect(() => {
    latestRef.current = value

    if (!enabled) {
      wasEnabledRef.current = false
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current)
        updateTimerRef.current = null
      }
      return
    }

    if (!wasEnabledRef.current) {
      wasEnabledRef.current = true
      setDisplayed(value)
      lastUpdateRef.current = Date.now()
      return
    }

    if (displayed === value || updateTimerRef.current) return

    const now = Date.now()
    const delay = Math.max(
      0,
      REASONING_PREVIEW_UPDATE_INTERVAL_MS - (now - lastUpdateRef.current),
    )
    updateTimerRef.current = setTimeout(() => {
      updateTimerRef.current = null
      setDisplayed(latestRef.current)
      lastUpdateRef.current = Date.now()
    }, delay)
  }, [displayed, enabled, value])

  useEffect(
    () => () => {
      if (updateTimerRef.current) clearTimeout(updateTimerRef.current)
    },
    [],
  )

  return displayed
}

const AssistantMessageReasoning = memo(function AssistantMessageReasoning({
  reasoning,
  hasAnswerContent,
  generationState,
  reasoningDurationMs,
  MarkdownComponent,
}: {
  reasoning: string
  hasAnswerContent: boolean
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
  reasoningDurationMs?: number
  MarkdownComponent?: React.ComponentType<{
    content: string
    scale?: 'xs' | 'sm' | 'base'
    animateIncrementalText?: boolean
  }>
}) {
  const { t } = useLanguage()
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
    return 'settled'
  }, [hasAnswerContent, hasReasoningText, isStreaming])

  const stageLabel = useMemo(() => {
    if (stage === 'requesting') {
      return t('quickAsk.statusRequesting', 'Requesting...')
    }
    if (stage === 'thinking') {
      return t('quickAsk.statusThinking', 'Thinking...')
    }
    if (reasoningDurationMs !== undefined) {
      return ''
    }
    return t('chat.reasoning', 'Reasoning')
  }, [reasoningDurationMs, stage, t])

  const isToggleable = hasReasoningText
  const showBody = hasReasoningText && isExpanded
  const showDots = showActivity
  const visibleStageLabel = useMemo(() => {
    if (!showDots) {
      return stageLabel
    }

    return stageLabel.replace(/\.\.\.$/, '')
  }, [showDots, stageLabel])
  const settledDurationSeconds =
    reasoningDurationMs !== undefined
      ? formatReasoningDurationSeconds(reasoningDurationMs)
      : null
  const reasoningRollText = useMemo(
    () => getReasoningRollText(reasoning),
    [reasoning],
  )
  const reasoningPreview = useThrottledReasoningRollText(
    reasoningRollText,
    stage === 'thinking' && !showBody,
  )
  const showPreview =
    reasoningPreview.length > 0 && !showBody && stage === 'thinking'
  const previewViewportRef = useRef<HTMLDivElement | null>(null)
  const previewTrackRef = useRef<HTMLDivElement | null>(null)
  const previewHeightRef = useRef(0)
  const previewWidthRef = useRef(0)
  const previewHoldOffsetRef = useRef(0)
  const previewAnimationRef = useRef<Animation | null>(null)

  useSafeLayoutEffect(() => {
    const viewport = previewViewportRef.current
    const track = previewTrackRef.current
    if (!viewport || !track) return

    if (!showPreview) {
      previewAnimationRef.current?.cancel()
      previewAnimationRef.current = null
      previewHeightRef.current = 0
      previewWidthRef.current = 0
      previewHoldOffsetRef.current = 0
      track.setCssProps({
        '--yolo-assistant-metadata-preview-hold-offset': '0px',
      })
      return
    }

    const width = viewport.clientWidth
    const height = track.scrollHeight
    const previousHeight = previewHeightRef.current
    const previousHoldOffset = previewHoldOffsetRef.current
    const widthChanged = Math.abs(width - previewWidthRef.current) > 0.5
    const lineHeight = Number.parseFloat(
      window.getComputedStyle(track).lineHeight,
    )
    const holdOffset = getReasoningPreviewHoldOffset(height, lineHeight)
    previewHeightRef.current = height
    previewWidthRef.current = width
    previewHoldOffsetRef.current = holdOffset
    track.style.setProperty(
      '--yolo-assistant-metadata-preview-hold-offset',
      `${holdOffset}px`,
    )

    if (widthChanged || previousHeight === 0 || height < previousHeight) {
      previewAnimationRef.current?.cancel()
      previewAnimationRef.current = null
      return
    }

    if (height === previousHeight) return

    const startOffset = height - previousHeight + previousHoldOffset
    if (Math.abs(startOffset - holdOffset) <= 0.5) return

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion || typeof track.animate !== 'function') {
      previewAnimationRef.current?.cancel()
      previewAnimationRef.current = null
      return
    }

    previewAnimationRef.current?.cancel()
    const animation = track.animate(
      [
        {
          opacity: 1,
          transform: `translateY(${startOffset}px)`,
        },
        {
          offset: 0.48,
          opacity: 0.4,
          transform: `translateY(${startOffset * 0.55 + holdOffset * 0.45}px)`,
        },
        {
          offset: 0.52,
          opacity: 0.4,
          transform: `translateY(${startOffset * 0.45 + holdOffset * 0.55}px)`,
        },
        { opacity: 1, transform: `translateY(${holdOffset}px)` },
      ],
      {
        duration: REASONING_PREVIEW_TRANSITION_MS,
        easing: MOTION_EASE_OUT_CSS,
      },
    )
    previewAnimationRef.current = animation
    animation.onfinish = () => {
      if (previewAnimationRef.current === animation) {
        previewAnimationRef.current = null
      }
    }
  }, [reasoningPreview, showPreview])

  useEffect(
    () => () => {
      previewAnimationRef.current?.cancel()
    },
    [],
  )

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
      className={`yolo-assistant-message-metadata yolo-assistant-message-metadata--${stage}${showBody ? ' is-expanded' : ''}${showActivity ? ' is-active' : ''}${showPreview ? ' has-preview' : ''}`}
      data-stage={stage}
    >
      <button
        type="button"
        className={`yolo-assistant-message-metadata-toggle${!isToggleable ? ' is-static' : ''}`}
        onClick={handleToggle}
        disabled={!isToggleable}
      >
        <span className="yolo-assistant-message-metadata-label">
          <span className="yolo-assistant-message-metadata-label-text">
            {stage === 'settled' && settledDurationSeconds !== null ? (
              <>
                <span className="yolo-assistant-message-metadata-label-title">
                  Thought
                </span>
                <span className="yolo-assistant-message-metadata-label-detail">
                  {' '}for {settledDurationSeconds}s
                </span>
              </>
            ) : (
              visibleStageLabel
            )}
          </span>
          {showDots && (
            <DotLoader
              variant="dots"
              className="yolo-assistant-message-metadata-loader"
            />
          )}
        </span>
        {isToggleable ? (
          isExpanded ? (
            <ChevronDown className="yolo-assistant-message-metadata-toggle-icon" />
          ) : (
            <ChevronRight className="yolo-assistant-message-metadata-toggle-icon" />
          )
        ) : null}
      </button>
      <div
        ref={previewViewportRef}
        className="yolo-assistant-message-metadata-preview"
        aria-hidden
      >
        <div
          ref={previewTrackRef}
          className="yolo-assistant-message-metadata-preview-track"
        >
          {reasoningPreview}
        </div>
      </div>
      <div className="yolo-assistant-message-metadata-body">
        <div className="yolo-assistant-message-metadata-content">
          {MarkdownComponent ? (
            <MarkdownComponent
              content={reasoning}
              scale="xs"
              animateIncrementalText={generationState === 'streaming'}
            />
          ) : (
            <TransitioningMarkdown
              content={reasoning}
              scale="xs"
              generationState={generationState}
            />
          )}
        </div>
      </div>
    </div>
  )
})

export default AssistantMessageReasoning
