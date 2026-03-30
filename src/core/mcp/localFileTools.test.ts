jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'

import {
  callLocalFileTool,
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
      expect(result.error).toContain('operation must be an object')
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
      expect(result.error).toContain('operation must be an object')
    }
  })

  it('supports context prune tool results', async () => {
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
                id: 'read-1',
                name: 'yolo_local__fs_read',
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
        toolCallIds: [' read-1 ', 'read-2', 'read-1'],
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
      acceptedToolCallIds: ['read-1'],
      ignoredToolCallIds: ['read-2'],
      reason: 'superseded by newer reads',
    })
  })

  it('ignores fs_read results from the same tool message as prune', async () => {
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
                id: 'read-history',
                name: 'yolo_local__fs_read',
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
                id: 'read-current',
                name: 'yolo_local__fs_read',
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
        toolCallIds: ['read-history', 'read-current'],
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
      acceptedToolCallIds: ['read-history'],
      ignoredToolCallIds: ['read-current'],
      reason: null,
    })
  })

  it('only accepts successful text fs_read results for pruning', async () => {
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
                id: 'read-success',
                name: 'yolo_local__fs_read',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'read-error',
                name: 'yolo_local__fs_read',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Error,
                error: 'missing file',
              },
            },
            {
              request: {
                id: 'read-aborted',
                name: 'yolo_local__fs_read',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Aborted,
              },
            },
          ],
        },
      ],
      args: {
        toolCallIds: ['read-success', 'read-error', 'read-aborted'],
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
      acceptedToolCallIds: ['read-success'],
      ignoredToolCallIds: ['read-error', 'read-aborted'],
      reason: null,
    })
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
