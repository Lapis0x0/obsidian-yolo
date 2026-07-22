import { parseAnkiPackage } from '../parser'
import type { AnkiImportResult } from '../parser/types'

import type { WorkerRuntimePort } from './ports'
import type { AnkiWorkerRequest, AnkiWorkerResponse } from './protocol'

export type AnkiPackageParser = (
  input: Uint8Array,
  options: { wasmBinary: Uint8Array; now?: number },
) => Promise<AnkiImportResult>

export const startAnkiWorkerRuntime = (
  runtime: WorkerRuntimePort<AnkiWorkerRequest, AnkiWorkerResponse>,
  parse: AnkiPackageParser = parseAnkiPackage,
): (() => void) =>
  runtime.subscribeMessage((request) => {
    void parse(new Uint8Array(request.packageBytes), {
      wasmBinary: new Uint8Array(request.wasmBytes),
      now: request.now,
    })
      .then((result) => {
        const transfer = Object.values(result.mediaFiles).map((bytes) =>
          bytes.buffer instanceof ArrayBuffer
            ? bytes.buffer
            : bytes.buffer.slice(0),
        )
        runtime.postMessage(
          { id: request.id, result } satisfies AnkiWorkerResponse,
          transfer,
        )
      })
      .catch((error: unknown) =>
        runtime.postMessage({
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        } satisfies AnkiWorkerResponse),
      )
  })
