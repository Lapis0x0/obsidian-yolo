import { type ButtonHTMLAttributes, forwardRef } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { formatTokenCount } from '../../utils/llm/formatTokenCount'

// viewBox 20x20 内放半径 9 的圆 + stroke-width 2，让描边外缘正好贴边，
// 避免环容器视觉上比实际圆大出 1px 留白
const RING_RADIUS = 9
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

const clampRatio = (value: number) => {
  if (!Number.isFinite(value)) {
    return 0
  }
  if (value <= 0) {
    return 0
  }
  if (value >= 1) {
    return 1
  }
  return value
}

const getUsageTone = (ratio: number) => {
  if (ratio >= 0.9) {
    return 'danger'
  }
  if (ratio >= 0.7) {
    return 'warning'
  }
  return 'normal'
}

export type ContextUsageRingProps = {
  promptTokens: number
  /** Null when the model context window is unknown — track only, no progress arc. */
  maxContextTokens: number | null
  label: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>

/**
 * Compact ring showing prompt-token usage against the model context window.
 * Rendered as a `<button>` so it can act as a Popover trigger.
 *
 * IMPORTANT: when used as `<Popover.Trigger asChild>`, Radix's `Slot` clones
 * this component and merges Radix-injected props (onClick / onKeyDown /
 * onPointerDown / aria-haspopup / aria-controls / id / data-state, …) onto the
 * resulting element. We must spread the full prop bag through to the
 * underlying `<button>` — picking out individual props would silently drop the
 * trigger's click/key handlers. That's why the type is the full
 * `ButtonHTMLAttributes` rather than a hand-picked subset.
 */
const ContextUsageRing = forwardRef<HTMLButtonElement, ContextUsageRingProps>(
  function ContextUsageRing(
    { promptTokens, maxContextTokens, label, className, title, ...rest },
    ref,
  ) {
    const { t } = useLanguage()
    const hasMax =
      typeof maxContextTokens === 'number' &&
      maxContextTokens > 0 &&
      Number.isFinite(maxContextTokens)
    const ratio = hasMax ? clampRatio(promptTokens / maxContextTokens) : null
    const dashOffset =
      ratio === null ? RING_CIRCUMFERENCE : RING_CIRCUMFERENCE * (1 - ratio)
    const tone = ratio === null ? 'normal' : getUsageTone(ratio)
    const percentLabel = ratio === null ? null : `${Math.round(ratio * 100)}%`
    const unknownMaxSuffix = t(
      'chat.contextUsageUnknownMaxSuffix',
      '（未设置上下文窗口上限）',
    )
    const titleLabel = hasMax
      ? `${label}: ${formatTokenCount(promptTokens)} / ${formatTokenCount(maxContextTokens)} (${percentLabel})`
      : `${label}: ${formatTokenCount(promptTokens)}${unknownMaxSuffix}`

    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={
          className
            ? `yolo-context-usage-ring ${className}`
            : 'yolo-context-usage-ring'
        }
        data-tone={tone}
        data-has-max={hasMax ? 'true' : 'false'}
        aria-label={titleLabel}
        // Don't fall back to titleLabel: Obsidian already shows its own
        // tooltip from aria-label; adding title on top stacks a second
        // native browser tooltip (same issue as LLMDebugButton).
        title={title}
      >
        <svg
          className="yolo-context-usage-ring__svg"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <circle
            className="yolo-context-usage-ring__track"
            cx="10"
            cy="10"
            r={RING_RADIUS}
          />
          {hasMax ? (
            <circle
              className="yolo-context-usage-ring__progress"
              cx="10"
              cy="10"
              r={RING_RADIUS}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
            />
          ) : null}
        </svg>
        {!hasMax ? (
          <span
            className="yolo-context-usage-ring__unknown-mark"
            aria-hidden="true"
          >
            ?
          </span>
        ) : null}
        <span className="yolo-context-usage-ring__sr-only">
          {percentLabel ??
            `${formatTokenCount(promptTokens)}${unknownMaxSuffix}`}
        </span>
      </button>
    )
  },
)

export default ContextUsageRing
