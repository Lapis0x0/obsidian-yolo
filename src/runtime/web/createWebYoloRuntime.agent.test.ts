import { createWebYoloRuntime } from './createWebYoloRuntime'
import { WebApiClient } from './WebApiClient'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'

const mockGetJson = jest.fn()
const mockPostJson = jest.fn()
const mockOpenEventSource = jest.fn()

jest.mock('./obsidianCompat', () => {
  class App {}

  class TFolder {
    vault: unknown
    path: string
    name: string
    parent: TFolder | null = null
    children: Array<TFolder | TFile> = []

    constructor(vault: unknown, path: string) {
      this.vault = vault
      this.path = path
      this.name = path === '/' ? '/' : path.split('/').pop() || ''
    }
  }

  class TFile {
    vault: unknown
    path: string
    name: string
    basename: string
    extension: string
    parent: TFolder | null = null
    stat?: unknown

    constructor(vault: unknown, path: string) {
      this.vault = vault
      this.path = path
      this.name = path.split('/').pop() || ''
      this.extension = this.name.includes('.')
        ? this.name.split('.').pop() || ''
        : ''
      this.basename = this.extension
        ? this.name.slice(0, -(this.extension.length + 1))
        : this.name
    }
  }

  class Notice {
    constructor(_message: string, _timeout?: number) {}
  }

  return {
    App,
    TFile,
    TFolder,
    Notice,
    MarkdownView: class MarkdownView {},
    MarkdownRenderer: {},
    Platform: {
      isMacOS: false,
      isDesktopApp: true,
      isPhone: false,
      isIosApp: false,
    },
    Keymap: {
      isModEvent: () => false,
    },
    htmlToMarkdown: (html: string) => html,
    normalizePath: (path: string) => path.replace(/\\/g, '/'),
  }
})

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
  webSearch: {
    providers: [],
    common: {
      resultSize: 10,
      searchTimeoutMs: 120000,
      scrapeTimeoutMs: 20000,
    },
  },
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

describe('createWebYoloRuntime agent run state priming', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(globalThis as any).window = { dispatchEvent: jest.fn() }
    ;(globalThis as any).document = {
      body: { appendChild: jest.fn() },
      createElement: () => ({
        style: {},
        appendChild: jest.fn(),
        addEventListener: jest.fn(),
        remove: jest.fn(),
      }),
      getElementById: () => null,
    }
    ;(globalThis as any).requestAnimationFrame = (cb: Function) =>
      setTimeout(cb, 0)
  })

  afterEach(() => {
    delete (globalThis as any).window
    delete (globalThis as any).document
    delete (globalThis as any).requestAnimationFrame
  })

  it('stores conversationMessages and compaction before posting run request', async () => {
    mockPostJson.mockResolvedValue({ ok: true })

    const api = new WebApiClient('http://localhost:18789')
    const runtime = createWebYoloRuntime(
      api,
      {
        pluginInfo: {
          id: 'obsidian-yolo',
          name: 'YOLO',
          version: '1.5.7',
        },
        settings: minimalSettings,
        vaultName: 'Vault',
        activeFile: null,
        theme: {
          bodyClasses: [],
          htmlClasses: [],
          cssVariables: {},
        },
      },
      [],
    )

    await runtime.agent.run({
      conversationId: 'conv-1',
      messages: [{ role: 'user', content: 'request' } as any],
      conversationMessages: [{ role: 'user', content: 'visible' } as any],
      compaction: [{ summary: 's1' }] as any,
    })

    expect(runtime.agent.getState('conv-1')).toEqual(
      expect.objectContaining({
        conversationId: 'conv-1',
        status: 'running',
        messages: [{ role: 'user', content: 'visible' }],
        compaction: [{ summary: 's1' }],
      }),
    )
  })
})
