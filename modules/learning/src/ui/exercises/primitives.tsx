import type { ReactNode } from 'react'

export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
}) {
  return (
    <span className={`yolo-learning-pill yolo-learning-pill-${tone}`}>
      {children}
    </span>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  badges,
  getLabel,
}: {
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  badges?: Partial<Record<T, number>>
  getLabel?: (value: T) => ReactNode
}) {
  return (
    <div className="yolo-learning-segmented">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={value === option ? 'is-active' : undefined}
          onClick={() => onChange(option)}
        >
          {getLabel?.(option) ?? option}
          {badges?.[option] ? (
            <span className="yolo-learning-segmented-badge">
              {badges[option]}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

export function SelectMenu({
  value,
  options,
  onChange,
}: {
  value: string
  options: ReadonlyArray<string | { value: string; label: ReactNode }>
  onChange: (value: string) => void
}) {
  return (
    <div className="yolo-learning-select">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="yolo-learning-select-input"
      >
        {options.map((option) => {
          const item =
            typeof option === 'string'
              ? { value: option, label: option }
              : option
          return (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          )
        })}
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
