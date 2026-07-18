jest.mock('obsidian', () => ({ ItemView: class {} }))

import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { CoreModuleHostCapabilityProvider } from './hostCapabilities'
import type { ModuleContributionRegistrar } from './moduleRuntime'
import { ModuleRuntime } from './moduleRuntime'
import type { YoloModuleDefinition } from './types'

const createRuntime = (
  registrar: ModuleContributionRegistrar,
  activityRegistry = new BackgroundActivityRegistry(),
) =>
  new ModuleRuntime(
    registrar,
    new CoreModuleHostCapabilityProvider({
      backgroundActivities: activityRegistry,
    }),
  )

describe('ModuleRuntime', () => {
  it('reports only committed, undisposed modules as active', async () => {
    const runtime = createRuntime({ commit: jest.fn() })
    expect(runtime.isActive('learning')).toBe(false)

    await runtime.activate(
      { id: 'learning', activate: () => undefined },
      '1.2.3',
    )
    expect(runtime.isActive('learning')).toBe(true)
    expect(runtime.isActive('learning', '1.2.3')).toBe(true)
    expect(runtime.isActive('learning', '2.0.0')).toBe(false)

    runtime.dispose()
    expect(runtime.isActive('learning')).toBe(false)
  })

  it('rolls back a hanging activation when its signal is aborted', async () => {
    const runtime = createRuntime({ commit: jest.fn() })
    const controller = new AbortController()
    let cleaned = false
    const activation = runtime.activate(
      {
        id: 'hanging',
        activate: ({ lifecycle }) => {
          lifecycle.add(() => {
            cleaned = true
          })
          return new Promise<void>(() => undefined)
        },
      },
      '1.0.0',
      controller.signal,
    )

    controller.abort()

    await expect(activation).rejects.toThrow('disposed during activation')
    expect(cleaned).toBe(true)
    expect(runtime.isActive('hanging')).toBe(false)
    runtime.dispose()
  })

  it('injects assets and activates them only after module activation commits', async () => {
    let assetsActive = false
    const readText = jest.fn(async () => {
      if (!assetsActive) throw new Error('assets are not active')
      return 'body {}'
    })
    const runtime = new ModuleRuntime(
      { commit: jest.fn() },
      new CoreModuleHostCapabilityProvider({
        assets: {
          create: () => ({
            api: {
              readText,
              readArrayBuffer: async () => new ArrayBuffer(0),
              createBlobUrl: async () => 'blob:test',
            },
            activate: () => {
              assetsActive = true
            },
          }),
        },
        backgroundActivities: new BackgroundActivityRegistry(),
      }),
    )
    let moduleAssets!: Parameters<
      Parameters<ModuleRuntime['activate']>[0]['activate']
    >[0]['assets']

    await runtime.activate({
      id: 'asset-module',
      activate: async (host) => {
        moduleAssets = host.assets
        await expect(host.assets.readText('theme.css')).rejects.toThrow(
          'assets are not active',
        )
      },
    })

    await expect(moduleAssets.readText('theme.css')).resolves.toBe('body {}')
    runtime.dispose()
  })

  it('defers publication and activates capabilities before command callbacks', async () => {
    let configActive = false
    let storageActive = false
    let resolveConfig!: () => void
    const configReady = new Promise<void>((resolve) => {
      resolveConfig = resolve
    })
    let markConfigStarted!: () => void
    const configStarted = new Promise<void>((resolve) => {
      markConfigStarted = resolve
    })
    const configApi = Object.freeze({
      getSnapshot: () => {
        if (!configActive) throw new Error('config is unavailable')
        return { schemaVersion: 1, data: { enabled: true } }
      },
      replace: async (next: { schemaVersion: number; data: unknown }) => next,
      subscribe: () => () => undefined,
    })
    const storageScope = Object.freeze({
      list: async () => {
        if (!storageActive) throw new Error('storage is unavailable')
        return []
      },
      stat: async () => null,
      listEntries: async () => ({ files: [], folders: [] }),
      readText: async () => null,
      readBinary: async () => null,
      readJson: async () => null,
      writeText: async () => undefined,
      writeBinary: async () => undefined,
      writeJson: async () => undefined,
      mkdir: async () => undefined,
      rename: async () => undefined,
      removeFile: async () => false,
      remove: async () => undefined,
    })
    const privateStorageApi = Object.freeze({
      synchronized: storageScope,
      deviceLocal: storageScope,
    })
    const activityRegistry = new BackgroundActivityRegistry()
    let activityIds: string[] = []
    activityRegistry.subscribe((activities) => {
      activityIds = [...activities.keys()]
    })
    let commandObservation: Promise<void> | undefined
    const commit = jest.fn((_moduleId, contributions) => {
      const command = contributions.commands?.[0]
      if (!command) throw new Error('Expected staged command')
      commandObservation = Promise.resolve(command.callback())
    })
    const runtime = new ModuleRuntime(
      { commit },
      new CoreModuleHostCapabilityProvider({
        backgroundActivities: activityRegistry,
        config: {
          create: () => ({
            api: configApi,
            activate: async () => {
              markConfigStarted()
              await configReady
              configActive = true
            },
          }),
        },
        privateStorage: {
          create: () => ({
            api: privateStorageApi,
            activate: () => {
              storageActive = true
            },
          }),
        },
      }),
    )
    let injectedConfig!: typeof configApi
    let injectedStorage!: typeof privateStorageApi
    const activation = runtime.activate({
      id: 'stateful-module',
      activate: async (host) => {
        injectedConfig = host.config as typeof configApi
        injectedStorage = host.privateStorage as typeof privateStorageApi
        expect(() => host.config.getSnapshot()).toThrow('config is unavailable')
        await expect(host.privateStorage.synchronized.list()).rejects.toThrow(
          'storage is unavailable',
        )
        host.workspace.registerCommand({
          id: 'observe-state',
          name: 'Observe state',
          callback: async () => {
            expect(host.config.getSnapshot()).toEqual({
              schemaVersion: 1,
              data: { enabled: true },
            })
            await expect(
              host.privateStorage.synchronized.list(),
            ).resolves.toEqual([])
          },
        })
        host.background.upsert({
          id: 'preparing',
          title: 'Preparing',
          status: 'waiting',
        })
      },
    })
    await configStarted

    expect(commit).not.toHaveBeenCalled()
    expect(activityIds).toEqual([])
    expect(() => injectedConfig.getSnapshot()).toThrow('config is unavailable')
    await expect(injectedStorage.synchronized.list()).rejects.toThrow(
      'storage is unavailable',
    )
    resolveConfig()
    await activation
    if (!commandObservation) throw new Error('Command was not observed')
    await commandObservation

    expect(commit).toHaveBeenCalledTimes(1)
    expect(activityIds).toEqual(['module:["stateful-module","preparing"]'])
    expect(injectedConfig.getSnapshot()).toEqual({
      schemaVersion: 1,
      data: { enabled: true },
    })
    await expect(injectedStorage.synchronized.list()).resolves.toEqual([])
    runtime.dispose()
  })

  it('rolls back a deferred config preparation failure and permits retry', async () => {
    const providerCleanup = jest.fn()
    const contributionCleanup = jest.fn()
    const commit = jest.fn((_moduleId, _contributions, lifecycle) => {
      lifecycle.add(contributionCleanup)
    })
    let attempts = 0
    let rejectPreparation!: (error: Error) => void
    const failedPreparation = new Promise<void>((_resolve, reject) => {
      rejectPreparation = reject
    })
    let markPreparationStarted!: () => void
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve
    })
    const activityRegistry = new BackgroundActivityRegistry()
    let activityIds: string[] = []
    activityRegistry.subscribe((activities) => {
      activityIds = [...activities.keys()]
    })
    const runtime = new ModuleRuntime(
      { commit },
      new CoreModuleHostCapabilityProvider({
        backgroundActivities: activityRegistry,
        config: {
          create: (_moduleId, lifecycle) => {
            lifecycle.add(providerCleanup)
            return {
              api: {
                getSnapshot: () => ({ schemaVersion: 1, data: {} }),
                replace: async (next) => next,
                subscribe: () => () => undefined,
              },
              activate: async () => {
                attempts += 1
                if (attempts === 1) {
                  markPreparationStarted()
                  await failedPreparation
                }
              },
            }
          },
        },
      }),
    )
    const definition: YoloModuleDefinition = {
      id: 'retry-module',
      activate: (host) => {
        host.background.upsert({
          id: 'preparing',
          title: 'Preparing',
          status: 'waiting',
        })
      },
    }

    const firstActivation = runtime.activate(definition)
    await preparationStarted
    expect(commit).not.toHaveBeenCalled()
    expect(activityIds).toEqual([])
    rejectPreparation(new Error('config activation failed'))

    await expect(firstActivation).rejects.toThrow('config activation failed')
    expect(commit).not.toHaveBeenCalled()
    expect(contributionCleanup).not.toHaveBeenCalled()
    expect(providerCleanup).toHaveBeenCalledTimes(1)
    expect(activityIds).toEqual([])

    await expect(runtime.activate(definition)).resolves.toBeUndefined()
    runtime.dispose()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(contributionCleanup).toHaveBeenCalledTimes(1)
    expect(providerCleanup).toHaveBeenCalledTimes(2)
    expect(activityIds).toEqual([])
  })

  it('rejects promptly when disposed during capability preparation', async () => {
    const providerCleanup = jest.fn()
    const contributionCleanup = jest.fn()
    const configReady = new Promise<void>(() => undefined)
    let markConfigStarted!: () => void
    const configStarted = new Promise<void>((resolve) => {
      markConfigStarted = resolve
    })
    const runtime = new ModuleRuntime(
      {
        commit: (_moduleId, _contributions, lifecycle) => {
          lifecycle.add(contributionCleanup)
        },
      },
      new CoreModuleHostCapabilityProvider({
        backgroundActivities: new BackgroundActivityRegistry(),
        config: {
          create: (_moduleId, lifecycle) => {
            lifecycle.add(providerCleanup)
            return {
              api: {
                getSnapshot: () => ({ schemaVersion: 1, data: {} }),
                replace: async (next) => next,
                subscribe: () => () => undefined,
              },
              activate: async () => {
                markConfigStarted()
                await configReady
              },
            }
          },
        },
      }),
    )
    const activation = runtime.activate({
      id: 'disposed-capability-module',
      activate: () => undefined,
    })
    await configStarted

    runtime.dispose()

    await expect(activation).rejects.toThrow(
      'disposed during capability prepare',
    )
    expect(contributionCleanup).not.toHaveBeenCalled()
    expect(providerCleanup).toHaveBeenCalledTimes(1)
  })

  it('does not commit declarations when module activation fails', async () => {
    const commit = jest.fn()
    const registrar: ModuleContributionRegistrar = { commit }
    const runtime = createRuntime(registrar)
    const cleanup = jest.fn()

    await expect(
      runtime.activate({
        id: 'broken',
        activate: (host) => {
          host.lifecycle.add(cleanup)
          host.workspace.registerView({
            type: 'broken-view',
            name: 'Broken',
            icon: 'bug',
            render: () => null,
          })
          throw new Error('activation failed')
        },
      }),
    ).rejects.toThrow('activation failed')
    expect(commit).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })

  it('rolls back a failed commit and disposes active modules once', async () => {
    const commitCleanup = jest.fn()
    const registrar: ModuleContributionRegistrar = {
      commit: (_id, _contributions, lifecycle) => {
        lifecycle.add(commitCleanup)
        throw new Error('commit failed')
      },
    }
    const runtime = createRuntime(registrar)

    await expect(
      runtime.activate({
        id: 'commit-failure',
        activate: (host) =>
          host.workspace.registerRibbonAction({
            icon: 'bug',
            title: 'Broken',
            onClick: () => undefined,
          }),
      }),
    ).rejects.toThrow('commit failed')
    expect(commitCleanup).toHaveBeenCalledTimes(1)
    runtime.dispose()
    runtime.dispose()
    expect(commitCleanup).toHaveBeenCalledTimes(1)
  })

  it('waits for asynchronous activation before contribution commit', async () => {
    const commit = jest.fn()
    const runtime = createRuntime({ commit })
    await expect(
      runtime.activate({
        id: 'async-module',
        activate: async (host) => {
          host.workspace.registerRibbonAction({
            icon: 'clock',
            title: 'Async',
            onClick: () => undefined,
          })
        },
      }),
    ).resolves.toBeUndefined()
    expect(commit).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })

  it('promptly disposes a never-resolving definition and ignores late rejection', async () => {
    const cleanup = jest.fn()
    const commit = jest.fn()
    const runtime = createRuntime({ commit })
    let rejectActivation!: (error: Error) => void
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectActivation = reject
    })
    const activation = runtime.activate({
      id: 'pending-module',
      activate: async (host) => {
        host.lifecycle.add(cleanup)
        await blocked
      },
    })

    runtime.dispose()

    await expect(activation).rejects.toThrow('disposed during activation')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()

    rejectActivation(new Error('late module rejection'))
    await Promise.resolve()
  })

  it('rolls back background activities when activation fails', async () => {
    const activityRegistry = new BackgroundActivityRegistry()
    const snapshots: string[][] = []
    activityRegistry.subscribe((activities) => {
      snapshots.push([...activities.keys()])
    })
    const runtime = createRuntime({ commit: jest.fn() }, activityRegistry)

    await expect(
      runtime.activate({
        id: 'broken-background',
        activate: (host) => {
          host.background.upsert({
            id: 'work',
            title: 'Work',
            status: 'running',
          })
          throw new Error('activation failed')
        },
      }),
    ).rejects.toThrow('activation failed')

    expect(snapshots).toEqual([[]])
    runtime.dispose()
  })

  it('keeps a background-only module active until runtime disposal', async () => {
    const activityRegistry = new BackgroundActivityRegistry()
    let activityIds: string[] = []
    activityRegistry.subscribe((activities) => {
      activityIds = [...activities.keys()]
    })
    const commit = jest.fn()
    const runtime = createRuntime({ commit }, activityRegistry)

    await expect(
      runtime.activate({
        id: 'background-only',
        activate: (host) => {
          host.background.upsert({
            id: 'notice',
            title: 'Notice',
            status: 'reminder',
          })
        },
      }),
    ).resolves.toBeUndefined()

    expect(commit).toHaveBeenCalledWith(
      'background-only',
      {},
      expect.anything(),
    )
    expect(activityIds).toEqual(['module:["background-only","notice"]'])

    runtime.dispose()
    expect(activityIds).toEqual([])
  })

  it('does not publish background activities before async activation commits', async () => {
    const activityRegistry = new BackgroundActivityRegistry()
    let activityIds: string[] = []
    activityRegistry.subscribe((activities) => {
      activityIds = [...activities.keys()]
    })
    let continueActivation!: () => void
    const blocked = new Promise<void>((resolve) => {
      continueActivation = resolve
    })
    const runtime = createRuntime({ commit: jest.fn() }, activityRegistry)
    const activation = runtime.activate({
      id: 'async-background',
      activate: async (host) => {
        host.background.upsert({
          id: 'work',
          title: 'Work',
          status: 'running',
        })
        await blocked
      },
    })

    await Promise.resolve()
    expect(activityIds).toEqual([])

    continueActivation()
    await activation
    expect(activityIds).toEqual(['module:["async-background","work"]'])
    runtime.dispose()
  })

  it('allows an initially idle lifecycle-owned service module', async () => {
    const commit = jest.fn()
    const cleanup = jest.fn()
    const runtime = createRuntime({ commit })

    await expect(
      runtime.activate({
        id: 'idle-service',
        activate: (host) => {
          host.lifecycle.add(cleanup)
        },
      }),
    ).resolves.toBeUndefined()
    expect(commit).toHaveBeenCalledWith('idle-service', {}, expect.anything())

    runtime.dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('rolls back registrar contributions after background commit fails', async () => {
    const commit = jest.fn()
    const contributionCleanup = jest.fn()
    const runtime = new ModuleRuntime(
      {
        commit: (moduleId, contributions, lifecycle) => {
          commit(moduleId, contributions, lifecycle)
          lifecycle.add(contributionCleanup)
        },
      },
      new CoreModuleHostCapabilityProvider({
        backgroundActivities: {
          upsert: jest.fn(),
          upsertAll: () => {
            throw new Error('background commit failed')
          },
          remove: jest.fn(),
        },
      }),
    )

    await expect(
      runtime.activate({
        id: 'mixed-module',
        activate: (host) => {
          host.background.upsert({
            id: 'work',
            title: 'Work',
            status: 'running',
          })
          host.workspace.registerView({
            type: 'mixed-view',
            name: 'Mixed',
            icon: 'box',
            render: () => null,
          })
        },
      }),
    ).rejects.toThrow('background commit failed')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(contributionCleanup).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })

  it('does not publish background activities when registrar commit fails', async () => {
    const onOpen = jest.fn()
    const upsertAll = jest.fn()
    const remove = jest.fn()
    const runtime = new ModuleRuntime(
      {
        commit: () => {
          throw new Error('workspace commit failed')
        },
      },
      new CoreModuleHostCapabilityProvider({
        backgroundActivities: {
          upsert: jest.fn(),
          upsertAll,
          remove,
        },
      }),
    )

    await expect(
      runtime.activate({
        id: 'failed-workspace',
        activate: (host) => {
          host.background.upsert({
            id: 'notice',
            title: 'Notice',
            status: 'reminder',
            onOpen,
          })
          host.workspace.registerView({
            type: 'failed-view',
            name: 'Failed',
            icon: 'x',
            render: () => null,
          })
        },
      }),
    ).rejects.toThrow('workspace commit failed')

    expect(onOpen).not.toHaveBeenCalled()
    expect(upsertAll).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('does not commit workspace declarations after reentrant disposal', async () => {
    const commit = jest.fn()
    const remove = jest.fn()
    const runtime = new ModuleRuntime(
      { commit },
      new CoreModuleHostCapabilityProvider({
        backgroundActivities: {
          upsert: jest.fn(),
          upsertAll: () => runtime.dispose(),
          remove,
        },
      }),
    )

    await expect(
      runtime.activate({
        id: 'reentrant-capability',
        activate: (host) => {
          host.background.upsert({
            id: 'work',
            title: 'Work',
            status: 'running',
          })
        },
      }),
    ).rejects.toThrow('disposed during capability commit')

    expect(commit).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(
      'module:["reentrant-capability","work"]',
    )
  })

  it('does not restore a scope disposed during contribution commit', async () => {
    const activityRegistry = new BackgroundActivityRegistry()
    const runtime = createRuntime(
      {
        commit: () => runtime.dispose(),
      },
      activityRegistry,
    )

    await expect(
      runtime.activate({
        id: 'reentrant-contribution',
        activate: (host) => {
          host.background.upsert({
            id: 'work',
            title: 'Work',
            status: 'running',
          })
        },
      }),
    ).rejects.toThrow('disposed during contribution commit')

    await expect(
      runtime.activate({ id: 'late-module', activate: () => undefined }),
    ).rejects.toThrow('Module runtime is disposed')
  })

  it('opens only through the active module workspace capability', async () => {
    const openView = jest.fn(async () => undefined)
    const runtime = createRuntime({ commit: jest.fn(), openView })
    let moduleOpenView!: Parameters<
      Parameters<ModuleRuntime['activate']>[0]['activate']
    >[0]['workspace']['openView']

    await runtime.activate({
      id: 'workspace-module',
      activate: async (host) => {
        moduleOpenView = (options) => host.workspace.openView(options)
        await expect(moduleOpenView()).rejects.toThrow(
          'workspace is not active',
        )
        host.workspace.registerView({
          type: 'workspace-view',
          name: 'Workspace',
          icon: 'layout',
          render: () => null,
        })
      },
    })

    await expect(moduleOpenView({ newLeaf: true })).resolves.toBeUndefined()
    expect(openView).toHaveBeenCalledWith(
      'workspace-module',
      { newLeaf: true },
      expect.any(Function),
    )
    await expect(
      moduleOpenView({
        newLeaf: 'yes',
      } as unknown as Parameters<typeof moduleOpenView>[0]),
    ).rejects.toThrow('newLeaf must be a boolean')
    await expect(
      moduleOpenView(null as unknown as Parameters<typeof moduleOpenView>[0]),
    ).rejects.toThrow('options must be an object')
    let optionReads = 0
    await moduleOpenView({
      get newLeaf() {
        optionReads += 1
        return optionReads === 1
      },
    })
    expect(optionReads).toBe(1)
    expect(openView).toHaveBeenLastCalledWith(
      'workspace-module',
      { newLeaf: true },
      expect.any(Function),
    )

    const target = { type: 'project', projectId: 'alpha' }
    await moduleOpenView({ state: target })
    target.projectId = 'changed'
    expect(openView).toHaveBeenLastCalledWith(
      'workspace-module',
      { newLeaf: undefined, state: { type: 'project', projectId: 'alpha' } },
      expect.any(Function),
    )
    await expect(
      moduleOpenView({
        state: { callback: () => undefined },
      }),
    ).rejects.toThrow('structured-cloneable')

    runtime.dispose()
    await expect(moduleOpenView()).rejects.toThrow('workspace is not active')
  })

  it('rejects navigation when the host has no workspace controller', async () => {
    const runtime = createRuntime({ commit: jest.fn() })
    let moduleOpenView!: () => Promise<void>
    await runtime.activate({
      id: 'no-navigation',
      activate: (host) => {
        moduleOpenView = () => host.workspace.openView()
      },
    })

    await expect(moduleOpenView()).rejects.toThrow(
      'workspace navigation is unavailable',
    )
    runtime.dispose()
  })

  it('closes workspace navigation before registrar-owned cleanup runs', async () => {
    const openView = jest.fn(async () => undefined)
    let moduleOpenView!: () => Promise<void>
    let cleanupNavigation: Promise<void> | null = null
    const runtime = createRuntime({
      commit: (_moduleId, _contributions, lifecycle) => {
        lifecycle.add(() => {
          cleanupNavigation = moduleOpenView()
        })
      },
      openView,
    })
    await runtime.activate({
      id: 'cleanup-navigation',
      activate: (host) => {
        moduleOpenView = () => host.workspace.openView()
      },
    })

    runtime.dispose()

    await expect(cleanupNavigation).rejects.toThrow('workspace is not active')
    expect(openView).not.toHaveBeenCalled()
  })
})
