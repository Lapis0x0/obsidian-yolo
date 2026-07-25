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
  it('persists disabled before quiescing and removes the record before enabling', async () => {
    const events: string[] = []
    let enabled = true
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 1, components: [descriptor] },
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
      registry: { schemaVersion: 1, components: [descriptor] },
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
      registry: { schemaVersion: 1, components: [descriptor] },
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

  it('keeps disabled state when disable races an initial activation', async () => {
    let finishVerification!: () => void
    const verification = new Promise<void>((resolve) => {
      finishVerification = resolve
    })
    let desiredEnabled = true
    const load = jest.fn()
    const service = new RuntimeComponentService({
      registry: { schemaVersion: 1, components: [descriptor] },
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
        schemaVersion: 1,
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
})
