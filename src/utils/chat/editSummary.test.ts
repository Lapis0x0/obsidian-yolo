import type { AssistantToolMessageGroup } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  collectGroupEditSummary,
  countFileChangeStats,
  createToolEditSummary,
  deriveToolEditUndoStatus,
  hasFileContentChanged,
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

  it('uses caller-provided counts instead of recomputing the diff', () => {
    const summary = createToolEditSummary({
      path: 'note.md',
      beforeContent: ['one', 'two', 'three'].join('\n'),
      afterContent: ['one', 'dos', 'tres'].join('\n'),
      counts: { addedLines: 40, removedLines: 2, lineStatsAvailable: true },
    })

    expect(summary).toMatchObject({
      totalAddedLines: 40,
      totalRemovedLines: 2,
      files: [{ addedLines: 40, removedLines: 2 }],
    })
  })

  it('still reports no summary for unchanged content even with counts given', () => {
    expect(
      createToolEditSummary({
        path: 'note.md',
        beforeContent: 'same',
        afterContent: 'same',
        counts: { addedLines: 9, removedLines: 9, lineStatsAvailable: true },
      }),
    ).toBeUndefined()
  })

  it('detects whether content changed without computing line stats', () => {
    expect(
      hasFileContentChanged({ beforeContent: 'a', afterContent: 'a' }),
    ).toBe(false)
    expect(
      hasFileContentChanged({ beforeContent: 'a', afterContent: 'b' }),
    ).toBe(true)
    // 内容相同但存在性不同（创建/删除空文件）仍然算变了。
    expect(
      hasFileContentChanged({
        beforeContent: '',
        afterContent: '',
        beforeExists: false,
        afterExists: true,
      }),
    ).toBe(true)
  })

  it('keeps per-file net deltas independent when several files are edited', () => {
    // 净增删按 (first, latest) 这对快照缓存；这里确保缓存不会在文件之间串味，
    // 并且重复调用给出一致结果。
    const makeGroup = (
      entries: Array<{ toolCallId: string; path: string }>,
    ): AssistantToolMessageGroup =>
      [
        { role: 'assistant', id: 'assistant-1', content: 'done' },
        {
          role: 'tool',
          id: 'tool-1',
          toolCalls: entries.map(({ toolCallId, path }) => ({
            request: { id: toolCallId, name: 'yolo_local__fs_edit' },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: '{}',
                metadata: {
                  editSummary: createToolEditSummary({
                    path,
                    beforeContent: 'placeholder',
                    afterContent: 'placeholder changed',
                  }),
                },
              },
            },
          })),
        },
      ] as AssistantToolMessageGroup

    editUndoSnapshotStore.set({
      toolCallId: 'call-a',
      path: 'a.md',
      beforeContent: 'a',
      afterContent: ['a', 'a2', 'a3'].join('\n'),
      beforeExists: true,
      afterExists: true,
      appliedAt: 1,
    })
    editUndoSnapshotStore.set({
      toolCallId: 'call-b',
      path: 'b.md',
      beforeContent: ['b', 'b2', 'b3'].join('\n'),
      afterContent: 'b',
      beforeExists: true,
      afterExists: true,
      appliedAt: 2,
    })

    const group = makeGroup([
      { toolCallId: 'call-a', path: 'a.md' },
      { toolCallId: 'call-b', path: 'b.md' },
    ])

    const first = collectGroupEditSummary(group)
    const second = collectGroupEditSummary(group)

    expect(first?.files).toMatchObject([
      { path: 'a.md', addedLines: 2, removedLines: 0 },
      { path: 'b.md', addedLines: 0, removedLines: 2 },
    ])
    expect(second?.files).toEqual(first?.files)
  })

  it('gives up on line stats instead of guessing when the file is too large', () => {
    // vscode-diff 只给「两侧合计 <1700 行」的 DP 路径传了 timeout，更大的输入
    // 走无上限的 Myers 行对齐（实测 20000 行全量重写要 17 秒）。超过规模上限时
    // 宁可不给数字，也不能让主线程跑到算完。
    const before = Array.from({ length: 2001 }, (_, i) => `原始第 ${i} 行`)
    const after = Array.from({ length: 2001 }, (_, i) => `修改第 ${i} 行`)

    const started = Date.now()
    const stats = countFileChangeStats({
      beforeContent: before.join('\n'),
      afterContent: after.join('\n'),
    })

    expect(stats.lineStatsAvailable).toBe(false)
    // 没有真的去跑 diff——同规模的全量重写在有 timeout 时也要上百毫秒。
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('still counts oversized creates and deletes, which need no diff', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `第 ${i} 行`).join('\n')

    expect(
      countFileChangeStats({
        beforeContent: '',
        afterContent: huge,
        beforeExists: false,
        afterExists: true,
      }),
    ).toEqual({ addedLines: 5000, removedLines: 0, lineStatsAvailable: true })

    expect(
      countFileChangeStats({
        beforeContent: huge,
        afterContent: '',
        beforeExists: true,
        afterExists: false,
      }),
    ).toEqual({ addedLines: 0, removedLines: 5000, lineStatsAvailable: true })
  })

  it('reports available line stats for ordinary edits', () => {
    expect(
      countFileChangeStats({
        beforeContent: ['one', 'two', 'three'].join('\n'),
        afterContent: ['one', 'dos', 'three'].join('\n'),
      }),
    ).toEqual({ addedLines: 1, removedLines: 1, lineStatsAvailable: true })
  })

  it('hides the delta on the summary when line stats are unavailable', () => {
    const summary = createToolEditSummary({
      path: 'note.md',
      beforeContent: 'a',
      afterContent: 'b',
      counts: { addedLines: 0, removedLines: 0, lineStatsAvailable: false },
    })

    expect(summary?.files[0].lineStatsAvailable).toBe(false)
  })

  it('marks group totals unusable when a file could not be counted', () => {
    // 合计是逐文件求和，算不出行数的文件贡献 0，合计就少算了——不能让标题
    // 拿这个残缺的和去冒充完整数字。
    const unavailable = createToolEditSummary({
      path: 'huge.md',
      beforeContent: 'a',
      afterContent: 'b',
      counts: { addedLines: 0, removedLines: 0, lineStatsAvailable: false },
    })

    const result = collectGroupEditSummary([
      { role: 'assistant', id: 'assistant-1', content: 'done' },
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
                metadata: { editSummary: unavailable },
              },
            },
          },
        ],
      },
    ] as AssistantToolMessageGroup)

    expect(result?.totalLineStatsAvailable).toBe(false)
  })

  it('keeps group totals usable for providers that only report turn-wide stats', () => {
    // Claude CLI 只拿得到整轮的 insertions/deletions，于是把每个文件标成
    // 不可用、把整轮数字放进合计。这种情况下合计是准确的，不能被误伤。
    const turnWide = {
      files: [
        {
          path: 'a.md',
          addedLines: 12,
          removedLines: 3,
          lineStatsAvailable: false,
          operation: 'edit' as const,
          undoStatus: 'unavailable' as const,
        },
        {
          path: 'b.md',
          addedLines: 0,
          removedLines: 0,
          lineStatsAvailable: false,
          operation: 'edit' as const,
          undoStatus: 'unavailable' as const,
        },
      ],
      totalFiles: 2,
      totalAddedLines: 12,
      totalRemovedLines: 3,
      undoStatus: 'unavailable' as const,
    }

    const result = collectGroupEditSummary([
      { role: 'assistant', id: 'assistant-1', content: 'done' },
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
                metadata: { editSummary: turnWide },
              },
            },
          },
        ],
      },
    ] as AssistantToolMessageGroup)

    expect(result?.totalLineStatsAvailable).toBe(true)
    expect(result?.files.every((file) => !file.lineStatsAvailable)).toBe(true)
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
      lineStatsAvailable: true,
    })
  })
})
