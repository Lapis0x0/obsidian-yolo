const renderedTrees: unknown[] = []
const roots: Array<{ render: jest.Mock; unmount: jest.Mock }> = []

// 模块 mock 与 ChatView.cli-runtime.test.tsx 相同：ChatView 只需要能被构造，
// 这里测的是它把对话切换记进标签页历史的逻辑。

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

    async setState(): Promise<void> {}
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

import { ChatView } from './ChatView'

type HistoryEntry = {
  title: string
  state: { state: Record<string, unknown> }
}

type ConversationContext = {
  currentConversationId?: string
  currentConversationPersisted?: boolean
  currentConversationTitle?: string
}

type TestChatView = {
  recordConversationHistory(context: ConversationContext): void
  setState(state: unknown, result: { history: boolean }): Promise<void>
}

const createView = () => {
  const pushState = jest.fn((_entry: HistoryEntry) => {})
  const view = Object.create(ChatView.prototype) as TestChatView
  Object.assign(view, {
    plugin: { t: (_key: string, fallback: string) => fallback },
    leaf: {
      history: { pushState },
      getViewState: () => ({
        type: 'yolo-chat-view',
        state: {
          currentConversationId: 'current',
          currentConversationTitle: 'Current title',
        },
      }),
    },
    chatRef: { current: { loadConversation: jest.fn(async () => {}) } },
    isClosed: false,
    isApplyingPersistedViewState: false,
    shownConversation: null,
    historyTargetConversationId: undefined,
    displayTitle: '',
  })
  return { view, pushState }
}

const persisted = (id: string, title = id): ConversationContext => ({
  currentConversationId: id,
  currentConversationPersisted: true,
  currentConversationTitle: title,
})

describe('ChatView conversation navigation history', () => {
  it('records the conversation being left when switching to another one', () => {
    const { view, pushState } = createView()

    view.recordConversationHistory(persisted('a', 'A'))
    view.recordConversationHistory(persisted('b', 'B'))
    view.recordConversationHistory(persisted('c', 'C'))

    expect(pushState.mock.calls.map(([entry]) => entry.title)).toEqual([
      'A',
      'B',
    ])
    expect(pushState.mock.calls[0][0].state.state).toEqual({
      currentConversationId: 'a',
      currentConversationTitle: 'A',
    })
  })

  it('ignores context updates that keep the same conversation', () => {
    const { view, pushState } = createView()

    view.recordConversationHistory(persisted('a', 'A'))
    view.recordConversationHistory(persisted('a', 'A renamed'))

    expect(pushState).not.toHaveBeenCalled()
  })

  it('records the conversation left for a new chat, not the new chat itself', () => {
    const { view, pushState } = createView()

    view.recordConversationHistory(persisted('a', 'A'))
    view.recordConversationHistory({
      currentConversationId: 'new',
      currentConversationPersisted: false,
    })
    // 新对话发出第一条消息后落盘：同一个 id，不算一次离开
    view.recordConversationHistory(persisted('new', 'New'))

    expect(pushState.mock.calls.map(([entry]) => entry.title)).toEqual(['A'])
  })

  it('does not record again when back / forward brings a conversation back', async () => {
    const { view, pushState } = createView()
    view.recordConversationHistory(persisted('a', 'A'))
    view.recordConversationHistory(persisted('b', 'B'))
    pushState.mockClear()

    // Obsidian 后退：带着历史里的状态调 setState，随后对话切到 A
    await view.setState(
      { currentConversationId: 'a', currentConversationTitle: 'A' },
      { history: false },
    )
    view.recordConversationHistory(persisted('a', 'A'))

    expect(pushState).not.toHaveBeenCalled()

    // 之后用户自己再切走，照常记
    view.recordConversationHistory(persisted('c', 'C'))
    expect(pushState.mock.calls.map(([entry]) => entry.title)).toEqual(['A'])
  })

  it('does nothing when the tab history is unavailable', () => {
    const { view } = createView()
    Object.assign(view, { leaf: { getViewState: () => ({ state: {} }) } })

    expect(() => {
      view.recordConversationHistory(persisted('a'))
      view.recordConversationHistory(persisted('b'))
    }).not.toThrow()
  })
})
