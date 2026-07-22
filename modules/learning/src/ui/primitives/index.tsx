import cx from 'clsx'
import type React from 'react'

export type Mastery = 'mastered' | 'learning' | 'new'

export function RingProgress({
  value,
  size = 60,
  stroke = 5,
  showLabel = true,
  className,
  label,
}: {
  value: number
  size?: number
  stroke?: number
  showLabel?: boolean
  className?: string
  label?: React.ReactNode
}) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (value / 100) * circumference

  return (
    <div
      className={cx('yolo-learning-ring', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="yolo-learning-ring-svg">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="yolo-learning-ring-track"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className="yolo-learning-ring-value"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      {showLabel && (
        <span
          className="yolo-learning-ring-label"
          style={{ fontSize: size * 0.24 }}
        >
          {label ?? `${value}%`}
        </span>
      )}
    </div>
  )
}

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

export function MasteryDot({ mastery }: { mastery: Mastery }) {
  return (
    <span
      className={cx(
        'yolo-learning-mastery-dot',
        `yolo-learning-mastery-dot-${mastery}`,
      )}
    />
  )
}

export function SelectMenu({
  value,
  options,
  onChange,
}: {
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="yolo-learning-select">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="yolo-learning-select-input"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden
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
