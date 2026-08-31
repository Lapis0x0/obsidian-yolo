jest.mock('obsidian', () => {
  class TAbstractFile {
    name: string
    constructor(public path: string) {
      this.name = path.split('/').pop() ?? path
    }
  }
  class TFile extends TAbstractFile {
    extension: string
    basename: string
    stat = { ctime: 1, mtime: 2 }
    constructor(path: string) {
      super(path)
      const dot = this.name.lastIndexOf('.')
      this.extension = dot >= 0 ? this.name.slice(dot + 1) : ''
      this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name
    }
  }
  class TFolder extends TAbstractFile {}

  class Scope {
    handlers: Array<{
      modifiers: string[] | null
      key: string | null
      func: (...args: unknown[]) => unknown
    }> = []
    constructor(public parent?: unknown) {}
    register(
      modifiers: string[] | null,
      key: string | null,
      func: (...args: unknown[]) => unknown,
    ) {
      const handler = { modifiers, key, func }
      this.handlers.push(handler)
      return handler
    }
    unregister(handler: unknown) {
      this.handlers = this.handlers.filter((h) => h !== handler)
    }
  }

  class FakeElement {
    _children: FakeElement[] = []
    className = ''
    textContent = ''
    attrs: Record<string, string> = {}
    ownerDocument: { createElement: (tag: string) => FakeElement }
    constructor(public tagName = 'div') {
      this.ownerDocument = {
        createElement: (tag: string) => new FakeElement(tag),
      }
    }
    appendChild(child: FakeElement) {
      this._children.push(child)
      return child
    }
    removeChild(child: FakeElement) {
      this._children = this._children.filter((c) => c !== child)
      return child
    }
    get firstChild() {
      return this._children[0] ?? null
    }
    get children() {
      return this._children
    }
    setAttribute(name: string, value: string) {
      this.attrs[name] = value
    }
  }

  class TextFileView {
    contentEl: FakeElement
    containerEl: {
      onWindowMigrated: (cb: () => void) => () => void
      triggerMigration: () => void
    }
    file: InstanceType<typeof TFile> | null = null
    requestSave = jest.fn()
    // The real super chain (EditableFileView.onOpen wires the editable
    // header title; FileView.onClose unloads the file) must be awaitable
    // from HostModuleFileView's overrides — prototype methods, so `super.`
    // lookups resolve.
    async onOpen(): Promise<void> {}
    async onClose(): Promise<void> {}
    constructor(public leaf: unknown) {
      // Real Obsidian's View base constructor calls getViewType() before the
      // subclass constructor body (and TS parameter properties) have run —
      // replicated here so a subclass reading not-yet-assigned fields from
      // getViewType() fails in tests the way it fails in the app.
      ;(this as { getViewType?: () => string }).getViewType?.()
      this.contentEl = new FakeElement('div')
      let migrateCb: (() => void) | null = null
      this.containerEl = {
        onWindowMigrated: (cb: () => void) => {
          migrateCb = cb
          return () => {
            migrateCb = null
          }
        },
        triggerMigration: () => migrateCb?.(),
      }
    }
  }

  return { TextFileView, TFile, TFolder, TAbstractFile, Scope }
})

import type { Plugin } from 'obsidian'
import { Scope, TFile, TFolder } from 'obsidian'

import { loadLocale } from '../../i18n'
import { LocaleStore } from '../i18n/localeStore'

import { ModuleLifecycleScope } from './lifecycleScope'
import {
  ModuleFileMenuRegistry,
  ModuleFileViewSlot,
  createModuleFileView,
} from './moduleFileView'
import type {
  YoloModuleFileViewInstanceV1,
  YoloModuleFileViewV1,
} from './types'

const makeLocales = (initial = 'en') =>
  new LocaleStore({ readLocale: () => initial })

