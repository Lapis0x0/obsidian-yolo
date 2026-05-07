import { WebApiClient } from './WebApiClient'
import { WebApiError } from './WebApiClient'
import { createWebYoloRuntime } from './createWebYoloRuntime'
import type { WebBootstrapPayload } from './createWebYoloRuntime'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { WebThemeSnapshot } from './webTheme'

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}))

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: {},
}))

jest.mock('turndown', () => ({
  __esModule: true,
  default: class MockTurndownService {
    turndown(html: string): string {
      return html
    }
  },
}))

// Minimal DOM mock for notice() test
const domById = new Map<string, any>()
beforeAll(() => {
  jest.useFakeTimers()
  ;(globalThis as any).requestAnimationFrame = (cb: Function) => setTimeout(cb, 0)
  const mockBody = { appendChild: jest.fn() }
  ;(globalThis as any).document = {
    body: mockBody,
    createElement: () => {
      const el: any = {
        id: '',
        style: {},
        remove: jest.fn(),
        addEventListener: jest.fn(),
        appendChild: jest.fn(),
      }
      // id assignment automatically registers in domById
      Object.defineProperty(el, 'id', {
        get: () => el._id || '',
        set: (v: string) => { el._id = v; domById.set(v, el) },
      })
      return el
    },
    getElementById: (id: string) => domById.get(id) || null,
  }
})

const mockGetJson = jest.fn()
const mockPostJson = jest.fn()
const mockOpenEventSource = jest.fn()

jest.mock('./WebApiClient', () => {
  const actual = jest.requireActual('./WebApiClient')
  return {
    ...actual,
    WebApiClient: jest.fn().mockImplementation(() => ({
      getJson: mockGetJson,
      postJson: mockPostJson,
      postArrayBuffer: jest.fn(),
      openEventSource: mockOpenEventSource,
    })),
  }
})

const minimalSettings = {
  version: 50 as const,
  providers: [],
  chatModels: [],
  embeddingModels: [],
  chatModelId: '',
  chatTitleModelId: '',
  embeddingModelId: '',
  systemPrompt: '',
  ragOptions: {
    enabled: true,
    chunkSize: 1000,
    thresholdTokens: 20000,
    minSimilarity: 0,
    limit: 10,
    excludePatterns: [],
    includePatterns: [],
    indexPdf: true,
    autoUpdateEnabled: true,
    autoUpdateIntervalHours: 0,
    lastAutoUpdateAt: 0,
  },
  mcp: { servers: [], builtinToolOptions: {} },
  webSearch: { providers: [], common: { resultSize: 10, searchTimeoutMs: 120000, scrapeTimeoutMs: 20000 } },
  skills: { disabledSkillIds: [] },
  yolo: { baseDir: 'YOLO' },
  chatOptions: { includeCurrentFileContent: true },
  continuationOptions: {},
  assistants: [],
  notificationOptions: {},
  debug: {},
  webRuntimeServer: {
    enabled: false,
    host: '127.0.0.1',
    port: 18789,
    serveStatic: true,
  },
  quickAskAssistantId: undefined,
  currentAssistantId: undefined,
} as unknown as SmartComposerSettings

const bootstrap: WebBootstrapPayload = {
  pluginInfo: {
    id: 'obsidian-yolo',
    name: 'YOLO',
    version: '1.5.7',
  },
  settings: minimalSettings,
  vaultName: 'Test Vault',
  activeFile: null,
  theme: {
    bodyClasses: ['theme-dark'],
    htmlClasses: ['theme-dark'],
    cssVariables: {
      '--background-primary': '#111111',
    },
  } satisfies WebThemeSnapshot,
}

// Mock window for ui.openSettings test
let mockDispatchEvent: jest.Mock

beforeAll(() => {
  mockDispatchEvent = jest.fn()
  ;(globalThis as any).window = {
    dispatchEvent: mockDispatchEvent,
  }
})

afterAll(() => {
  delete (globalThis as any).window
})

