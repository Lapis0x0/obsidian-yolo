import type { ReactNode } from 'react'

export type Mastery = 'mastered' | 'learning' | 'new'

export function MasteryDot({ mastery }: { mastery: Mastery }) {
  return (
    <span
      className={`yolo-learning-mastery-dot yolo-learning-mastery-dot-${mastery}`}
    />
  )
}

export function SelectMenu({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string
  options: ReadonlyArray<string | { value: string; label: ReactNode }>
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="yolo-learning-select">
      <select
        value={value}
        disabled={disabled}
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
