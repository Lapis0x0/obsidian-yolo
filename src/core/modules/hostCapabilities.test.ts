import {
  type BackgroundActivity,
  BackgroundActivityRegistry,
} from '../background/backgroundActivityRegistry'

import { CoreModuleHostCapabilityProvider } from './hostCapabilities'
import { ModuleLifecycleScope } from './lifecycleScope'

describe('CoreModuleHostCapabilityProvider', () => {
  it('creates and activates module assets with the owning lifecycle', async () => {
    const lifecycle = new ModuleLifecycleScope()
    const api = Object.freeze({
      readText: jest.fn(async () => 'asset'),
      readArrayBuffer: jest.fn(async () => new ArrayBuffer(0)),
      createBlobUrl: jest.fn(async () => 'blob:asset'),
    })
    const activateAssets = jest.fn()
    const createAssets = jest.fn(() => ({ api, activate: activateAssets }))
    const activation = new CoreModuleHostCapabilityProvider({
      assets: { create: createAssets },
      backgroundActivities: new BackgroundActivityRegistry(),
    }).create('asset-module', lifecycle)

    expect(createAssets).toHaveBeenCalledWith('asset-module', lifecycle)
    expect(activation.capabilities.assets).toBe(api)
    await activation.prepare()
    activation.activate()
    activation.commit()

    expect(activateAssets).toHaveBeenCalledTimes(1)
    await expect(
      activation.capabilities.assets.readText('theme.css'),
    ).resolves.toBe('asset')
    lifecycle.dispose()
  })

  it('stages, namespaces, and cleans up only the owning module', () => {
    const registry = new BackgroundActivityRegistry()
    let latest: ReadonlyMap<string, BackgroundActivity> = new Map()
    registry.subscribe((activities) => {
      latest = activities
    })
    const provider = new CoreModuleHostCapabilityProvider({
      backgroundActivities: registry,
      now: () => 42,
    })
    const firstLifecycle = new ModuleLifecycleScope()
    const secondLifecycle = new ModuleLifecycleScope()
    const firstActivation = provider.create('first:module', firstLifecycle)
    const secondActivation = provider.create('second', secondLifecycle)
    const first = firstActivation.capabilities
    const second = secondActivation.capabilities

    first.background.upsert({
      id: 'shared:id',
      title: 'First',
      detail: 'Running',
      status: 'running',
    })
    second.background.upsert({
      id: 'shared:id',
      title: 'Second',
      summary: 'Review cards',
      icon: 'bell',
      status: 'reminder',
    })
    expect(latest.size).toBe(0)

    firstActivation.commit()
    secondActivation.commit()
    expect([...latest.keys()]).toEqual([
      'module:["first:module","shared:id"]',
      'module:["second","shared:id"]',
    ])
    expect(latest.get('module:["first:module","shared:id"]')).toMatchObject({
      kind: 'module:first:module',
      title: 'First',
      detail: 'Running',
      status: 'running',
      updatedAt: 42,
    })

    firstLifecycle.dispose()
    expect([...latest.keys()]).toEqual(['module:["second","shared:id"]'])
    expect(() =>
      first.background.upsert({
        id: 'late',
        title: 'Late',
        status: 'failed',
      }),
    ).toThrow('no longer active')

    second.background.remove('shared:id')
    expect(latest.size).toBe(0)
    secondLifecycle.dispose()
  })

  it('isolates callback and reporter errors, captures, and revokes it', async () => {
    const registry = new BackgroundActivityRegistry()
    let latest: ReadonlyMap<string, BackgroundActivity> = new Map()
    registry.subscribe((activities) => {
      latest = activities
    })
    const reportCallbackError = jest.fn(() => {
      throw new Error('reporter failed')
    })
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: registry,
      reportCallbackError,
    }).create('callback-module', lifecycle)
    const background = activation.capabilities.background
    const originalCallback = jest.fn(() => {
      throw new Error('callback failed')
    })
    const declaration = {
      id: 'notice',
      title: 'Notice',
      status: 'reminder',
      onOpen: originalCallback,
    } as const

    background.upsert(declaration)
    Object.assign(declaration, { onOpen: jest.fn() })
    await activation.prepare()
    activation.activate()
    activation.commit()
    const activity = latest.get('module:["callback-module","notice"]')
    if (activity?.action?.type !== 'callback') {
      throw new Error('Expected callback action')
    }
    const callbackAction = activity.action

    expect(() => callbackAction.run()).not.toThrow()
    expect(originalCallback).toHaveBeenCalledTimes(1)
    expect(reportCallbackError).toHaveBeenCalledWith(
      'callback-module',
      expect.objectContaining({ message: 'callback failed' }),
    )

    lifecycle.dispose()
    callbackAction.run()
    expect(originalCallback).toHaveBeenCalledTimes(1)
  })

  it('reports asynchronous callback rejections', async () => {
    const registry = new BackgroundActivityRegistry()
    let latest: ReadonlyMap<string, BackgroundActivity> = new Map()
    registry.subscribe((activities) => {
      latest = activities
    })
    let resolveReported!: () => void
    const reported = new Promise<void>((resolve) => {
      resolveReported = resolve
    })
    const reportCallbackError = jest.fn(() => resolveReported())
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: registry,
      reportCallbackError,
    }).create('async-module', lifecycle)
    const rejection = new Error('async callback failed')

    activation.capabilities.background.upsert({
      id: 'notice',
      title: 'Notice',
      status: 'reminder',
      onOpen: () => Promise.reject(rejection),
    })
    await activation.prepare()
    activation.activate()
    activation.commit()
    const activity = latest.get('module:["async-module","notice"]')
    if (activity?.action?.type !== 'callback') {
      throw new Error('Expected callback action')
    }
    activity.action.run()
    await reported

    expect(reportCallbackError).toHaveBeenCalledWith('async-module', rejection)
    lifecycle.dispose()
  })

  it('rejects invalid declarations but accepts malformed Unicode ids', () => {
    const upsert = jest.fn()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: {
        upsert,
        upsertAll: (activities) => {
          for (const activity of activities) upsert(activity)
        },
        remove: jest.fn(),
      },
    }).create('invalid-module', lifecycle)
    const background = activation.capabilities.background

    expect(() =>
      background.upsert({ id: '', title: 'Title', status: 'running' }),
    ).toThrow('id must be a non-empty string')
    expect(() =>
      background.upsert({ id: 'id', title: '', status: 'running' }),
    ).toThrow('title must be a non-empty string')
    expect(() =>
      background.upsert({
        id: 'id',
        title: 'Title',
        detail: 42,
        status: 'running',
      } as unknown as Parameters<typeof background.upsert>[0]),
    ).toThrow('detail must be a string')
    expect(upsert).not.toHaveBeenCalled()

    expect(() =>
      background.upsert({
        id: '\ud800',
        title: 'Unicode',
        status: 'running',
      }),
    ).not.toThrow()
    expect(upsert).not.toHaveBeenCalled()
    activation.commit()
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'module:["invalid-module","\\ud800"]' }),
    )
    lifecycle.dispose()
  })

  it('validates and publishes the same accessor-backed snapshot', () => {
    let titleReads = 0
    const published: BackgroundActivity[] = []
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: {
        upsert: jest.fn(),
        upsertAll: (activities) => published.push(...activities),
        remove: jest.fn(),
      },
    }).create('accessor-module', lifecycle)
    const declaration = {
      id: 'activity',
      get title() {
        titleReads += 1
        return titleReads === 1 ? 'Stable title' : (42 as unknown as string)
      },
      status: 'running' as const,
    }

    activation.capabilities.background.upsert(declaration)
    activation.commit()

    expect(titleReads).toBe(1)
    expect(published[0].title).toBe('Stable title')
    lifecycle.dispose()
  })

  it('retains ownership when commit mutates the sink and then throws', () => {
    const stored = new Map<string, BackgroundActivity>()
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: {
        upsert: (activity) => {
          stored.set(activity.id, activity)
        },
        upsertAll: (activities) => {
          for (const activity of activities) stored.set(activity.id, activity)
          throw new Error('subscriber failed')
        },
        remove: (id) => {
          stored.delete(id)
        },
      },
    }).create('throwing-publish', lifecycle)

    activation.capabilities.background.upsert({
      id: 'activity',
      title: 'Activity',
      status: 'running',
    })
    expect(() => activation.commit()).toThrow('subscriber failed')
    expect(stored.size).toBe(1)

    lifecycle.dispose()
    expect(stored.size).toBe(0)
  })

  it('attempts every owned removal when one cleanup fails', () => {
    const stored = new Map<string, BackgroundActivity>()
    const removeAttempts: string[] = []
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: {
        upsert: (activity) => stored.set(activity.id, activity),
        upsertAll: (activities) => {
          for (const activity of activities) stored.set(activity.id, activity)
        },
        remove: (id) => {
          removeAttempts.push(id)
          if (id.includes('first')) throw new Error('remove failed')
          stored.delete(id)
        },
      },
    }).create('cleanup-module', lifecycle)
    const background = activation.capabilities.background
    background.upsert({ id: 'first', title: 'First', status: 'running' })
    background.upsert({ id: 'second', title: 'Second', status: 'running' })
    activation.commit()

    expect(() => lifecycle.dispose()).toThrow(
      'Module lifecycle disposal reported errors',
    )
    expect(removeAttempts).toEqual([
      'module:["cleanup-module","first"]',
      'module:["cleanup-module","second"]',
    ])
    expect([...stored.keys()]).toEqual(['module:["cleanup-module","first"]'])
  })

  it('publishes staged activities in one batch', () => {
    const upsert = jest.fn()
    const batches: BackgroundActivity[][] = []
    const upsertAll = jest.fn((activities: Iterable<BackgroundActivity>) => {
      batches.push([...activities])
    })
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: { upsert, upsertAll, remove: jest.fn() },
    }).create('batch-module', lifecycle)
    activation.capabilities.background.upsert({
      id: 'first',
      title: 'First',
      status: 'running',
    })
    activation.capabilities.background.upsert({
      id: 'second',
      title: 'Second',
      status: 'waiting',
    })

    activation.commit()

    expect(upsert).not.toHaveBeenCalled()
    expect(upsertAll).toHaveBeenCalledTimes(1)
    expect(batches[0]).toHaveLength(2)
    lifecycle.dispose()
  })

  it('revokes callbacks when an activity is replaced or removed', async () => {
    const registry = new BackgroundActivityRegistry()
    let latest: ReadonlyMap<string, BackgroundActivity> = new Map()
    registry.subscribe((activities) => {
      latest = activities
    })
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: registry,
    }).create('replacement-module', lifecycle)
    const background = activation.capabilities.background
    const firstCallback = jest.fn()
    const secondCallback = jest.fn()
    background.upsert({
      id: 'notice',
      title: 'First',
      status: 'reminder',
      onOpen: firstCallback,
    })
    await activation.prepare()
    activation.activate()
    activation.commit()
    const firstActivity = latest.get('module:["replacement-module","notice"]')
    if (firstActivity?.action?.type !== 'callback') {
      throw new Error('Expected first callback action')
    }

    background.upsert({
      id: 'notice',
      title: 'Second',
      status: 'reminder',
      onOpen: secondCallback,
    })
    firstActivity.action.run()
    expect(firstCallback).not.toHaveBeenCalled()
    const secondActivity = latest.get('module:["replacement-module","notice"]')
    if (secondActivity?.action?.type !== 'callback') {
      throw new Error('Expected second callback action')
    }
    secondActivity.action.run()
    expect(secondCallback).toHaveBeenCalledTimes(1)

    background.remove('notice')
    secondActivity.action.run()
    expect(secondCallback).toHaveBeenCalledTimes(1)
    lifecycle.dispose()
  })

  it('injects state APIs, prepares config, then activates synchronously', async () => {
    const lifecycle = new ModuleLifecycleScope()
    const configApi = Object.freeze({
      getSnapshot: jest.fn(() => ({ schemaVersion: 1, data: {} })),
      replace: jest.fn(async (next) => next),
      subscribe: jest.fn(() => () => undefined),
    })
    const storageScope = Object.freeze({
      list: jest.fn(async () => []),
      stat: jest.fn(async () => null),
      listEntries: jest.fn(async () => ({ files: [], folders: [] })),
      readText: jest.fn(async () => null),
      readBinary: jest.fn(async () => null),
      readJson: jest.fn(async () => null),
      writeText: jest.fn(async () => undefined),
      writeBinary: jest.fn(async () => undefined),
      writeJson: jest.fn(async () => undefined),
      mkdir: jest.fn(async () => undefined),
      rename: jest.fn(async () => undefined),
      removeFile: jest.fn(async () => false),
      remove: jest.fn(async () => undefined),
    })
    const privateStorageApi = Object.freeze({
      synchronized: storageScope,
      deviceLocal: storageScope,
    })
    let resolveConfig!: () => void
    const configReady = new Promise<void>((resolve) => {
      resolveConfig = resolve
    })
    const activateConfig = jest.fn(() => configReady)
    const activatePrivateStorage = jest.fn()
    const createConfig = jest.fn(() => ({
      api: configApi,
      activate: activateConfig,
    }))
    const createPrivateStorage = jest.fn(() => ({
      api: privateStorageApi,
      activate: activatePrivateStorage,
    }))
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: new BackgroundActivityRegistry(),
      config: { create: createConfig },
      privateStorage: { create: createPrivateStorage },
    }).create('stateful-module', lifecycle)

    expect(createConfig).toHaveBeenCalledWith('stateful-module', lifecycle)
    expect(createPrivateStorage).toHaveBeenCalledWith(
      'stateful-module',
      lifecycle,
    )
    expect(activation.capabilities.config).toBe(configApi)
    expect(activation.capabilities.privateStorage).toBe(privateStorageApi)
    const preparing = activation.prepare()
    expect(activateConfig).toHaveBeenCalledTimes(1)
    expect(activatePrivateStorage).not.toHaveBeenCalled()

    resolveConfig()
    await preparing

    expect(activatePrivateStorage).not.toHaveBeenCalled()
    activation.activate()
    activation.commit()
    expect(activatePrivateStorage).toHaveBeenCalledTimes(1)
    lifecycle.dispose()
  })

  it('provides safe unavailable state capability defaults', async () => {
    const lifecycle = new ModuleLifecycleScope()
    const activation = new CoreModuleHostCapabilityProvider({
      backgroundActivities: new BackgroundActivityRegistry(),
    }).create('default-state-module', lifecycle)

    expect(() => activation.capabilities.config.getSnapshot()).toThrow(
      'config capability is unavailable',
    )
    await expect(
      activation.capabilities.privateStorage.deviceLocal.readText('state.json'),
    ).rejects.toThrow('private storage capability is unavailable')
    await expect(activation.prepare()).resolves.toBeUndefined()
    expect(() => activation.activate()).not.toThrow()
    activation.commit()
    lifecycle.dispose()
  })
})
