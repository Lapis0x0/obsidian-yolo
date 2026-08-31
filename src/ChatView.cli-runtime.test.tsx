const renderedTrees: unknown[] = []
const roots: Array<{ render: jest.Mock; unmount: jest.Mock }> = []

jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react')
  return { __esModule: true, ...actual, default: actual }
})

jest.mock('react-dom/client', () => ({
  createRoot: jest.fn(() => {
    const root = {
      render: jest.fn((tree: unknown) => renderedTrees.push(tree)),
      unmount: jest.fn(),
    }
    roots.push(root)
    return root
  }),
}))

jest.mock('obsidian', () => {
  class ItemView {
    app: unknown
    containerEl: unknown
    leaf: unknown

    constructor(leaf: unknown) {
      this.leaf = leaf
      this.app = {}
      this.containerEl = {}
    }
  }
  class Modal {
    app: unknown
    contentEl: { empty: () => void }
    titleEl: { setText: () => void }
    modalEl: { classList: { add: () => void; remove: () => void } }

    constructor(app: unknown) {
      this.app = app
      this.contentEl = { empty: () => {} }
      this.titleEl = { setText: () => {} }
      this.modalEl = { classList: { add: () => {}, remove: () => {} } }
    }

    open(): void {}
    close(): void {}
    onOpen(): void {}
    onClose(): void {}
  }
  return {
    ItemView,
    Modal,
    TFile: class {},
    TFolder: class {},
    WorkspaceLeaf: class {},
  }
})

const passthroughProvider = ({ children }: { children: unknown }) => children
jest.mock('./contexts/app-context', () => ({
  AppProvider: passthroughProvider,
}))
jest.mock('./contexts/chat-view-context', () => ({
  ChatViewProvider: passthroughProvider,
}))
jest.mock('./contexts/dark-mode-context', () => ({
  DarkModeProvider: passthroughProvider,
}))
jest.mock('./contexts/database-context', () => ({
  DatabaseProvider: passthroughProvider,
}))
jest.mock('./contexts/dialog-container-context', () => ({
  DialogContainerProvider: passthroughProvider,
}))
jest.mock('./contexts/language-context', () => ({
  LanguageProvider: passthroughProvider,
}))
jest.mock('./contexts/mcp-context', () => ({
  McpProvider: passthroughProvider,
}))
jest.mock('./contexts/plugin-context', () => ({
  PluginProvider: passthroughProvider,
}))
jest.mock('./contexts/settings-context', () => ({
  SettingsProvider: passthroughProvider,
}))

const ChatSidebarTabs = jest.fn((_props: unknown) => null)
const mockChatSidebarTabsComponent = (props: unknown) => ChatSidebarTabs(props)
jest.mock('./components/chat-view/ChatSidebarTabs', () => ({
  __esModule: true,
  default: mockChatSidebarTabsComponent,
}))
jest.mock('./hooks/useChatHistory', () => ({
  getConversationDisplayTitle: (title: string | undefined) => title ?? '',
}))

import type { ReactElement } from 'react'

import { ChatView } from './ChatView'
import type { CliRuntimeScope } from './core/cli-runtime/coordinator'

type TestChatView = {
  app: unknown
  containerEl: {
    children: unknown[]
    win: { cancelAnimationFrame: jest.Mock }
  }
  cliRuntimeScope?: CliRuntimeScope
  cliRuntimeScopeInitialization: Promise<void> | null
  cliRuntimeScopeDisposal: Promise<void> | null
  prepareCliRuntimeScopeForOpen(): Promise<void>
  initializeCliRuntimeScope(): Promise<void>
  rebuild(): Promise<void>
  render(): Promise<void>
  onClose(): Promise<void>
  isClosed: boolean
  root: { render: jest.Mock; unmount: jest.Mock } | null
}

const makeScope = (): {
  scope: CliRuntimeScope
  dispose: jest.Mock<Promise<void>, []>
} => {
  const dispose = jest.fn(async () => undefined)
  return {
    scope: { dispose } as unknown as CliRuntimeScope,
    dispose,
  }
}

