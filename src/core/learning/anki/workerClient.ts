import workerScript from 'virtual:anki-worker-script'

import type { AnkiImportResult } from './types'
import type { AnkiWorkerRequest, AnkiWorkerResponse } from './worker'

export const parseAnkiPackageInWorker = (
  packageBytes: ArrayBuffer,
  wasmBytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<AnkiImportResult> => {
  const url = URL.createObjectURL(
    new Blob([workerScript], { type: 'text/javascript' }),
  )
  const worker = new Worker(url)
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const cleanup = () => {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
    const abort = () => {
      cleanup()
      reject(new DOMException('Anki import was aborted', 'AbortError'))
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => {
      cleanup()
      signal?.removeEventListener('abort', abort)
      reject(new Error(event.message))
    }
    worker.onmessage = (event: MessageEvent<AnkiWorkerResponse>) => {
      if (event.data.id !== id) return
      cleanup()
      if (event.data.error) reject(new Error(event.data.error))
      else if (event.data.result) resolve(event.data.result)
      else reject(new Error('Anki worker returned no result'))
    }
    worker.postMessage(
      { id, packageBytes, wasmBytes } satisfies AnkiWorkerRequest,
      [packageBytes, wasmBytes],
    )
  })
}
