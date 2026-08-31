jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { AssistantWorkspaceScope } from '../../types/assistant.types'
import type { RagKnowledgeAccess } from '../rag/ragAccess'
import type { RAGEngine } from '../rag/ragEngine'

import { runVaultSearch } from './vaultSearchService'

// A single-knowledge-base stub: enough for `runVaultSearchStructured`'s
// no-`knowledgeBase`-argument merge path to find one base and query it.
const ragAccessOf = (engine: unknown): RagKnowledgeAccess => ({
  listKnowledgeBases: () => [
    { id: 'kb-a', name: 'kb-a', description: '', include: [], exclude: [] },
  ],
  getRagEngine: async () => engine as RAGEngine,
})

describe('runVaultSearch', () => {
  it('defaults to hybrid and falls back to keyword with an explicit reason', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue([file]),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue([file]),
        },
      } as unknown as App,
      args: {
        scope: 'files',
        query: 'note',
      },
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'vault_search',
      requestedMode: 'hybrid',
      effectiveMode: 'keyword',
      fallbackReason: 'Semantic search is not available in this context.',
      scope: 'files',
      query: 'note',
      path: '',
      results: [{ kind: 'file', path: 'note.md', source: 'keyword' }],
    })
  })

  it('keeps explicit rag strict when semantic search is unavailable', async () => {
    const root = Object.assign(new TFolder(), { path: '' })

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
        },
      } as unknown as App,
      args: {
        mode: 'rag',
        query: 'note',
      },
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error).toBe(
        'Semantic search is not available in this context.',
      )
    }
  })

  it('falls back to keyword when the configured embedding model no longer exists', async () => {
    // Stale reference: the settings' embeddingModelId still points at a
    // model id that was since removed from embeddingModels (e.g. its
    // provider was deleted). Semantic search must not silently query with a
    // model that no longer resolves — it should fall back to keyword with a
    // reason that says so, not claim the vault has no knowledge bases.
    const root = Object.assign(new TFolder(), { path: '' })
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const getRagEngine = jest.fn()

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue([file]),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue([file]),
        },
      } as unknown as App,
      settings: {
        ragOptions: { enabled: true, limit: 10 },
        embeddingModelId: 'deleted-model',
        embeddingModels: [{ id: 'some-other-model' }],
      } as unknown as YoloSettings,
      ragAccess: {
        listKnowledgeBases: () => [
          {
            id: 'kb-a',
            name: 'kb-a',
            description: '',
            include: [],
            exclude: [],
          },
        ],
        getRagEngine,
      },
      args: {
        scope: 'files',
        query: 'note',
      },
    })

    expect(getRagEngine).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error('expected success')
    }
    const parsed = JSON.parse(result.text) as {
      effectiveMode: string
      fallbackReason: string
    }
    expect(parsed.effectiveMode).toBe('keyword')
    expect(parsed.fallbackReason).toBe(
      'The configured embedding model no longer exists. Fell back to keyword search.',
    )
  })

  it('rejects rag mode scoped to files or dirs', async () => {
    const root = Object.assign(new TFolder(), { path: '' })

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
        },
      } as unknown as App,
      settings: {
        ragOptions: { enabled: true, limit: 10 },
        embeddingModelId: 'test-embedding',
        embeddingModels: [{ id: 'test-embedding' }],
      } as unknown as YoloSettings,
      ragAccess: ragAccessOf({ processQuery: jest.fn() }),
      args: {
        mode: 'rag',
        scope: 'files',
        query: 'note',
      },
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error).toMatch(/rag mode only supports content search/)
    }
  })

  it('matches keyword file search by whitespace-separated tokens instead of full query string', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const files = [
      Object.assign(new TFile(), {
        path: '2.工作/3.工作流专项/1月/✅ 0109 Workflow 体系总览.md',
        stat: { size: 20 },
      }),
      Object.assign(new TFile(), {
        path: '2.工作/3.工作流专项/2月/✅ 0210 工作流复盘模块项目规划.md',
        stat: { size: 20 },
      }),
      Object.assign(new TFile(), {
        path: '2.工作/普通项目/普通笔记.md',
        stat: { size: 20 },
      }),
    ]

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue(files),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue(files),
        },
      } as unknown as App,
      args: {
        mode: 'keyword',
        scope: 'files',
        query: 'workflow 工作流程 工作流',
        maxResults: 10,
      },
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'vault_search',
      requestedMode: 'keyword',
      effectiveMode: 'keyword',
      scope: 'files',
      query: 'workflow 工作流程 工作流',
      path: '',
      results: [
        {
          kind: 'file',
          path: '2.工作/3.工作流专项/1月/✅ 0109 Workflow 体系总览.md',
          source: 'keyword',
        },
        {
          kind: 'file',
          path: '2.工作/3.工作流专项/2月/✅ 0210 工作流复盘模块项目规划.md',
          source: 'keyword',
        },
      ],
    })
  })

  it('excludes the YOLO user data root from keyword file and dir results', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const dataFolder = Object.assign(new TFolder(), { path: 'YOLO/data' })
    const files = [
      Object.assign(new TFile(), {
        path: 'YOLO/data/chats/v1_report.json',
        stat: { size: 20 },
      }),
      Object.assign(new TFile(), {
        path: 'Notes/report.md',
        stat: { size: 20 },
      }),
    ]

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue(files),
          getAllLoadedFiles: jest.fn().mockReturnValue([root, dataFolder]),
          getMarkdownFiles: jest.fn().mockReturnValue(files),
          read: jest.fn().mockResolvedValue(''),
        },
      } as unknown as App,
      settings: { yolo: { baseDir: 'YOLO' } } as unknown as YoloSettings,
      args: {
        mode: 'keyword',
        scope: 'all',
        query: 'report',
        maxResults: 10,
      },
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error('expected success')
    }

    const payload = JSON.parse(result.text) as {
      results: Array<{ kind: string; path: string }>
    }
    expect(payload.results).toEqual([
      { kind: 'file', path: 'Notes/report.md', source: 'keyword' },
    ])
  })

  it('ranks keyword content hits by matched token count before file path', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const fileA = Object.assign(new TFile(), {
      path: 'a.md',
      stat: { size: 200 },
    })
    const fileB = Object.assign(new TFile(), {
      path: 'b.md',
      stat: { size: 200 },
    })

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue([fileA, fileB]),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue([fileA, fileB]),
          read: jest
            .fn()
            .mockImplementation(async (file: TFile) =>
              file.path === 'a.md'
                ? 'workflow 工作流 双命中'
                : '只有 workflow 单命中',
            ),
        },
      } as unknown as App,
      args: {
        mode: 'keyword',
        scope: 'content',
        query: 'workflow 工作流',
        maxResults: 10,
      },
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toMatchObject({
      results: [
        {
          kind: 'content_group',
          path: 'a.md',
          hitCount: 1,
        },
        {
          kind: 'content_group',
          path: 'b.md',
          hitCount: 1,
        },
      ],
    })
  })

  it('aggregates hybrid content hits by file and keeps top snippets', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const fileA = Object.assign(new TFile(), {
      path: 'workflow-a.md',
      stat: { size: 200 },
    })
    const fileB = Object.assign(new TFile(), {
      path: 'workflow-b.md',
      stat: { size: 200 },
    })

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue([fileA, fileB]),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue([fileA, fileB]),
          read: jest
            .fn()
            .mockImplementation(async (file: TFile) =>
              file.path === 'workflow-a.md'
                ? 'workflow intro\nother line\nworkflow appendix'
                : 'nothing relevant here',
            ),
        },
      } as unknown as App,
      settings: {
        ragOptions: {
          enabled: true,
          limit: 10,
        },
        embeddingModelId: 'test-embedding',
        embeddingModels: [{ id: 'test-embedding' }],
      } as unknown as YoloSettings,
      ragAccess: ragAccessOf({
        processQuery: jest.fn().mockResolvedValue([
          {
            path: 'workflow-a.md',
            content: 'workflow intro chunk',
            metadata: { startLine: 1, endLine: 2 },
            similarity: 0.91,
          },
          {
            path: 'workflow-b.md',
            content: 'workflow b chunk',
            metadata: { startLine: 3, endLine: 4 },
            similarity: 0.89,
          },
          {
            path: 'workflow-a.md',
            content: 'workflow appendix chunk',
            metadata: { startLine: 10, endLine: 12 },
            similarity: 0.82,
          },
        ]),
      }),
      args: {
        mode: 'hybrid',
        query: 'workflow',
        maxResults: 10,
      },
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toMatchObject({
      tool: 'vault_search',
      requestedMode: 'hybrid',
      effectiveMode: 'hybrid',
      scope: 'content',
      query: 'workflow',
      path: '',
      results: [
        {
          kind: 'content_group',
          path: 'workflow-a.md',
          source: 'hybrid',
          hitCount: 2,
          snippets: [
            { startLine: 1, endLine: 2 },
            { startLine: 10, endLine: 12 },
          ],
        },
        {
          kind: 'content_group',
          path: 'workflow-b.md',
          source: 'hybrid',
          hitCount: 1,
          snippets: [{ startLine: 3, endLine: 4 }],
        },
      ],
    })
  })

  it('dedupes the same chunk returned by two overlapping knowledge bases before truncating to the limit', async () => {
    // kb-a and kb-b both cover 'shared/dup.md' (e.g. one base's include
    // folder nests inside the other's), so an unscoped `vault_search` query
    // gets the identical highest-similarity row back from both engines. Each
    // base also has one lower-similarity chunk the other doesn't index.
    //
    // `ragOptions.limit` is 3 and there are 3 truly distinct chunks (dup,
    // only-a, only-b). If the merge truncates to the limit *before*
    // deduping, the duplicate eats a second slot and `only-b` (the lowest
    // similarity, sorted last) gets dropped even though it should have made
    // the cut. Deduping first keeps all three.
    const root = Object.assign(new TFolder(), { path: '' })
    const dupChunk = {
      path: 'shared/dup.md',
      content: 'duplicated chunk content',
      metadata: { startLine: 5, endLine: 8 },
      similarity: 0.9,
    }
    const ragAccess: RagKnowledgeAccess = {
      listKnowledgeBases: () => [
        { id: 'kb-a', name: 'kb-a', description: '', include: [], exclude: [] },
        { id: 'kb-b', name: 'kb-b', description: '', include: [], exclude: [] },
      ],
      getRagEngine: async (kbId: string) =>
        ({
          processQuery: jest.fn().mockResolvedValue(
            kbId === 'kb-a'
              ? [
                  dupChunk,
                  {
                    path: 'only-a.md',
                    content: 'only in kb-a',
                    metadata: { startLine: 1, endLine: 2 },
                    similarity: 0.85,
                  },
                ]
              : [
                  dupChunk,
                  {
                    path: 'only-b.md',
                    content: 'only in kb-b',
                    metadata: { startLine: 1, endLine: 2 },
                    similarity: 0.8,
                  },
                ],
          ),
        }) as unknown as RAGEngine,
    }

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
        },
      } as unknown as App,
      settings: {
        ragOptions: { enabled: true, limit: 3 },
        embeddingModelId: 'test-embedding',
        embeddingModels: [{ id: 'test-embedding' }],
      } as unknown as YoloSettings,
      ragAccess,
      args: {
        mode: 'rag',
        query: 'dup',
        maxResults: 10,
      },
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') {
      throw new Error('expected success')
    }

    const parsed = JSON.parse(result.text) as {
      results: Array<{ path: string; hitCount?: number }>
    }
    expect(parsed.results.map((r) => r.path).sort()).toEqual([
      'only-a.md',
      'only-b.md',
      'shared/dup.md',
    ])
    const dupGroup = parsed.results.find((r) => r.path === 'shared/dup.md')
    expect(dupGroup).toMatchObject({ hitCount: 1 })
  })

  it('passes the assistant workspace scope through to the RAG query, intersected with the requested path', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const workspaceScope: AssistantWorkspaceScope = {
      enabled: true,
      include: ['Notes'],
      exclude: [],
    }
    const processQuery = jest.fn().mockResolvedValue([])

    await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
        },
      } as unknown as App,
      settings: {
        yolo: { baseDir: 'YOLO' },
        ragOptions: { enabled: true, limit: 10 },
        embeddingModelId: 'test-embedding',
        embeddingModels: [{ id: 'test-embedding' }],
      } as unknown as YoloSettings,
      ragAccess: ragAccessOf({ processQuery }),
      workspaceScope,
      args: { mode: 'rag', query: 'note' },
    })

    expect(processQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          files: ['Notes'],
          folders: ['Notes'],
          exclude: ['YOLO/data'],
        },
      }),
    )
  })

  it('short-circuits to an empty RAG result without querying when the path scope and workspace scope share no path', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const dirFolder = Object.assign(new TFolder(), { path: 'Private' })
    const workspaceScope: AssistantWorkspaceScope = {
      enabled: true,
      include: ['Notes'],
      exclude: [],
    }
    const processQuery = jest.fn()

    const result = await runVaultSearch({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getAbstractFileByPath: jest.fn().mockReturnValue(dirFolder),
        },
      } as unknown as App,
      settings: {
        yolo: { baseDir: 'YOLO' },
        ragOptions: { enabled: true, limit: 10 },
        embeddingModelId: 'test-embedding',
        embeddingModels: [{ id: 'test-embedding' }],
      } as unknown as YoloSettings,
      ragAccess: ragAccessOf({ processQuery }),
      workspaceScope,
      args: { mode: 'rag', query: 'note', path: 'Private' },
    })

    expect(processQuery).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(JSON.parse(result.text)).toMatchObject({ results: [] })
    }
  })

  it('returns aborted immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await runVaultSearch({
      app: { vault: {} } as unknown as App,
      args: { query: 'note' },
      signal: controller.signal,
    })

    expect(result.status).toBe('aborted')
  })

  it('surfaces argument validation errors', async () => {
    const result = await runVaultSearch({
      app: { vault: {} } as unknown as App,
      args: { mode: 'not-a-mode' },
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.error).toMatch(/mode must be one of/)
    }
  })
})
