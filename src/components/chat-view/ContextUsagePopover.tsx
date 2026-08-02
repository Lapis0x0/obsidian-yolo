import * as Popover from '@radix-ui/react-popover'
import { type RefObject, useCallback, useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { CliContextUsageCategory } from '../../core/cli-runtime/types'
import type { PromptSectionBucket } from '../../utils/chat/requestContextBuilder'
import { formatTokenCount } from '../../utils/llm/formatTokenCount'
import { YoloPopoverContent } from '../common/popover'

import ContextUsageRing from './ContextUsageRing'
import {
  type ContextBreakdownInputs,
  useContextBreakdown,
} from './useContextBreakdown'

type BucketKey = PromptSectionBucket

const BUCKET_ORDER: BucketKey[] = [
  'system',
  'tools',
  'rules',
  'skills',
  'memory',
  'reasoning',
  'conversation',
]

const BUCKET_CLASS: Record<BucketKey, string> = {
  system: 'yolo-context-breakdown-swatch--system',
  tools: 'yolo-context-breakdown-swatch--tools',
  rules: 'yolo-context-breakdown-swatch--rules',
  skills: 'yolo-context-breakdown-swatch--skills',
  memory: 'yolo-context-breakdown-swatch--memory',
  conversation: 'yolo-context-breakdown-swatch--conversation',
  reasoning: 'yolo-context-breakdown-swatch--reasoning',
}

// Minimum visual width (as percent of bar) for any non-zero segment, so tiny
// buckets stay visible. Affects bar visuals only — list numbers stay truthful.
const MIN_BAR_PERCENT = 0.6

export type ContextUsagePopoverProps = {
  promptTokens: number
  maxContextTokens: number | null
  cacheHitRate?: number
  label: string
  /** Anchor ref pointing at the input-container so the popover lines up with
   * the input box (not just the ring). */
  anchorRef: RefObject<HTMLElement | null>
  /** When provided, opens the native per-bucket local estimate breakdown. */
  buildInputs?: () =>
    | ContextBreakdownInputs
    | null
    | Promise<ContextBreakdownInputs | null>
  /** Provider-reported categories (Claude getContextUsage). Shown instead of
   * the local estimate when `buildInputs` is absent. */
  categories?: readonly CliContextUsageCategory[]
}

export default function ContextUsagePopover({
  promptTokens,
  maxContextTokens,
  cacheHitRate,
  label,
  anchorRef,
  buildInputs,
  categories,
}: ContextUsagePopoverProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const showLocalBreakdown = typeof buildInputs === 'function'
  const remoteCategories = !showLocalBreakdown ? (categories ?? []) : []
  const showRemoteBreakdown = remoteCategories.length > 0

  const breakdown = useContextBreakdown(
    open && showLocalBreakdown,
    buildInputs ?? (() => null),
  )

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
  }, [])

  const bucketLabels = useMemo<Record<BucketKey, string>>(
    () => ({
      system: t('chat.contextBreakdown.bucket.system', 'System prompt'),
      tools: t('chat.contextBreakdown.bucket.tools', 'Tools'),
      rules: t('chat.contextBreakdown.bucket.rules', 'Rules'),
      skills: t('chat.contextBreakdown.bucket.skills', 'Skills'),
      memory: t('chat.contextBreakdown.bucket.memory', 'Memory'),
      conversation: t(
        'chat.contextBreakdown.bucket.conversation',
        'Conversation',
      ),
      reasoning: t('chat.contextBreakdown.bucket.reasoning', 'Reasoning'),
    }),
    [t],
  )

  const hasMax =
    typeof maxContextTokens === 'number' &&
    maxContextTokens > 0 &&
    Number.isFinite(maxContextTokens)
  const ratio = hasMax
    ? Math.min(1, Math.max(0, promptTokens / maxContextTokens))
    : null
  const percentLabel = ratio === null ? null : `${Math.round(ratio * 100)}%`
  const cacheHitPercentLabel =
    typeof cacheHitRate === 'number' && Number.isFinite(cacheHitRate)
      ? `${Math.round(Math.min(1, Math.max(0, cacheHitRate)) * 100)}%`
      : null
  const breakdownBarAriaLabel = t(
    'chat.contextBreakdown.breakdownBarAriaLabel',
    'Context breakdown',
  )
  const usageBarAriaLabel = t(
    'chat.contextBreakdown.usageBarAriaLabel',
    'Context usage',
  )

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      {/* Radix typing wants RefObject<Measurable> with no null in current.
          HTMLElement is structurally Measurable; the cast is safe and avoids
          forcing the caller to keep two refs in lockstep. */}
      <Popover.Anchor
        virtualRef={
          anchorRef as unknown as React.RefObject<{
            getBoundingClientRect: () => DOMRect
          }>
        }
      />
      <Popover.Trigger asChild>
        <ContextUsageRing
          promptTokens={promptTokens}
          maxContextTokens={maxContextTokens}
          label={label}
        />
      </Popover.Trigger>
      <YoloPopoverContent
        variant="default"
        anchorRef={anchorRef}
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="yolo-context-breakdown-popover"
        onOpenAutoFocus={(event) => {
          // Don't steal focus from the input box.
          event.preventDefault()
        }}
      >
        <div className="yolo-context-breakdown">
          <div className="yolo-context-breakdown__header">
            <div className="yolo-context-breakdown__title-row">
              <div className="yolo-context-breakdown__title">
                {t('chat.contextBreakdown.title', 'Context')}
              </div>
              {showLocalBreakdown ? (
                <div className="yolo-context-breakdown__caption">
                  {t(
                    'chat.contextBreakdown.localEstimateCaption',
                    '本地估算，可能与服务端计费存在偏差',
                  )}
                </div>
              ) : null}
            </div>
            <div className="yolo-context-breakdown__summary">
              <div className="yolo-context-breakdown__metrics">
                {percentLabel ? (
                  <span className="yolo-context-breakdown__percent">
                    {t(
                      'chat.contextBreakdown.fullLabel',
                      '{{percent}} Full',
                    ).replace('{{percent}}', percentLabel)}
                  </span>
                ) : null}
                {cacheHitPercentLabel ? (
                  <span className="yolo-context-breakdown__cache-hit">
                    {t(
                      'chat.contextBreakdown.cacheHitLabel',
                      'Previous turn cache hit {{percent}}',
                    ).replace('{{percent}}', cacheHitPercentLabel)}
                  </span>
                ) : null}
              </div>
              <span className="yolo-context-breakdown__totals">
                {showLocalBreakdown && breakdown.status === 'ready'
                  ? hasMax
                    ? `~${formatTokenCount(breakdown.data.total)} / ${formatTokenCount(maxContextTokens)}`
                    : `~${formatTokenCount(breakdown.data.total)}`
                  : hasMax
                    ? `~${formatTokenCount(promptTokens)} / ${formatTokenCount(maxContextTokens)}`
                    : `~${formatTokenCount(promptTokens)}`}{' '}
                <span className="yolo-context-breakdown__totals-suffix">
                  {t('chat.contextBreakdown.tokensSuffix', 'Tokens')}
                </span>
              </span>
            </div>
          </div>
          {showLocalBreakdown ? (
            <>
              <BreakdownBar
                breakdown={breakdown}
                maxContextTokens={maxContextTokens}
                ariaLabel={breakdownBarAriaLabel}
              />
              <BreakdownList
                breakdown={breakdown}
                bucketLabels={bucketLabels}
                errorLabel={t(
                  'chat.contextBreakdown.error',
                  'Estimation failed',
                )}
              />
            </>
          ) : showRemoteBreakdown ? (
            <>
              <RemoteCategoriesBar
                categories={remoteCategories}
                maxContextTokens={maxContextTokens}
                promptTokens={promptTokens}
                ariaLabel={breakdownBarAriaLabel}
              />
              <RemoteCategoriesList categories={remoteCategories} />
            </>
          ) : (
            <UsageBar
              promptTokens={promptTokens}
              ratio={ratio}
              ariaLabel={usageBarAriaLabel}
            />
          )}
          {showLocalBreakdown && !hasMax ? (
            <p className="yolo-context-breakdown__unknown-max-hint">
              {t(
                'chat.contextBreakdown.unknownMaxHint',
                '可在模型设置中配置上下文窗口 token，以显示占用比例',
              )}
            </p>
          ) : null}
        </div>
      </YoloPopoverContent>
    </Popover.Root>
  )
}

