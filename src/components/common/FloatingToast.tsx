import cx from 'clsx'
import type { ReactNode } from 'react'

export function FloatingToast({
  children,
  className,
  exiting = false,
  role,
}: {
  children: ReactNode
  className?: string
  exiting?: boolean
  role?: 'alert' | 'status'
}) {
  return (
    <div
      className={cx('yolo-floating-toast', exiting && 'is-exiting', className)}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
    >
      {children}
    </div>
  )
}
