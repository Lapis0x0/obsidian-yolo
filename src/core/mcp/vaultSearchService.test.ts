jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { RAGEngine } from '../rag/ragEngine'

import { runVaultSearch } from './vaultSearchService'

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
      tool: 'fs_search',
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
      } as unknown as YoloSettings,
      getRagEngine: async () =>
        ({ processQuery: jest.fn() }) as unknown as RAGEngine,
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
      tool: 'fs_search',
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
      } as unknown as YoloSettings,
      getRagEngine: async () =>
        ({
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
        }) as unknown as RAGEngine,
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
      tool: 'fs_search',
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
