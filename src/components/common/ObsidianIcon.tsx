import { getIcon, setIcon } from 'obsidian'
import { useEffect, useRef } from 'react'

/** Generic fallback used whenever `name` is missing or not a recognized lucide id. */
export const DEFAULT_OBSIDIAN_ICON_FALLBACK = 'puzzle'

/**
 * Renders an Obsidian-native icon (the lucide word list, via `setIcon`)
 * inside a `<span>`. Falls back to `DEFAULT_OBSIDIAN_ICON_FALLBACK` when
 * `name` is undefined or not a recognized icon id (validated with
 * `getIcon`), so callers — including code rendering an icon name supplied by
 * a third-party module — never need to validate it themselves.
 *
 * Sizing and color are left to the caller's CSS, matching the existing
 * convention for `setIcon`-based glyphs elsewhere in this codebase (e.g. a
 * `<container> svg { width; height }` rule) rather than a `size` prop —
 * lucide-react icons size via an SVG attribute, but a `setIcon`-produced
 * `<svg>` only responds to CSS.
 */
export function ObsidianIcon({
  name,
  fallback = DEFAULT_OBSIDIAN_ICON_FALLBACK,
  className,
}: {
  name?: string
  fallback?: string
  className?: string
}) {
  const ref = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const resolvedName = name && getIcon(name) ? name : fallback
    setIcon(element, resolvedName)
  }, [name, fallback])

  return (
    <span
      ref={ref}
      className={`yolo-obsidian-icon${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    />
  )
}
