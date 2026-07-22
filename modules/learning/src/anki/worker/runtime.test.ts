import type { AnkiImportResult } from '../parser/types'

import type { WorkerRuntimePort } from './ports'
import type { AnkiWorkerRequest, AnkiWorkerResponse } from './protocol'
import { startAnkiWorkerRuntime } from './runtime'

const emptyResult = (): AnkiImportResult => ({
  format: 'modern',
  decks: [],
  notes: [],
  media: {},
  mediaFiles: {},
  srsPlan: { eventsByCard: {} },
  warnings: [],
})

describe('startAnkiWorkerRuntime', () => {
  it('parses requests and transfers media buffers in the response', async () => {
    let listener: ((request: AnkiWorkerRequest) => void) | undefined
    const remove = jest.fn()
    const postMessage = jest.fn()
    const runtime: WorkerRuntimePort<AnkiWorkerRequest, AnkiWorkerResponse> = {
      subscribeMessage: jest.fn((next) => {
        listener = next
        return remove
      }),
      postMessage,
    }
    const media = new Uint8Array([1, 2, 3])
    const result = { ...emptyResult(), mediaFiles: { 'image.png': media } }
    const parse = jest.fn(async () => result)
    const packageBytes = new ArrayBuffer(2)
    const wasmBytes = new ArrayBuffer(3)

    expect(startAnkiWorkerRuntime(runtime, parse)).toBe(remove)
    listener?.({ id: 'request', packageBytes, wasmBytes, now: 42 })
    await Promise.resolve()

    expect(parse).toHaveBeenCalledWith(new Uint8Array(packageBytes), {
      wasmBinary: new Uint8Array(wasmBytes),
      now: 42,
    })
    expect(postMessage).toHaveBeenCalledWith({ id: 'request', result }, [
      media.buffer,
    ])
  })

  it('returns a correlated error without a transfer list', async () => {
    let listener: ((request: AnkiWorkerRequest) => void) | undefined
    const postMessage = jest.fn()
    const runtime: WorkerRuntimePort<AnkiWorkerRequest, AnkiWorkerResponse> = {
      subscribeMessage(next) {
        listener = next
        return () => undefined
      },
      postMessage,
    }
    const parse = jest.fn(async () => {
      throw new Error('bad package')
    })

    startAnkiWorkerRuntime(runtime, parse)
    listener?.({
      id: 'request',
      packageBytes: new ArrayBuffer(0),
      wasmBytes: new ArrayBuffer(0),
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(postMessage).toHaveBeenCalledWith({
      id: 'request',
      error: 'bad package',
    })
  })
})