function RemoteCategoriesBar({
  categories,
  maxContextTokens,
  promptTokens,
  ariaLabel,
}: {
  categories: readonly CliContextUsageCategory[]
  maxContextTokens: number | null
  promptTokens: number
  ariaLabel: string
}) {
  const hasMax =
    typeof maxContextTokens === 'number' &&
    maxContextTokens > 0 &&
    Number.isFinite(maxContextTokens)
  const max = hasMax
    ? maxContextTokens
    : Math.max(
        1,
        promptTokens,
        categories.reduce((sum, category) => sum + category.tokens, 0),
      )
  const segments = categories.filter((category) => category.tokens > 0)

  return (
    <div
      className="yolo-context-breakdown__bar"
      role="img"
      aria-label={ariaLabel}
    >
      {segments.map((segment, index) => {
        const pct = (segment.tokens / max) * 100
        const widthPct = Math.max(pct, MIN_BAR_PERCENT)
        return (
          <span
            key={`${segment.name}-${index}`}
            className={`yolo-context-breakdown__bar-segment ${BUCKET_CLASS[segment.bucket]}`}
            style={{ width: `${widthPct}%` }}
          />
        )
      })}
    </div>
  )
}

function RemoteCategoriesList({
  categories,
}: {
  categories: readonly CliContextUsageCategory[]
}) {
  return (
    <ul className="yolo-context-breakdown__list">
      {categories.map((category, index) => (
        <li
          key={`${category.name}-${index}`}
          className="yolo-context-breakdown__list-item"
          data-bucket={category.bucket}
        >
          <span
            className={`yolo-context-breakdown__swatch ${BUCKET_CLASS[category.bucket]}`}
            aria-hidden="true"
          />
          <span className="yolo-context-breakdown__list-label">
            {category.name}
          </span>
          <span className="yolo-context-breakdown__list-tokens">
            {formatTokenCount(category.tokens)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function UsageBar({
  promptTokens,
  ratio,
  ariaLabel,
}: {
  promptTokens: number
  ratio: number | null
  ariaLabel: string
}) {
  const tone =
    ratio === null
      ? 'normal'
      : ratio >= 0.9
        ? 'danger'
        : ratio >= 0.7
          ? 'warning'
          : 'normal'
  // Without a known max, show a modest filled stub so the track still reads
  // as a usage bar rather than an empty strip.
  const widthPct =
    ratio === null
      ? promptTokens > 0
        ? 8
        : 0
      : Math.min(100, Math.max(ratio > 0 ? MIN_BAR_PERCENT : 0, ratio * 100))

  return (
    <div
      className="yolo-context-breakdown__bar"
      role="img"
      aria-label={ariaLabel}
      data-tone={tone}
    >
      {widthPct > 0 ? (
        <span
          className="yolo-context-breakdown__bar-fill"
          style={{ width: `${widthPct}%` }}
        />
      ) : null}
    </div>
  )
}

function BreakdownBar({
  breakdown,
  maxContextTokens,
  ariaLabel,
}: {
  breakdown: ReturnType<typeof useContextBreakdown>
  maxContextTokens: number | null
  ariaLabel: string
}) {
  if (breakdown.status !== 'ready') {
    return (
      <div
        className="yolo-context-breakdown__bar yolo-context-breakdown__bar--skeleton"
        aria-hidden="true"
      />
    )
  }

  const hasMax =
    typeof maxContextTokens === 'number' &&
    maxContextTokens > 0 &&
    Number.isFinite(maxContextTokens)
  const totalTokens = breakdown.data.total
  const max = hasMax ? maxContextTokens : Math.max(1, totalTokens)
  const segments = BUCKET_ORDER.map((bucket) => {
    const tokens =
      breakdown.data.buckets.find((b) => b.bucket === bucket)?.tokens ?? 0
    return { bucket, tokens }
  }).filter((seg) => seg.tokens > 0)

  return (
    <div
      className="yolo-context-breakdown__bar"
      role="img"
      aria-label={ariaLabel}
    >
      {segments.map((seg) => {
        const pct = (seg.tokens / max) * 100
        const widthPct = Math.max(pct, MIN_BAR_PERCENT)
        return (
          <span
            key={seg.bucket}
            className={`yolo-context-breakdown__bar-segment ${BUCKET_CLASS[seg.bucket]}`}
            style={{ width: `${widthPct}%` }}
          />
        )
      })}
    </div>
  )
}

function BreakdownList({
  breakdown,
  bucketLabels,
  errorLabel,
}: {
  breakdown: ReturnType<typeof useContextBreakdown>
  bucketLabels: Record<BucketKey, string>
  errorLabel: string
}) {
  if (breakdown.status === 'error') {
    return <div className="yolo-context-breakdown__error">{errorLabel}</div>
  }

  return (
    <ul className="yolo-context-breakdown__list">
      {BUCKET_ORDER.map((bucket) => {
        const isReady = breakdown.status === 'ready'
        const tokens = isReady
          ? (breakdown.data.buckets.find((b) => b.bucket === bucket)?.tokens ??
            0)
          : null
        return (
          <li
            key={bucket}
            className="yolo-context-breakdown__list-item"
            data-bucket={bucket}
          >
            <span
              className={`yolo-context-breakdown__swatch ${BUCKET_CLASS[bucket]}`}
              aria-hidden="true"
            />
            <span className="yolo-context-breakdown__list-label">
              {bucketLabels[bucket]}
            </span>
            <span className="yolo-context-breakdown__list-tokens">
              {tokens === null ? (
                <span
                  className="yolo-context-breakdown__list-skeleton"
                  aria-hidden="true"
                />
              ) : (
                formatTokenCount(tokens)
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
