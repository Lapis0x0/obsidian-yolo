import type { AssistantToolMessageGroup } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { editUndoSnapshotStore } from './editUndoSnapshotStore'

import {
  collectGroupEditSummary,
  createToolEditSummary,
  deriveToolEditUndoStatus,
} from './editSummary'

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
    expect(result?.files[0]?.path).toBe('note.md')
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
      appliedAt: 1,
    })
    editUndoSnapshotStore.set({
      toolCallId: 'call-2',
      path: 'note.md',
      beforeContent: ['hello', 'world'].join('\n'),
      afterContent: ['hello', 'world!'].join('\n'),
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
})
