// The math engine: MathJax, laid out as Obsidian lays out a formula in a
// note, in a worker of its own (./worker.ts) so that a board full of
// formulas is laid out without holding up the window.

import workerSource from 'virtual:mathjax-worker-script'

import type {
  MathEngineComponentApi,
  MathLayout,
} from '../../../src/core/runtime-components/contracts'

import type { MathWorkerRequest, MathWorkerResponse } from './worker'

globalThis.__yolo_register_runtime_component__({
  id: 'mathjax-engine',
  create(): MathEngineComponentApi {
    const url = URL.createObjectURL(
      new Blob([workerSource], { type: 'text/javascript' }),
    )
    const worker = new Worker(url)
    let next = 0
    let disposed = false
    const pending = new Map<
      number,
      Readonly<{
        resolve: (layouts: readonly (MathLayout | null)[]) => void
        reject: (error: Error) => void
      }>
    >()
    const failAll = (error: Error): void => {
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
    }
    worker.onmessage = (event: MessageEvent<MathWorkerResponse>) => {
      const waiter = pending.get(event.data.id)
      pending.delete(event.data.id)
      waiter?.resolve(event.data.layouts)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      failAll(new Error(`Math engine failed: ${event.message}`))
    }
    return Object.freeze({
      layout(requests) {
        if (disposed) {
          return Promise.reject(new Error('Math engine is disposed'))
        }
        if (requests.length === 0) return Promise.resolve([])
        const id = next++
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          worker.postMessage({ id, requests } satisfies MathWorkerRequest)
        })
      },
      dispose() {
        if (disposed) return
        disposed = true
        worker.terminate()
        URL.revokeObjectURL(url)
        failAll(new Error('Math engine is disposed'))
      },
    })
  },
})
