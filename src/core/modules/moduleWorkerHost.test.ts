import { ModuleLifecycleScope } from './lifecycleScope'
import { ModuleWorkerHostCapabilityProvider } from './moduleWorkerHost'

type Listener = (event: never) => void

class FakeWorker {
  readonly postMessage = jest.fn()
  readonly terminate = jest.fn()
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    let listeners = this.listeners.get(type)
    if (!listeners) this.listeners.set(type, (listeners = new Set()))
    listeners.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event as never)
  }
}

describe('ModuleWorkerHostCapabilityProvider', () => {
  const originalCreateObjectUrl = URL.createObjectURL.bind(URL)
  const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL)
  const createObjectUrl = jest.fn(() => 'blob:module-worker')
  const revokeObjectUrl = jest.fn()

  beforeEach(() => {
    createObjectUrl.mockClear()
    revokeObjectUrl.mockClear()
    URL.createObjectURL = createObjectUrl
    URL.revokeObjectURL = revokeObjectUrl
  })

  afterAll(() => {
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
  })

  const create = () => {
    const native = new FakeWorker()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ModuleWorkerHostCapabilityProvider(
      () => native as unknown as Worker,
    ).create('learning', lifecycle)
    activation.activate()
    return { activation, lifecycle, native }
  }

  it('correlates RPC responses and transfers buffers', async () => {
    const { activation, lifecycle, native } = create()
    const worker = activation.api.create('self.onmessage = () => undefined')
    const bytes = new ArrayBuffer(2)
    const result = worker.call<string>(
      'parse',
      { bytes },
      { transfer: [bytes] },
    )
    expect(native.postMessage).toHaveBeenCalledWith(
      { id: 1, method: 'parse', payload: { bytes } },
      [bytes],
    )
    native.emit('message', { data: { id: 1, result: 'ready' } })
    await expect(result).resolves.toBe('ready')
    lifecycle.dispose()
    expect(native.terminate).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:module-worker')
  })

  it('cancels one request without terminating sibling calls', async () => {
    const { activation, lifecycle, native } = create()
    const worker = activation.api.create('worker')
    const controller = new AbortController()
    const cancelled = worker.call('first', null, { signal: controller.signal })
    const sibling = worker.call<string>('second')
    controller.abort()

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.postMessage).toHaveBeenCalledWith({ id: 1, cancel: true })
    expect(native.terminate).not.toHaveBeenCalled()
    native.emit('message', { data: { id: 2, result: 'ok' } })
    await expect(sibling).resolves.toBe('ok')
    lifecycle.dispose()
  })

  it('rejects pending calls and future capability use after disposal', async () => {
    const { activation, lifecycle, native } = create()
    const worker = activation.api.create('worker')
    const pending = worker.call('pending')
    lifecycle.dispose()

    await expect(pending).rejects.toThrow('terminated')
    expect(native.terminate).toHaveBeenCalledTimes(1)
    expect(() => activation.api.create('late')).toThrow('no longer active')
  })
})
