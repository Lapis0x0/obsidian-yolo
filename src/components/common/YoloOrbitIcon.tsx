import React from 'react'

// Keep in sync with src/yoloIcon.ts (Obsidian ribbon / view tab icon).
const ORBIT_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 8.333,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

type YoloOrbitIconProps = {
  size?: number
  className?: string
}

export function YoloOrbitIcon({
  size = 16,
  className,
}: YoloOrbitIconProps): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
    >
      <circle cx="50" cy="50" r="12.5" {...ORBIT_STROKE} />
      <circle cx="79.167" cy="20.833" r="8.333" {...ORBIT_STROKE} />
      <circle cx="20.833" cy="79.167" r="8.333" {...ORBIT_STROKE} />
      <path
        d="M43.333 91.25a41.667 41.667 0 0 0 41.421-64.233"
        {...ORBIT_STROKE}
      />
      <path
        d="M56.25 8.75a41.667 41.667 0 0 0-41.004 64.233"
        {...ORBIT_STROKE}
      />
    </svg>
  )
}
