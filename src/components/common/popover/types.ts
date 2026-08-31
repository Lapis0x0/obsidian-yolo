import { CSSProperties } from 'react'

export type YoloPopoverVariant = 'default' | 'continuation'

/**
 * Props shared by `<YoloDropdownContent>` and `<YoloPopoverContent>`.
 *
 * Sizing is intentionally explicit: every consumer MUST declare its own
 * minWidth / maxWidth / maxHeight (or leave them undefined for `auto`).
 * No values are inherited from any "shared" CSS class — that's the whole
 * point of this abstraction. See docs/plans/parsed-wiggling-shore.md.
 */
export type YoloPopoverProps = {
  /** Visual preset. `default` matches the chat-sidebar look; `continuation` matches the Continuation floating popover look. */
  variant?: YoloPopoverVariant
  minWidth?: number | string
  maxWidth?: number | string
  maxHeight?: number | string
}

const toCssLength = (
  value: number | string | undefined,
): string | undefined => {
  if (value === undefined) return undefined
  return typeof value === 'number' ? `${value}px` : value
}

export const resolveYoloPopoverClassName = (
  variant: YoloPopoverVariant = 'default',
  extra?: string,
): string => {
  const base = `yolo-popover-surface yolo-popover-surface--${variant}`
  return extra ? `${base} ${extra}` : base
}

export const resolveYoloPopoverStyle = (
  size: Pick<YoloPopoverProps, 'minWidth' | 'maxWidth' | 'maxHeight'>,
  override?: CSSProperties,
): CSSProperties => {
  const out: CSSProperties = { ...override }
  const min = toCssLength(size.minWidth)
  const max = toCssLength(size.maxWidth)
  const maxH = toCssLength(size.maxHeight)
  if (min !== undefined) out.minWidth = min
  if (max !== undefined) out.maxWidth = max
  if (maxH !== undefined) {
    // Radix Popover / DropdownMenu inject `--radix-*-content-available-height`
    // representing the viewport space on the chosen side of the trigger. Clamp
    // the requested cap by that so the surface never overflows the viewport
    // (which would let the outer `overflow: hidden` cut off the scrollbar of
    // inner scroll regions). Whichever primitive is active sets its own var;
    // the other resolves to the fallback chain end and is ignored.
    out.maxHeight = `min(${maxH}, var(--radix-popover-content-available-height, var(--radix-dropdown-menu-content-available-height, ${maxH})))`
  }
  return out
}
