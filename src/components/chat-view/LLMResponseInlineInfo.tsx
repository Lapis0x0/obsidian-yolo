import * as Tooltip from '@radix-ui/react-tooltip'
import { ArrowDown, ArrowUp, Clock, Zap } from 'lucide-react'
import { ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { AssistantToolMessageGroup } from '../../types/chat'
import { ResponseUsage } from '../../types/llm/response'

import {
  LLMDebugIconButton,
  getLLMDebugTraceIdsForMessages,
  hasLLMDebugCacheForTraceIds,
} from './LLMDebugButton'
import { LLMRequestEntry, useLLMResponseInfo } from './useLLMResponseInfo'

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
 *   6. (cached)     — drop the whole cache breakdown, keep only total input
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
  showInputCache: boolean
}

const LEVEL_COUNT = 7

const configForLevel = (level: number): LevelConfig => ({
  showSpeedUnit: level < 1,
  showInputUnit: level < 2,
  showOutputUnit: level < 2,
  showInputCachedWord: level < 3,
  showTime: level < 4,
  showSpeed: level < 5,
  showInputCache: level < 6,
})

const LEVELS: LevelConfig[] = Array.from({ length: LEVEL_COUNT }, (_, i) =>
  configForLevel(i),
)

type RenderInputs = {
  usage: ResponseUsage | null
  cachedTokens: number | null
  cacheCreationTokens: number | null
  durationMs: number | null
  tokensPerSecond: number | null
}

const getCachedTokens = (usage: ResponseUsage | null) =>
  usage?.cache_read_input_tokens !== undefined &&
  usage.cache_read_input_tokens > 0
    ? usage.cache_read_input_tokens
    : null

const getCacheCreationTokens = (usage: ResponseUsage | null) =>
  usage?.cache_creation_input_tokens !== undefined &&
  usage.cache_creation_input_tokens > 0
    ? usage.cache_creation_input_tokens
    : null

const getTokensPerSecond = (
  usage: ResponseUsage | null,
  durationMs: number | null,
) =>
  usage && durationMs && durationMs > 0
    ? usage.completion_tokens / (durationMs / 1000)
    : null

const buildInputs = (
  usage: ResponseUsage | null,
  durationMs: number | null,
): RenderInputs => ({
  usage,
  cachedTokens: getCachedTokens(usage),
  cacheCreationTokens: getCacheCreationTokens(usage),
  durationMs,
  tokensPerSecond: getTokensPerSecond(usage, durationMs),
})