describe('createWebYoloRuntime', () => {
  let runtime: ReturnType<typeof createWebYoloRuntime>
  const api = new WebApiClient('http://localhost:18789')

  beforeEach(() => {
    jest.clearAllMocks()
    runtime = createWebYoloRuntime(api, bootstrap, [])
  })

  describe('pluginInfo', () => {
    it('returns the bootstrap plugin info', () => {
      expect(runtime.pluginInfo).toEqual({
        id: 'obsidian-yolo',
        name: 'YOLO',
        version: '1.5.7',
      })
    })
  })

  describe('settings', () => {
    it('get() returns current settings', () => {
      expect(runtime.settings.get()).toBe(bootstrap.settings)
    })

    it('update() sends POST to /api/settings/update', async () => {
      mockPostJson.mockResolvedValue({ ...minimalSettings, chatModelId: 'gpt-5' })

      await runtime.settings.update({ ...minimalSettings, chatModelId: 'gpt-5' })

      expect(mockPostJson).toHaveBeenCalledWith('/api/settings/update', {
        ...minimalSettings,
        chatModelId: 'gpt-5',
      })
    })

    it('subscribe() notifies listeners after settings update', async () => {
      const listener = jest.fn()
      const newSettings = { ...minimalSettings, chatModelId: 'claude-4' }
      mockPostJson.mockResolvedValue(newSettings)

      runtime.settings.subscribe(listener)
      await runtime.settings.update(newSettings)

      expect(listener).toHaveBeenCalledWith(newSettings)
    })

    it('subscribe() returns an unsubscribe function', () => {
      const listener = jest.fn()
      const unsubscribe = runtime.settings.subscribe(listener)
      expect(typeof unsubscribe).toBe('function')
    })
  })

  describe('chat', () => {
    it('list() calls GET /api/chat/list', async () => {
      mockGetJson.mockResolvedValue([{ id: '1', title: 'Chat 1' }])

      const result = await runtime.chat.list()

      expect(mockGetJson).toHaveBeenCalledWith('/api/chat/list')
      expect(result).toEqual([{ id: '1', title: 'Chat 1' }])
    })

    it('get() calls GET /api/chat/get/:id', async () => {
      mockGetJson.mockResolvedValue({ id: 'abc', title: 'Test' })

      const result = await runtime.chat.get('abc')

      expect(mockGetJson).toHaveBeenCalledWith('/api/chat/get/abc')
      expect(result).toEqual({ id: 'abc', title: 'Test' })
    })

    it('get() returns null on 404', async () => {
      mockGetJson.mockRejectedValue(
        new WebApiError('GET', '/api/chat/get/missing', 404),
      )

      await expect(runtime.chat.get('missing')).resolves.toBeNull()
    })

    it('save() calls POST /api/chat/save', async () => {
      mockPostJson.mockResolvedValue({ ok: true })

      await runtime.chat.save({ id: 'abc', messages: [] })

      expect(mockPostJson).toHaveBeenCalledWith('/api/chat/save', {
        id: 'abc',
        messages: [],
      })
    })

    it('delete() calls POST /api/chat/delete', async () => {
      mockPostJson.mockResolvedValue({ ok: true })

      await runtime.chat.delete('abc')

      expect(mockPostJson).toHaveBeenCalledWith('/api/chat/delete', { id: 'abc' })
    })

    it('togglePinned() calls POST /api/chat/toggle-pinned', async () => {
      mockPostJson.mockResolvedValue({ ok: true })

      await runtime.chat.togglePinned('abc')

      expect(mockPostJson).toHaveBeenCalledWith('/api/chat/toggle-pinned', {
        id: 'abc',
      })
    })

    it('updateTitle() calls POST /api/chat/update-title', async () => {
      mockPostJson.mockResolvedValue({ ok: true })

      await runtime.chat.updateTitle('abc', 'Renamed', {
        touchUpdatedAt: false,
      })

      expect(mockPostJson).toHaveBeenCalledWith('/api/chat/update-title', {
        id: 'abc',
        title: 'Renamed',
        touchUpdatedAt: false,
      })
    })
  })

  describe('agent', () => {
    it('run() calls POST /api/agent/run', async () => {
      mockPostJson.mockResolvedValue({ ok: true })

      await runtime.agent.run({
        conversationId: 'conv-1',
        messages: [],
      })

      expect(mockPostJson).toHaveBeenCalledWith('/api/agent/run', {
        conversationId: 'conv-1',
        messages: [],
      })
    })

    it('abort() calls POST /api/agent/abort/:id', async () => {
      mockPostJson.mockResolvedValue({ ok: true })

      await runtime.agent.abort('conv-1')

      expect(mockPostJson).toHaveBeenCalledWith('/api/agent/abort/conv-1', {})
    })

    it('approveToolCall() calls POST /api/agent/approve-tool-call', async () => {
      mockPostJson.mockResolvedValue({ ok: true })

      const result = await runtime.agent.approveToolCall({
        conversationId: 'conv-1',
        toolCallId: 'tc-1',
      })

      expect(mockPostJson).toHaveBeenCalledWith(
        '/api/agent/approve-tool-call',
        { conversationId: 'conv-1', toolCallId: 'tc-1' },
      )
      expect(result).toBe(true)
    })

    it('rejectToolCall() calls POST /api/agent/reject-tool-call', () => {
      runtime.agent.rejectToolCall({
        conversationId: 'conv-1',
        toolCallId: 'tc-1',
      })

      expect(mockPostJson).toHaveBeenCalledWith(
        '/api/agent/reject-tool-call',
        { conversationId: 'conv-1', toolCallId: 'tc-1' },
      )
    })

    it('abortToolCall() calls POST /api/agent/abort-tool-call', () => {
      runtime.agent.abortToolCall({
        conversationId: 'conv-1',
        toolCallId: 'tc-1',
      })

      expect(mockPostJson).toHaveBeenCalledWith(
        '/api/agent/abort-tool-call',
        { conversationId: 'conv-1', toolCallId: 'tc-1' },
      )
    })

    it('subscribe() opens EventSource and passes parsed state to listener', () => {
      const mockEs = {
        addEventListener: jest.fn(),
        close: jest.fn(),
      }
      mockOpenEventSource.mockReturnValue(mockEs)
      const listener = jest.fn()

      const unsubscribe = runtime.agent.subscribe('conv-1', listener)

      expect(mockEs.addEventListener).toHaveBeenCalledWith(
        'state',
        expect.any(Function),
      )

      const stateHandler = mockEs.addEventListener.mock.calls.find(
        (call: any[]) => call[0] === 'state',
      )![1]
      const fakeEvent = { data: JSON.stringify({ status: 'running', conversationId: 'conv-1' }) }
      stateHandler(fakeEvent)

      expect(listener).toHaveBeenCalledWith({
        status: 'running',
        conversationId: 'conv-1',
      })

      unsubscribe()
      expect(mockEs.close).toHaveBeenCalled()
    })
  })

  describe('vault', () => {
    it('getActiveFile() returns null', () => {
      expect(runtime.vault.getActiveFile()).toBeNull()
    })

    it('read() calls GET /api/vault/read', async () => {
      mockGetJson.mockResolvedValue({ content: 'file content' })

      const result = await runtime.vault.read('/test/file.md')

      expect(mockGetJson).toHaveBeenCalledWith(
        '/api/vault/read?path=test%2Ffile.md',
      )
      expect(result).toEqual('file content')
    })

    it('search() calls GET /api/vault/search', async () => {
      mockGetJson.mockResolvedValue([{ path: '/test/file.md', name: 'file.md' }])

      const result = await runtime.vault.search('test')

      expect(mockGetJson).toHaveBeenCalledWith('/api/vault/search?query=test')
      expect(result).toEqual([{ path: '/test/file.md', name: 'file.md' }])
    })
  })

  describe('ui', () => {
    it('notice() appends to body without throwing', () => {
      expect(() => runtime.ui.notice('Hello')).not.toThrow()
    })

    it('openSettings() dispatches a custom event', () => {
      runtime.ui.openSettings()

      expect(mockDispatchEvent).toHaveBeenCalledWith(
        new CustomEvent('yolo:web-open-settings'),
      )
    })
  })
})
