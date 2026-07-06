jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('clsx', () => ({
  __esModule: true,
  default: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

jest.mock('../../contexts/plugin-context', () => ({
  usePlugin: () => ({}),
}))

const mockedObsidianCodeBlock = jest.fn((_: unknown) => null)
jest.mock('./ObsidianMarkdown', () => ({
  ObsidianCodeBlock: (props: unknown) => mockedObsidianCodeBlock(props),
}))

const mockedLiveTaskCard = jest.fn((_: unknown) => null)
jest.mock('./tool-cards/LiveTaskCard', () => ({
  LiveTaskCard: (props: unknown) => mockedLiveTaskCard(props),
}))

const mockedSubagentCard = jest.fn((_: unknown) => null)
jest.mock('./tool-cards/SubagentCard', () => ({
  SubagentCard: (props: unknown) => mockedSubagentCard(props),
}))

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatTerminalCommandResultMessage } from '../../types/chat'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import { getToolHeadlineParts, getToolHeadlineText } from './toolHeadline'
import type { ToolLabels } from './ToolMessage'
import ToolMessage, {
  areToolCallItemPropsEqual,
  getHeadlineDisplayInfo,
  getToolResultDisplayText,
} from './ToolMessage'

describe('ToolMessage rendering', () => {
  beforeEach(() => {
    mockedObsidianCodeBlock.mockClear()
    mockedLiveTaskCard.mockClear()
    mockedSubagentCard.mockClear()
  })

  it('hydrates original terminal_command card from persisted result output', () => {
    const terminalResult: ChatTerminalCommandResultMessage = {
      role: 'terminal_command_result',
      id: 'result-1',
      taskId: 'task-1',
      source: {
        type: 'llm_tool_call',
        assistantMessageId: 'assistant-1',
        toolCallId: 'tool-1',
      },
      title: 'for i in $(seq 1 8); do echo $i; sleep 1; done',
      status: 'completed',
      exitCode: 0,
      stdout: '1\n2\n3\n4\n5\n6\n7\n8\n',
      stderr: '',
      durationMs: 8000,
      delegateAssistantMessageId: 'assistant-1',
      delegateToolCallId: 'tool-1',
    }

    renderToStaticMarkup(
      React.createElement(ToolMessage, {
        message: {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'tool-1',
                name: 'yolo_local__terminal_command',
                arguments: createCompleteToolCallArguments({
                  value: {
                    command: 'for i in $(seq 1 8); do echo $i; sleep 1; done',
                    background: true,
                  },
                }),
              },
              response: {
                status: ToolCallResponseStatus.PendingApproval,
              },
            },
          ],
        },
        conversationId: 'conversation-1',
        terminalCommandResultsByToolCallId: new Map([
          ['tool-1', terminalResult],
        ]),
        onMessageUpdate: () => {},
      }),
    )

    expect(mockedLiveTaskCard).toHaveBeenCalledWith(
      expect.objectContaining({
        initialStdout: terminalResult.stdout,
        initialStderr: terminalResult.stderr,
        response: expect.objectContaining({
          status: ToolCallResponseStatus.Success,
        }),
      }),
    )
  })

  it('renders approval actions for pending delegate_subagent calls', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ToolMessage, {
        message: {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'tool-1',
                name: 'yolo_local__delegate_subagent',
                arguments: createCompleteToolCallArguments({
                  value: {
                    description: 'Count vault files',
                    prompt: 'Count files in the vault.',
                  },
                }),
              },
              response: {
                status: ToolCallResponseStatus.PendingApproval,
              },
            },
          ],
        },
        conversationId: 'conversation-1',
        onMessageUpdate: () => {},
      }),
    )

    expect(mockedSubagentCard).not.toHaveBeenCalled()
    expect(markup).toContain('Allow')
    expect(markup).toContain('Reject')
  })

  it('does not render hidden parameters or result content while collapsed', () => {
    renderToStaticMarkup(
      React.createElement(ToolMessage, {
        message: {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'tool-1',
                name: 'yolo_local__fs_read',
                arguments: createCompleteToolCallArguments({
                  value: {
                    paths: ['docs/large.md'],
                    operation: { type: 'lines', startLine: 1 },
                    padding: 'x'.repeat(100_000),
                  },
                }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: 'x'.repeat(100_000),
                  metadata: {
                    fsReadOperation: {
                      type: 'lines',
                      startLine: 1,
                      endLine: 10,
                      isPdf: false,
                    },
                  },
                },
              },
            },
          ],
        },
        conversationId: 'conversation-1',
        onMessageUpdate: () => {},
      }),
    )

    expect(mockedObsidianCodeBlock).not.toHaveBeenCalled()
  })

  it('does not hydrate persisted terminal output while collapsed', () => {
    const terminalResult: ChatTerminalCommandResultMessage = {
      role: 'terminal_command_result',
      id: 'result-1',
      taskId: 'task-1',
      source: {
        type: 'llm_tool_call',
        assistantMessageId: 'assistant-1',
        toolCallId: 'tool-1',
      },
      title: 'npm test',
      status: 'completed',
      exitCode: 0,
      stdout: 'x'.repeat(100_000),
      stderr: '',
      durationMs: 1000,
      delegateAssistantMessageId: 'assistant-1',
      delegateToolCallId: 'tool-1',
    }

    renderToStaticMarkup(
      React.createElement(ToolMessage, {
        message: {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'tool-1',
                name: 'yolo_local__terminal_command',
                arguments: createCompleteToolCallArguments({
                  value: { command: 'npm test', background: true },
                }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '' },
              },
            },
          ],
        },
        conversationId: 'conversation-1',
        terminalCommandResultsByToolCallId: new Map([
          ['tool-1', terminalResult],
        ]),
        onMessageUpdate: () => {},
      }),
    )

    expect(mockedLiveTaskCard).not.toHaveBeenCalled()
  })

  it('keeps unchanged tool call item props memo-equivalent', () => {
    const request = {
      id: 'tool-1',
      name: 'yolo_local__fs_read',
      arguments: createCompleteToolCallArguments({
        value: { paths: ['docs/plan.md'] },
      }),
    }
    const response: ToolCallResponse = {
      status: ToolCallResponseStatus.Success,
      data: { type: 'text' as const, text: 'ok' },
    }
    const onResponseUpdate = jest.fn()
    const props = {
      request,
      response,
      conversationId: 'conversation-1',
      toolMessageId: 'tool-message-1',
      showCompactionPendingHint: false,
      showRunningFooter: true,
      onResponseUpdate,
    }

    expect(areToolCallItemPropsEqual(props, { ...props })).toBe(true)
    expect(
      areToolCallItemPropsEqual(props, {
        ...props,
        response: {
          status: ToolCallResponseStatus.Error,
          error: 'failed',
        } satisfies ToolCallResponse,
      }),
    ).toBe(false)
  })
})

