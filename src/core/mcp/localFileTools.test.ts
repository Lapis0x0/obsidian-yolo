jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'
import type { RAGEngine } from '../rag/ragEngine'

import {
  callLocalFileTool,
  getLocalFileTools,
  isLocalFsWriteToolName,
  parseLocalFsActionFromToolArgs,
  recoverLikelyEscapedBackslashSequences,
} from './localFileTools'

afterEach(() => {
  editUndoSnapshotStore.clear()
})

describe('recoverLikelyEscapedBackslashSequences', () => {
  it('recovers latex commands decoded as control characters', () => {
    const broken = `A=${'\b'}egin{bmatrix}1 & 2${'\t'}imes y`
    const recovered = recoverLikelyEscapedBackslashSequences(broken)

    expect(recovered).toContain('\\begin{bmatrix}')
    expect(recovered).toContain('\\times y')
  })

  it('keeps intended newline and tab characters unchanged when not command-like', () => {
    const input = 'line1\n\nline2\t42'
    const recovered = recoverLikelyEscapedBackslashSequences(input)

    expect(recovered).toBe(input)
  })
})

describe('local fs tool action helpers', () => {
  it('parses split file-op tools to fs actions', () => {
    expect(
      parseLocalFsActionFromToolArgs({
        toolName: 'fs_create_file',
        args: { path: 'a.md', content: 'x' },
      }),
    ).toBe('create_file')
    expect(
      parseLocalFsActionFromToolArgs({
        toolName: 'fs_delete_dir',
        args: { path: 'tmp', recursive: true },
      }),
    ).toBe('delete_dir')
  })

  it('recognizes write tool names with local prefixes', () => {
    expect(isLocalFsWriteToolName('fs_edit')).toBe(true)
    expect(isLocalFsWriteToolName('yolo_local__fs_move')).toBe(true)
    expect(isLocalFsWriteToolName('yolo_local__fs_read')).toBe(false)
  })

  it('routes fs_edit approval through apply review', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({ finalContent: 'hello changed' })
      return true
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      openApplyReview,
      toolCallId: 'tool-call-1',
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        operation: {
          type: 'replace',
          oldText: 'world',
          newText: 'changed',
        },
      },
      requireReview: true,
    })

    expect(openApplyReview).toHaveBeenCalledTimes(1)
    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(editUndoSnapshotStore.get('tool-call-1', 'note.md')).toMatchObject({
      beforeContent: 'hello world',
      afterContent: 'hello changed',
    })
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 1,
      totalRemovedLines: 1,
      undoStatus: 'available',
    })
  })

  it('treats fs_edit review close as abort without persisting', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onCancel?.()
      return true
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      openApplyReview,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        operation: {
          type: 'replace',
          oldText: 'world',
          newText: 'changed',
        },
      },
      requireReview: true,
    })

    expect(openApplyReview).toHaveBeenCalledTimes(1)
    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe('aborted')
  })

  it('rejects the removed fs_edit operations array shape', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        operations: [
          {
            type: 'replace',
            oldText: 'world',
            newText: 'changed',
          },
        ],
      },
    })

    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('operation must be a nested JSON object')
    }
  })

  it('supports fs_edit replace_lines operations', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue(['one', 'two', 'three'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        operation: {
          type: 'replace_lines',
          startLine: 2,
          endLine: 3,
          newText: ['dos', 'tres'].join('\n'),
        },
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(modify).toHaveBeenCalledWith(file, ['one', 'dos', 'tres'].join('\n'))
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 2,
      totalRemovedLines: 2,
    })
  })

  it('returns edit summary metadata for fs_create_file', async () => {
    const create = jest.fn()

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create,
          createFolder: jest.fn(),
        },
      } as unknown as App,
      toolCallId: 'tool-call-create-1',
      toolName: 'fs_create_file',
      args: {
        path: 'note.md',
        content: ['one', 'two'].join('\n'),
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(create).toHaveBeenCalledWith('note.md', ['one', 'two'].join('\n'))
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 2,
      totalRemovedLines: 0,
      files: [{ operation: 'create' }],
    })
    expect(
      editUndoSnapshotStore.get('tool-call-create-1', 'note.md'),
    ).toMatchObject({
      beforeExists: false,
      afterExists: true,
    })
  })

  it('returns edit summary metadata for fs_delete_file', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const read = jest.fn().mockResolvedValue(['one', 'two'].join('\n'))
    const trashFile = jest.fn()

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
        fileManager: {
          trashFile,
        },
      } as unknown as App,
      toolCallId: 'tool-call-delete-1',
      toolName: 'fs_delete_file',
      args: {
        path: 'note.md',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(trashFile).toHaveBeenCalledWith(file)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 0,
      totalRemovedLines: 2,
      files: [{ operation: 'delete' }],
    })
    expect(
      editUndoSnapshotStore.get('tool-call-delete-1', 'note.md'),
    ).toMatchObject({
      beforeExists: true,
      afterExists: false,
    })
  })

  it('supports fs_read full operation', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const read = jest.fn().mockResolvedValue(['one', 'two', 'three'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
      } as unknown as App,
      toolCallId: 'read-call-1',
      toolName: 'fs_read',
      args: {
        paths: ['note.md'],
        operation: {
          type: 'full',
        },
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      toolCallId: string | null
      requestedOperation: { type: string }
      results: Array<{
        ok: boolean
        content: string
        returnedRange: { startLine: number | null; endLine: number | null }
      }>
    }
    expect(payload.toolCallId).toBe('read-call-1')
    expect(payload.requestedOperation.type).toBe('full')
    expect(payload.results[0]).toMatchObject({
      ok: true,
      content: ['1|one', '2|two', '3|three'].join('\n'),
      returnedRange: {
        startLine: 1,
        endLine: 3,
      },
    })
  })

  it('returns full fs_read content without internal character truncation', async () => {
    const longLine = 'a'.repeat(25_000)
    const file = Object.assign(new TFile(), {
      path: 'long-note.md',
      stat: { size: longLine.length },
    })
    const read = jest.fn().mockResolvedValue(longLine)

    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
      } as unknown as App,
      toolName: 'fs_read',
      args: {
        paths: ['long-note.md'],
        operation: {
          type: 'full',
        },
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    const payload = JSON.parse(result.text) as {
      requestedOperation: { type: string }
      results: Array<{
        ok: boolean
        content: string
      }>
    }

    expect(payload.requestedOperation).toMatchObject({ type: 'full' })
    expect(payload.results[0]).toMatchObject({
      ok: true,
      content: `1|${longLine}`,
    })
  })

  it('supports fs_read lines operation with numbered output', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 40 },
    })
    const read = jest
      .fn()
      .mockResolvedValue(['one', 'two', 'three', 'four'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
      } as unknown as App,
      toolName: 'fs_read',
      args: {
        paths: ['note.md'],
        operation: {
          type: 'lines',
          startLine: 2,
          maxLines: 2,
        },
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      toolCallId: string | null
      requestedOperation: {
        type: string
        startLine: number | null
        maxLines: number | null
      }
      results: Array<{
        ok: boolean
        content: string
        hasMoreAbove: boolean
        hasMoreBelow: boolean
        nextStartLine: number | null
      }>
    }
    expect(payload.toolCallId).toBeNull()
    expect(payload.requestedOperation).toMatchObject({
      type: 'lines',
      startLine: 2,
      maxLines: 2,
    })
    expect(payload.results[0]).toMatchObject({
      ok: true,
      content: ['2|two', '3|three'].join('\n'),
      hasMoreAbove: true,
      hasMoreBelow: true,
      nextStartLine: 4,
    })
  })

  it('rejects removed top-level fs_read line arguments', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const read = jest.fn().mockResolvedValue('one\ntwo')

    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
      } as unknown as App,
      toolName: 'fs_read',
      args: {
        paths: ['note.md'],
        startLine: 1,
        maxLines: 2,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('operation must be a nested JSON object')
    }
  })

  it('defaults fs_search to hybrid and falls back to keyword with explicit reason', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue([file]),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue([file]),
        },
      } as unknown as App,
      toolName: 'fs_search',
      args: {
        scope: 'files',
        query: 'note',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
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

    const result = await callLocalFileTool({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
        },
      } as unknown as App,
      toolName: 'fs_search',
      args: {
        mode: 'rag',
        query: 'note',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain(
        'Semantic search is not available in this context.',
      )
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

    const result = await callLocalFileTool({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue(files),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue(files),
        },
      } as unknown as App,
      toolName: 'fs_search',
      args: {
        mode: 'keyword',
        scope: 'files',
        query: 'workflow 工作流程 工作流',
        maxResults: 10,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
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

    const result = await callLocalFileTool({
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
      toolName: 'fs_search',
      args: {
        mode: 'keyword',
        scope: 'content',
        query: 'workflow 工作流',
        maxResults: 10,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
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

    const result = await callLocalFileTool({
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
      } as unknown as SmartComposerSettings,
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
      toolName: 'fs_search',
      args: {
        mode: 'hybrid',
        query: 'workflow',
        maxResults: 10,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
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

  it('supports context prune tool results for any successful text tool output', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'edit-1',
                name: 'yolo_local__fs_edit',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
      ],
      args: {
        toolCallIds: [' edit-1 ', 'read-2', 'edit-1'],
        reason: 'superseded by newer reads',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-1',
      operation: 'prune_selected',
      acceptedToolCallIds: ['edit-1'],
      ignoredToolCallIds: ['read-2'],
      reason: 'superseded by newer reads',
    })
  })

  it('ignores tool results from the same tool message as prune', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-history',
          toolCalls: [
            {
              request: {
                id: 'edit-history',
                name: 'yolo_local__fs_edit',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-message-current',
          toolCalls: [
            {
              request: {
                id: 'edit-current',
                name: 'server__tool_a',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'prune-1',
                name: 'yolo_local__context_prune_tool_results',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Running,
              },
            },
          ],
        },
      ],
      args: {
        toolCallIds: ['edit-history', 'edit-current'],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-1',
      operation: 'prune_selected',
      acceptedToolCallIds: ['edit-history'],
      ignoredToolCallIds: ['edit-current'],
      reason: null,
    })
  })

  it('only accepts successful text non-control tool results for pruning', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'search-success',
                name: 'yolo_local__fs_search',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'edit-error',
                name: 'yolo_local__fs_edit',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Error,
                error: 'missing file',
              },
            },
            {
              request: {
                id: 'remote-aborted',
                name: 'server__tool_a',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Aborted,
              },
            },
            {
              request: {
                id: 'compact-success',
                name: 'yolo_local__context_compact',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
      ],
      args: {
        toolCallIds: [
          'search-success',
          'edit-error',
          'remote-aborted',
          'compact-success',
        ],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-1',
      operation: 'prune_selected',
      acceptedToolCallIds: ['search-success'],
      ignoredToolCallIds: ['edit-error', 'remote-aborted', 'compact-success'],
      reason: null,
    })
  })

  it('supports pruning all prunable tool results at once', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-all-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'search-1',
                name: 'yolo_local__fs_search',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'remote-1',
                name: 'server__tool_a',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
      ],
      args: {
        mode: 'all',
        reason: 'reset working set',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-all-1',
      operation: 'prune_all',
      acceptedToolCallIds: ['search-1', 'remote-1'],
      ignoredToolCallIds: [],
      reason: 'reset working set',
    })
  })

  it('returns success with empty accepted ids when mode is all and nothing is prunable', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-all-empty-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
      ],
      args: {
        mode: 'all',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-all-empty-1',
      operation: 'prune_all',
      acceptedToolCallIds: [],
      ignoredToolCallIds: [],
      reason: null,
    })
  })

  it('requires toolCallIds when mode is selected', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-selected-empty-1',
      toolName: 'context_prune_tool_results',
      args: {
        mode: 'selected',
        toolCallIds: [],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain(
        'toolCallIds cannot be empty when mode is selected.',
      )
    }
  })

  it('supports context compact control operation', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'compact-1',
      toolName: 'context_compact',
      args: {
        reason: 'context window is crowded',
        instruction: 'preserve pending edits and file paths',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_compact',
      toolCallId: 'compact-1',
      operation: 'compact_restart',
      reason: 'context window is crowded',
      instruction: 'preserve pending edits and file paths',
    })
  })

  it('handles memory tools through local tool dispatcher', async () => {
    const entries = new Map<string, unknown>()
    const contents = new Map<string, string>()

    const app = {
      vault: {
        getAbstractFileByPath: jest
          .fn()
          .mockImplementation((path: string) => entries.get(path) ?? null),
        createFolder: jest.fn().mockImplementation(async (path: string) => {
          const folder = Object.assign(new TFolder(), {
            path,
            children: [],
          })
          entries.set(path, folder)
          return folder
        }),
        create: jest
          .fn()
          .mockImplementation(async (path: string, content: string) => {
            const file = Object.assign(new TFile(), {
              path,
              stat: { size: content.length },
            })
            entries.set(path, file)
            contents.set(path, content)
            return file
          }),
        read: jest
          .fn()
          .mockImplementation(
            async (file: TFile) => contents.get(file.path) ?? '',
          ),
        modify: jest
          .fn()
          .mockImplementation(async (file: TFile, content: string) => {
            contents.set(file.path, content)
            ;(file as { stat?: { size?: number } }).stat = {
              size: content.length,
            }
          }),
      },
    } as unknown as App

    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: 'Helper Agent',
          systemPrompt: 'You are helper.',
        },
      ],
    } as never

    const addResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_add',
      args: {
        content: '用户希望回答保持简洁',
        category: 'preferences',
      },
    })
    expect(addResult.status).toBe('success')
    const assistantMemoryPath = 'YOLO/memory/Helper Agent.md'
    expect(contents.get(assistantMemoryPath) ?? '').toContain(
      'Preference_1: 用户希望回答保持简洁',
    )

    const updateResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_update',
      args: {
        id: 'Preference_1',
        new_content: '用户希望回答保持简洁并直接',
      },
    })
    expect(updateResult.status).toBe('success')

    const deleteResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_delete',
      args: {
        id: 'Preference_1',
      },
    })
    expect(deleteResult.status).toBe('success')
    expect(contents.get(assistantMemoryPath) ?? '').not.toContain(
      'Preference_1',
    )
  })

  it('supports partial-success batch add and delete for memory tools', async () => {
    const entries = new Map<string, unknown>()
    const contents = new Map<string, string>()

    const app = {
      vault: {
        getAbstractFileByPath: jest
          .fn()
          .mockImplementation((path: string) => entries.get(path) ?? null),
        createFolder: jest.fn().mockImplementation(async (path: string) => {
          const folder = Object.assign(new TFolder(), {
            path,
            children: [],
          })
          entries.set(path, folder)
          return folder
        }),
        create: jest
          .fn()
          .mockImplementation(async (path: string, content: string) => {
            const file = Object.assign(new TFile(), {
              path,
              stat: { size: content.length },
            })
            entries.set(path, file)
            contents.set(path, content)
            return file
          }),
        read: jest
          .fn()
          .mockImplementation(
            async (file: TFile) => contents.get(file.path) ?? '',
          ),
        modify: jest
          .fn()
          .mockImplementation(async (file: TFile, content: string) => {
            contents.set(file.path, content)
            ;(file as { stat?: { size?: number } }).stat = {
              size: content.length,
            }
          }),
      },
    } as unknown as App

    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: 'Helper Agent',
          systemPrompt: 'You are helper.',
        },
      ],
    } as never

    const batchAddResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_add',
      args: {
        items: [
          {
            content: '批量记录 1',
            category: 'other',
          },
          {
            content: '   ',
            category: 'other',
          },
          {
            content: '批量记录 2',
            category: 'other',
          },
        ],
      },
    })
    expect(batchAddResult.status).toBe(ToolCallResponseStatus.Success)
    if (batchAddResult.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const batchAddPayload = JSON.parse(batchAddResult.text) as {
      mode: string
      okCount: number
      failCount: number
      results: Array<{ ok: boolean; id?: string }>
    }
    expect(batchAddPayload.mode).toBe('batch')
    expect(batchAddPayload.okCount).toBe(2)
    expect(batchAddPayload.failCount).toBe(1)
    const createdIds = batchAddPayload.results
      .filter((result) => result.ok)
      .map((result) => result.id)
    expect(createdIds).toEqual(['Memory_1', 'Memory_2'])

    const assistantMemoryPath = 'YOLO/memory/Helper Agent.md'

    const batchDeleteResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_delete',
      args: {
        ids: ['Memory_1', 'NotExist_404', 'Memory_2'],
      },
    })
    expect(batchDeleteResult.status).toBe(ToolCallResponseStatus.Success)
    if (batchDeleteResult.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const batchDeletePayload = JSON.parse(batchDeleteResult.text) as {
      mode: string
      okCount: number
      failCount: number
      results: Array<{ ok: boolean; id: string }>
    }
    expect(batchDeletePayload.mode).toBe('batch')
    expect(batchDeletePayload.okCount).toBe(2)
    expect(batchDeletePayload.failCount).toBe(1)
    expect(
      batchDeletePayload.results.filter((result) => !result.ok)[0]?.id,
    ).toBe('NotExist_404')

    expect(contents.get(assistantMemoryPath) ?? '').not.toContain('Memory_1')
    expect(contents.get(assistantMemoryPath) ?? '').not.toContain('Memory_2')
  })

  it('creates missing parent folders before creating a file', async () => {
    const entries = new Map<string, unknown>()
    const contents = new Map<string, string>()
    const createFolder = jest.fn().mockImplementation(async (path: string) => {
      const folder = Object.assign(new TFolder(), {
        path,
        children: [],
      })
      entries.set(path, folder)
      return folder
    })
    const create = jest
      .fn()
      .mockImplementation(async (path: string, content: string) => {
        const file = Object.assign(new TFile(), {
          path,
          stat: { size: content.length },
        })
        entries.set(path, file)
        contents.set(path, content)
        return file
      })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest
            .fn()
            .mockImplementation((path: string) => entries.get(path) ?? null),
          createFolder,
          create,
        },
      } as unknown as App,
      toolName: 'fs_create_file',
      args: {
        path: '99-Assets/YOLO/skills/content-organization/SKILL.md',
        content: '# test',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(createFolder).toHaveBeenNthCalledWith(1, '99-Assets')
    expect(createFolder).toHaveBeenNthCalledWith(2, '99-Assets/YOLO')
    expect(createFolder).toHaveBeenNthCalledWith(3, '99-Assets/YOLO/skills')
    expect(createFolder).toHaveBeenNthCalledWith(
      4,
      '99-Assets/YOLO/skills/content-organization',
    )
    expect(create).toHaveBeenCalledWith(
      '99-Assets/YOLO/skills/content-organization/SKILL.md',
      '# test',
    )
    expect(
      contents.get('99-Assets/YOLO/skills/content-organization/SKILL.md'),
    ).toBe('# test')
  })

  it('supports batch create_file calls with items', async () => {
    const entries = new Map<string, unknown>()
    const contents = new Map<string, string>()
    const createFolder = jest.fn().mockImplementation(async (path: string) => {
      const folder = Object.assign(new TFolder(), {
        path,
        children: [],
      })
      entries.set(path, folder)
      return folder
    })
    const create = jest
      .fn()
      .mockImplementation(async (path: string, content: string) => {
        const file = Object.assign(new TFile(), {
          path,
          stat: { size: content.length },
        })
        entries.set(path, file)
        contents.set(path, content)
        return file
      })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest
            .fn()
            .mockImplementation((path: string) => entries.get(path) ?? null),
          createFolder,
          create,
        },
      } as unknown as App,
      toolName: 'fs_create_file',
      args: {
        items: [
          { path: 'docs/a.md', content: 'A' },
          { path: 'docs/b.md', content: 'B' },
        ],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(create).toHaveBeenNthCalledWith(1, 'docs/a.md', 'A')
    expect(create).toHaveBeenNthCalledWith(2, 'docs/b.md', 'B')
    expect(contents.get('docs/a.md')).toBe('A')
    expect(contents.get('docs/b.md')).toBe('B')
  })

  it('supports batch move calls with items and reports partial failures', async () => {
    const entries = new Map<string, TFile | TFolder>()
    const docsFolder = Object.assign(new TFolder(), {
      path: 'docs',
      children: [],
    })
    const sourceA = Object.assign(new TFile(), {
      path: 'docs/a.md',
      stat: { size: 1 },
    })
    const sourceB = Object.assign(new TFile(), {
      path: 'docs/b.md',
      stat: { size: 1 },
    })
    entries.set('docs', docsFolder)
    entries.set('docs/a.md', sourceA)
    entries.set('docs/b.md', sourceB)

    const renameFile = jest
      .fn()
      .mockImplementation(async (file: TFile | TFolder, newPath: string) => {
        entries.delete(file.path)
        file.path = newPath
        entries.set(newPath, file)
      })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest
            .fn()
            .mockImplementation((path: string) => entries.get(path) ?? null),
          createFolder: jest.fn(),
        },
        fileManager: {
          renameFile,
        },
      } as unknown as App,
      toolName: 'fs_move',
      args: {
        items: [
          { oldPath: 'docs/a.md', newPath: 'docs/a-renamed.md' },
          { oldPath: 'docs/missing.md', newPath: 'docs/missing-renamed.md' },
        ],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(renameFile).toHaveBeenCalledTimes(1)
    expect(entries.has('docs/a-renamed.md')).toBe(true)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(JSON.parse(result.text)).toMatchObject({
      tool: 'fs_move',
      action: 'move',
      dryRun: false,
      results: [
        {
          ok: true,
          target: 'docs/a.md -> docs/a-renamed.md',
        },
        {
          ok: false,
          target: 'docs/missing.md -> docs/missing-renamed.md',
          message: 'Source path not found: docs/missing.md',
        },
      ],
    })
  })

  it('keeps fs tool schemas batch-friendly without top-level combinators', () => {
    const tools = getLocalFileTools()
    const schemaByName = new Map(
      tools.map((tool) => [tool.name, tool.inputSchema] as const),
    )

    for (const toolName of [
      'fs_create_file',
      'fs_delete_file',
      'fs_create_dir',
      'fs_delete_dir',
      'fs_move',
    ] as const) {
      const schema = schemaByName.get(toolName) as
        | {
            properties?: {
              items?: {
                minItems?: number
              }
            }
            oneOf?: unknown
            anyOf?: unknown
            allOf?: unknown
          }
        | undefined

      expect(schema).toBeDefined()
      expect(schema?.properties?.items?.minItems).toBe(1)
      expect(schema?.oneOf).toBeUndefined()
      expect(schema?.anyOf).toBeUndefined()
      expect(schema?.allOf).toBeUndefined()
    }
  })

  it('rejects empty batch items for fs_create_file at runtime', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn(),
          createFolder: jest.fn(),
          create: jest.fn(),
        },
      } as unknown as App,
      toolName: 'fs_create_file',
      args: {
        items: [],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('items must contain at least one entry')
    }
  })

  it('creates missing parent folders before creating a directory', async () => {
    const entries = new Map<string, unknown>()
    const createFolder = jest.fn().mockImplementation(async (path: string) => {
      const folder = Object.assign(new TFolder(), {
        path,
        children: [],
      })
      entries.set(path, folder)
      return folder
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest
            .fn()
            .mockImplementation((path: string) => entries.get(path) ?? null),
          createFolder,
        },
      } as unknown as App,
      toolName: 'fs_create_dir',
      args: {
        path: '99-Assets/YOLO/skills/content-organization',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(createFolder).toHaveBeenNthCalledWith(1, '99-Assets')
    expect(createFolder).toHaveBeenNthCalledWith(2, '99-Assets/YOLO')
    expect(createFolder).toHaveBeenNthCalledWith(3, '99-Assets/YOLO/skills')
    expect(createFolder).toHaveBeenNthCalledWith(
      4,
      '99-Assets/YOLO/skills/content-organization',
    )
  })
})
