import * as Popover from '@radix-ui/react-popover'
import {
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type RefObject,
  forwardRef,
} from 'react'

type ContentProps = ComponentPropsWithoutRef<typeof Popover.Content> & {
  anchorRef?: RefObject<Node | null>
  container?: HTMLElement
  variant?: 'default' | 'smart-space'
  minWidth?: number | string
  maxWidth?: number | string
  maxHeight?: number | string
}

const cssLength = (value: number | string | undefined) =>
  typeof value === 'number' ? `${value}px` : value

export function resolvePopoverContainer(
  container: HTMLElement | undefined,
  anchor: Node | null | undefined,
): HTMLElement | undefined {
  return container ?? anchor?.ownerDocument?.body ?? undefined
}

export const YoloPopoverContent = forwardRef<HTMLDivElement, ContentProps>(
  function YoloPopoverContent(
    {
      anchorRef,
      container,
      variant = 'default',
      minWidth,
      maxWidth,
      maxHeight,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) {
    const requestedMaxHeight = cssLength(maxHeight)
    const surfaceStyle: CSSProperties = {
      ...style,
      minWidth: cssLength(minWidth),
      maxWidth: cssLength(maxWidth),
      maxHeight: requestedMaxHeight
        ? `min(${requestedMaxHeight}, var(--radix-popover-content-available-height, ${requestedMaxHeight}))`
        : undefined,
    }
    return (
      <Popover.Portal
        container={resolvePopoverContainer(container, anchorRef?.current)}
      >
        <Popover.Content
          ref={ref}
          className={`yolo-popover-surface yolo-popover-surface--${variant}${className ? ` ${className}` : ''}`}
          style={surfaceStyle}
          {...props}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    )
  },
)
