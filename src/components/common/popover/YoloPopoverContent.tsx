import * as Popover from '@radix-ui/react-popover'
import { ComponentPropsWithoutRef, forwardRef } from 'react'

import {
  YoloPopoverProps,
  resolveYoloPopoverClassName,
  resolveYoloPopoverStyle,
} from './types'

type RadixContentProps = ComponentPropsWithoutRef<typeof Popover.Content>

export type YoloPopoverContentProps = Omit<RadixContentProps, 'className'> &
  YoloPopoverProps & {
    /** Portal container. Forwarded to `Popover.Portal`. */
    container?: HTMLElement
    /** Extra class on the inner Content (escape hatch). */
    className?: string
  }

/**
 * Wraps `Popover.Portal` + `Popover.Content`. Same surface system as
 * `<YoloDropdownContent>` but for non-menu popovers (Radix Popover primitive).
 */
export const YoloPopoverContent = forwardRef<
  HTMLDivElement,
  YoloPopoverContentProps
>(function YoloPopoverContent(
  {
    variant,
    minWidth,
    maxWidth,
    maxHeight,
    container,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  return (
    <Popover.Portal container={container}>
      <Popover.Content
        ref={ref}
        className={resolveYoloPopoverClassName(variant, className)}
        style={resolveYoloPopoverStyle(
          { minWidth, maxWidth, maxHeight },
          style,
        )}
        {...rest}
      >
        {children}
      </Popover.Content>
    </Popover.Portal>
  )
})
