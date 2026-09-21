import {
  type FileChangeRows,
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  type ToolEditOperation,
  type ToolEditSummary,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import type { EditUndoSnapshot } from '../../utils/chat/editUndoSnapshotStore'

import {
  type FileChangeResolution,
  buildPendingFileChangeRows,
  resolveFileChangeRows,
} from './file-change-resolver'
import {
  buildFileChangeRowsFromContent,
  buildFileChangeRowsFromTexts,
  withoutLineNumbers,
} from './file-change-rows'

const request = (
  value: Record<string, unknown>,
  name = 'yolo_local__fs_write',
): Pick<ToolCallRequest, 'name' | 'arguments' | 'metadata'> => ({
  name,
  arguments: createCompleteToolCallArguments({ value }),
})

const success = (editSummary?: ToolEditSummary): ToolCallResponse => ({
  status: ToolCallResponseStatus.Success,
  data: { type: 'text', text: '{}', metadata: { editSummary } },
})

const pending: ToolCallResponse = {
  status: ToolCallResponseStatus.PendingApproval,
}

const summaryOf = (
  path: string,
  operation: ToolEditOperation,
): ToolEditSummary => ({
  files: [
    {
      path,
      addedLines: 1,
      removedLines: operation === 'create' ? 0 : 1,
      operation,
      undoStatus: 'available',
    },
  ],
  totalFiles: 1,
  totalAddedLines: 1,
  totalRemovedLines: operation === 'create' ? 0 : 1,
  undoStatus: 'available',
})

const createdSummary = (path: string) => summaryOf(path, 'create')
const editedSummary = (path: string) => summaryOf(path, 'edit')

const snapshot = (
  overrides: Partial<EditUndoSnapshot> = {},
): EditUndoSnapshot => ({
  toolCallId: 'call-1',
  path: 'note.md',
  beforeContent: 'before\n',
  afterContent: 'after\n',
  beforeExists: true,
  afterExists: true,
  appliedAt: 0,
  ...overrides,
})

const rowsOf = (...files: FileChangeRows[]): FileChangeResolution => ({
  type: 'rows',
  files,
})

const pendingRead = (resolution: FileChangeResolution | null) => {
  if (resolution?.type !== 'readCurrent') {
    throw new Error(`expected readCurrent, got ${JSON.stringify(resolution)}`)
  }
  return resolution.read
}

describe('resolveFileChangeRows', () => {
  it('uses pre-built rows on the request as they are', () => {
    const prebuilt = [
      buildFileChangeRowsFromTexts('a.md', 'x', 'y'),
      buildFileChangeRowsFromContent('b.md', 'z'),
    ]
    expect(
      resolveFileChangeRows(
        { name: 'Edit', metadata: { fileChangeRows: prebuilt } },
        pending,
      ),
    ).toEqual(rowsOf(...prebuilt))
  })

  it("draws a finished replace from this call's undo snapshot, at the file's real lines", () => {
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', oldText: 'before', newText: 'after' }),
        success(editedSummary('note.md')),
        { undoSnapshot: snapshot() },
      ),
    ).toEqual(
      rowsOf(buildFileChangeRowsFromTexts('note.md', 'before\n', 'after\n')),
    )
  })

  it("falls back to a finished replace's fragment, without line numbers, once the snapshot is gone", () => {
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', oldText: 'a', newText: 'b' }),
        success(editedSummary('note.md')),
      ),
    ).toEqual(
      rowsOf(
        withoutLineNumbers(buildFileChangeRowsFromTexts('note.md', 'a', 'b')),
      ),
    )
  })

  it('places a pending replace at its real lines by reading the file', () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request(
          { path: 'note.md', oldText: 'l2', newText: 'L2' },
          'yolo_local__fs_edit',
        ),
        pending,
      ),
    )
    expect(
      buildPendingFileChangeRows(read, { state: 'text', text: 'l1\nl2\nl3\n' }),
    ).toEqual(
      buildFileChangeRowsFromTexts('note.md', 'l1\nl2\nl3\n', 'l1\nL2\nl3\n'),
    )
    // The replace would fail against this text, so there is nothing to place:
    // the fragment is shown, unnumbered.
    expect(
      buildPendingFileChangeRows(read, { state: 'text', text: 'other\n' }),
    ).toEqual(
      withoutLineNumbers(buildFileChangeRowsFromTexts('note.md', 'l2', 'L2')),
    )
  })

  it("applies edit_file's replaceAll to every occurrence in the pending preview", () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request(
          {
            path: '/abs/note.md',
            oldText: 'x',
            newText: 'y',
            replaceAll: true,
          },
          'yolo_local__edit_file',
        ),
        pending,
      ),
    )
    expect(read.filesystem).toBe('native')
    expect(
      buildPendingFileChangeRows(read, { state: 'text', text: 'x\na\nx\n' }),
    ).toEqual(
      buildFileChangeRowsFromTexts('/abs/note.md', 'x\na\nx\n', 'y\na\ny\n'),
    )
  })

  it('falls back to the in-memory undo snapshot when the arguments carry no original text', () => {
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'after\n' }),
        success(editedSummary('note.md')),
        { undoSnapshot: snapshot() },
      ),
    ).toEqual(
      rowsOf(buildFileChangeRowsFromTexts('note.md', 'before\n', 'after\n')),
    )
  })

  it('treats a snapshot of a file that did not exist as an empty original', () => {
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'after\n' }),
        success(createdSummary('note.md')),
        { undoSnapshot: snapshot({ beforeExists: false, beforeContent: '' }) },
      ),
    ).toEqual(rowsOf(buildFileChangeRowsFromTexts('note.md', '', 'after\n')))
  })

  it('reads a pure creation off the persisted editSummary when no snapshot survives', () => {
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'line\n' }),
        // The native tools report the resolved path, which need not equal the
        // `path` argument — the creation is recognised by operation, not path.
        success(createdSummary('/outside/vault/note.md')),
      ),
    ).toEqual(rowsOf(buildFileChangeRowsFromTexts('note.md', '', 'line\n')))
  })

  it('shows the written content alone when the original is gone', () => {
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'rewritten\n' }),
        success(editedSummary('note.md')),
      ),
    ).toEqual(rowsOf(buildFileChangeRowsFromContent('note.md', 'rewritten\n')))
  })

  it("uses fs_edit's line-range newText as the written content", () => {
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', startLine: 2, endLine: 4, newText: 'x\n' }),
        success(editedSummary('note.md')),
      ),
    ).toEqual(rowsOf(buildFileChangeRowsFromContent('note.md', 'x\n')))
  })

  it('never uses the review snapshot: an overwrite with no undo snapshot stays afterOnly', () => {
    // The review snapshot accumulates the whole round, so it must not stand
    // in for this call's own before-text.
    const resolved = resolveFileChangeRows(
      request({ path: 'note.md', content: 'second write\n' }),
      success(editedSummary('note.md')),
    )
    expect(
      resolved?.type === 'rows' ? resolved.files[0].completeness : null,
    ).toBe('afterOnly')
  })

  it('returns null for error and rejected calls so the default sections stay', () => {
    const args = request({ path: 'note.md', oldText: 'a', newText: 'b' })
    const prebuilt: Pick<ToolCallRequest, 'name' | 'metadata'> = {
      name: 'Edit',
      metadata: {
        fileChangeRows: [buildFileChangeRowsFromTexts('a.md', 'x', 'y')],
      },
    }
    for (const response of [
      { status: ToolCallResponseStatus.Error, error: 'boom' },
      { status: ToolCallResponseStatus.Rejected, reason: 'no' },
    ] satisfies ToolCallResponse[]) {
      expect(resolveFileChangeRows(args, response)).toBeNull()
      // The status gate applies to pre-built rows as well.
      expect(resolveFileChangeRows(prebuilt, response)).toBeNull()
    }
  })

  it('draws a running call only from rows fixed when the call was made', () => {
    const running: ToolCallResponse = {
      status: ToolCallResponseStatus.Running,
    }
    const built = buildFileChangeRowsFromTexts('a.md', 'x', 'y')
    expect(
      resolveFileChangeRows(
        { name: 'Edit', metadata: { fileChangeRows: [built] } },
        running,
      ),
    ).toEqual(rowsOf(built))
    // A replace mid-write: only its fragment is fixed, and it is not placed
    // in the file, so it carries no line numbers.
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', oldText: 'a', newText: 'b' }),
        running,
        { undoSnapshot: snapshot() },
      ),
    ).toEqual(
      rowsOf(
        withoutLineNumbers(buildFileChangeRowsFromTexts('note.md', 'a', 'b')),
      ),
    )
    // An overwrite mid-write: the disk is neither the before nor the after,
    // and the write has left no snapshot or summary yet.
    expect(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'new\n' }),
        running,
        { undoSnapshot: snapshot() },
      ),
    ).toBeNull()
  })

  it("never reads a CLI call's provider-native arguments as a native tool's", () => {
    // Field names that happen to match `fs_write`'s must not be diffed.
    const cliRequest: Pick<ToolCallRequest, 'name' | 'arguments' | 'metadata'> =
      {
        name: 'write',
        arguments: createCompleteToolCallArguments({
          value: { path: 'note.md', content: 'new\n' },
        }),
        metadata: {
          cliToolCall: {
            runtimeId: 'hermes',
            eventType: 'tool_call',
            name: 'write',
            capability: 'file_change',
          },
        },
      }
    expect(resolveFileChangeRows(cliRequest, success())).toBeNull()
    expect(resolveFileChangeRows(cliRequest, pending)).toBeNull()
  })

  it('returns null when there is no path, and when there is nothing written to show', () => {
    expect(
      resolveFileChangeRows(request({ oldText: 'a', newText: 'b' }), success()),
    ).toBeNull()
    expect(
      resolveFileChangeRows(request({ path: 'note.md' }), success()),
    ).toBeNull()
  })
})

