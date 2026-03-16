jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import {
  callLocalFileTool,
  isLocalFsWriteToolName,
  parseLocalFsActionFromToolArgs,
  recoverLikelyEscapedBackslashSequences,
} from './localFileTools'

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
      requireReview: true,
    })

    expect(openApplyReview).toHaveBeenCalledTimes(1)
    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe('success')
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
    expect(contents.get('YOLO/memory/assistant-helper.md') ?? '').toContain(
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
    expect(contents.get('YOLO/memory/assistant-helper.md') ?? '').not.toContain(
      'Preference_1',
    )
  })
})
