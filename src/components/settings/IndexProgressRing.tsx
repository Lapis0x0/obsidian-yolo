type IndexProgressRingProps = {
  percent: number
  size?: number
  strokeWidth?: number
  'aria-label'?: string
}

export function IndexProgressRing({
  percent,
  size = 36,
  strokeWidth = 3,
  'aria-label': ariaLabel,
}: IndexProgressRingProps) {
  const clamped = Math.max(0, Math.min(100, percent))
  const center = size / 2
  const r = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * r
  const dashOffset = circumference * (1 - clamped / 100)

  const label = ariaLabel ?? `Indexing progress ${Math.round(clamped)} percent`

  return (
    <div
      className="yolo-index-ring"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="presentation"
        focusable="false"
      >
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          className="yolo-index-ring-track"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          className="yolo-index-ring-fill"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: 'stroke-dashoffset 200ms ease' }}
        />
      </svg>
      <span className="yolo-index-ring-label" aria-hidden="true">
        <span className="yolo-index-ring-pct">{Math.round(clamped)}</span>
        <span className="yolo-index-ring-sym">%</span>
      </span>
    </div>
  )
}
