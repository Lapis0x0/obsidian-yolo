import * as Popover from '@radix-ui/react-popover'
import { ComponentPropsWithoutRef, RefObject, forwardRef } from 'react'

import {
  YoloPopoverProps,
  resolveYoloPopoverClassName,
  resolveYoloPopoverStyle,
} from './types'

type RadixContentProps = ComponentPropsWithoutRef<typeof Popover.Content>

export type YoloPopoverContentProps = Omit<RadixContentProps, 'className'> &
  YoloPopoverProps & {
    /**
     * Trigger (or anchor) ref. Used to resolve the Portal container from the
     * trigger's current document — keeps the popover in the same document as
     * its trigger, including after the panel is moved to an Obsidian popout
     * window — and inside the trigger's Obsidian modal, if any.
     */
    anchorRef?: RefObject<Node | null>
    /** Explicit Portal container override. Takes precedence over `anchorRef`. */
    container?: HTMLElement
    /** Extra class on the inner Content (escape hatch). */
    className?: string
  }

/**
 * Where a popover anchored at `anchorRef` mounts. Inside an Obsidian modal it
 * goes into that modal's container: the modal pulls focus back whenever it
 * leaves the container, and a popover that takes focus (a search field) would
 * otherwise close the instant it opens. Everywhere else, the trigger's own
 * document body.
 */
const resolveAnchorPortalContainer = (
  anchorRef: RefObject<Node | null> | undefined,
): HTMLElement | undefined => {
  const anchor = anchorRef?.current
  if (!anchor) return undefined
  const element =
    anchor instanceof Element ? anchor : (anchor.parentElement ?? null)
  const modalContainer = element?.closest<HTMLElement>('.modal-container')
  return modalContainer ?? anchor.ownerDocument?.body ?? undefined
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
    anchorRef,
    container,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const portalContainer = container ?? resolveAnchorPortalContainer(anchorRef)
  return (
    <Popover.Portal container={portalContainer}>
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
