jest.mock('obsidian', () => ({ ItemView: class {} }))

import type { Plugin, WorkspaceLeaf } from 'obsidian'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ObsidianModuleContributionRegistrar } from './moduleRuntime'

const view = {
  type: 'module-view',
  name: 'Module view',
  icon: 'box',
  render: () => null,
}

describe('ObsidianModuleContributionRegistrar', () => {
  it('reuses and reveals an existing module view', async () => {
    const existingLeaf = {} as WorkspaceLeaf
    const workspace = {
      getLeavesOfType: jest.fn(() => [existingLeaf]),
      getLeaf: jest.fn(),
      revealLeaf: jest.fn(),
    }
    const registerView = jest.fn()
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace },
      registerView,
    } as unknown as Plugin)
    registrar.commit('notes', { view }, new ModuleLifecycleScope())

    await registrar.openView('notes')

    expect(registerView).toHaveBeenCalledWith(view.type, expect.any(Function))
    expect(workspace.getLeavesOfType).toHaveBeenCalledWith(view.type)
    expect(workspace.getLeaf).not.toHaveBeenCalled()
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf)
  })

  it('creates a tab for a missing view or an explicit new leaf', async () => {
    const existingLeaf = {} as WorkspaceLeaf
    const setViewState = jest.fn(async () => undefined)
    const newLeaf = {
      setViewState,
      detach: jest.fn(),
    } as unknown as WorkspaceLeaf
    const workspace = {
      getLeavesOfType: jest.fn(() => [] as WorkspaceLeaf[]),
      getLeaf: jest.fn(() => newLeaf),
      revealLeaf: jest.fn(),
    }
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace },
      registerView: jest.fn(),
    } as unknown as Plugin)
    registrar.commit('notes', { view }, new ModuleLifecycleScope())

    await registrar.openView('notes')
    expect(setViewState).toHaveBeenCalledWith({
      type: view.type,
      active: true,
    })
    expect(workspace.revealLeaf).toHaveBeenCalledWith(newLeaf)

    workspace.getLeavesOfType.mockReturnValue([existingLeaf])
    await registrar.openView('notes', { newLeaf: true })
    expect(workspace.getLeavesOfType).toHaveBeenCalledTimes(1)
    expect(workspace.getLeaf).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent default opens but not explicit new leaves', async () => {
    let finishViewState!: () => void
    const viewStatePending = new Promise<void>((resolve) => {
      finishViewState = resolve
    })
    const setViewState = jest.fn(() => viewStatePending)
    const leaf = {
      setViewState,
      detach: jest.fn(),
    } as unknown as WorkspaceLeaf
    const workspace = {
      getLeavesOfType: jest.fn(() => [] as WorkspaceLeaf[]),
      getLeaf: jest.fn(() => leaf),
      revealLeaf: jest.fn(async () => undefined),
    }
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace },
      registerView: jest.fn(),
    } as unknown as Plugin)
    registrar.commit('notes', { view }, new ModuleLifecycleScope())

    const first = registrar.openView('notes')
    const second = registrar.openView('notes')
    expect(workspace.getLeaf).toHaveBeenCalledTimes(1)
    finishViewState()
    await Promise.all([first, second])

    await Promise.all([
      registrar.openView('notes', { newLeaf: true }),
      registrar.openView('notes', { newLeaf: true }),
    ])
    expect(workspace.getLeaf).toHaveBeenCalledTimes(3)
  })

  it('detaches a newly created leaf when the module becomes inactive', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    let finishViewState!: () => void
    const viewStatePending = new Promise<void>((resolve) => {
      finishViewState = resolve
    })
    const detach = jest.fn(() => {
      throw new Error('detach failed')
    })
    const leaf = {
      setViewState: jest.fn(() => viewStatePending),
      detach,
    } as unknown as WorkspaceLeaf
    const workspace = {
      getLeavesOfType: jest.fn(() => [] as WorkspaceLeaf[]),
      getLeaf: jest.fn(() => leaf),
      revealLeaf: jest.fn(async () => undefined),
    }
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace },
      registerView: jest.fn(),
    } as unknown as Plugin)
    registrar.commit('notes', { view }, new ModuleLifecycleScope())
    let active = true

    const opening = registrar.openView('notes', undefined, () => active)
    active = false
    finishViewState()

    await expect(opening).rejects.toThrow('workspace is not active')
    expect(detach).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('failed to detach'),
      expect.objectContaining({ message: 'detach failed' }),
    )
    expect(workspace.revealLeaf).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('rejects modules without a registered view', async () => {
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace: {} },
    } as unknown as Plugin)

    await expect(registrar.openView('service-only')).rejects.toThrow(
      'has no registered view',
    )
  })
})
