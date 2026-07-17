import type { AnkiWorkerHandle, AnkiWorkerHost } from './AnkiWorkerHost'
import type { AnkiImportResult } from './types'
import type { AnkiWorkerRequest, AnkiWorkerResponse } from './worker'
import { parseAnkiPackageInWorker } from './workerClient'

const result: AnkiImportResult = {
  format: 'modern',
  decks: [],
  notes: [],
  media: {},
  mediaFiles: {},
  srsPlan: { eventsByCard: {} },
  warnings: [],
}
const requestId = '00000000-0000-4000-8000-000000000000' as const

class TestWorker
  implements AnkiWorkerHandle<AnkiWorkerRequest, AnkiWorkerResponse>
{
  messageListener: ((message: AnkiWorkerResponse) => void) | undefined
  errorListener: ((error: Error) => void) | undefined
  readonly postMessage = jest.fn(
    (_message: AnkiWorkerRequest, _transfer: ArrayBuffer[]) => undefined,
  )
  readonly terminate = jest.fn()
  readonly removeMessage = jest.fn(() => {
    this.messageListener = undefined
  })
  readonly removeError = jest.fn(() => {
    this.errorListener = undefined
  })

  subscribeMessage(listener: (message: AnkiWorkerResponse) => void) {
    this.messageListener = listener
    return this.removeMessage
  }

  subscribeError(listener: (error: Error) => void) {
    this.errorListener = listener
    return this.removeError
  }
}

const setup = (worker = new TestWorker()) => {
  const host: AnkiWorkerHost = {
    spawn: jest.fn(() => worker) as AnkiWorkerHost['spawn'],
  }
  const packageBytes = new ArrayBuffer(2)
  const wasmBytes = new ArrayBuffer(3)
  return { host, worker, packageBytes, wasmBytes }
}

const expectCleanedUp = (worker: TestWorker) => {
  expect(worker.removeMessage).toHaveBeenCalledTimes(1)
  expect(worker.removeError).toHaveBeenCalledTimes(1)
  expect(worker.terminate).toHaveBeenCalledTimes(1)
}

describe('parseAnkiPackageInWorker', () => {
  beforeEach(() => {
    jest.spyOn(crypto, 'randomUUID').mockReturnValue(requestId)
  })

  afterEach(() => jest.restoreAllMocks())

  it('preserves the request ID and transfer list, then cleans up on success', async () => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    const controller = new AbortController()
    const removeEventListener = jest.spyOn(
      controller.signal,
      'removeEventListener',
    )
    const promise = parseAnkiPackageInWorker(
      host,
      packageBytes,
      wasmBytes,
      controller.signal,
    )

    expect(worker.postMessage).toHaveBeenCalledWith(
      { id: requestId, packageBytes, wasmBytes },
      [packageBytes, wasmBytes],
    )
    worker.messageListener?.({ id: 'other-id', result })
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.messageListener?.({ id: requestId, result })

    await expect(promise).resolves.toBe(result)
    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    )
    expectCleanedUp(worker)
  })

  it.each([
    [
      'result error',
      (worker: TestWorker) =>
        worker.messageListener?.({ id: requestId, error: 'parse failed' }),
      'parse failed',
    ],
    [
      'empty result',
      (worker: TestWorker) => worker.messageListener?.({ id: requestId }),
      'Anki worker returned no result',
    ],
    [
      'runtime error',
      (worker: TestWorker) =>
        worker.errorListener?.(new Error('worker crashed')),
      'worker crashed',
    ],
  ])('cleans up on %s', async (_name, fail, message) => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    const promise = parseAnkiPackageInWorker(host, packageBytes, wasmBytes)

    fail(worker)

    await expect(promise).rejects.toThrow(message)
    expectCleanedUp(worker)
  })

  it('cleans up when postMessage throws', async () => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    worker.postMessage.mockImplementation(() => {
      throw new Error('clone failed')
    })

    await expect(
      parseAnkiPackageInWorker(host, packageBytes, wasmBytes),
    ).rejects.toThrow('clone failed')
    expectCleanedUp(worker)
  })

  it('terminates and rejects when the error subscription throws', async () => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    jest.spyOn(worker, 'subscribeError').mockImplementation(() => {
      throw new Error('error subscription failed')
    })

    await expect(
      parseAnkiPackageInWorker(host, packageBytes, wasmBytes),
    ).rejects.toThrow('error subscription failed')
    expect(worker.removeMessage).not.toHaveBeenCalled()
    expect(worker.removeError).not.toHaveBeenCalled()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.postMessage).not.toHaveBeenCalled()
  })

  it('removes the error subscription and terminates when the message subscription throws', async () => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    jest.spyOn(worker, 'subscribeMessage').mockImplementation(() => {
      throw new Error('message subscription failed')
    })

    await expect(
      parseAnkiPackageInWorker(host, packageBytes, wasmBytes),
    ).rejects.toThrow('message subscription failed')
    expect(worker.removeMessage).not.toHaveBeenCalled()
    expect(worker.removeError).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.postMessage).not.toHaveBeenCalled()
  })

  it('preserves the parser error and attempts every teardown when cleanup throws', async () => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    const controller = new AbortController()
    const removeAbortListener = jest
      .spyOn(controller.signal, 'removeEventListener')
      .mockImplementation(() => {
        throw new Error('abort cleanup failed')
      })
    worker.removeMessage.mockImplementation(() => {
      throw new Error('message cleanup failed')
    })
    worker.removeError.mockImplementation(() => {
      throw new Error('error cleanup failed')
    })
    worker.terminate.mockImplementation(() => {
      throw new Error('termination failed')
    })
    const promise = parseAnkiPackageInWorker(
      host,
      packageBytes,
      wasmBytes,
      controller.signal,
    )

    worker.messageListener?.({ id: requestId, error: 'parse failed' })

    await expect(promise).rejects.toThrow('parse failed')
    expect(worker.removeMessage).toHaveBeenCalledTimes(1)
    expect(worker.removeError).toHaveBeenCalledTimes(1)
    expect(removeAbortListener).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('preserves a successful result when cleanup throws', async () => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    worker.removeMessage.mockImplementation(() => {
      throw new Error('message cleanup failed')
    })
    worker.terminate.mockImplementation(() => {
      throw new Error('termination failed')
    })
    const promise = parseAnkiPackageInWorker(host, packageBytes, wasmBytes)

    worker.messageListener?.({ id: requestId, result })

    await expect(promise).resolves.toBe(result)
    expect(worker.removeMessage).toHaveBeenCalledTimes(1)
    expect(worker.removeError).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('cleans up the abort listener and worker on abort with single settlement', async () => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    const controller = new AbortController()
    const removeEventListener = jest.spyOn(
      controller.signal,
      'removeEventListener',
    )
    const promise = parseAnkiPackageInWorker(
      host,
      packageBytes,
      wasmBytes,
      controller.signal,
    )

    controller.abort()
    worker.errorListener?.(new Error('late error'))

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    )
    expectCleanedUp(worker)
  })

  it('spawns and immediately cleans up for an already-aborted signal', async () => {
    const { host, worker, packageBytes, wasmBytes } = setup()
    const controller = new AbortController()
    controller.abort()

    await expect(
      parseAnkiPackageInWorker(
        host,
        packageBytes,
        wasmBytes,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.postMessage).not.toHaveBeenCalled()
    expectCleanedUp(worker)
  })
})
