jest.mock('obsidian', () => ({
  ItemView: class {
    readonly constructedViewType: string

    constructor() {
      this.constructedViewType = (
        this as unknown as { getViewType(): string }
      ).getViewType()
    }
  },
  TextFileView: class {
    contentEl = { firstChild: null, appendChild: () => undefined }
    containerEl = { onWindowMigrated: () => () => undefined }
    requestSave = () => undefined
  },
  TFile: class {
    name: string
    constructor(public path: string) {
      this.name = path.split('/').pop() ?? path
    }
  },
  TFolder: class {
    name: string
    constructor(public path: string) {
      this.name = path.split('/').pop() ?? path
    }
  },
}))

import { type Plugin, TFolder, type WorkspaceLeaf } from 'obsidian'

import { LocaleStore } from '../i18n/localeStore'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ObsidianModuleContributionRegistrar } from './moduleRuntime'

const view = {
  type: 'module-view',
  name: 'Module view',
  icon: 'box',
  render: () => null,
}

const fileView = {
  viewType: 'module-file-view',
  extensions: ['yoloboard'],
  name: 'Module file view',
  icon: 'layout-grid',
  factory: jest.fn(),
}

/** Every registrar in this file constructs a ModuleFileMenuRegistry, which
 * registers a plugin-lifetime `workspace.on('file-menu', ...)` listener —
 * so every plugin mock needs a minimal, real `workspace.on`/`registerEvent`
 * even in tests that only exercise plain views/commands/ribbon actions. */
const withWorkspaceEvents = <T extends { workspace?: object }>(
  app: T,
): T & { workspace: object } => ({
  ...app,
  workspace: { on: jest.fn(() => ({})), ...(app.workspace ?? {}) },
})

describe('ObsidianModuleContributionRegistrar', () => {
  it('provides the view declaration during the ItemView base constructor', () => {
    const registerView = jest.fn()
    const registrar = new ObsidianModuleContributionRegistrar({
      app: withWorkspaceEvents({ workspace: {} }),
      registerView,
      registerEvent: jest.fn(),
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
      app: withWorkspaceEvents({ workspace }),
      registerView,
      registerEvent: jest.fn(),
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
      app: withWorkspaceEvents({ workspace }),
      registerView,
      registerEvent: jest.fn(),
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
      app: withWorkspaceEvents({ workspace }),
      registerView: jest.fn(),
      registerEvent: jest.fn(),
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
      app: withWorkspaceEvents({ workspace }),
      registerView: jest.fn(),
      registerEvent: jest.fn(),
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
      app: withWorkspaceEvents({ workspace }),
      registerView: jest.fn(),
      registerEvent: jest.fn(),
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
      app: withWorkspaceEvents({ workspace: {} }),
      registerEvent: jest.fn(),
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
      app: withWorkspaceEvents({ workspace: {} }),
      manifest: { id: 'yolo' },
      addCommand,
      removeCommand,
      registerEvent: jest.fn(),
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
      app: withWorkspaceEvents({ workspace: {} }),
      manifest: { id: 'yolo' },
      addCommand,
      removeCommand: jest.fn(),
      registerEvent: jest.fn(),
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
        app: withWorkspaceEvents({ workspace: { trigger } }),
        addCommand,
        addRibbonIcon,
        registerView,
        removeCommand: jest.fn(),
        registerEvent: jest.fn(),
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

  it('registers a module file view and its extensions as a plugin-lifetime slot', () => {
    const registerView = jest.fn()
    const registerExtensions = jest.fn()
    const registrar = new ObsidianModuleContributionRegistrar({
      app: withWorkspaceEvents({ workspace: {} }),
      registerView,
      registerExtensions,
      registerEvent: jest.fn(),
    } as unknown as Plugin)

    registrar.commit(
      'whiteboard',
      { fileViews: [fileView] },
      new ModuleLifecycleScope(),
    )

    expect(registerView).toHaveBeenCalledWith(
      fileView.viewType,
      expect.any(Function),
    )
    expect(registerExtensions).toHaveBeenCalledWith(
      fileView.extensions,
      fileView.viewType,
    )
  })

  it('rejects a second module claiming an already-registered file view type or extension', () => {
    const registrar = new ObsidianModuleContributionRegistrar({
      app: withWorkspaceEvents({ workspace: {} }),
      registerView: jest.fn(),
      registerExtensions: jest.fn(),
      registerEvent: jest.fn(),
    } as unknown as Plugin)
    registrar.commit(
      'whiteboard',
      { fileViews: [fileView] },
      new ModuleLifecycleScope(),
    )

    expect(() =>
      registrar.commit(
        'intruder',
        { fileViews: [{ ...fileView, extensions: ['other'] }] },
        new ModuleLifecycleScope(),
      ),
    ).toThrow(`Module file view type "${fileView.viewType}" is already registered`)

    expect(() =>
      registrar.commit(
        'intruder',
        {
          fileViews: [{ ...fileView, viewType: 'intruder-view' }],
        },
        new ModuleLifecycleScope(),
      ),
    ).toThrow(
      `Module file view extension "${fileView.extensions[0]}" is already registered to view type "${fileView.viewType}"`,
    )
  })

  it('detaches file-view leaves on deactivate for a module with no plain view', () => {
    const detachLeavesOfType = jest.fn()
    const registrar = new ObsidianModuleContributionRegistrar({
      app: withWorkspaceEvents({ workspace: { detachLeavesOfType } }),
      registerView: jest.fn(),
      registerExtensions: jest.fn(),
      registerEvent: jest.fn(),
    } as unknown as Plugin)
    registrar.commit(
      'whiteboard',
      { fileViews: [fileView] },
      new ModuleLifecycleScope(),
    )

    registrar.deactivate('whiteboard', true)

    expect(detachLeavesOfType).toHaveBeenCalledWith(fileView.viewType)
  })

  it('wires committed file menu actions into the plugin-lifetime file-menu listener', () => {
    let fileMenuHandler:
      | ((menu: unknown, file: unknown, source: string) => void)
      | undefined
    const on = jest.fn(
      (name: string, cb: typeof fileMenuHandler): object => {
        if (name === 'file-menu') fileMenuHandler = cb
        return {}
      },
    )
    const registrar = new ObsidianModuleContributionRegistrar({
      app: { workspace: { on } },
      registerEvent: jest.fn(),
    } as unknown as Plugin)
    const onSelect = jest.fn()
    registrar.commit(
      'whiteboard',
      {
        fileMenuActions: [
          {
            id: 'open-in-board',
            title: 'Open in Whiteboard',
            icon: 'layout-grid',
            appliesTo: 'folder',
            onSelect,
          },
        ],
      },
      new ModuleLifecycleScope(),
    )

    const clicks: Array<() => void> = []
    const menu = {
      addItem: (cb: (item: unknown) => void) => {
        const item = {
          setTitle: () => item,
          setIcon: () => item,
          onClick: (fn: () => void) => {
            clicks.push(fn)
            return item
          },
        }
        cb(item)
      },
    }
    const folder = new (TFolder as unknown as {
      new (path: string): InstanceType<typeof TFolder>
    })('notes')
    fileMenuHandler?.(menu, folder, 'test')

    expect(clicks).toHaveLength(1)
    clicks[0]()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'folder', path: 'notes' }),
    )
  })
})