const createView = (
  createCliRuntimeScope: () => Promise<CliRuntimeScope | null>,
): TestChatView => {
  const manager = {
    getLeafPlacement: jest.fn(() => 'sidebar'),
    unregisterLeaf: jest.fn(),
  }
  const host = { ownerDocument: {} }
  const view = Object.create(ChatView.prototype) as unknown as TestChatView
  Object.assign(view, {
    plugin: {
      app: {},
      settings: {},
      createCliRuntimeScope,
      getChatLeafSessionManager: () => manager,
      setSettings: jest.fn(),
      addSettingsChangeListener: jest.fn(),
      getDbManager: jest.fn(),
      getRAGEngine: jest.fn(),
      getMcpManager: jest.fn(),
    },
    app: {},
    leaf: {},
    containerEl: {
      children: [{}, host],
      win: { cancelAnimationFrame: jest.fn() },
    },
    root: null,
    chatRef: { current: null },
    mountedHost: null,
    mountedDoc: null,
    hostObserver: null,
    windowMigratedDisposer: null,
    runtimeSnapshot: null,
    rebuildScheduled: false,
    rebuildRafId: null,
    rebuildRafWindow: null,
    isClosed: false,
    pendingRestoredConversationId: undefined,
    restoredConversationLoadPromise: null,
    cliRuntimeScope: undefined,
    cliRuntimeScopeInitialization: null,
    cliRuntimeScopeDisposal: null,
  })
  return view
}

const findElement = (
  node: unknown,
  predicate: (element: ReactElement) => boolean,
): ReactElement | null => {
  if (!node || typeof node !== 'object') return null
  const element = node as ReactElement
  if ('type' in element && predicate(element)) return element
  const children = (element.props as { children?: unknown } | undefined)
    ?.children
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElement(child, predicate)
      if (match) return match
    }
    return null
  }
  return findElement(children, predicate)
}

describe('ChatView CLI runtime scope lifecycle', () => {
  beforeEach(() => {
    renderedTrees.length = 0
    roots.length = 0
    jest.clearAllMocks()
  })

  it('creates one scope and passes the same instance through a host rebuild', async () => {
    const { scope } = makeScope()
    const createCliRuntimeScope = jest.fn(async () => scope)
    const view = createView(createCliRuntimeScope)
    await view.initializeCliRuntimeScope()

    await view.render()
    const firstTree = renderedTrees.at(-1)
    const firstTabs = findElement(
      firstTree,
      (element) => element.type === mockChatSidebarTabsComponent,
    )

    const replacementHost = { ownerDocument: {} }
    view.containerEl.children[1] = replacementHost
    await view.rebuild()
    const rebuiltTree = renderedTrees.at(-1)
    const rebuiltTabs = findElement(
      rebuiltTree,
      (element) => element.type === mockChatSidebarTabsComponent,
    )

    expect(createCliRuntimeScope).toHaveBeenCalledTimes(1)
    expect(firstTabs?.props.initialChatProps.cliRuntimeScope).toBe(scope)
    expect(rebuiltTabs?.props.initialChatProps.cliRuntimeScope).toBe(scope)
  })

  it('disposes its scope once when the view closes', async () => {
    const { scope, dispose } = makeScope()
    const view = createView(async () => scope)
    await view.initializeCliRuntimeScope()
    await view.render()

    await view.onClose()
    await view.onClose()

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(view.cliRuntimeScope).toBeUndefined()
  })

  it('disposes a scope that finishes creation after close starts', async () => {
    let resolveScope!: (scope: CliRuntimeScope) => void
    const scopePromise = new Promise<CliRuntimeScope>((resolve) => {
      resolveScope = resolve
    })
    const { scope, dispose } = makeScope()
    const view = createView(() => scopePromise)

    const initialization = view.initializeCliRuntimeScope()
    const close = view.onClose()
    resolveScope(scope)
    await Promise.all([initialization, close])

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(view.cliRuntimeScope).toBeUndefined()
  })

  it('creates a fresh scope when the same ChatView instance reopens', async () => {
    const first = makeScope()
    const second = makeScope()
    const createCliRuntimeScope = jest
      .fn<Promise<CliRuntimeScope>, []>()
      .mockResolvedValueOnce(first.scope)
      .mockResolvedValueOnce(second.scope)
    const view = createView(createCliRuntimeScope)

    await view.initializeCliRuntimeScope()
    await view.onClose()
    await view.prepareCliRuntimeScopeForOpen()
    view.isClosed = false
    await view.initializeCliRuntimeScope()

    expect(createCliRuntimeScope).toHaveBeenCalledTimes(2)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.dispose).not.toHaveBeenCalled()
    expect(view.cliRuntimeScope).toBe(second.scope)
  })
})
