import {
  AdvancedLinesDiffComputer,
  type ILinesDiffComputerOptions,
} from 'vscode-diff'

import type {
  AssistantToolMessageGroup,
  ChatToolMessage,
} from '../../types/chat'
import type {
  ToolCallResponse,
  ToolEditOperation,
  ToolEditSummary,
  ToolEditSummaryFile,
  ToolEditUndoStatus,
} from '../../types/tool-call.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  type EditUndoSnapshot,
  editUndoSnapshotStore,
} from './editUndoSnapshotStore'

export type GroupEditSummaryEntry = {
  toolMessageId: string
  toolCallId: string
  summary: ToolEditSummary
}

export type GroupEditSummaryPathItem = {
  path: string
  addedLines: number
  removedLines: number
  lineStatsAvailable: boolean
  operation: ToolEditOperation
  undoStatus: ToolEditUndoStatus
  firstRoundId: string
  latestRoundId: string
}

export type GroupEditSummary = {
  entries: GroupEditSummaryEntry[]
  files: GroupEditSummaryPathItem[]
  totalFiles: number
  totalAddedLines: number
  totalRemovedLines: number
  undoStatus: ToolEditUndoStatus
  hasUndoableFiles: boolean
}

/**
 * 行数统计跑在主线程上，产出的只是聊天卡片上的 `+N/-M`。
 *
 * vscode-diff 把 `maxComputationTimeMs: 0` 解释为「不限时」
 * （`advancedLinesDiffComputer.js` → `InfiniteTimeout`），而 Myers 是
 * O(N·D)：改动行数接近总行数时退化成 O(N²)。实测「4000 行、前一半全部重写」
 * 这种输入不限时要 13 秒，期间整个 Obsidian 主线程（连窗口按钮）都冻结。
 *
 * 注意这个值不是耗时上界：vscode-diff 只在算法的检查点上看时间，两次检查之间
 * 有一整段不可中断的工作。同一输入下把上限设成 25ms 和设成 200ms 实耗几乎一样
 * （都是那一段的长度，实测约 115ms），所以它的作用是「从不限时变成有限」，而不是
 * 「压到 100ms 以内」。取 100ms 是取一个足够宽松的值，让值得精确统计的常规改动
 * （300~2000 行的编辑实测 3~32ms）绝不会被截断。
 *
 * 超时后 vscode-diff 是按区段降级而不是整体放弃，行数统计因此几乎不受影响：
 * 上面那个输入在有上限时仍然给出与不限时完全相同的 +2000/-2000。
 */
const LINE_STATS_MAX_COMPUTATION_MS = 100

const LINE_DIFF_OPTIONS: ILinesDiffComputerOptions = {
  ignoreTrimWhitespace: false,
  computeMoves: false,
  maxComputationTimeMs: LINE_STATS_MAX_COMPUTATION_MS,
}

export const countChangedLines = (
  beforeContent: string,
  afterContent: string,
) => {
  const beforeLines = beforeContent.split('\n')
  const afterLines = afterContent.split('\n')
  const diffComputer = new AdvancedLinesDiffComputer()
  const changes = diffComputer.computeDiff(
    beforeLines,
    afterLines,
    LINE_DIFF_OPTIONS,
  ).changes

  return changes.reduce(
    (acc, change) => {
      acc.removedLines +=
        change.originalRange.endLineNumberExclusive -
        change.originalRange.startLineNumber
      acc.addedLines +=
        change.modifiedRange.endLineNumberExclusive -
        change.modifiedRange.startLineNumber
      return acc
    },
    { addedLines: 0, removedLines: 0 },
  )
}

const countContentLines = (content: string): number => {
  return content.length === 0 ? 0 : content.split('\n').length
}

export const countFileChangeStats = ({
  beforeContent,
  afterContent,
  beforeExists = true,
  afterExists = true,
}: {
  beforeContent: string
  afterContent: string
  beforeExists?: boolean
  afterExists?: boolean
}) => {
  if (!beforeExists && !afterExists) {
    return { addedLines: 0, removedLines: 0 }
  }

  if (!beforeExists) {
    return {
      addedLines: countContentLines(afterContent),
      removedLines: 0,
    }
  }

  if (!afterExists) {
    return {
      addedLines: 0,
      removedLines: countContentLines(beforeContent),
    }
  }

  return countChangedLines(beforeContent, afterContent)
}

