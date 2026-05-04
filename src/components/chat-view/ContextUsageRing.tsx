import * as Tooltip from '@radix-ui/react-tooltip'

import { formatTokenCount } from '../../utils/llm/formatTokenCount'

const RING_RADIUS = 8
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

export default function ContextUsageRing({
  promptTokens,
  maxContextTokens,
  label,
}: {
  promptTokens: number
  maxContextTokens: number
  label: string
}) {
  const ratio = clampRatio(promptTokens / maxContextTokens)
  const dashOffset = RING_CIRCUMFERENCE * (1 - ratio)
  const tone = getUsageTone(ratio)
  const percentLabel = `${Math.round(ratio * 100)}%`
  const tooltipLabel = `${label}: ${formatTokenCount(promptTokens)} / ${formatTokenCount(maxContextTokens)} (${percentLabel})`

  return (
    <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div
            className="smtcmp-context-usage-ring"
            data-tone={tone}
            aria-hidden="true"
          >
            <svg
              className="smtcmp-context-usage-ring__svg"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <circle
                className="smtcmp-context-usage-ring__track"
                cx="10"
                cy="10"
                r={RING_RADIUS}
              />
              <circle
                className="smtcmp-context-usage-ring__progress"
                cx="10"
                cy="10"
                r={RING_RADIUS}
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <span className="smtcmp-context-usage-ring__sr-only">
              {percentLabel}
            </span>
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="smtcmp-tooltip-content"
            side="bottom"
            sideOffset={6}
          >
            {tooltipLabel}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