describe('pending approval without the original in the arguments', () => {
  it('asks for the current vault file for fs_write', () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'new\n' }),
        pending,
        // A pending call has not written anything, so no snapshot applies —
        // but even a stale one must not beat the file on disk.
        { undoSnapshot: snapshot() },
      ),
    )
    expect(read.path).toBe('note.md')
    expect(read.filesystem).toBe('vault')
  })

  it('reads through node:fs for the native tools', () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request(
          { path: '~/notes/a.txt', content: 'new\n' },
          'yolo_local__write_file',
        ),
        pending,
      ),
    )
    expect(read.filesystem).toBe('native')
  })

  it('diffs an overwrite against the current content', () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'a\nB\nc' }),
        pending,
      ),
    )
    expect(
      buildPendingFileChangeRows(read, { state: 'text', text: 'a\nb\nc' }),
    ).toEqual(buildFileChangeRowsFromTexts('note.md', 'a\nb\nc', 'a\nB\nc'))
  })

  it('draws a pure creation when the file does not exist yet', () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'a' }),
        pending,
      ),
    )
    expect(buildPendingFileChangeRows(read, { state: 'absent' })).toEqual(
      buildFileChangeRowsFromTexts('note.md', '', 'a'),
    )
  })

  it('shows the written content alone when the file cannot be read', () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request({ path: 'note.md', content: 'a' }),
        pending,
      ),
    )
    expect(buildPendingFileChangeRows(read, { state: 'unreadable' })).toEqual(
      buildFileChangeRowsFromContent('note.md', 'a'),
    )
  })

  it("applies fs_edit's line range to the current content", () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request(
          { path: 'note.md', startLine: 2, endLine: 3, newText: 'X' },
          'yolo_local__fs_edit',
        ),
        pending,
      ),
    )
    expect(
      buildPendingFileChangeRows(read, { state: 'text', text: 'a\nb\nc\nd' }),
    ).toEqual(buildFileChangeRowsFromTexts('note.md', 'a\nb\nc\nd', 'a\nX\nd'))
  })

  it('falls back to the written content when the line range does not apply', () => {
    const read = pendingRead(
      resolveFileChangeRows(
        request(
          { path: 'note.md', startLine: 8, endLine: 9, newText: 'X' },
          'yolo_local__fs_edit',
        ),
        pending,
      ),
    )
    expect(
      buildPendingFileChangeRows(read, { state: 'text', text: 'a\nb' }),
    ).toEqual(buildFileChangeRowsFromContent('note.md', 'X'))
    expect(buildPendingFileChangeRows(read, { state: 'absent' })).toEqual(
      buildFileChangeRowsFromContent('note.md', 'X'),
    )
  })
})