function renderItems(
  { usage, cachedTokens, durationMs, tokensPerSecond }: RenderInputs,
  {
    showSpeedUnit,
    showInputUnit,
    showOutputUnit,
    showInputCachedWord,
    showTime,
    showSpeed,
    showInputCache,
  }: LevelConfig,
): ReactNode {
  return (
    <>
      {usage && (
        <span className="yolo-llm-inline-info-item yolo-llm-inline-info-item--input">
          <ArrowUp className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--input" />
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
      {usage && (
        <span className="yolo-llm-inline-info-item yolo-llm-inline-info-item--output">
          <ArrowDown className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--output" />
          <span>
            {formatTokenCount(usage.completion_tokens)}
            {showOutputUnit && ' tokens'}
          </span>
        </span>
      )}
      {showSpeed && tokensPerSecond !== null && (
        <span className="yolo-llm-inline-info-item yolo-llm-inline-info-item--speed">
          <Zap className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--speed" />
          <span>
            {tokensPerSecond.toFixed(1)}
            {showSpeedUnit && ' tok/s'}
          </span>
        </span>
      )}
      {showTime && durationMs !== null && (
        <span className="yolo-llm-inline-info-item yolo-llm-inline-info-item--time">
          <Clock className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--time" />
          <span>{formatDuration(durationMs)}</span>
        </span>
      )}
    </>
  )
}

type TooltipBlockOptions = {
  title?: string
  showSpeed?: boolean
}

function renderTooltipBlock(
  {
    usage,
    cachedTokens,
    cacheCreationTokens,
    durationMs,
    tokensPerSecond,
  }: RenderInputs,
  { title, showSpeed = true }: TooltipBlockOptions = {},
): ReactNode {
  const cacheRatio =
    usage && cachedTokens !== null && usage.prompt_tokens > 0
      ? cachedTokens / usage.prompt_tokens
      : null

  return (
    <div className="yolo-llm-inline-info-tooltip-block">
      {title && (
        <div className="yolo-llm-inline-info-tooltip-title">{title}</div>
      )}
      {usage && (
        <>
          <div className="yolo-llm-inline-info-tooltip-row">
            <ArrowUp className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--input" />
            <span className="yolo-llm-inline-info-tooltip-label">Input</span>
            <span className="yolo-llm-inline-info-tooltip-value">
              {usage.prompt_tokens.toLocaleString()} tokens
            </span>
          </div>
          {cachedTokens !== null && cacheRatio !== null && (
            <div className="yolo-llm-inline-info-tooltip-sub">
              <span>
                {cachedTokens.toLocaleString()} cached ·{' '}
                {(cacheRatio * 100).toFixed(1)}% hit
              </span>
            </div>
          )}
          {cacheCreationTokens !== null && (
            <div className="yolo-llm-inline-info-tooltip-sub">
              <span>{cacheCreationTokens.toLocaleString()} cache written</span>
            </div>
          )}
          <div className="yolo-llm-inline-info-tooltip-row">
            <ArrowDown className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--output" />
            <span className="yolo-llm-inline-info-tooltip-label">Output</span>
            <span className="yolo-llm-inline-info-tooltip-value">
              {usage.completion_tokens.toLocaleString()} tokens
            </span>
          </div>
        </>
      )}
      {showSpeed && tokensPerSecond !== null && (
        <div className="yolo-llm-inline-info-tooltip-row">
          <Zap className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--speed" />
          <span className="yolo-llm-inline-info-tooltip-label">Speed</span>
          <span className="yolo-llm-inline-info-tooltip-value">
            {tokensPerSecond.toFixed(1)} tok/s
          </span>
        </div>
      )}
      {durationMs !== null && (
        <div className="yolo-llm-inline-info-tooltip-row">
          <Clock className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--time" />
          <span className="yolo-llm-inline-info-tooltip-label">Duration</span>
          <span className="yolo-llm-inline-info-tooltip-value">
            {formatDuration(durationMs)}
          </span>
        </div>
      )}
    </div>
  )
}

function renderBreakdownRow(request: LLMRequestEntry): ReactNode {
  const { usage } = request
  const cachedTokens = getCachedTokens(usage)
  const cacheRatio =
    cachedTokens !== null && usage.prompt_tokens > 0
      ? cachedTokens / usage.prompt_tokens
      : null
  const tokensPerSecond = getTokensPerSecond(usage, request.durationMs)

  return (
    <div key={request.messageId} className="yolo-llm-inline-info-breakdown-row">
      <span className="yolo-llm-inline-info-breakdown-index">
        {request.index}
      </span>
      <span className="yolo-llm-inline-info-breakdown-cell">
        <ArrowUp className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--input" />
        <span>
          {formatTokenCount(usage.prompt_tokens)}
          {cacheRatio !== null && ` (${(cacheRatio * 100).toFixed(1)}%)`}
        </span>
      </span>
      <span className="yolo-llm-inline-info-breakdown-cell">
        <ArrowDown className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--output" />
        <span>{formatTokenCount(usage.completion_tokens)}</span>
      </span>
      <span className="yolo-llm-inline-info-breakdown-cell">
        <Zap className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--speed" />
        <span>
          {tokensPerSecond !== null ? `${tokensPerSecond.toFixed(1)}` : '-'}
        </span>
      </span>
      <span className="yolo-llm-inline-info-breakdown-cell">
        <Clock className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--time" />
        <span>
          {request.durationMs !== null
            ? formatDuration(request.durationMs)
            : '-'}
        </span>
      </span>
    </div>
  )
}

export default function LLMResponseInlineInfo({
  messages,
}: {
  messages: AssistantToolMessageGroup
}) {
  const { t } = useLanguage()
  const {
    usage,
    durationMs,
    totalUsage,
    totalDurationMs,
    requestCount,
    requests,
  } = useLLMResponseInfo(messages)

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
  }, [usage, durationMs, totalUsage, requestCount])

  const debugTraceIds = useMemo(
    () => getLLMDebugTraceIdsForMessages(messages),
    [messages],
  )
  const hasDebugCache = useMemo(
    () => hasLLMDebugCacheForTraceIds(debugTraceIds),
    [debugTraceIds],
  )

  if (!usage && durationMs === null) {
    return null
  }

  const lastInputs = buildInputs(usage, durationMs)
  const totalInputs =
    totalUsage || totalDurationMs !== null
      ? buildInputs(totalUsage, totalDurationMs)
      : null
  const hasMultipleRequests = requestCount >= 2 && totalInputs !== null

  // Inline bar: when there are multiple LLM calls in this Agent turn, show
  // aggregated values across the whole turn — tokens, duration, and speed all
  // reflect the cumulative cost. Speed is derived from totalUsage/totalDuration
  // so the four numbers reconcile (output / duration ≈ speed).
  const inlineInputs: RenderInputs =
    hasMultipleRequests && totalInputs ? totalInputs : lastInputs

  // 已占用上下文 ≈ 最后一次的 prompt + completion，反映当前对话历史大小。
  // cached 取自 last call 的命中量，因为 completion 不会被 cache。
  const nextTurnTokens = usage
    ? usage.prompt_tokens + usage.completion_tokens
    : null
  const nextTurnCachedTokens = getCachedTokens(usage)

  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className="yolo-llm-inline-info">
            <div className="yolo-llm-inline-info-content" ref={containerRef}>
              {renderItems(inlineInputs, LEVELS[levelIndex])}
            </div>
            <div className="yolo-llm-inline-info-ghosts" aria-hidden="true">
              {LEVELS.map((config, i) => (
                <div
                  key={i}
                  ref={(node) => {
                    ghostRefs.current[i] = node
                  }}
                  className="yolo-llm-inline-info-content yolo-llm-inline-info-ghost"
                >
                  {renderItems(inlineInputs, config)}
                </div>
              ))}
            </div>
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="yolo-tooltip-content yolo-llm-inline-info-tooltip-content"
            side="top"
            sideOffset={6}
            align="start"
          >
            <div className="yolo-llm-inline-info-tooltip">
              {hasMultipleRequests && totalUsage ? (
                <>
                  <div className="yolo-llm-inline-info-tooltip-title">
                    <span>
                      {t(
                        'chat.inlineInfo.callsTitle',
                        '{{count}} calls this turn',
                      ).replace('{{count}}', String(requestCount))}
                    </span>
                    <LLMDebugIconButton
                      messages={messages}
                      traceIds={debugTraceIds}
                      className="clickable-icon yolo-llm-inline-info-debug-button"
                    />
                    <span className="yolo-llm-inline-info-tooltip-title-summary">
                      <span className="yolo-llm-inline-info-breakdown-cell">
                        <ArrowUp className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--input" />
                        <span>
                          {formatTokenCount(totalUsage.prompt_tokens)}
                          {(() => {
                            const totalCached = getCachedTokens(totalUsage)
                            return totalCached !== null &&
                              totalUsage.prompt_tokens > 0
                              ? ` (${(
                                  (totalCached / totalUsage.prompt_tokens) *
                                  100
                                ).toFixed(1)}%)`
                              : null
                          })()}
                        </span>
                      </span>
                      <span className="yolo-llm-inline-info-breakdown-cell">
                        <ArrowDown className="yolo-llm-inline-info-icon yolo-llm-inline-info-icon--output" />
                        <span>
                          {formatTokenCount(totalUsage.completion_tokens)}
                        </span>
                      </span>
                    </span>
                  </div>
                  <div className="yolo-llm-inline-info-tooltip-divider" />
                  <div className="yolo-llm-inline-info-breakdown-list">
                    {requests.map(renderBreakdownRow)}
                  </div>
                </>
              ) : (
                <>
                  {hasDebugCache && (
                    <>
                      <div className="yolo-llm-inline-info-tooltip-title">
                        <span>
                          {t(
                            'chat.inlineInfo.callsTitle',
                            '{{count}} calls this turn',
                          ).replace('{{count}}', String(requestCount || 1))}
                        </span>
                        <LLMDebugIconButton
                          messages={messages}
                          traceIds={debugTraceIds}
                          className="clickable-icon yolo-llm-inline-info-debug-button"
                        />
                      </div>
                      <div className="yolo-llm-inline-info-tooltip-divider" />
                    </>
                  )}
                  {renderTooltipBlock(lastInputs)}
                </>
              )}
              {nextTurnTokens !== null && (
                <>
                  <div className="yolo-llm-inline-info-tooltip-divider" />
                  <div className="yolo-llm-inline-info-tooltip-footer">
                    {nextTurnCachedTokens !== null
                      ? t(
                          'chat.inlineInfo.nextTurnContextCached',
                          'Context used: ~{{tokens}} tokens ({{cached}} cached)',
                        )
                          .replace(
                            '{{tokens}}',
                            formatTokenCount(nextTurnTokens),
                          )
                          .replace(
                            '{{cached}}',
                            formatTokenCount(nextTurnCachedTokens),
                          )
                      : t(
                          'chat.inlineInfo.nextTurnContext',
                          'Context used: ~{{tokens}} tokens',
                        ).replace(
                          '{{tokens}}',
                          formatTokenCount(nextTurnTokens),
                        )}
                  </div>
                </>
              )}
            </div>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
