jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('../../runtime/react-compat', () => ({
  Notice: jest.fn(),
  usePlugin: () => ({
    getAgentService: () => ({
      approveToolCall: jest.fn(),
      rejectToolCall: jest.fn(),
      abortToolCall: jest.fn(),
    }),
  }),
}))

jest.mock('./ObsidianMarkdown', () => ({
  ObsidianCodeBlock: () => null,
}))

jest.mock('./tool-cards/ExternalAgentToolCard', () => ({
  ExternalAgentToolCard: () => null,
}))

import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import { getToolHeadlineParts, getToolHeadlineText } from './toolHeadline'
import { type ToolLabels, getHeadlineDisplayInfo } from './ToolMessage'

describe('ToolMessage headline helpers', () => {
  const labels: ToolLabels = {
    statusLabels: {
      [ToolCallResponseStatus.PendingApproval]: 'Call',
      [ToolCallResponseStatus.Rejected]: 'Rejected',
      [ToolCallResponseStatus.Running]: 'Running',
      [ToolCallResponseStatus.Success]: '',
      [ToolCallResponseStatus.Error]: 'Failed',
      [ToolCallResponseStatus.Aborted]: 'Aborted',
    },
    unknownStatus: 'Unknown',
    displayNames: {
      fs_create_file: 'Create file',
      fs_delete_file: 'Delete file',
      fs_create_dir: 'Create folder',
      fs_delete_dir: 'Delete folder',
      fs_move: 'Move path',
    },
    writeActionLabels: {
      create_file: 'Create file',
      delete_file: 'Delete file',
      create_dir: 'Create folder',
      delete_dir: 'Delete folder',
      move: 'Move path',
    },
    readFull: '全文',
    readLineRange: (startLine: number, endLine: number, isPdf: boolean) =>
      `${startLine}-${endLine}${isPdf ? '页' : '行'}`,
    target: 'Target',
    scope: 'Scope',
    query: 'Query',
    path: 'Path',
    paths: 'paths',
    parameters: 'Parameters',
    noParameters: 'No parameters',
    result: 'Result',
    error: 'Error',
    allow: 'Allow',
    reject: 'Reject',
    abort: 'Abort',
    allowForThisChat: 'Allow for this chat',
  }

  it('appends edit deltas after the path for successful edit calls', () => {
    const displayInfo = {
      displayName: 'Text editing',
      summaryText: 'Folder/Internal Transaction Closed-loop Design Schedule.md',
    }

    expect(
      getToolHeadlineText({
        status: ToolCallResponseStatus.Success,
        displayInfo,
        labels,
        editSummary: {
          files: [],
          totalFiles: 1,
          totalAddedLines: 8,
          totalRemovedLines: 0,
          undoStatus: 'available',
        },
      }),
    ).toBe(
      'Text editing: Folder/Internal Transaction Closed-loop Design Schedule.md +8',
    )
  })

  it('omits zero edit deltas from headline text', () => {
    expect(
      getToolHeadlineText({
        status: ToolCallResponseStatus.Success,
        displayInfo: {
          displayName: 'Text editing',
          summaryText: 'schedule.md',
        },
        labels,
        editSummary: {
          files: [],
          totalFiles: 1,
          totalAddedLines: 0,
          totalRemovedLines: 4,
          undoStatus: 'available',
        },
      }),
    ).toBe('Text editing: schedule.md -4')
  })

  it('separates title, path, and deltas for header layout', () => {
    expect(
      getToolHeadlineParts({
        status: ToolCallResponseStatus.Success,
        displayInfo: {
          displayName: 'Text editing',
          summaryText: 'schedule.md',
        },
        labels,
        editSummary: {
          files: [],
          totalFiles: 1,
          totalAddedLines: 3,
          totalRemovedLines: 1,
          undoStatus: 'available',
        },
      }),
    ).toEqual({
      titleText: 'Text editing',
      summaryText: 'schedule.md',
      addedLines: 3,
      removedLines: 1,
    })
  })

  it('adds full-read mode to successful fs_read headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_read',
          arguments: createCompleteToolCallArguments({
            value: {
              paths: ['docs/plan.md'],
              operation: {
                type: 'full',
              },
            },
          }),
        },
        response: {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: JSON.stringify({
              requestedOperation: { type: 'full', modality: 'text' },
              results: [],
            }),
          },
        },
        labels,
      }).summaryText,
    ).toBe('docs/plan.md | 全文')
  })

  it('adds line-range mode to successful fs_read headlines (markdown)', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_read',
          arguments: createCompleteToolCallArguments({
            value: {
              paths: ['docs/plan.md'],
              operation: {
                type: 'lines',
                startLine: 12,
              },
            },
          }),
        },
        response: {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: JSON.stringify({
              requestedOperation: { type: 'lines', modality: 'text' },
              results: [
                {
                  path: 'docs/plan.md',
                  ok: true,
                  totalLines: 200,
                  returnedRange: { startLine: 12, endLine: 61 },
                  hasMoreBelow: true,
                  nextStartLine: 62,
                  content: '...',
                },
              ],
            }),
          },
        },
        labels,
      }).summaryText,
    ).toBe('docs/plan.md | 12-61行')
  })

  it('uses 页 suffix and single-page range for PDF fs_read headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_read',
          arguments: createCompleteToolCallArguments({
            value: {
              paths: ['docs/paper.pdf'],
              operation: {
                type: 'lines',
                startLine: 1,
              },
            },
          }),
        },
        response: {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: JSON.stringify({
              requestedOperation: { type: 'lines', modality: 'text' },
              results: [
                {
                  path: 'docs/paper.pdf',
                  ok: true,
                  totalLines: 7,
                  returnedRange: { startLine: 1, endLine: 1 },
                  hasMoreBelow: true,
                  nextStartLine: 2,
                  content: '',
                },
              ],
            }),
          },
        },
        labels,
      }).summaryText,
    ).toBe('docs/paper.pdf | 1-1页')
  })

  it('omits range while fs_read response is pending', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_read',
          arguments: createCompleteToolCallArguments({
            value: {
              paths: ['docs/plan.md'],
              operation: { type: 'lines', startLine: 12 },
            },
          }),
        },
        labels,
      }).summaryText,
    ).toBe('docs/plan.md')
  })

  it('uses file path as summary for create-file headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_create_file',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'docs/new-note.md',
              content: '# hello',
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Create file',
      summaryText: 'docs/new-note.md',
    })
  })

  it('uses folder path as summary for create-dir headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_create_dir',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'docs/archive',
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Create folder',
      summaryText: 'docs/archive',
    })
  })

  it('uses source and destination paths for move headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_move',
          arguments: createCompleteToolCallArguments({
            value: {
              oldPath: 'docs/old.md',
              newPath: 'docs/new.md',
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Move path',
      summaryText: 'docs/old.md -> docs/new.md',
    })
  })

  it('summarizes batch create-file headlines by shared parent directory', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_create_file',
          arguments: createCompleteToolCallArguments({
            value: {
              items: [
                { path: 'docs/a.md', content: 'A' },
                { path: 'docs/b.md', content: 'B' },
              ],
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Create file',
      summaryText: '在 docs 下创建 2 个文件',
    })
  })

  it('summarizes batch move headlines by target directory', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_move',
          arguments: createCompleteToolCallArguments({
            value: {
              items: [
                { oldPath: 'docs/a.md', newPath: 'docs/a-1.md' },
                { oldPath: 'docs/b.md', newPath: 'docs/b-1.md' },
                { oldPath: 'docs/c.md', newPath: 'docs/c-1.md' },
              ],
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Move path',
      summaryText: '移动 3 项到 docs',
    })
  })

  it('summarizes batch delete-file headlines by shared parent directory', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_delete_file',
          arguments: createCompleteToolCallArguments({
            value: {
              items: [
                { path: 'docs/a.md' },
                { path: 'docs/b.md' },
                { path: 'docs/c.md' },
              ],
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Delete file',
      summaryText: '删除 docs 下 3 个文件',
    })
  })

  it('falls back to generic batch summary when create-file paths are distributed', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_create_file',
          arguments: createCompleteToolCallArguments({
            value: {
              items: [
                { path: 'docs/a.md', content: 'A' },
                { path: 'notes/b.md', content: 'B' },
              ],
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Create file',
      summaryText: '创建 2 个文件',
    })
  })
})