describe('ModuleFileViewSlot', () => {
  const board: YoloModuleFileViewV1 = {
    viewType: 'yolo-whiteboard',
    extensions: ['yoloboard'],
    name: { en: 'Whiteboard', zh: '白板' },
    icon: 'layout-grid',
    factory: jest.fn(),
  }

  it('binds and unbinds, notifying subscribers', () => {
    const slot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      board.name,
      makeLocales(),
    )
    const events: (YoloModuleFileViewV1 | null)[] = []
    slot.subscribe((declaration) => events.push(declaration))

    expect(slot.get()).toBeNull()
    slot.bind(board)
    expect(slot.get()).toBe(board)
    slot.unbind()
    expect(slot.get()).toBeNull()
    expect(events).toEqual([board, null])
  })

  it('rejects a mismatched viewType and a second concurrent bind', () => {
    const slot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      board.name,
      makeLocales(),
    )
    expect(() => slot.bind({ ...board, viewType: 'other' })).toThrow(
      'changed file view type',
    )
    slot.bind(board)
    expect(() => slot.bind(board)).toThrow('already active')
  })

  it('ignores unbind when the expected declaration no longer matches', () => {
    const slot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      board.name,
      makeLocales(),
    )
    slot.bind(board)
    slot.unbind({ ...board })
    expect(slot.get()).toBe(board)
  })

  it('resolves the display name and inactive placeholder per locale', async () => {
    await Promise.all([loadLocale('en'), loadLocale('zh')])
    const locales = makeLocales('en')
    const slot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      board.name,
      locales,
    )
    expect(slot.getName()).toBe('Whiteboard')
    expect(slot.getInactivePlaceholderText()).toMatch(/not currently active/)

    const zhLocales = makeLocales('zh-CN')
    const zhSlot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      board.name,
      zhLocales,
    )
    expect(zhSlot.getName()).toBe('白板')
    expect(zhSlot.getInactivePlaceholderText()).toBe(
      '该文件类型由一个当前未启用的模块提供。',
    )
  })
})

type InstanceHandle = {
  instance: YoloModuleFileViewInstanceV1
  liveData: string
  dispose: jest.Mock
}

function makeFactory(): {
  factory: YoloModuleFileViewV1['factory']
  handles: InstanceHandle[]
} {
  const handles: InstanceHandle[] = []
  const factory: YoloModuleFileViewV1['factory'] = () => {
    const handle: InstanceHandle = {
      liveData: '',
      dispose: jest.fn(),
      instance: undefined as unknown as YoloModuleFileViewInstanceV1,
    }
    handle.instance = Object.freeze({
      setViewData: (data: string) => {
        handle.liveData = data
      },
      getViewData: () => handle.liveData,
      clear: jest.fn(),
      dispose: handle.dispose,
    })
    handles.push(handle)
    return handle.instance
  }
  return { factory, handles }
}

function makePlugin(): Plugin {
  return {
    app: {
      keymap: { scope: new Scope(), pushScope: jest.fn(), popScope: jest.fn() },
    },
  } as unknown as Plugin
}

