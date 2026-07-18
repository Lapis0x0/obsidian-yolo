import { ModuleLifecycleScope } from './lifecycleScope'
import {
  managedModuleDataNamespace,
  runExclusive,
} from './managedModuleDataLock'
import { ManagedModulePathsCapabilityProvider } from './modulePaths'

describe('ManagedModulePathsCapabilityProvider', () => {
  it('derives a frozen module root and publishes only real changes after activation', () => {
    let baseDir = 'YOLO'
    let sourceListener: (() => void) | undefined
    const unsubscribeSource = jest.fn()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ManagedModulePathsCapabilityProvider({
      getBaseDir: () => baseDir,
      subscribe: (listener) => {
        sourceListener = listener
        return unsubscribeSource
      },
    }).create('learning', lifecycle)
    const listener = jest.fn()
    activation.api.subscribe(listener)

    expect(activation.api.getSnapshot()).toEqual({
      contentRoot: 'YOLO/learning',
    })
    expect(Object.isFrozen(activation.api.getSnapshot())).toBe(true)

    baseDir = 'Knowledge'
    sourceListener?.()
    expect(activation.api.getSnapshot()).toEqual({
      contentRoot: 'Knowledge/learning',
    })
    expect(listener).not.toHaveBeenCalled()

    activation.activate()
    expect(listener).toHaveBeenCalledTimes(1)
    sourceListener?.()
    expect(listener).toHaveBeenCalledTimes(1)
    baseDir = 'School'
    sourceListener?.()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(activation.api.getSnapshot()).toEqual({
      contentRoot: 'School/learning',
    })

    lifecycle.dispose()
    expect(unsubscribeSource).toHaveBeenCalledTimes(1)
    expect(() => activation.api.getSnapshot()).toThrow('no longer active')
  })

  it('isolates listener and error-reporter failures', () => {
    let sourceListener: (() => void) | undefined
    let baseDir = 'YOLO'
    const reportCallbackError = jest.fn(() => {
      throw new Error('reporter failed')
    })
    const lifecycle = new ModuleLifecycleScope()
    const activation = new ManagedModulePathsCapabilityProvider({
      getBaseDir: () => baseDir,
      subscribe: (listener) => {
        sourceListener = listener
        return () => undefined
      },
      reportCallbackError,
    }).create('learning', lifecycle)
    const error = new Error('listener failed')
    activation.api.subscribe(() => {
      throw error
    })
    activation.activate()

    baseDir = 'Moved'
    expect(() => sourceListener?.()).not.toThrow()
    expect(reportCallbackError).toHaveBeenCalledWith('learning', error)
    lifecycle.dispose()
  })

  it('rejects path-like module ids and invalid listeners', () => {
    const provider = new ManagedModulePathsCapabilityProvider({
      getBaseDir: () => 'YOLO',
      subscribe: () => () => undefined,
    })
    expect(() =>
      provider.create('../learning', new ModuleLifecycleScope()),
    ).toThrow('path segment')
    const activation = provider.create('learning', new ModuleLifecycleScope())
    expect(() => activation.api.subscribe(42 as unknown as () => void)).toThrow(
      'listener must be a function',
    )
    expect(() =>
      activation.api.runExclusive('../srs', () => undefined),
    ).toThrow('namespace')
  })

  it('shares the real managed-data barrier with Core relocation callers', async () => {
    const vaultIdentity = {}
    let baseDir = 'YOLO'
    let publishChange = (): void => undefined
    const options = {
      vaultIdentity,
      getBaseDir: () => baseDir,
      subscribe: (listener: () => void) => {
        publishChange = listener
        return () => undefined
      },
    }
    const secondLifecycle = new ModuleLifecycleScope()
    const second = new ManagedModulePathsCapabilityProvider(options).create(
      'learning',
      secondLifecycle,
    )
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const relocation = runExclusive(
      vaultIdentity,
      managedModuleDataNamespace('learning', 'managed-data'),
      () => barrier,
    )
    const observedRoots: string[] = []
    const queued = second.api.runExclusive('managed-data', () => {
      observedRoots.push(second.api.getSnapshot().contentRoot)
    })

    await Promise.resolve()
    expect(observedRoots).toEqual([])
    baseDir = 'Moved'
    publishChange()
    release()
    await relocation
    await queued
    expect(observedRoots).toEqual(['Moved/learning'])
    secondLifecycle.dispose()
  })
})
