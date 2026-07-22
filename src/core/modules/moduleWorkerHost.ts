import type { ModuleLifecycleScope } from './lifecycleScope'

export type YoloModuleWorkerCallOptionsV1 = Readonly<{
  signal?: AbortSignal
  transfer?: readonly ArrayBuffer[]
}>

export type YoloModuleWorkerV1 = Readonly<{
  call<TResult = unknown>(
    method: string,
    payload?: unknown,
    options?: YoloModuleWorkerCallOptionsV1,
  ): Promise<TResult>
  terminate(): void
}>

export type YoloModuleWorkersV1 = Readonly<{
  create(source: string): YoloModuleWorkerV1
}>

export type ModuleWorkerFactory = (url: string) => Worker

export class ModuleWorkerHostCapabilityProvider {
  constructor(
    private readonly createWorker: ModuleWorkerFactory = (url) =>
      new Worker(url),
  ) {}

  create(moduleId: string, lifecycle: ModuleLifecycleScope) {
    const workers = new Set<YoloModuleWorkerV1>()
    let active = true
    let activationComplete = false
    lifecycle.add(() => {
      active = false
      activationComplete = false
      for (const worker of workers) worker.terminate()
      workers.clear()
    })
    const assertActive = (): void => {
      if (!active) throw new Error(`Module "${moduleId}" is no longer active`)
      if (!activationComplete)
        throw new Error(`Module "${moduleId}" workers are not active`)
    }
    const api: YoloModuleWorkersV1 = Object.freeze({
      create: (source) => {
        assertActive()
        if (typeof source !== 'string' || !source)
          throw new TypeError('Worker source must be a non-empty string')
        const url = URL.createObjectURL(
          new Blob([source], { type: 'text/javascript' }),
        )
        let nativeWorker: Worker
        try {
          nativeWorker = this.createWorker(url)
        } catch (error) {
          URL.revokeObjectURL(url)
          throw error
        }
        let terminated = false
        let nextId = 0
        const pending = new Map<
          number,
          {
            resolve(value: unknown): void
            reject(error: Error): void
            cleanup(): void
          }
        >()
        const terminate = (): void => {
          if (terminated) return
          terminated = true
          workers.delete(handle)
          nativeWorker.removeEventListener('message', onMessage)
          nativeWorker.removeEventListener('error', onError)
          nativeWorker.terminate()
          URL.revokeObjectURL(url)
          for (const request of pending.values()) {
            request.cleanup()
            request.reject(
              new Error(`Module "${moduleId}" worker was terminated`),
            )
          }
          pending.clear()
        }
        const onMessage = (event: MessageEvent) => {
          const response = event.data as {
            id?: unknown
            result?: unknown
            error?: unknown
          }
          if (
            !response ||
            typeof response !== 'object' ||
            typeof response.id !== 'number'
          )
            return
          const request = pending.get(response.id)
          if (!request) return
          pending.delete(response.id)
          request.cleanup()
          if (typeof response.error === 'string')
            request.reject(new Error(response.error))
          else request.resolve(response.result)
        }
        const onError = (event: ErrorEvent) => {
          const error =
            event.error instanceof Error
              ? event.error
              : new Error(event.message || 'Module worker failed')
          for (const request of pending.values()) {
            request.cleanup()
            request.reject(error)
          }
          pending.clear()
          terminate()
        }
        const handle: YoloModuleWorkerV1 = Object.freeze({
          call: <TResult>(
            method: string,
            payload?: unknown,
            options?: YoloModuleWorkerCallOptionsV1,
          ) => {
            assertActive()
            if (terminated)
              return Promise.reject(
                new Error(`Module "${moduleId}" worker was terminated`),
              )
            if (typeof method !== 'string' || !method.trim())
              return Promise.reject(
                new TypeError('Worker method must be a non-empty string'),
              )
            if (options?.signal?.aborted) return Promise.reject(abortError())
            const id = ++nextId
            return new Promise<TResult>((resolve, reject) => {
              const abort = () => {
                if (!pending.delete(id)) return
                try {
                  nativeWorker.postMessage({ id, cancel: true })
                } catch {
                  // Cancellation still settles locally if the worker has failed.
                }
                reject(abortError())
              }
              const cleanup = () =>
                options?.signal?.removeEventListener('abort', abort)
              pending.set(id, {
                resolve: (value) => resolve(value as TResult),
                reject,
                cleanup,
              })
              options?.signal?.addEventListener('abort', abort, { once: true })
              try {
                nativeWorker.postMessage({ id, method, payload }, [
                  ...(options?.transfer ?? []),
                ])
              } catch (error) {
                pending.delete(id)
                cleanup()
                reject(
                  error instanceof Error ? error : new Error(String(error)),
                )
              }
            })
          },
          terminate,
        })
        nativeWorker.addEventListener('message', onMessage)
        nativeWorker.addEventListener('error', onError)
        workers.add(handle)
        return handle
      },
    })
    return Object.freeze({
      api,
      activate: () => {
        if (!active) assertActive()
        activationComplete = true
      },
    })
  }
}

export const UNAVAILABLE_MODULE_WORKER_CAPABILITY_PROVIDER = Object.freeze({
  create: () => ({
    api: Object.freeze({
      create: () => {
        throw new Error('Module worker capability is unavailable')
      },
    }),
    activate: () => undefined,
  }),
})

function abortError(): DOMException {
  return new DOMException('Module worker call was aborted', 'AbortError')
}
