jest.mock('obsidian', () => ({ ItemView: class {} }))

import type { ModuleContributionRegistrar } from './moduleRuntime'
import { ModuleRuntime } from './moduleRuntime'

describe('ModuleRuntime', () => {
  it('does not commit declarations when module activation fails', async () => {
    const commit = jest.fn()
    const registrar: ModuleContributionRegistrar = { commit }
    const runtime = new ModuleRuntime(registrar)
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
    const runtime = new ModuleRuntime(registrar)

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
    const runtime = new ModuleRuntime({ commit })
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
    const runtime = new ModuleRuntime({ commit })
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
})