describe('getToolResultDisplayText', () => {
  it('returns text unchanged when it fits within the display budget', () => {
    const text = 'small fs_read output'
    expect(
      getToolResultDisplayText({
        response: {
          status: ToolCallResponseStatus.Success,
          data: { type: 'text', text },
        },
      }),
    ).toBe(text)
  })

  it('truncates oversized text regardless of the tool name', () => {
    const text = 'a'.repeat(20_000)
    const displayed = getToolResultDisplayText({
      response: {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text },
      },
    })

    expect(displayed.startsWith('a'.repeat(12_000))).toBe(true)
    expect(displayed).toContain(
      '[Display shortened by 8000 characters. The assistant received the full tool result.]',
    )
    expect(displayed.length).toBeLessThan(text.length)
  })
})

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
      terminal_command: 'Terminal command',
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
    terminalCommandSessionPoll: (sessionId: number) =>
      `Session ${sessionId} · Poll`,
    terminalCommandSessionKill: (sessionId: number) =>
      `Session ${sessionId} · Kill`,
    terminalCommandSessionInput: (sessionId: number, inputPreview: string) =>
      `Session ${sessionId} · Input: ${inputPreview}`,
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
            metadata: {
              fsReadOperation: { type: 'full', isPdf: false },
            },
          },
        },
        labels,
      }).summaryText,
    ).toBe('docs/plan.md | 全文')
  })

  it('shows concrete paths for multi-path fs_read headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_read',
          arguments: createCompleteToolCallArguments({
            value: {
              paths: ['docs/one.md', 'docs/two.md'],
              operation: { type: 'full' },
            },
          }),
        },
        response: {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: '',
            metadata: {
              fsReadOperation: { type: 'full', isPdf: false },
            },
          },
        },
        labels,
      }).summaryText,
    ).toBe('docs/one.md, docs/two.md | 全文')
  })

  it('omits extra paths only when fs_read has five or more paths', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_read',
          arguments: createCompleteToolCallArguments({
            value: {
              paths: [
                'docs/one.md',
                'docs/two.md',
                'docs/three.md',
                'docs/four.md',
                'docs/five.md',
              ],
              operation: { type: 'full' },
            },
          }),
        },
        response: {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: '',
            metadata: {
              fsReadOperation: { type: 'full', isPdf: false },
            },
          },
        },
        labels,
      }).summaryText,
    ).toBe('docs/one.md, docs/two.md, docs/three.md, docs/four.md +1 | 全文')
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
            metadata: {
              fsReadOperation: {
                type: 'lines',
                startLine: 12,
                endLine: 61,
                isPdf: false,
              },
            },
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
            metadata: {
              fsReadOperation: {
                type: 'lines',
                startLine: 1,
                endLine: 1,
                isPdf: true,
              },
            },
          },
        },
        labels,
      }).summaryText,
    ).toBe('docs/paper.pdf | 1-1页')
  })

  it('does not parse fs_read response text for legacy headlines without metadata', () => {
    const parseSpy = jest.spyOn(JSON, 'parse')

    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__fs_read',
          arguments: createCompleteToolCallArguments({
            value: {
              paths: ['docs/large.md'],
              operation: { type: 'lines', startLine: 1 },
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
                  path: 'docs/large.md',
                  ok: true,
                  returnedRange: { startLine: 1, endLine: 1000 },
                },
              ],
            }),
          },
        },
        labels,
      }).summaryText,
    ).toBe('docs/large.md')
    expect(parseSpy).not.toHaveBeenCalled()

    parseSpy.mockRestore()
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

  it('uses shell command as summary for terminal_command headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: {
              command: 'git status',
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Terminal command',
      summaryText: 'git status',
    })
  })

  it('uses basename plus arguments for long single terminal_command headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: {
              command:
                '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli plugin:reload id=yolo',
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Terminal command',
      summaryText: 'obsidian-cli plugin:reload id=yolo',
    })
  })

  it('uses command-name summary for long streaming terminal_command headlines', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: {
              command:
                'for i in $(seq 1 15); do echo "[$i] $(date +%H:%M:%S)"; sleep 1; done && echo "=== done ===" && pwd && ls -la src | head -8',
              background: true,
            },
          }),
        },
        labels,
      }),
    ).toEqual({
      displayName: 'Terminal command',
      summaryText:
        'Long bash command with streaming output seq, echo, date, sleep, pwd +2',
    })
  })

  it('uses session poll/kill/input summaries for terminal_command follow-ups', () => {
    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { session_id: 3 },
          }),
        },
        labels,
      }).summaryText,
    ).toBe('Session 3 · Poll')

    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { session_id: 3, kill: true },
          }),
        },
        labels,
      }).summaryText,
    ).toBe('Session 3 · Kill')

    expect(
      getHeadlineDisplayInfo({
        request: {
          name: 'yolo_local__terminal_command',
          arguments: createCompleteToolCallArguments({
            value: { session_id: 3, input: 'y\n' },
          }),
        },
        labels,
      }).summaryText,
    ).toBe('Session 3 · Input: y')
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