describe('HostModuleFileView (via createModuleFileView)', () => {
  it('never regresses getViewData to empty after the module deactivates', () => {
    const { factory, handles } = makeFactory()
    const view: YoloModuleFileViewV1 = {
      viewType: 'yolo-whiteboard',
      extensions: ['yoloboard'],
      name: 'Whiteboard',
      icon: 'layout-grid',
      factory,
    }
    const slot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      view.name,
      makeLocales(),
    )
    const plugin = makePlugin()
    const hostView = createModuleFileView(
      {} as never,
      plugin,
      slot,
    ) as unknown as {
      onOpen(): Promise<void>
      onClose(): Promise<void>
      getViewData(): string
      setViewData(data: string, clear: boolean): void
    }

    slot.bind(view)
    void hostView.onOpen()
    hostView.setViewData('# hello', true)
    expect(handles).toHaveLength(1)

    // Simulate the user editing live inside the module (not yet saved back
    // through setViewData) before the module deactivates.
    handles[0].liveData = '# hello, edited live'

    slot.unbind()

    expect(hostView.getViewData()).toBe('# hello, edited live')
    expect(handles[0].dispose).toHaveBeenCalledTimes(1)
  })

  it('caches setViewData calls that arrive before onOpen and replays them on bind', () => {
    const { factory, handles } = makeFactory()
    const view: YoloModuleFileViewV1 = {
      viewType: 'yolo-whiteboard',
      extensions: ['yoloboard'],
      name: 'Whiteboard',
      icon: 'layout-grid',
      factory,
    }
    const slot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      view.name,
      makeLocales(),
    )
    const hostView = createModuleFileView(
      {} as never,
      makePlugin(),
      slot,
    ) as unknown as {
      onOpen(): Promise<void>
      getViewData(): string
      setViewData(data: string, clear: boolean): void
    }

    // setViewData before onOpen: no instance exists yet.
    hostView.setViewData('# preloaded', true)
    expect(handles).toHaveLength(0)
    expect(hostView.getViewData()).toBe('# preloaded')

    slot.bind(view)
    void hostView.onOpen()

    expect(handles).toHaveLength(1)
    expect(handles[0].liveData).toBe('# preloaded')
  })

  it('rebuilds the instance and replays the latest live data on window migration', () => {
    const { factory, handles } = makeFactory()
    const view: YoloModuleFileViewV1 = {
      viewType: 'yolo-whiteboard',
      extensions: ['yoloboard'],
      name: 'Whiteboard',
      icon: 'layout-grid',
      factory,
    }
    const slot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      view.name,
      makeLocales(),
    )
    slot.bind(view)
    const hostView = createModuleFileView(
      {} as never,
      makePlugin(),
      slot,
    ) as unknown as {
      onOpen(): Promise<void>
      containerEl: { triggerMigration: () => void }
    }
    void hostView.onOpen()
    handles[0].liveData = '# edited before popout'

    hostView.containerEl.triggerMigration()

    expect(handles).toHaveLength(2)
    expect(handles[0].dispose).toHaveBeenCalledTimes(1)
    expect(handles[1].liveData).toBe('# edited before popout')
  })

  it('maps a true keymap handler result to Obsidian\'s "consumed" (false) return', () => {
    const { factory } = makeFactory()
    const registerSpy = jest.spyOn(Scope.prototype, 'register')
    const view: YoloModuleFileViewV1 = {
      viewType: 'yolo-whiteboard',
      extensions: ['yoloboard'],
      name: 'Whiteboard',
      icon: 'layout-grid',
      factory: (context) => {
        const handler = jest.fn(() => true)
        context.registerKeymap([{ modifiers: [], key: 'Escape', handler }])
        return factory(context)
      },
    }
    const slot = new ModuleFileViewSlot(
      'whiteboard',
      'yolo-whiteboard',
      'layout-grid',
      view.name,
      makeLocales(),
    )
    slot.bind(view)
    const plugin = makePlugin()
    const hostView = createModuleFileView({} as never, plugin, slot)
    void (hostView as unknown as { onOpen(): Promise<void> }).onOpen()

    // Bindings live on the view's own scope, which Obsidian consults only
    // while this leaf is active — never pushed above the whole app.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Read as a jest.fn() call-recorder, never invoked unbound.
    const pushScope = plugin.app.keymap.pushScope as jest.Mock
    expect(pushScope).not.toHaveBeenCalled()
    expect((hostView as unknown as { scope: unknown }).scope).toBeTruthy()
    expect(registerSpy).toHaveBeenCalledTimes(1)
    const wrappedHandler = registerSpy.mock.calls[0]?.[2] as () => unknown
    expect(wrappedHandler()).toBe(false)
    registerSpy.mockRestore()
  })
})

type MenuItemHandle = { title: string; onClick: () => void }

function makeFile(path: string) {
  return new (TFile as unknown as {
    new (path: string): InstanceType<typeof TFile>
  })(path)
}

function makeFolder(path: string) {
  return new (TFolder as unknown as {
    new (path: string): InstanceType<typeof TFolder>
  })(path)
}

