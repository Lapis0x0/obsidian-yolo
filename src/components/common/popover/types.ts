import { CSSProperties } from 'react'

export type YoloPopoverVariant = 'default' | 'smart-space'

/**
 * Props shared by `<YoloDropdownContent>` and `<YoloPopoverContent>`.
 *
 * Sizing is intentionally explicit: every consumer MUST declare its own
 * minWidth / maxWidth / maxHeight (or leave them undefined for `auto`).
 * No values are inherited from any "shared" CSS class — that's the whole
 * point of this abstraction. See docs/plans/parsed-wiggling-shore.md.
 */
export type YoloPopoverProps = {
  /** Visual preset. `default` matches the chat-sidebar look; `smart-space` matches the SmartSpace floating popover look. */
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
  if (maxH !== undefined) out.maxHeight = maxH
  return out
}
