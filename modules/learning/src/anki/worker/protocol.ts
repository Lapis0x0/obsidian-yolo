import type { AnkiImportResult } from '../parser/types'

export type AnkiWorkerRequest = {
  id: string
  packageBytes: ArrayBuffer
  wasmBytes: ArrayBuffer
  now?: number
}

export type AnkiWorkerResponse = {
  id: string
  result?: AnkiImportResult
  error?: string
}
