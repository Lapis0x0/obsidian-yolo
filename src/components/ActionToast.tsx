import { AlertTriangle, Check, CircleX, X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { type Root, createRoot } from 'react-dom/client'

import { FloatingToast } from './common/FloatingToast'

export type ActionToastTone = 'success' | 'warning' | 'error'

export type ActionToastOptions = {
  id: string
  tone: ActionToastTone
  title: string
  message: string
  actionLabel: string
  dismissLabel: string
  onAction: () => void | Promise<void>
}

type ActionToastSubscriber = () => void

export type ActionToastEntry = ActionToastOptions & { instanceId: number }

export class ActionToastStore {
  private toasts: ActionToastEntry[] = []
  private nextInstanceId = 0
  private readonly subscribers = new Set<ActionToastSubscriber>()

  readonly getSnapshot = (): ActionToastEntry[] => this.toasts

  readonly subscribe = (subscriber: ActionToastSubscriber): (() => void) => {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  show(toast: ActionToastOptions): void {
    const entry = { ...toast, instanceId: ++this.nextInstanceId }
    this.toasts = [...this.toasts.filter((item) => item.id !== toast.id), entry]
    this.emit()
  }

  dismiss(id: string): void {
    const next = this.toasts.filter((toast) => toast.id !== id)
    if (next.length === this.toasts.length) return
    this.toasts = next
    this.emit()
  }

  dismissInstance(instanceId: number): void {
    const next = this.toasts.filter((toast) => toast.instanceId !== instanceId)
    if (next.length === this.toasts.length) return
    this.toasts = next
    this.emit()
  }

  private emit(): void {
    for (const subscriber of this.subscribers) subscriber()
  }
}

export type ActionToastController = {
  show: (toast: ActionToastOptions) => void
  dismiss: (id: string) => void
  destroy: () => void
}

function ActionToastHost({ store }: { store: ActionToastStore }) {
  const toasts = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )

  return (
    <>
      {toasts.map((toast) => (
        <ActionToastItem key={toast.instanceId} store={store} toast={toast} />
      ))}
    </>
  )
}

function ActionToastItem({
  store,
  toast,
}: {
  store: ActionToastStore
  toast: ActionToastEntry
}) {
  const [exiting, setExiting] = useState(false)
  const [actionPending, setActionPending] = useState(false)

  useEffect(() => {
    if (!exiting) return
    const timer = window.setTimeout(
      () => store.dismissInstance(toast.instanceId),
      160,
    )
    return () => window.clearTimeout(timer)
  }, [exiting, store, toast])

  const Icon =
    toast.tone === 'success'
      ? Check
      : toast.tone === 'warning'
        ? AlertTriangle
        : CircleX

  const runAction = () => {
    setActionPending(true)
    void Promise.resolve(toast.onAction())
      .then(() => setExiting(true))
      .catch((error: unknown) => {
        console.error('[YOLO] Action toast navigation failed:', error)
        setActionPending(false)
      })
  }

  return (
    <FloatingToast
      className={`yolo-action-toast is-${toast.tone}`}
      exiting={exiting}
      role={toast.tone === 'error' ? 'alert' : 'status'}
    >
      <div className="yolo-action-toast-main">
        <span className="yolo-action-toast-seal" aria-hidden>
          <Icon size={17} strokeWidth={2.2} />
        </span>
        <div className="yolo-action-toast-copy">
          <strong>{toast.title}</strong>
          <span>{toast.message}</span>
        </div>
        <button
          type="button"
          className="yolo-action-toast-close"
          onClick={() => setExiting(true)}
          aria-label={toast.dismissLabel}
          title={toast.dismissLabel}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>
      <div className="yolo-action-toast-actions">
        <button
          type="button"
          className="yolo-action-toast-dismiss"
          onClick={() => setExiting(true)}
        >
          {toast.dismissLabel}
        </button>
        <button
          type="button"
          className="yolo-action-toast-cta"
          disabled={actionPending}
          onClick={runAction}
        >
          {toast.actionLabel}
        </button>
      </div>
    </FloatingToast>
  )
}

export function mountActionToast(): ActionToastController {
  const store = new ActionToastStore()
  const container = document.createElement('div')
  container.className =
    'yolo-floating-toast-root is-bottom-right yolo-action-toast-root'
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  root.render(<ActionToastHost store={store} />)

  return {
    show: (toast) => store.show(toast),
    dismiss: (id) => store.dismiss(id),
    destroy: () => {
      root.unmount()
      container.remove()
    },
  }
}
