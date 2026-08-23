import type { RuntimeComponentDescriptor } from './runtimeComponentManifest'
import { RuntimeComponentRuntime } from './runtimeComponentRuntime'
import { RuntimeComponentService } from './runtimeComponentService'

const descriptor: RuntimeComponentDescriptor = {
  id: 'tokenizer',
  platforms: ['desktop', 'mobile'],
  nameKey: 'name',
  descriptionKey: 'description',
  impactKey: 'impact',
  entry: 'runtime-components/tokenizer/dist/entry.js',
  byteSize: 10,
  sha256: 'a'.repeat(64),
}

const pdfDescriptor: RuntimeComponentDescriptor = {
  ...descriptor,
  id: 'pdf-engine',
  entry: 'runtime-components/pdf-engine/dist/entry.js',
  sha256: 'b'.repeat(64),
}

describe('RuntimeComponentService desired intent', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('persists disabled before quiescing and removes the record before enabling', async () => {
    const events: string[] = []
    let enabled = true
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 2, components: [descriptor] },
      platform: 'desktop',
      store: {
        hasPlausibleEntry: async () => false,
      } as never,
      installer: {
        ensure: async () => {
          events.push('installed')
        },
        verifyInstalled: async () => undefined,
      } as never,
      loader: {} as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {
        isEnabled: async () => enabled,
        disable: async () => {
          events.push('intent-disabled')
          enabled = false
        },
        enable: async () => {
          events.push('intent-removed')
          enabled = true
        },
        subscribe: () => () => undefined,
      } as never,
      deviceStateStore: {
        write: async () => undefined,
      } as never,
    })
    service.registerQuiesceParticipant('tokenizer', async () => {
      events.push('participant')
    })

    const initialSnapshot = service.getSnapshot()
    expect(service.getSnapshot()).toBe(initialSnapshot)
    await service.setEnabled('tokenizer', false)
    expect(service.getSnapshot()).not.toBe(initialSnapshot)
    expect(events).toEqual(['intent-disabled', 'participant'])
    expect(service.getSnapshot()[0]).toMatchObject({
      enabled: false,
      status: 'disabled',
    })

    await service.setEnabled('tokenizer', true)
    expect(events).toEqual([
      'intent-disabled',
      'participant',
      'intent-removed',
      'installed',
    ])
    expect(service.getSnapshot()[0]).toMatchObject({
      enabled: true,
      status: 'ready',
    })
  })

  it('does not change the local runtime when desired-intent persistence fails', async () => {
    const participant = jest.fn(async () => undefined)
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 2, components: [descriptor] },
      platform: 'desktop',
      store: {} as never,
      installer: {} as never,
      loader: {} as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {
        disable: async () => {
          throw new Error('sync write failed')
        },
      } as never,
      deviceStateStore: {} as never,
    })
    service.registerQuiesceParticipant('tokenizer', participant)

    await expect(service.setEnabled('tokenizer', false)).rejects.toThrow(
      'sync write failed',
    )
    expect(participant).not.toHaveBeenCalled()
    expect(service.getSnapshot()[0]).toMatchObject({
      enabled: true,
      status: 'missing',
    })
  })

  it('verifies and loads once while reusing an active instance across leases', async () => {
    const verifyInstalled = jest.fn(async () => undefined)
    const readEntry = jest.fn(async () => new Uint8Array([1]))
    const load = jest.fn(async () => ({
      id: 'tokenizer' as const,
      create: () => ({ count: (text: string) => text.length, dispose() {} }),
    }))
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 2, components: [descriptor] },
      platform: 'desktop',
      store: {
        hasPlausibleEntry: async () => true,
        readEntry,
      } as never,
      installer: { verifyInstalled } as never,
      loader: { load } as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {} as never,
      deviceStateStore: { write: async () => undefined } as never,
    })

    const first = await service.acquire('tokenizer')
    first.release()
    const second = await service.acquire('tokenizer')
    second.release()

    expect(verifyInstalled).toHaveBeenCalledTimes(1)
    expect(readEntry).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('readAsset ensures artifacts are installed once, then reads the named asset', async () => {
    const embeddingDescriptor: RuntimeComponentDescriptor = {
      ...descriptor,
      id: 'embedding-engine',
      platforms: ['desktop'],
      entry: 'runtime-components/embedding-engine/dist/entry.js',
      sha256: 'c'.repeat(64),
      assets: [
        {
          name: 'ort-wasm-simd-threaded.wasm',
          path: 'runtime-components/embedding-engine/dist/assets/ort-wasm-simd-threaded.wasm',
          byteSize: 4,
          sha256: 'd'.repeat(64),
        },
      ],
    }
    const verifyInstalled = jest.fn(async () => undefined)
    const readAsset = jest.fn(async () => new Uint8Array([1, 2, 3, 4]))
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 2, components: [embeddingDescriptor] },
      platform: 'desktop',
      store: {
        hasPlausibleEntry: async () => true,
        readAsset,
      } as never,
      installer: { verifyInstalled } as never,
      loader: {} as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {} as never,
      deviceStateStore: { write: async () => undefined } as never,
    })

    const bytes = await service.readAsset(
      'embedding-engine',
      'ort-wasm-simd-threaded.wasm',
    )
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(readAsset).toHaveBeenCalledWith(
      embeddingDescriptor,
      embeddingDescriptor.assets![0],
    )

    await expect(
      service.readAsset('embedding-engine', 'not-a-declared-asset'),
    ).rejects.toThrow('has no asset')
  })

  it('keeps disabled state when disable races an initial activation', async () => {
    let finishVerification!: () => void
    const verification = new Promise<void>((resolve) => {
      finishVerification = resolve
    })
    let desiredEnabled = true
    const load = jest.fn()
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 2, components: [descriptor] },
      platform: 'desktop',
      store: {
        hasPlausibleEntry: async () => true,
        readEntry: async () => new Uint8Array([1]),
      } as never,
      installer: { verifyInstalled: async () => verification } as never,
      loader: { load } as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {
        disable: async () => {
          desiredEnabled = false
        },
        isEnabled: async () => desiredEnabled,
      } as never,
      deviceStateStore: { write: async () => undefined } as never,
    })

    const acquiring = service.acquire('tokenizer')
    await Promise.resolve()
    const disabling = service.setEnabled('tokenizer', false)
    await Promise.resolve()
    finishVerification()

    await expect(acquiring).rejects.toThrow('quiescing')
    await disabling
    expect(load).not.toHaveBeenCalled()
    expect(service.getSnapshot()[0]).toMatchObject({
      enabled: false,
      status: 'disabled',
    })
  })

  it('keeps artifact downloads globally serial when different components are demanded', async () => {
    let activeDownloads = 0
    let maxActiveDownloads = 0
    const finishes: Array<() => void> = []
    const ensure = jest.fn(
      async () =>
        await new Promise<void>((resolve) => {
          activeDownloads += 1
          maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads)
          finishes.push(() => {
            activeDownloads -= 1
            resolve()
          })
        }),
    )
    const service = new RuntimeComponentService({
      registry: {
        schemaVersion: 2,
        components: [descriptor, pdfDescriptor],
      },
      platform: 'desktop',
      store: {
        hasPlausibleEntry: async () => false,
        readEntry: async () => new Uint8Array([1]),
      } as never,
      installer: { ensure } as never,
      loader: {
        load: async (component: RuntimeComponentDescriptor) =>
          component.id === 'tokenizer'
            ? {
                id: 'tokenizer',
                create: () => ({
                  count: (text: string) => text.length,
                  dispose() {},
                }),
              }
            : {
                id: 'pdf-engine',
                create: () => ({ dispose() {} }),
              },
      } as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {} as never,
      deviceStateStore: { write: async () => undefined } as never,
    })

    const tokenizer = service.acquire('tokenizer')
    const pdf = service.acquire('pdf-engine')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ensure).toHaveBeenCalledTimes(1)
    finishes.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ensure).toHaveBeenCalledTimes(2)
    finishes.shift()?.()
    ;(await tokenizer).release()
    ;(await pdf).release()
    expect(maxActiveDownloads).toBe(1)
  })

  it('stops after three automatic retries for a transient failure', async () => {
    jest.useFakeTimers()
    const ensure = jest.fn().mockRejectedValue(new Error('network timeout'))
    const write = jest.fn(async (state: Record<string, unknown>) => state)
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 2, components: [descriptor] },
      platform: 'desktop',
      store: { hasPlausibleEntry: async () => false } as never,
      installer: { ensure } as never,
      loader: {} as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {} as never,
      deviceStateStore: { write } as never,
    })

    await expect(service.retry('tokenizer')).rejects.toThrow('network timeout')
    expect(ensure).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(10_000)
    expect(ensure).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(60_000)
    expect(ensure).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(5 * 60_000)
    expect(ensure).toHaveBeenCalledTimes(4)

    await jest.advanceTimersByTimeAsync(60 * 60_000)
    expect(ensure).toHaveBeenCalledTimes(4)
    expect(write.mock.calls.at(-1)?.[0]).toMatchObject({
      error: 'network timeout',
      retry: {
        automaticRetryCount: 3,
        retryAt: null,
      },
    })
    service.stop()
    jest.useRealTimers()
  })

  it('does not retry a permanent failure automatically', async () => {
    jest.useFakeTimers()
    const ensure = jest
      .fn()
      .mockRejectedValue(new Error('Downloaded component SHA-256 mismatch'))
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 2, components: [descriptor] },
      platform: 'desktop',
      store: { hasPlausibleEntry: async () => false } as never,
      installer: { ensure } as never,
      loader: {} as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {} as never,
      deviceStateStore: { write: async () => undefined } as never,
    })

    await expect(service.retry('tokenizer')).rejects.toThrow('SHA-256 mismatch')
    await jest.advanceTimersByTimeAsync(60 * 60_000)
    expect(ensure).toHaveBeenCalledTimes(1)
    service.stop()
    jest.useRealTimers()
  })

  it('restores a scheduled retry without resetting its persisted budget', async () => {
    jest.useFakeTimers()
    const retryAt = Date.now() + 60_000
    const ensure = jest.fn().mockResolvedValue(undefined)
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 2, components: [descriptor] },
      platform: 'desktop',
      store: { hasPlausibleEntry: async () => false } as never,
      installer: { ensure } as never,
      loader: {} as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {
        isEnabled: async () => true,
        subscribe: () => () => undefined,
      } as never,
      deviceStateStore: {
        read: async () => ({
          componentId: 'tokenizer',
          platform: 'desktop',
          activeHash: null,
          pending: null,
          error: 'network timeout',
          retry: {
            descriptorHash: descriptor.sha256,
            automaticRetryCount: 2,
            retryAt,
          },
        }),
        write: async (state: Record<string, unknown>) => state,
      } as never,
      scheduleIdle: (callback) => {
        callback()
        return () => undefined
      },
    })

    await service.start()
    expect(service.getSnapshot()[0]).toMatchObject({
      status: 'failed',
      error: 'network timeout',
    })
    expect(ensure).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(59_999)
    expect(ensure).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()[0]).toMatchObject({
      status: 'ready',
      error: null,
    })
    service.stop()
  })

  it('has no record for a desktop-only component on mobile, and refuses to acquire or read it', async () => {
    const embeddingDescriptor: RuntimeComponentDescriptor = {
      ...descriptor,
      id: 'embedding-engine',
      platforms: ['desktop'],
      entry: 'runtime-components/embedding-engine/dist/entry.js',
      sha256: 'c'.repeat(64),
    }
    const service = new RuntimeComponentService({
      registry: {
        schemaVersion: 2,
        components: [descriptor, embeddingDescriptor],
      },
      platform: 'mobile',
      store: { hasPlausibleEntry: async () => false } as never,
      installer: {
        ensure: async () => undefined,
        verifyInstalled: async () => undefined,
      } as never,
      loader: {} as never,
      runtime: new RuntimeComponentRuntime(),
      intentStore: {
        isEnabled: async () => true,
        disable: async () => undefined,
        enable: async () => undefined,
        subscribe: () => () => undefined,
      } as never,
      deviceStateStore: { write: async () => undefined } as never,
    })

    expect(
      service
        .getSnapshot()
        .some((record) => record.descriptor.id === 'embedding-engine'),
    ).toBe(false)
    // The desktop-only-but-mobile-platform component simply never appears
    // in the snapshot, but a caller that names it directly must still get a
    // clear rejection rather than an undefined/silent failure.
    await expect(service.acquire('embedding-engine')).rejects.toThrow(
      'unavailable on this platform',
    )
    await expect(
      service.readAsset('embedding-engine', 'model.wasm'),
    ).rejects.toThrow('unavailable on this platform')
  })
})
