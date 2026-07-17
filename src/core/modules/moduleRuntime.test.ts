jest.mock('obsidian', () => ({ ItemView: class {} }))

import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { CoreModuleHostCapabilityProvider } from './hostCapabilities'
import type { ModuleContributionRegistrar } from './moduleRuntime'
import { ModuleRuntime } from './moduleRuntime'

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

  it('rolls back a pending activation when the runtime is disposed', async () => {
    const cleanup = jest.fn()
    const commit = jest.fn()
    const runtime = createRuntime({ commit })
    let continueActivation!: () => void
    const blocked = new Promise<void>((resolve) => {
      continueActivation = resolve
    })
    const activation = runtime.activate({
      id: 'pending-module',
      activate: async (host) => {
        host.lifecycle.add(cleanup)
        await blocked
        host.workspace.registerRibbonAction({
          icon: 'clock',
          title: 'Pending',
          onClick: () => undefined,
        })
      },
    })

    runtime.dispose()
    continueActivation()

    await expect(activation).rejects.toThrow()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
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

  it('does not commit workspace declarations after capability commit fails', async () => {
    const commit = jest.fn()
    const runtime = new ModuleRuntime(
      { commit },
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
    expect(commit).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('keeps callbacks disabled when workspace contribution commit fails', async () => {
    const onOpen = jest.fn()
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
          upsertAll: (activities) => {
            const [activity] = [...activities]
            if (activity.action?.type === 'callback') activity.action.run()
          },
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
    expect(remove).toHaveBeenCalledWith('module:["failed-workspace","notice"]')
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

    expect(commit).not.toHaveBeenCalled()
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
