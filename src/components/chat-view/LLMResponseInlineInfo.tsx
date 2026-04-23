import * as Tooltip from '@radix-ui/react-tooltip'
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
 * Progressive compression — each level drops exactly one thing vs the previous
 * level. This keeps the inline bar's visual change smooth as the container
 * narrows, avoiding the "cliff" where many suffixes disappear at once.
 *
 * Order of things dropped, from least to most important:
 *   1. ⚡ "tok/s"    — icon alone conveys "speed"
 *   2. "tokens"     — on both ↑ and ↓, icons + arrow direction are enough
 *   3. "cached"     — the parens + number next to ↑ remain contextual
 *   4. 🕐 duration  — nice-to-have
 *   5. ⚡ speed     — fully derivable from ↓ and 🕐
 *   6. ↓ output     — less info-dense than ↑
 *   7. (cached)     — drop the whole cache breakdown, keep only total input
 *
 * The full detail is always accessible via the hover tooltip, so these drops
 * never actually hide information — they just move it to a secondary surface.
 */
type LevelConfig = {
  showSpeedUnit: boolean
  showInputUnit: boolean
  showOutputUnit: boolean
  showInputCachedWord: boolean
  showTime: boolean
  showSpeed: boolean
  showOutput: boolean
  showInputCache: boolean
}

const LEVEL_COUNT = 8

const configForLevel = (level: number): LevelConfig => ({
  showSpeedUnit: level < 1,
  showInputUnit: level < 2,
  showOutputUnit: level < 2,
  showInputCachedWord: level < 3,
  showTime: level < 4,
  showSpeed: level < 5,
  showOutput: level < 6,
  showInputCache: level < 7,
})

const LEVELS: LevelConfig[] = Array.from({ length: LEVEL_COUNT }, (_, i) =>
  configForLevel(i),
)

type RenderInputs = {
  usage: ResponseUsage | null
  cachedTokens: number | null
  durationMs: number | null
  tokensPerSecond: number | null
}

function renderItems(
  { usage, cachedTokens, durationMs, tokensPerSecond }: RenderInputs,
  {
    showSpeedUnit,
    showInputUnit,
    showOutputUnit,
    showInputCachedWord,
    showTime,
    showSpeed,
    showOutput,
    showInputCache,
  }: LevelConfig,
): ReactNode {
  return (
    <>
      {usage && (
        <span className="smtcmp-llm-inline-info-item smtcmp-llm-inline-info-item--input">
          <ArrowUp className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--input" />
          <span>
            {formatTokenCount(usage.prompt_tokens)}
            {showInputUnit && ' tokens'}
            {showInputCache && cachedTokens !== null && (
              <>
                {' ('}
                {formatTokenCount(cachedTokens)}
                {showInputCachedWord && ' cached'}
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
            {showOutputUnit && ' tokens'}
          </span>
        </span>
      )}
      {showSpeed && tokensPerSecond !== null && (
        <span className="smtcmp-llm-inline-info-item smtcmp-llm-inline-info-item--speed">
          <Zap className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--speed" />
          <span>
            {tokensPerSecond.toFixed(1)}
            {showSpeedUnit && ' tok/s'}
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

function renderTooltipDetails({
  usage,
  cachedTokens,
  durationMs,
  tokensPerSecond,
}: RenderInputs): ReactNode {
  const cacheCreation =
    usage?.cache_creation_input_tokens !== undefined &&
    usage.cache_creation_input_tokens > 0
      ? usage.cache_creation_input_tokens
      : null

  const cacheRatio =
    usage && cachedTokens !== null && usage.prompt_tokens > 0
      ? cachedTokens / usage.prompt_tokens
      : null

  return (
    <div className="smtcmp-llm-inline-info-tooltip">
      {usage && (
        <>
          <div className="smtcmp-llm-inline-info-tooltip-row">
            <ArrowUp className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--input" />
            <span className="smtcmp-llm-inline-info-tooltip-label">Input</span>
            <span className="smtcmp-llm-inline-info-tooltip-value">
              {usage.prompt_tokens.toLocaleString()} tokens
            </span>
          </div>
          {cachedTokens !== null && cacheRatio !== null && (
            <div className="smtcmp-llm-inline-info-tooltip-sub">
              <span>
                {cachedTokens.toLocaleString()} cached ·{' '}
                {(cacheRatio * 100).toFixed(1)}% hit
              </span>
            </div>
          )}
          {cacheCreation !== null && (
            <div className="smtcmp-llm-inline-info-tooltip-sub">
              <span>{cacheCreation.toLocaleString()} cache written</span>
            </div>
          )}
          <div className="smtcmp-llm-inline-info-tooltip-row">
            <ArrowDown className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--output" />
            <span className="smtcmp-llm-inline-info-tooltip-label">Output</span>
            <span className="smtcmp-llm-inline-info-tooltip-value">
              {usage.completion_tokens.toLocaleString()} tokens
            </span>
          </div>
        </>
      )}
      {tokensPerSecond !== null && (
        <div className="smtcmp-llm-inline-info-tooltip-row">
          <Zap className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--speed" />
          <span className="smtcmp-llm-inline-info-tooltip-label">Speed</span>
          <span className="smtcmp-llm-inline-info-tooltip-value">
            {tokensPerSecond.toFixed(1)} tok/s
          </span>
        </div>
      )}
      {durationMs !== null && (
        <div className="smtcmp-llm-inline-info-tooltip-row">
          <Clock className="smtcmp-llm-inline-info-icon smtcmp-llm-inline-info-icon--time" />
          <span className="smtcmp-llm-inline-info-tooltip-label">Duration</span>
          <span className="smtcmp-llm-inline-info-tooltip-value">
            {formatDuration(durationMs)}
          </span>
        </div>
      )}
    </div>
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

  const inputs: RenderInputs = {
    usage,
    cachedTokens,
    durationMs,
    tokensPerSecond,
  }

  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className="smtcmp-llm-inline-info">
            <div className="smtcmp-llm-inline-info-content" ref={containerRef}>
              {renderItems(inputs, LEVELS[levelIndex])}
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
                  {renderItems(inputs, config)}
                </div>
              ))}
            </div>
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="smtcmp-tooltip-content smtcmp-llm-inline-info-tooltip-content"
            side="top"
            sideOffset={6}
            align="start"
          >
            {renderTooltipDetails(inputs)}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
