import { createBrowserWorkerFactory } from './browserWorkerFactory'

describe('createBrowserWorkerFactory', () => {
  const createObjectURL = jest.fn(() => 'blob:anki-worker')
  const revokeObjectURL = jest.fn()
  const addEventListener = jest.fn()
  const removeEventListener = jest.fn()
  const postMessage = jest.fn()
  const terminate = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      value: { createObjectURL, revokeObjectURL },
    })
    Object.defineProperty(globalThis, 'Blob', {
      configurable: true,
      value: jest.fn(),
    })
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: jest.fn(() => ({
        addEventListener,
        removeEventListener,
        postMessage,
        terminate,
      })),
    })
  })

  it('bridges events and revokes the URL exactly once on termination', () => {
    const worker = createBrowserWorkerFactory().spawn<string, string>('source')
    const onMessage = jest.fn()
    const onError = jest.fn()
    worker.subscribeMessage(onMessage)
    worker.subscribeError(onError)

    const messageBridge = addEventListener.mock.calls.find(
      ([type]) => type === 'message',
    )?.[1]
    const errorBridge = addEventListener.mock.calls.find(
      ([type]) => type === 'error',
    )?.[1]
    messageBridge({ data: 'response' })
    errorBridge({ message: 'crashed' })
    worker.terminate()
    worker.terminate()

    expect(onMessage).toHaveBeenCalledWith('response')
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'crashed' }),
    )
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:anki-worker')
  })

  it('revokes the URL if Worker construction throws', () => {
    jest.mocked(Worker).mockImplementationOnce(() => {
      throw new Error('construction failed')
    })

    expect(() => createBrowserWorkerFactory().spawn('source')).toThrow(
      'construction failed',
    )
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:anki-worker')
  })
})
