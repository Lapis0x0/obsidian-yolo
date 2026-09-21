import type { SessionMessage } from '@yolo/claude-agent-sdk-runtime'

import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

import {
  applyClaudeEdit,
  applyClaudeFileChangeResult,
  buildClaudePendingFileChangeRows,
  toVaultRelativePath,
} from './fileChange'
import { hydrateClaudeSessionMessages, toToolCallRequest } from './messages'

const request = (name: string): ToolCallRequest =>
  toToolCallRequest({ id: 'call-1', name, input: {} })

const success = (cliToolResult: unknown): ToolCallResponse => ({
  status: ToolCallResponseStatus.Success,
  data: { type: 'text', text: 'ok', metadata: { cliToolResult } },
})

describe('Claude file-change mapping', () => {
  it('marks Edit, Write and NotebookEdit as file changes', () => {
    for (const name of ['Edit', 'Write', 'NotebookEdit']) {
      expect(request(name).metadata?.cliToolCall?.capability).toBe(
        'file_change',
      )
    }
    expect(request('Read').metadata?.cliToolCall?.capability).toBeUndefined()
  })

  it('applies an edit the way the Edit tool does', () => {
    expect(applyClaudeEdit('a b a', 'b', 'B', false)).toBe('a B a')
    expect(applyClaudeEdit('a b a', 'a', 'A', true)).toBe('A b A')
    // A non-unique match without replaceAll is an Edit error, not a guess.
    expect(applyClaudeEdit('a b a', 'a', 'A', false)).toBeNull()
    expect(applyClaudeEdit('a b', 'x', 'y', false)).toBeNull()
    // `$` patterns are literal text, not replacement syntax.
    expect(applyClaudeEdit('a b', 'b', '$&$&', false)).toBe('a $&$&')
    // An empty oldString creates a file.
    expect(applyClaudeEdit(null, '', 'new', false)).toBe('new')
    expect(applyClaudeEdit('text', '', 'new', false)).toBeNull()
  })

  it('keeps paths outside the vault absolute', () => {
    expect(toVaultRelativePath('/vault/', '/vault/a/b.md')).toBe('a/b.md')
    expect(toVaultRelativePath('C:\\vault', 'C:\\vault\\a.md')).toBe('a.md')
    expect(toVaultRelativePath('/vault', '/other/a.md')).toBe('/other/a.md')
  })

  it('maps a Write that creates a file to an all-added diff', () => {
    const { request: mapped, response } = applyClaudeFileChangeResult(
      '/vault',
      {
        request: request('Write'),
        response: success({
          type: 'create',
          filePath: '/vault/new.md',
          content: 'one\ntwo\n',
          structuredPatch: [],
          originalFile: null,
        }),
      },
    )
    expect(mapped.metadata?.fileChangeRows).toEqual([
      {
        path: 'new.md',
        completeness: 'diff',
        hiddenTrailingLines: 0,
        rows: [
          { type: 'line', change: 'added', newLineNumber: 1, text: 'one' },
          { type: 'line', change: 'added', newLineNumber: 2, text: 'two' },
        ],
      },
    ])
    expect(response).toMatchObject({
      data: {
        metadata: {
          editSummary: {
            files: [
              {
                path: 'new.md',
                addedLines: 2,
                removedLines: 0,
                operation: 'create',
                undoStatus: 'unavailable',
              },
            ],
            undoStatus: 'unavailable',
          },
        },
      },
    })
  })

  it('diffs a NotebookEdit by cell and counts the notebook file', () => {
    const { request: mapped, response } = applyClaudeFileChangeResult(
      '/vault',
      {
        request: request('NotebookEdit'),
        response: success({
          new_source: 'print(2)',
          old_source: 'print(1)',
          cell_type: 'code',
          language: 'python',
          edit_mode: 'replace',
          notebook_path: '/vault/n.ipynb',
          original_file: '{\n"source": "print(1)"\n}',
          updated_file: '{\n"source": "print(2)"\n}',
        }),
      },
    )
    expect(mapped.metadata?.fileChangeRows?.[0]?.rows).toEqual([
      {
        type: 'line',
        change: 'removed',
        oldLineNumber: 1,
        text: 'print(1)',
      },
      { type: 'line', change: 'added', newLineNumber: 1, text: 'print(2)' },
    ])
    expect(response).toMatchObject({
      data: {
        metadata: {
          editSummary: {
            files: [{ path: 'n.ipynb', addedLines: 1, removedLines: 1 }],
          },
        },
      },
    })
  })

  it('leaves calls it cannot read unchanged', () => {
    const unmatchedEdit = {
      request: request('Edit'),
      response: success({
        filePath: '/vault/a.md',
        oldString: 'missing',
        newString: 'x',
        originalFile: 'text',
        replaceAll: false,
      }),
    }
    expect(applyClaudeFileChangeResult('/vault', unmatchedEdit)).toBe(
      unmatchedEdit,
    )
    const failed = {
      request: request('Write'),
      response: {
        status: ToolCallResponseStatus.Error,
        error: 'denied',
      } as ToolCallResponse,
    }
    expect(applyClaudeFileChangeResult('/vault', failed)).toBe(failed)
    const otherTool = {
      request: request('Read'),
      response: success({ filePath: '/vault/a.md', content: 'x' }),
    }
    expect(applyClaudeFileChangeResult('/vault', otherTool)).toBe(otherTool)
  })

  it('previews a pending Edit against the current file text', () => {
    const input = {
      file_path: '/vault/a.md',
      old_string: 'b',
      new_string: 'B',
    }
    expect(
      buildClaudePendingFileChangeRows('/vault', 'Edit', input, 'a\nb\n')?.rows,
    ).toEqual([
      {
        type: 'line',
        change: 'unchanged',
        oldLineNumber: 1,
        newLineNumber: 1,
        text: 'a',
      },
      { type: 'line', change: 'removed', oldLineNumber: 2, text: 'b' },
      { type: 'line', change: 'added', newLineNumber: 2, text: 'B' },
    ])
    // The edit no longer applies to what is on disk: no preview.
    expect(
      buildClaudePendingFileChangeRows('/vault', 'Edit', input, 'x\n'),
    ).toBeNull()
    expect(
      buildClaudePendingFileChangeRows(
        '/vault',
        'NotebookEdit',
        { notebook_path: '/vault/n.ipynb', new_source: 'x' },
        '{}',
      ),
    ).toBeNull()
  })

  it('restores the rows and summary of a transcript Write', () => {
    const messages = hydrateClaudeSessionMessages(
      [
        {
          type: 'assistant',
          uuid: 'assistant-1',
          session_id: 'session-1',
          parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'write-1',
                name: 'Write',
                input: { file_path: '/vault/a.md', content: 'b\n' },
              },
            ],
          },
        },
        {
          type: 'user',
          uuid: 'result-1',
          session_id: 'session-1',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'write-1', content: 'ok' },
            ],
          },
          toolUseResult: {
            type: 'update',
            filePath: '/vault/a.md',
            content: 'b\n',
            structuredPatch: [],
            originalFile: 'a\n',
          },
        },
      ] as unknown as SessionMessage[],
      '/vault',
    )
    const toolMessage = messages.find((message) => message.role === 'tool')
    const toolCall =
      toolMessage?.role === 'tool' ? toolMessage.toolCalls[0] : undefined
    expect(toolCall?.request.metadata?.fileChangeRows?.[0]).toMatchObject({
      path: 'a.md',
      completeness: 'diff',
    })
    expect(toolCall?.response).toMatchObject({
      data: {
        metadata: {
          editSummary: {
            files: [{ path: 'a.md', addedLines: 1, removedLines: 1 }],
          },
        },
      },
    })
  })
})
