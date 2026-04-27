import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ComponentPropsWithoutRef, forwardRef } from 'react'

import {
  YoloPopoverProps,
  resolveYoloPopoverClassName,
  resolveYoloPopoverStyle,
} from './types'

type RadixContentProps = ComponentPropsWithoutRef<typeof DropdownMenu.Content>

export type YoloDropdownContentProps = Omit<RadixContentProps, 'className'> &
  YoloPopoverProps & {
    /** Portal container. Forwarded to `DropdownMenu.Portal`. */
    container?: HTMLElement
    /** Extra class on the inner Content (escape hatch for consumer-specific tweaks). */
    className?: string
  }

/**
 * Wraps `DropdownMenu.Portal` + `DropdownMenu.Content` with the YOLO popover
 * surface system. All sizing/visual concerns are declared via props; never
 * inherit from a shared CSS class.
 */
export const YoloDropdownContent = forwardRef<
  HTMLDivElement,
  YoloDropdownContentProps
>(function YoloDropdownContent(
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
    <DropdownMenu.Portal container={container}>
      <DropdownMenu.Content
        ref={ref}
        className={resolveYoloPopoverClassName(variant, className)}
        style={resolveYoloPopoverStyle(
          { minWidth, maxWidth, maxHeight },
          style,
        )}
        {...rest}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
})
