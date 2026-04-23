import { ArrowDown, ArrowUp, Clock, Zap } from 'lucide-react'
import { ReactNode, useLayoutEffect, useRef, useState } from 'react'

import { AssistantToolMessageGroup } from '../../types/chat'
import { ResponseUsage } from '../../types/llm/response'

import { useLLMResponseInfo } from './useLLMResponseInfo'

const formatTokenCount = (value: number) => {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`
  }
  return value.toString()
}

const formatDuration = (durationMs: number) => {
  const seconds = durationMs / 1000
  return `${seconds.toFixed(1)}s`
}

/**
 * Adaptive compression levels, from fullest to sparsest.
 * The ↑ input field (including cache breakdown) is preserved at every level;
 * lower-priority fields drop in order as the container narrows.
 */
const LEVELS = [
  { showSuffix: true, showOutput: true, showSpeed: true, showTime: true },
  { showSuffix: false, showOutput: true, showSpeed: true, showTime: true },
  { showSuffix: false, showOutput: true, showSpeed: false, showTime: true },
  { showSuffix: false, showOutput: true, showSpeed: false, showTime: false },
  { showSuffix: false, showOutput: false, showSpeed: false, showTime: false },
] as const
type LevelConfig = (typeof LEVELS)[number]

function renderItems(
  {
    usage,
    cachedTokens,
    durationMs,
    tokensPerSecond,
  }: {
    usage: ResponseUsage | null
    cachedTokens: number | null
    durationMs: number | null
    tokensPerSecond: number | null
  },
  { showSuffix, showOutput, showSpeed, showTime }: LevelConfig,
): ReactNode {
  return (
    <>
      {usage && (
        <span className="smtcmp-llm-inline-info-item smtcmp-llm-inline-info-item--input">
          <ArrowUp className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--input" />
          <span>
            {formatTokenCount(usage.prompt_tokens)}
            {showSuffix && ' tokens'}
            {cachedTokens !== null && (
              <>
                {' ('}
                {formatTokenCount(cachedTokens)}
                {showSuffix && ' cached'}
                {')'}
              </>
            )}
          </span>
        </span>
      )}
      {showOutput && usage && (
        <span className="smtcmp-llm-inline-info-item smtcmp-llm-inline-info-item--output">
          <ArrowDown className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--output" />
          <span>
            {formatTokenCount(usage.completion_tokens)}
            {showSuffix && ' tokens'}
          </span>
        </span>
      )}
      {showSpeed && tokensPerSecond !== null && (
        <span className="smtcmp-llm-inline-info-item smtcmp-llm-inline-info-item--speed">
          <Zap className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--speed" />
          <span>
            {tokensPerSecond.toFixed(1)}
            {showSuffix && ' tok/s'}
          </span>
        </span>
      )}
      {showTime && durationMs !== null && (
        <span className="smtcmp-llm-inline-info-item smtcmp-llm-inline-info-item--time">
          <Clock className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--time" />
          <span>{formatDuration(durationMs)}</span>
        </span>
      )}
    </>
  )
}

export default function LLMResponseInlineInfo({
  messages,
}: {
  messages: AssistantToolMessageGroup
}) {
  const { usage, durationMs } = useLLMResponseInfo(messages)
  const tokensPerSecond =
    usage && durationMs && durationMs > 0
      ? usage.completion_tokens / (durationMs / 1000)
      : null

  const containerRef = useRef<HTMLDivElement>(null)
  const ghostRefs = useRef<Array<HTMLDivElement | null>>([])
  const [levelIndex, setLevelIndex] = useState(0)

  // Measure each level's natural width once, then install a ResizeObserver on
  // the visible container that picks the fullest level that still fits. Both
  // steps live in a single effect so the measured widths always match what the
  // observer sees.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const widths = ghostRefs.current.map(
      (node) => node?.getBoundingClientRect().width ?? 0,
    )

    const pickLevel = () => {
      const available = container.clientWidth
      for (let i = 0; i < widths.length; i += 1) {
        if (widths[i] <= available) {
          setLevelIndex(i)
          return
        }
      }
      setLevelIndex(widths.length - 1)
    }

    pickLevel()
    const observer = new ResizeObserver(pickLevel)
    observer.observe(container)
    return () => observer.disconnect()
  }, [usage, durationMs])

  if (!usage && durationMs === null) {
    return null
  }

  const cachedTokens =
    usage?.cache_read_input_tokens !== undefined &&
    usage.cache_read_input_tokens > 0
      ? usage.cache_read_input_tokens
      : null

  const itemProps = { usage, cachedTokens, durationMs, tokensPerSecond }

  return (
    <div className="smtcmp-llm-inline-info">
      <div className="smtcmp-llm-inline-info-content" ref={containerRef}>
        {renderItems(itemProps, LEVELS[levelIndex])}
      </div>
      <div className="smtcmp-llm-inline-info-ghosts" aria-hidden="true">
        {LEVELS.map((config, i) => (
          <div
            key={i}
            ref={(node) => {
              ghostRefs.current[i] = node
            }}
            className="smtcmp-llm-inline-info-content smtcmp-llm-inline-info-ghost"
          >
            {renderItems(itemProps, config)}
          </div>
        ))}
      </div>
    </div>
  )
}
