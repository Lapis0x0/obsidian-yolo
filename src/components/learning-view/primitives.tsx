import cx from 'clsx'
import type React from 'react'

export type Mastery = 'mastered' | 'learning' | 'new'

/* Ring / circular progress */
export function RingProgress({
  value,
  size = 60,
  stroke = 5,
  showLabel = true,
  className,
}: {
  value: number
  size?: number
  stroke?: number
  showLabel?: boolean
  className?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c - (value / 100) * c
  return (
    <div
      className={cx('yolo-learning-ring', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="yolo-learning-ring-svg">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="yolo-learning-ring-track"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="yolo-learning-ring-value"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      {showLabel && (
        <span
          className="yolo-learning-ring-label"
          style={{ fontSize: size * 0.24 }}
        >
          {value}%
        </span>
      )}
    </div>
  )
}

/* Linear progress bar */
export function ProgressBar({
  value,
  className,
}: {
  value: number
  className?: string
}) {
  return (
    <div className={cx('yolo-learning-progress', className)}>
      <div
        className="yolo-learning-progress-fill"
        style={{ width: `${value}%` }}
      />
    </div>
  )
}

/* Pill / chip badge */
export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
  className?: string
}) {
  return (
    <span
      className={cx(
        'yolo-learning-pill',
        `yolo-learning-pill-${tone}`,
        className,
      )}
    >
      {children}
    </span>
  )
}

/* Mastery dot */
export function MasteryDot({
  mastery,
  className,
}: {
  mastery: Mastery
  className?: string
}) {
  return (
    <span
      className={cx(
        'yolo-learning-mastery-dot',
        `yolo-learning-mastery-dot-${mastery}`,
        className,
      )}
    />
  )
}

export const masteryLabel: Record<Mastery, string> = {
  mastered: '已掌握',
  learning: '学习中',
  new: '未开始',
}

type SelectOption = string | { value: string; label: string }

function selectOptionValue(option: SelectOption) {
  return typeof option === 'string' ? option : option.value
}

function selectOptionLabel(option: SelectOption) {
  return typeof option === 'string' ? option : option.label
}

/* Segmented control (mode / tab switch) */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  badges,
  getLabel,
  className,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  badges?: Partial<Record<T, number>>
  getLabel?: (value: T) => React.ReactNode
  className?: string
}) {
  return (
    <div className={cx('yolo-learning-segmented', className)}>
      {options.map((opt) => {
        const active = value === opt
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cx(
              'yolo-learning-segmented-option',
              active && 'is-active',
            )}
          >
            {getLabel ? getLabel(opt) : opt}
            {badges?.[opt] ? (
              <span
                className={cx(
                  'yolo-learning-segmented-badge',
                  active && 'is-active',
                )}
              >
                {badges[opt]}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/* Lightweight select that mimics a native dropdown trigger */
export function SelectMenu({
  value,
  options,
  onChange,
  className,
}: {
  value: string
  options: SelectOption[]
  onChange?: (v: string) => void
  className?: string
}) {
  return (
    <div className={cx('yolo-learning-select', className)}>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="yolo-learning-select-input"
      >
        {options.map((option) => (
          <option
            key={selectOptionValue(option)}
            value={selectOptionValue(option)}
          >
            {selectOptionLabel(option)}
          </option>
        ))}
      </select>
      <svg
        className="yolo-learning-select-chevron"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}