const deriveToolEditOperation = ({
  beforeExists,
  afterExists,
}: {
  beforeExists: boolean
  afterExists: boolean
}): ToolEditOperation => {
  if (!beforeExists && afterExists) {
    return 'create'
  }
  if (beforeExists && !afterExists) {
    return 'delete'
  }
  return 'edit'
}

export const deriveToolEditUndoStatus = (
  files: Array<Pick<ToolEditSummaryFile, 'undoStatus'>>,
): ToolEditUndoStatus => {
  if (files.length === 0) {
    return 'unavailable'
  }

  const statuses = new Set(files.map((file) => file.undoStatus))
  if (statuses.size === 1) {
    return files[0].undoStatus
  }

  return 'partial'
}

/**
 * 内容是否真的变了——`createToolEditSummary` 返回 `undefined` 的判据。
 * 单独导出是为了让调用方在不需要行数的路径上先判断，而不必为了拿这个布尔值
 * 去跑一次全文 diff。
 */
export const hasFileContentChanged = ({
  beforeContent,
  afterContent,
  beforeExists = true,
  afterExists = true,
}: {
  beforeContent: string
  afterContent: string
  beforeExists?: boolean
  afterExists?: boolean
}): boolean => !(beforeExists === afterExists && beforeContent === afterContent)

export const createToolEditSummary = ({
  path,
  beforeContent,
  afterContent,
  beforeExists = true,
  afterExists = true,
  reviewRoundId,
  counts,
}: {
  path: string
  beforeContent: string
  afterContent: string
  beforeExists?: boolean
  afterExists?: boolean
  reviewRoundId?: string
  /**
   * 已经算好的行数。调用方手上已有统计结果时传进来，避免为同一份内容重复跑
   * 一次全文 diff。
   */
  counts?: { addedLines: number; removedLines: number }
}): ToolEditSummary | undefined => {
  if (
    !hasFileContentChanged({
      beforeContent,
      afterContent,
      beforeExists,
      afterExists,
    })
  ) {
    return undefined
  }

  const { addedLines, removedLines } =
    counts ??
    countFileChangeStats({
      beforeContent,
      afterContent,
      beforeExists,
      afterExists,
    })

  const files: ToolEditSummaryFile[] = [
    {
      path,
      addedLines,
      removedLines,
      operation: deriveToolEditOperation({ beforeExists, afterExists }),
      undoStatus: 'available',
      reviewRoundId,
    },
  ]

  return {
    files,
    totalFiles: 1,
    totalAddedLines: addedLines,
    totalRemovedLines: removedLines,
    undoStatus: deriveToolEditUndoStatus(files),
  }
}

export const getToolCallEditSummary = (
  response: ToolCallResponse,
): ToolEditSummary | undefined => {
  if (response.status !== ToolCallResponseStatus.Success) {
    return undefined
  }

  return response.data.metadata?.editSummary
}

const aggregateUndoStatus = (
  statuses: ToolEditUndoStatus[],
): ToolEditUndoStatus => {
  if (statuses.length === 0) {
    return 'unavailable'
  }

  const unique = new Set(statuses)
  if (unique.size === 1) {
    return statuses[0]
  }

  return 'partial'
}

/**
 * 一对 undo 快照之间的净增删行数。
 *
 * 这是渲染路径上的计算：`collectGroupEditSummary` 由消息组的 `useMemo` 调用，
 * agent 运行期间每次工具调用的发起/返回、每次正文落盘都会让消息组重渲染，而
 * 每次重渲染都要把该组「至今编辑过的所有文件」重新统计一遍——代价是
 * 轮次 × 文件数 × 单次 diff，运行越久越重。
 *
 * 快照按 toolCallId 建立后不再变更，所以同一对快照的结果是常量，缓存即可。
 * 用嵌套 WeakMap 是为了让缓存随快照一起被回收：`editUndoSnapshotStore` 清空
 * 或删除某次编辑时，对应的缓存自然失效，不需要另写一套失效逻辑。
 */
const snapshotPairChangeStatsCache = new WeakMap<
  EditUndoSnapshot,
  WeakMap<EditUndoSnapshot, { addedLines: number; removedLines: number }>
>()

const countSnapshotPairChangeStats = (
  firstSnapshot: EditUndoSnapshot,
  latestSnapshot: EditUndoSnapshot,
): { addedLines: number; removedLines: number } => {
  let byLatest = snapshotPairChangeStatsCache.get(firstSnapshot)
  if (!byLatest) {
    byLatest = new WeakMap()
    snapshotPairChangeStatsCache.set(firstSnapshot, byLatest)
  }

  const cached = byLatest.get(latestSnapshot)
  if (cached) {
    return cached
  }

  const counts = countFileChangeStats({
    beforeContent: firstSnapshot.beforeContent,
    afterContent: latestSnapshot.afterContent,
    beforeExists: firstSnapshot.beforeExists,
    afterExists: latestSnapshot.afterExists,
  })
  byLatest.set(latestSnapshot, counts)
  return counts
}

