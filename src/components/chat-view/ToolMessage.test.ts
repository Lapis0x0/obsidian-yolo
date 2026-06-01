jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('../../contexts/plugin-context', () => ({
  usePlugin: () => ({}),
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
      [ToolCallResponseStatus.AwaitingUserInput]: 'Awaiting',
    },
    unknownStatus: 'Unknown',
    displayNames: {
      fs_write: 'Write file',
      fs_delete: 'Delete',
      fs_create_dir: 'Create folder',
      fs_move: 'Move path',
    },
    writeActionLabels: {
      write: 'Write file',
      delete: 'Delete',
      create_dir: 'Create folder',
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
    todoWriteCleared: 'Cleared list',
    todoWriteAllCompleted: (count: number) => `All completed (${count})`,
    todoWriteCreated: (count: number) => `Planned ${count} tasks`,
    todoWriteProgress: (done: number, total: number) =>
      `Progress ${done}/${total}`,
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

  it('uses file path as summary for write headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_write',
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
      displayName: 'Write file',
      summaryText: 'docs/new-note.md',
    })
  })

  it('uses file path as summary for delete headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_delete',
          arguments: createCompleteToolCallArguments({
            value: {
              path: 'docs/old-note.md',
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Delete',
      summaryText: 'docs/old-note.md',
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

  it('uses content (not legacy activeForm) for in_progress todo_write summary', () => {
    // Old persisted tool calls may still carry an `activeForm` field. The
    // chip summary must take it from `content` and ignore the legacy field.
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__todo_write',
          arguments: createCompleteToolCallArguments({
            value: {
              todos: [
                {
                  content: 'A done',
                  activeForm: 'Doing A',
                  status: 'completed',
                },
                {
                  content: '完成第二步',
                  activeForm: '推进到第二步',
                  status: 'in_progress',
                },
              ],
            },
          }),
        },
        response: {
          status: ToolCallResponseStatus.Success,
          data: { type: 'text', text: 'Todos updated.' },
        },
        labels,
      }).summaryText,
    ).toBe('完成第二步')
  })
})
