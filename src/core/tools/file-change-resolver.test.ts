import {
  type ToolCallResponse,
  ToolCallResponseStatus,
  type ToolEditOperation,
  type ToolEditSummary,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import type { EditUndoSnapshot } from '../../utils/chat/editUndoSnapshotStore'

import { resolveEditDiffSource } from './file-editing-diff'

const request = (value: Record<string, unknown>) => ({
  arguments: createCompleteToolCallArguments({ value }),
})

const success = (editSummary?: ToolEditSummary): ToolCallResponse => ({
  status: ToolCallResponseStatus.Success,
  data: { type: 'text', text: '{}', metadata: { editSummary } },
})

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

describe('resolveEditDiffSource', () => {
  it('diffs oldText/newText straight from the arguments', () => {
    expect(
      resolveEditDiffSource(
        request({ path: 'note.md', oldText: 'a', newText: 'b' }),
        success(editedSummary('note.md')),
        // Even with a snapshot on hand, the arguments win: they are what this
        // call asked for and they survive a reload.
        snapshot(),
      ),
    ).toEqual({
      kind: 'exact',
      path: 'note.md',
      beforeText: 'a',
      afterText: 'b',
    })
  })

  it('falls back to the in-memory undo snapshot when the arguments carry no original text', () => {
    expect(
      resolveEditDiffSource(
        request({ path: 'note.md', content: 'after\n' }),
        success(editedSummary('note.md')),
        snapshot(),
      ),
    ).toEqual({
      kind: 'exact',
      path: 'note.md',
      beforeText: 'before\n',
      afterText: 'after\n',
    })
  })

  it('treats a snapshot of a file that did not exist as an empty original', () => {
    expect(
      resolveEditDiffSource(
        request({ path: 'note.md', content: 'after\n' }),
        success(createdSummary('note.md')),
        snapshot({ beforeExists: false, beforeContent: '' }),
      ),
    ).toEqual({
      kind: 'exact',
      path: 'note.md',
      beforeText: '',
      afterText: 'after\n',
    })
  })

  it('reads a pure creation off the persisted editSummary when no snapshot survives', () => {
    expect(
      resolveEditDiffSource(
        request({ path: 'note.md', content: 'line\n' }),
        // The native tools report the resolved path, which need not equal the
        // `path` argument — the creation is recognised by operation, not path.
        success(createdSummary('/outside/vault/note.md')),
        undefined,
      ),
    ).toEqual({
      kind: 'exact',
      path: 'note.md',
      beforeText: '',
      afterText: 'line\n',
    })
  })

  it('shows the written content alone when the original is gone', () => {
    expect(
      resolveEditDiffSource(
        request({ path: 'note.md', content: 'rewritten\n' }),
        success(editedSummary('note.md')),
        undefined,
      ),
    ).toEqual({
      kind: 'afterOnly',
      path: 'note.md',
      afterText: 'rewritten\n',
    })
  })

  it("uses fs_edit's line-range newText as the written content", () => {
    expect(
      resolveEditDiffSource(
        request({ path: 'note.md', startLine: 2, endLine: 4, newText: 'x\n' }),
        success(editedSummary('note.md')),
        undefined,
      ),
    ).toEqual({ kind: 'afterOnly', path: 'note.md', afterText: 'x\n' })
  })

  it('never uses the review snapshot: an overwrite with no undo snapshot stays afterOnly', () => {
    // Guards the decision documented on `resolveEditDiffSource`: the review
    // snapshot accumulates the whole round, so it must not stand in here.
    const resolved = resolveEditDiffSource(
      request({ path: 'note.md', content: 'second write\n' }),
      success(editedSummary('note.md')),
      undefined,
    )
    expect(resolved?.kind).toBe('afterOnly')
  })

  it('returns null for every non-success status so the default sections stay', () => {
    const args = request({ path: 'note.md', oldText: 'a', newText: 'b' })
    expect(
      resolveEditDiffSource(args, {
        status: ToolCallResponseStatus.Error,
        error: 'boom',
      }),
    ).toBeNull()
    expect(
      resolveEditDiffSource(args, {
        status: ToolCallResponseStatus.Rejected,
        reason: 'no',
      }),
    ).toBeNull()
    expect(
      resolveEditDiffSource(args, {
        status: ToolCallResponseStatus.PendingApproval,
      }),
    ).toBeNull()
  })

  it('returns null when there is no path, and when there is nothing written to show', () => {
    expect(
      resolveEditDiffSource(request({ oldText: 'a', newText: 'b' }), success()),
    ).toBeNull()
    expect(
      resolveEditDiffSource(request({ path: 'note.md' }), success()),
    ).toBeNull()
  })
})
