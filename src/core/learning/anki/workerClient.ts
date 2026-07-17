import workerScript from 'virtual:anki-worker-script'

import type { AnkiWorkerHandle, AnkiWorkerHost } from './AnkiWorkerHost'
import type { AnkiImportResult } from './types'
import type { AnkiWorkerRequest, AnkiWorkerResponse } from './worker'

export const parseAnkiPackageInWorker = (
  host: AnkiWorkerHost,
  packageBytes: ArrayBuffer,
  wasmBytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<AnkiImportResult> => {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    let settled = false
    let removeMessageListener: () => void = () => undefined
    let removeErrorListener: () => void = () => undefined
    let worker: AnkiWorkerHandle<AnkiWorkerRequest, AnkiWorkerResponse>

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
      worker = host.spawn<AnkiWorkerRequest, AnkiWorkerResponse>(workerScript)
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
