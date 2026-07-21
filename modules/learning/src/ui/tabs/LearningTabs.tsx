import cx from 'clsx'
import type { ReactNode } from 'react'

import { type LearningTabKey, learningTabs } from './tabs'

export type LearningTabLabels = Record<LearningTabKey, ReactNode>

export function LearningTabs({
  value,
  onChange,
  labels,
  visibleTabs = learningTabs,
  disabledTabs = [],
  badges,
  className,
  ariaLabel,
}: {
  value: LearningTabKey
  onChange: (tab: LearningTabKey) => void
  labels: LearningTabLabels
  visibleTabs?: readonly LearningTabKey[]
  disabledTabs?: readonly LearningTabKey[]
  badges?: Partial<Record<LearningTabKey, number>>
  className?: string
  ariaLabel: string
}) {
  return (
    <div
      aria-label={ariaLabel}
      className={cx('yolo-learning-segmented', className)}
      role="tablist"
    >
      {visibleTabs.map((tab) => {
        const selected = value === tab
        const disabled = disabledTabs.includes(tab)
        return (
          <button
            aria-selected={selected}
            className={cx(
              'yolo-learning-segmented-option',
              selected && 'is-active',
            )}
            disabled={disabled}
            key={tab}
            onClick={() => onChange(tab)}
            role="tab"
            type="button"
          >
            {labels[tab]}
            {badges?.[tab] ? (
              <span
                className={cx(
                  'yolo-learning-segmented-badge',
                  selected && 'is-active',
                )}
              >
                {badges[tab]}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
