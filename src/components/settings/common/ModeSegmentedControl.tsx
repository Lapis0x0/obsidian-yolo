import type { LucideIcon } from 'lucide-react'
import type { CSSProperties } from 'react'

type ModeSegmentedControlOption<T extends string> = {
  value: T
  label: string
  Icon: LucideIcon
}

type ModeSegmentedControlProps<T extends string> = {
  value: T
  options: readonly ModeSegmentedControlOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
}

export function ModeSegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: ModeSegmentedControlProps<T>) {
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  return (
    <div
      className="yolo-mode-seg"
      role="tablist"
      aria-label={ariaLabel}
      style={
        {
          '--yolo-mode-seg-count': options.length,
          '--yolo-mode-seg-index': activeIndex,
        } as CSSProperties
      }
    >
      <div className="yolo-mode-seg-glider" aria-hidden="true" />
      {options.map(({ value: optionValue, label, Icon }) => (
        <button
          key={optionValue}
          type="button"
          role="tab"
          aria-selected={value === optionValue}
          className={`yolo-mode-seg-btn${
            value === optionValue ? ' is-active' : ''
          }`}
          onClick={() => onChange(optionValue)}
        >
          <span className="yolo-mode-seg-icon" aria-hidden="true">
            <Icon size={14} />
          </span>
          <span className="yolo-mode-seg-label">{label}</span>
        </button>
      ))}
    </div>
  )
}
