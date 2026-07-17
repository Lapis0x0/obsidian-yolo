import { parseAnkiPackage } from './index'

export type AnkiWorkerRequest = {
  id: string
  packageBytes: ArrayBuffer
  wasmBytes: ArrayBuffer
  now?: number
}
export type AnkiWorkerResponse = {
  id: string
  result?: Awaited<ReturnType<typeof parseAnkiPackage>>
  error?: string
}

self.onmessage = (event: MessageEvent<AnkiWorkerRequest>) => {
  const request = event.data
  void parseAnkiPackage(new Uint8Array(request.packageBytes), {
    wasmBinary: new Uint8Array(request.wasmBytes),
    now: request.now,
  })
    .then((result) => {
      const transfer = Object.values(result.mediaFiles).map((bytes) =>
        bytes.buffer instanceof ArrayBuffer
          ? bytes.buffer
          : bytes.buffer.slice(0),
      )
      const post = self.postMessage as unknown as (
        message: AnkiWorkerResponse,
        transfer: ArrayBuffer[],
      ) => void
      post.call(
        self,
        { id: request.id, result } satisfies AnkiWorkerResponse,
        transfer,
      )
    })
    .catch((error: unknown) =>
      self.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies AnkiWorkerResponse),
    )
}
