import cx from 'clsx'
import type { FocusEventHandler, MouseEventHandler, ReactNode } from 'react'

export function FloatingToast({
  children,
  className,
  exiting = false,
  role,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
}: {
  children: ReactNode
  className?: string
  exiting?: boolean
  role?: 'alert' | 'status'
  onMouseEnter?: MouseEventHandler<HTMLDivElement>
  onMouseLeave?: MouseEventHandler<HTMLDivElement>
  onFocus?: FocusEventHandler<HTMLDivElement>
  onBlur?: FocusEventHandler<HTMLDivElement>
}) {
  return (
    <div
      className={cx('yolo-floating-toast', exiting && 'is-exiting', className)}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {children}
    </div>
  )
}