export const collectGroupEditSummary = (
  messages: AssistantToolMessageGroup,
): GroupEditSummary | null => {
  const entries: GroupEditSummaryEntry[] = []

  messages.forEach((message) => {
    if (message.role !== 'tool') {
      return
    }

    message.toolCalls.forEach((toolCall) => {
      const summary = getToolCallEditSummary(toolCall.response)
      if (!summary || summary.files.length === 0) {
        return
      }

      entries.push({
        toolMessageId: message.id,
        toolCallId: toolCall.request.id,
        summary,
      })
    })
  })

  if (entries.length === 0) {
    return null
  }

  const pathMap = new Map<
    string,
    {
      firstToolCallId: string
      addedLines: number
      removedLines: number
      operation: ToolEditOperation
      lineStatsAvailable: boolean
      statuses: ToolEditUndoStatus[]
      latestToolCallId: string
      firstRoundId: string
      latestRoundId: string
    }
  >()

  entries.forEach((entry) => {
    const { summary } = entry
    summary.files.forEach((file) => {
      const roundId = file.reviewRoundId ?? entry.toolMessageId
      const existing = pathMap.get(file.path)
      if (!existing) {
        pathMap.set(file.path, {
          firstToolCallId: entry.toolCallId,
          addedLines: file.addedLines,
          removedLines: file.removedLines,
          operation: file.operation,
          lineStatsAvailable: file.lineStatsAvailable !== false,
          statuses: [file.undoStatus],
          latestToolCallId: entry.toolCallId,
          firstRoundId: roundId,
          latestRoundId: roundId,
        })
        return
      }

      existing.addedLines = file.addedLines
      existing.removedLines = file.removedLines
      existing.operation = file.operation
      existing.lineStatsAvailable =
        existing.lineStatsAvailable && file.lineStatsAvailable !== false
      existing.statuses.push(file.undoStatus)
      existing.latestToolCallId = entry.toolCallId
      existing.latestRoundId = roundId
    })
  })

  const files = [...pathMap.entries()].map(([path, value]) => {
    const firstSnapshot = editUndoSnapshotStore.get(value.firstToolCallId, path)
    const latestSnapshot = editUndoSnapshotStore.get(
      value.latestToolCallId,
      path,
    )
    const counts =
      firstSnapshot && latestSnapshot
        ? countSnapshotPairChangeStats(firstSnapshot, latestSnapshot)
        : {
            addedLines: value.addedLines,
            removedLines: value.removedLines,
          }
    const operation =
      firstSnapshot && latestSnapshot
        ? deriveToolEditOperation({
            beforeExists: firstSnapshot.beforeExists,
            afterExists: latestSnapshot.afterExists,
          })
        : value.operation

    return {
      path,
      addedLines: counts.addedLines,
      removedLines: counts.removedLines,
      operation,
      lineStatsAvailable: value.lineStatsAvailable,
      undoStatus: aggregateUndoStatus(value.statuses),
      firstRoundId: value.firstRoundId,
      latestRoundId: value.latestRoundId,
    }
  })

  const undoStatus = aggregateUndoStatus(files.map((file) => file.undoStatus))

  return {
    entries,
    files,
    totalFiles: files.length,
    totalAddedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    totalRemovedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
    undoStatus,
    hasUndoableFiles: entries.some(({ summary }) =>
      summary.files.some((file) => file.undoStatus === 'available'),
    ),
  }
}

export const updateToolMessageEditSummary = ({
  toolMessage,
  toolCallId,
  editSummary,
}: {
  toolMessage: ChatToolMessage
  toolCallId: string
  editSummary: ToolEditSummary
}): ChatToolMessage => {
  return {
    ...toolMessage,
    toolCalls: toolMessage.toolCalls.map((toolCall) => {
      if (
        toolCall.request.id !== toolCallId ||
        toolCall.response.status !== ToolCallResponseStatus.Success
      ) {
        return toolCall
      }

      return {
        ...toolCall,
        response: {
          ...toolCall.response,
          data: {
            ...toolCall.response.data,
            metadata: {
              ...toolCall.response.data.metadata,
              editSummary,
            },
          },
        },
      }
    }),
  }
}
