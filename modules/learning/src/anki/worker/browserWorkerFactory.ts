import type { WorkerFactory, WorkerPort } from './ports'

export const createBrowserWorkerFactory = (): WorkerFactory => ({
  spawn<TRequest, TResponse>(source: string): WorkerPort<TRequest, TResponse> {
    const url = URL.createObjectURL(
      new Blob([source], { type: 'text/javascript' }),
    )
    let worker: Worker
    try {
      worker = new Worker(url)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }

    let terminated = false
    const messageListeners = new Set<(event: MessageEvent<TResponse>) => void>()
    const errorListeners = new Set<(event: ErrorEvent) => void>()

    return {
      subscribeMessage(listener) {
        if (terminated) return () => undefined
        const bridge = (event: MessageEvent<TResponse>) => listener(event.data)
        messageListeners.add(bridge)
        worker.addEventListener('message', bridge)
        return () => {
          if (!messageListeners.delete(bridge)) return
          worker.removeEventListener('message', bridge)
        }
      },
      subscribeError(listener) {
        if (terminated) return () => undefined
        const bridge = (event: ErrorEvent) =>
          listener(
            event.error instanceof Error
              ? event.error
              : new Error(event.message),
          )
        errorListeners.add(bridge)
        worker.addEventListener('error', bridge)
        return () => {
          if (!errorListeners.delete(bridge)) return
          worker.removeEventListener('error', bridge)
        }
      },
      postMessage(message, transfer) {
        worker.postMessage(message, transfer)
      },
      terminate() {
        if (terminated) return
        terminated = true
        try {
          for (const bridge of messageListeners)
            worker.removeEventListener('message', bridge)
          for (const bridge of errorListeners)
            worker.removeEventListener('error', bridge)
          messageListeners.clear()
          errorListeners.clear()
          worker.terminate()
        } finally {
          URL.revokeObjectURL(url)
        }
      },
    }
  },
})
