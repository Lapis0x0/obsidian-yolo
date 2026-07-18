import type { AnkiImportResult } from '../parser/types'

import type { WorkerFactory, WorkerPort } from './ports'
import type { AnkiWorkerRequest, AnkiWorkerResponse } from './protocol'

export const parseAnkiPackageInWorker = (
  factory: WorkerFactory,
  workerSource: string,
  packageBytes: ArrayBuffer,
  wasmBytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<AnkiImportResult> => {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    let settled = false
    let removeMessageListener: () => void = () => undefined
    let removeErrorListener: () => void = () => undefined
    let worker: WorkerPort<AnkiWorkerRequest, AnkiWorkerResponse>

    const cleanup = () => {
      const attempts = [
        removeMessageListener,
        removeErrorListener,
        () => signal?.removeEventListener('abort', abort),
        () => worker.terminate(),
      ]
      for (const attempt of attempts) {
        try {
          attempt()
        } catch {
          // Teardown is best effort and must not replace the parse outcome.
        }
      }
    }
    const settle = (
      outcome: { result: AnkiImportResult } | { error: Error | DOMException },
    ) => {
      if (settled) return
      settled = true
      cleanup()
      if ('result' in outcome) resolve(outcome.result)
      else reject(outcome.error)
    }
    const abort = () => {
      settle({
        error: new DOMException('Anki import was aborted', 'AbortError'),
      })
    }

    try {
      worker = factory.spawn<AnkiWorkerRequest, AnkiWorkerResponse>(
        workerSource,
      )
    } catch (error) {
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    try {
      removeErrorListener = worker.subscribeError((error) => {
        settle({ error })
      })
      removeMessageListener = worker.subscribeMessage((response) => {
        if (response.id !== id) return
        if (response.error) settle({ error: new Error(response.error) })
        else if (response.result) settle({ result: response.result })
        else settle({ error: new Error('Anki worker returned no result') })
      })
    } catch (error) {
      settle({
        error: error instanceof Error ? error : new Error(String(error)),
      })
      return
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      worker.postMessage(
        { id, packageBytes, wasmBytes } satisfies AnkiWorkerRequest,
        [packageBytes, wasmBytes],
      )
    } catch (error) {
      settle({
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  })
}
