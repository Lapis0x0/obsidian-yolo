jest.mock('obsidian', () => ({
  ItemView: class {
    readonly constructedViewType: string

    constructor() {
      this.constructedViewType = (
        this as unknown as { getViewType(): string }
      ).getViewType()
    }
  },
}))

import type { Plugin, WorkspaceLeaf } from 'obsidian'

import { LocaleStore } from '../i18n/localeStore'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ObsidianModuleContributionRegistrar } from './moduleRuntime'

const view = {
  type: 'module-view',
  name: 'Module view',
  icon: 'box',
  render: () => null,
}

describe('ObsidianModuleContributionRegistrar', () => {
  it('provides the view declaration during the ItemView base constructor', () => {
    const registerView = jest.fn()
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace: {} },
      registerView,
    } as unknown as Plugin)
    registrar.commit('notes', { view }, new ModuleLifecycleScope())

    const factory = registerView.mock.calls[0]?.[1] as (
      leaf: WorkspaceLeaf,
    ) => {
      constructedViewType: string
      getViewType(): string
      getDisplayText(): string
      getIcon(): string
    }
    const itemView = factory({} as WorkspaceLeaf)

    expect(itemView.constructedViewType).toBe(view.type)
    expect(itemView.getViewType()).toBe(view.type)
    expect(itemView.getDisplayText()).toBe(view.name)
    expect(itemView.getIcon()).toBe(view.icon)
  })

  it('rebinds a module view without registering another Obsidian view type', async () => {
    const registerView = jest.fn()
    const workspace = {
      getLeavesOfType: jest.fn(() => [{}]),
      revealLeaf: jest.fn(async () => undefined),
    }
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace },
      registerView,
    } as unknown as Plugin)
    const first = new ModuleLifecycleScope()
    registrar.commit('notes', { view }, first)
    registrar.deactivate('notes', false)
    first.dispose()

    const second = new ModuleLifecycleScope()
    registrar.commit(
      'notes',
      { view: { ...view, name: 'Updated module view' } },
      second,
    )
    await expect(registrar.openView('notes')).resolves.toBeUndefined()

    expect(registerView).toHaveBeenCalledTimes(1)
    expect(workspace.revealLeaf).toHaveBeenCalledTimes(1)
    second.dispose()
  })

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

  it('namespaces, removes, and revokes module commands', () => {
    const callback = jest.fn()
    const addCommand = jest.fn()
    const removeCommand = jest.fn()
    const lifecycle = new ModuleLifecycleScope()
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace: {} },
      manifest: { id: 'yolo' },
      addCommand,
      removeCommand,
    } as unknown as Plugin)

    registrar.commit(
      'learning',
      {
        commands: [{ id: 'open', name: 'Open Learning', callback }],
      },
      lifecycle,
    )
    const declaration = addCommand.mock.calls[0]?.[0] as
      | { id: string; callback: () => void }
      | undefined
    expect(declaration?.id).toBe('module:learning:open')
    declaration?.callback()
    expect(callback).toHaveBeenCalledTimes(1)

    lifecycle.dispose()
    declaration?.callback()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(removeCommand).toHaveBeenCalledWith('module:learning:open')
  })

  it('isolates synchronous and asynchronous command failures', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    const addCommand = jest.fn()
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace: {} },
      manifest: { id: 'yolo' },
      addCommand,
      removeCommand: jest.fn(),
    } as unknown as Plugin)
    registrar.commit(
      'learning',
      {
        commands: [
          {
            id: 'sync',
            name: 'Sync failure',
            callback: () => {
              throw new Error('sync failed')
            },
          },
          {
            id: 'async',
            name: 'Async failure',
            callback: () => Promise.reject(new Error('async failed')),
          },
        ],
      },
      new ModuleLifecycleScope(),
    )

    expect(() => addCommand.mock.calls[0]?.[0].callback()).not.toThrow()
    addCommand.mock.calls[1]?.[0].callback()
    await Promise.resolve()
    expect(consoleError).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })

  it('updates localized view, ribbon, and command labels without changing identities', () => {
    let locale = 'en'
    const locales = new LocaleStore({ readLocale: () => locale })
    const addCommand = jest.fn()
    const ribbon = {
      remove: jest.fn(),
      setAttribute: jest.fn(),
    }
    const addRibbonIcon = jest.fn(() => ribbon)
    const registerView = jest.fn()
    const trigger = jest.fn()
    const lifecycle = new ModuleLifecycleScope()
    const registrar = new ObsidianModuleContributionRegistrar(
      {
        app: { workspace: { trigger } },
        addCommand,
        addRibbonIcon,
        registerView,
        removeCommand: jest.fn(),
      } as unknown as Plugin,
      locales,
    )
    const callback = jest.fn()
    registrar.commit(
      'learning',
      {
        view: { ...view, name: { en: 'Learning', zh: '学习' } },
        ribbonAction: {
          icon: 'graduation-cap',
          title: { en: 'Open Learning', zh: '打开学习' },
          onClick: callback,
        },
        commands: [
          {
            id: 'open',
            name: { en: 'Open Learning', zh: '打开学习' },
            callback,
          },
        ],
      },
      lifecycle,
    )
    const factory = registerView.mock.calls[0]?.[1] as (
      leaf: WorkspaceLeaf,
    ) => { getDisplayText(): string }
    const itemView = factory({} as WorkspaceLeaf)
    const command = addCommand.mock.calls[0]?.[0] as {
      id: string
      name: string
    }

    expect(itemView.getDisplayText()).toBe('Learning')
    expect(command).toMatchObject({
      id: 'module:learning:open',
      name: 'Open Learning',
    })
    locale = 'zh-CN'
    locales.refresh()

    expect(itemView.getDisplayText()).toBe('学习')
    expect(command.name).toBe('打开学习')
    expect(ribbon.setAttribute).toHaveBeenCalledWith('aria-label', '打开学习')
    expect(trigger).toHaveBeenCalledWith('layout-change')
    lifecycle.dispose()
    expect(ribbon.remove).toHaveBeenCalledTimes(1)
  })
})