describe('ModuleFileMenuRegistry', () => {
  function setup() {
    const handlers: Array<
      (menu: unknown, file: unknown, source: string) => void
    > = []
    const plugin = {
      app: {
        workspace: {
          on: jest.fn(
            (
              _name: string,
              cb: (menu: unknown, file: unknown, source: string) => void,
            ) => {
              handlers.push(cb)
              return {}
            },
          ),
        },
      },
      registerEvent: jest.fn(),
    } as unknown as Plugin
    const registry = new ModuleFileMenuRegistry(plugin, makeLocales())

    // Fires the real registered `file-menu` listener against a fake Menu
    // that records every item added to it, mirroring Obsidian's
    // Menu.addItem((item) => item.setTitle(...).setIcon(...).onClick(...)).
    const fire = (file: unknown): MenuItemHandle[] => {
      const items: MenuItemHandle[] = []
      const menu = {
        addItem: (cb: (item: unknown) => void) => {
          const handle: MenuItemHandle = { title: '', onClick: () => undefined }
          const item = {
            setTitle: (title: string) => {
              handle.title = title
              return item
            },
            setIcon: () => item,
            onClick: (fn: () => void) => {
              handle.onClick = fn
              return item
            },
          }
          items.push(handle)
          cb(item)
        },
      }
      handlers[0]?.(menu, file, 'test')
      return items
    }
    return { registry, fire }
  }

  it('only offers a file action for the matching extensions', () => {
    const { registry, fire } = setup()
    const onSelect = jest.fn()
    registry.commit(
      'whiteboard',
      [
        {
          id: 'open-in-board',
          title: 'Open in Whiteboard',
          icon: 'layout-grid',
          appliesTo: 'file',
          extensions: ['yoloboard'],
          onSelect,
        },
      ],
      new ModuleLifecycleScope(),
    )

    expect(fire(makeFile('notes.md'))).toHaveLength(0)

    const items = fire(makeFile('board.yoloboard'))
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Open in Whiteboard')
    items[0].onClick()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'file', path: 'board.yoloboard' }),
    )
  })

  it('never offers a file action for a folder, or vice versa', () => {
    const { registry, fire } = setup()
    registry.commit(
      'whiteboard',
      [
        {
          id: 'file-only',
          title: 'File only',
          icon: 'box',
          appliesTo: 'file',
          onSelect: jest.fn(),
        },
        {
          id: 'folder-only',
          title: 'Folder only',
          icon: 'box',
          appliesTo: 'folder',
          onSelect: jest.fn(),
        },
      ],
      new ModuleLifecycleScope(),
    )

    expect(fire(makeFile('notes.md')).map((i) => i.title)).toEqual([
      'File only',
    ])
    expect(fire(makeFolder('notes')).map((i) => i.title)).toEqual([
      'Folder only',
    ])
  })

  it('logs and isolates a synchronous or rejected onSelect failure', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    const { registry, fire } = setup()
    registry.commit(
      'whiteboard',
      [
        {
          id: 'sync-fail',
          title: 'Sync fail',
          icon: 'box',
          appliesTo: 'folder',
          onSelect: () => {
            throw new Error('sync failed')
          },
        },
        {
          id: 'async-fail',
          title: 'Async fail',
          icon: 'box',
          appliesTo: 'folder',
          onSelect: () => Promise.reject(new Error('async failed')),
        },
      ],
      new ModuleLifecycleScope(),
    )

    const items = fire(makeFolder('notes'))
    expect(items).toHaveLength(2)
    expect(() => items[0].onClick()).not.toThrow()
    items[1].onClick()
    await Promise.resolve()
    await Promise.resolve()

    expect(consoleError).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })

  it("stops offering a module's actions once its lifecycle disposes", () => {
    const { registry, fire } = setup()
    const lifecycle = new ModuleLifecycleScope()
    registry.commit(
      'whiteboard',
      [
        {
          id: 'open-in-board',
          title: 'Open',
          icon: 'box',
          appliesTo: 'folder',
          onSelect: jest.fn(),
        },
      ],
      lifecycle,
    )
    expect(fire(makeFolder('notes'))).toHaveLength(1)

    lifecycle.dispose()
    expect(fire(makeFolder('notes'))).toHaveLength(0)
  })
})
