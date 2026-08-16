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
import { getNodeWindow } from '../../utils/dom/window-context'
import DotLoader from '../common/DotLoader'

import TransitioningMarkdown from './TransitioningMarkdown'
import { useAssistantStreamedReasoning } from './useAssistantRenderStream'

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

/**
 * 轨道锚在视口顶部，所以视口长高时旧行天然不动，新行由下边缘扫出来——这一段
 * 不需要任何位移。位移只有封顶后才有意义：内容超出上限多少，就往上滚多少。
 * 两段动画因此永不并存，也就不存在主线程 height 与合成线程 transform 的失步。
 */
export const getReasoningPreviewViewportMetrics = ({
  contentHeight,
  holdOffset,
  lineHeight,
  previewLines,
}: {
  contentHeight: number
  holdOffset: number
  lineHeight: number
  previewLines: number
}): {
  viewportHeight: number
  scrollOffset: number
  isOverflowing: boolean
} => {
  const visibleHeight = Math.max(0, contentHeight - holdOffset)
  const capHeight = previewLines * lineHeight
  return {
    viewportHeight: Math.min(visibleHeight, capHeight),
    scrollOffset: Math.max(0, visibleHeight - capHeight),
    isOverflowing: visibleHeight > capHeight + 0.5,
  }
}

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
  reasoning: snapshotReasoning,
  hasAnswerContent,
  generationState,
  reasoningDurationMs,
  previewLines = 1,
  conversationId,
  messageId,
  isGenerating = false,
}: {
  reasoning: string
  hasAnswerContent: boolean
  /** 思考块自身的展示态；与消息是否还在生成不是一回事。 */
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
  reasoningDurationMs?: number
  /** 预览视口的最大可见行数；>1 时切换为随内容长高的面板形态。 */
  previewLines?: number
  /**
   * 生成中的思考文本走 assistant render stream。三者都给出时本组件自行订阅；
   * 缺省（例如正文内联的 `<think>` 块）时仍以 props 为准。
   */
  conversationId?: string
  messageId?: string
  isGenerating?: boolean
}) {
  const { t } = useLanguage()
  const [isExpanded, setIsExpanded] = useState(false)
  const hasUserInteracted = useRef(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const isStreaming = generationState === 'streaming'
  const reasoning = useAssistantStreamedReasoning({
    conversationId,
    messageId,
    isStreaming: isGenerating,
    reasoning: snapshotReasoning,
    ownerNodeRef: rootRef,
  })

  const hasReasoningText = useMemo(
    () => reasoning.trim().length > 0,
    [reasoning],
  )
  const previousReasoning = useRef(reasoning)
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
  const isPanelPreview = previewLines > 1
  const [isPreviewOverflowing, setIsPreviewOverflowing] = useState(false)
  const previewViewportRef = useRef<HTMLDivElement | null>(null)
  const previewTrackRef = useRef<HTMLDivElement | null>(null)
  const previewHeightRef = useRef(0)
  const previewWidthRef = useRef(0)
  const previewScrollOffsetRef = useRef(0)
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
      previewScrollOffsetRef.current = 0
      track.setCssProps({
        '--yolo-assistant-metadata-preview-scroll-offset': '0px',
      })
      if (isPanelPreview) {
        viewport.setCssProps({
          '--yolo-assistant-metadata-preview-viewport-height': '0px',
        })
        setIsPreviewOverflowing(false)
      }
      return
    }

    const trackWindow = getNodeWindow(track)
    const width = viewport.clientWidth
    const height = track.scrollHeight
    const previousHeight = previewHeightRef.current
    const previousScrollOffset = previewScrollOffsetRef.current
    const widthChanged = Math.abs(width - previewWidthRef.current) > 0.5
    const lineHeight = Number.parseFloat(
      trackWindow.getComputedStyle(track).lineHeight,
    )
    const holdOffset = getReasoningPreviewHoldOffset(height, lineHeight)
    const { viewportHeight, scrollOffset, isOverflowing } =
      getReasoningPreviewViewportMetrics({
        contentHeight: height,
        holdOffset,
        lineHeight,
        previewLines,
      })
    previewHeightRef.current = height
    previewWidthRef.current = width
    previewScrollOffsetRef.current = scrollOffset
    track.setCssProps({
      '--yolo-assistant-metadata-preview-scroll-offset': `${scrollOffset}px`,
    })

    if (isPanelPreview) {
      viewport.setCssProps({
        '--yolo-assistant-metadata-preview-viewport-height': `${viewportHeight}px`,
      })
      setIsPreviewOverflowing(isOverflowing)
    }

    if (widthChanged || previousHeight === 0 || height < previousHeight) {
      previewAnimationRef.current?.cancel()
      previewAnimationRef.current = null
      return
    }

    if (Math.abs(scrollOffset - previousScrollOffset) <= 0.5) return

    const prefersReducedMotion = trackWindow.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
    if (prefersReducedMotion || typeof track.animate !== 'function') {
      previewAnimationRef.current?.cancel()
      previewAnimationRef.current = null
      return
    }

    previewAnimationRef.current?.cancel()
    // 只有封顶后才走到这里，此时视口 height 已恒定，位移独占动画。透明度低谷
    // 只适合单行的整行置换，多行时会闪整块。
    const from = -previousScrollOffset
    const to = -scrollOffset
    const animation = track.animate(
      isPanelPreview
        ? [
            { transform: `translateY(${from}px)` },
            { transform: `translateY(${to}px)` },
          ]
        : [
            {
              opacity: 1,
              transform: `translateY(${from}px)`,
            },
            {
              offset: 0.48,
              opacity: 0.4,
              transform: `translateY(${from * 0.55 + to * 0.45}px)`,
            },
            {
              offset: 0.52,
              opacity: 0.4,
              transform: `translateY(${from * 0.45 + to * 0.55}px)`,
            },
            { opacity: 1, transform: `translateY(${to}px)` },
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
  }, [reasoningPreview, showPreview, isPanelPreview, previewLines])

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
      ref={rootRef}
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
                  {' '}
                  for {settledDurationSeconds}s
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
        className={`yolo-assistant-message-metadata-preview${
          isPanelPreview
            ? ` yolo-assistant-message-metadata-preview--panel${
                isPreviewOverflowing ? ' is-overflowing' : ''
              }`
            : ''
        }`}
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
          <TransitioningMarkdown
            content={reasoning}
            scale="xs"
            generationState={generationState}
          />
        </div>
      </div>
    </div>
  )
})

export default AssistantMessageReasoning
