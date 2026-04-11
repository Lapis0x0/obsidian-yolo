import type { AssistantToolMessageGroup } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  collectGroupEditSummary,
  countFileChangeStats,
  createToolEditSummary,
  deriveToolEditUndoStatus,
} from './editSummary'
import { editUndoSnapshotStore } from './editUndoSnapshotStore'

afterEach(() => {
  editUndoSnapshotStore.clear()
})

describe('editSummary helpers', () => {
  it('creates a file edit summary from before/after content', () => {
    const summary = createToolEditSummary({
      path: 'note.md',
      beforeContent: ['one', 'two', 'three'].join('\n'),
      afterContent: ['one', 'dos', 'tres'].join('\n'),
    })

    expect(summary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 2,
      totalRemovedLines: 2,
      undoStatus: 'available',
      files: [{ operation: 'edit', reviewRoundId: undefined }],
    })
  })

  it('tracks created files as additions instead of line diffs against empty text', () => {
    const summary = createToolEditSummary({
      path: 'note.md',
      beforeContent: '',
      afterContent: ['one', 'two'].join('\n'),
      beforeExists: false,
      afterExists: true,
    })

    expect(summary).toMatchObject({
      totalAddedLines: 2,
      totalRemovedLines: 0,
      files: [{ operation: 'create' }],
    })
  })

  it('aggregates a group summary by unique file path', () => {
    const firstSummary = createToolEditSummary({
      path: 'note.md',
      beforeContent: 'hello',
      afterContent: ['hello', 'world'].join('\n'),
    })
    const secondSummary = createToolEditSummary({
      path: 'note.md',
      beforeContent: ['hello', 'world'].join('\n'),
      afterContent: ['hello', 'world!'].join('\n'),
    })

    const group = [
      {
        role: 'assistant',
        id: 'assistant-1',
        content: 'done',
      },
      {
        role: 'tool',
        id: 'tool-1',
        toolCalls: [
          {
            request: { id: 'call-1', name: 'yolo_local__fs_edit' },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: '{}',
                metadata: {
                  editSummary: firstSummary,
                },
              },
            },
          },
          {
            request: { id: 'call-2', name: 'yolo_local__fs_edit' },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: '{}',
                metadata: {
                  editSummary: secondSummary,
                },
              },
            },
          },
        ],
      },
    ] as AssistantToolMessageGroup

    const result = collectGroupEditSummary(group)

    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 1,
      totalRemovedLines: 1,
      undoStatus: 'available',
      hasUndoableFiles: true,
    })
    expect(result?.files[0]).toMatchObject({
      path: 'note.md',
      firstRoundId: 'tool-1',
      latestRoundId: 'tool-1',
    })
  })

  it('prefers in-memory snapshots to compute net file deltas', () => {
    const firstSummary = createToolEditSummary({
      path: 'note.md',
      beforeContent: 'hello',
      afterContent: ['hello', 'world'].join('\n'),
    })
    const secondSummary = createToolEditSummary({
      path: 'note.md',
      beforeContent: ['hello', 'world'].join('\n'),
      afterContent: ['hello', 'world!'].join('\n'),
    })
    editUndoSnapshotStore.set({
      toolCallId: 'call-1',
      path: 'note.md',
      beforeContent: 'hello',
      afterContent: ['hello', 'world'].join('\n'),
      beforeExists: true,
      afterExists: true,
      appliedAt: 1,
    })
    editUndoSnapshotStore.set({
      toolCallId: 'call-2',
      path: 'note.md',
      beforeContent: ['hello', 'world'].join('\n'),
      afterContent: ['hello', 'world!'].join('\n'),
      beforeExists: true,
      afterExists: true,
      appliedAt: 2,
    })

    const result = collectGroupEditSummary([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: 'done',
      },
      {
        role: 'tool',
        id: 'tool-1',
        toolCalls: [
          {
            request: { id: 'call-1', name: 'yolo_local__fs_edit' },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: '{}',
                metadata: {
                  editSummary: firstSummary,
                },
              },
            },
          },
          {
            request: { id: 'call-2', name: 'yolo_local__fs_edit' },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: '{}',
                metadata: {
                  editSummary: secondSummary,
                },
              },
            },
          },
        ],
      },
    ] as AssistantToolMessageGroup)

    expect(result).toMatchObject({
      totalAddedLines: 1,
      totalRemovedLines: 0,
    })
  })

  it('derives partial undo status when file states diverge', () => {
    expect(
      deriveToolEditUndoStatus([
        { undoStatus: 'applied' },
        { undoStatus: 'unavailable' },
      ]),
    ).toBe('partial')
  })

  it('counts deleted files by removed content lines', () => {
    expect(
      countFileChangeStats({
        beforeContent: ['one', 'two'].join('\n'),
        afterContent: '',
        beforeExists: true,
        afterExists: false,
      }),
    ).toEqual({
      addedLines: 0,
      removedLines: 2,
    })
  })
})
