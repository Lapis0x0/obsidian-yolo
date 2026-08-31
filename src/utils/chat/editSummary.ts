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
  /** 见 `ToolEditSummary.totalLineStatsAvailable`。false 时不展示合计行数。 */
  totalLineStatsAvailable: boolean
  undoStatus: ToolEditUndoStatus
  hasUndoableFiles: boolean
}

/**
 * 行数统计的结果。`lineStatsAvailable` 为 false 表示这次没能算出可信的行数，
 * 此时 `addedLines` / `removedLines` 无意义——`AssistantEditSummary` 会据此
 * 不渲染 `+N/-M`。撤销和评审都不依赖它。
 */
export type FileChangeStats = {
  addedLines: number
  removedLines: number
  lineStatsAvailable: boolean
}

const UNAVAILABLE_LINE_STATS: FileChangeStats = {
  addedLines: 0,
  removedLines: 0,
  lineStatsAvailable: false,
}

/**
 * 行数统计跑在主线程上，产出的只是聊天卡片上的 `+N/-M`。
 *
 * vscode-diff 把 `maxComputationTimeMs: 0` 解释为「不限时」
 * （`advancedLinesDiffComputer.js` → `InfiniteTimeout`），而 Myers 是
 * O(N·D)：改动行数接近总行数时退化成 O(N²)。不限时的话「4000 行、前一半全部
 * 重写」实测要 13 秒，期间整个 Obsidian 主线程（连窗口按钮）都冻结。
 *
 * 注意这个值不是耗时上界：vscode-diff 只在算法的检查点上看时间，两次检查之间
 * 有一整段不可中断的工作。同一输入下把上限设成 25ms 和设成 200ms 实耗几乎一样
 * （都是那一段的长度，实测约 115ms），所以它的作用是「从不限时变成有限」，而不是
 * 「压到 100ms 以内」。取 100ms 是取一个足够宽松的值，让值得精确统计的常规改动
 * （300~2000 行的编辑实测 3~32ms）绝不会被截断。
 */
const LINE_STATS_MAX_COMPUTATION_MS = 100

/**
 * 单侧行数上限，超过就不统计。
 *
 * 上面那个时间上限管不住行对齐：vscode-diff 只给「两侧合计 < 1700 行」的
 * dynamic-programming 路径传了 timeout，超过这个规模走的是
 * `myersDiffingAlgorithm.compute(sequence1, sequence2)`——没有 timeout 参数，
 * 行对齐会一直跑到算完。实测全量重写：2000 行 99ms、5000 行 520ms、
 * 10000 行 1.6 秒、20000 行 17.7 秒。
 *
 * 代价取决于改动量 D，而 D 只有算完才知道，所以只能按输入规模保守截断。取 2000
 * 行是因为它把最坏情况压在 ~100ms：markdown 笔记极少超过这个长度，而超长文件
 * （通常是代码或数据）损失的只是一个展示数字。
 */
const LINE_STATS_MAX_LINES = 2000

const LINE_DIFF_OPTIONS: ILinesDiffComputerOptions = {
  ignoreTrimWhitespace: false,
  computeMoves: false,
  maxComputationTimeMs: LINE_STATS_MAX_COMPUTATION_MS,
}

export const countChangedLines = (
  beforeContent: string,
  afterContent: string,
): FileChangeStats => {
  const beforeLines = beforeContent.split('\n')
  const afterLines = afterContent.split('\n')

  if (
    beforeLines.length > LINE_STATS_MAX_LINES ||
    afterLines.length > LINE_STATS_MAX_LINES
  ) {
    return UNAVAILABLE_LINE_STATS
  }

  const diffComputer = new AdvancedLinesDiffComputer()
  const result = diffComputer.computeDiff(
    beforeLines,
    afterLines,
    LINE_DIFF_OPTIONS,
  )

  // `hitTimeout` 只说明结果是近似的，没说近似到什么程度：超时若发生在行对齐
  // 完成之前，vscode-diff 会退化成「整份文件全部替换」，把只改了一行的编辑报成
  // 全删全增。宁可不给数字，也不给一个看起来精确的错数字。
  if (result.hitTimeout) {
    return UNAVAILABLE_LINE_STATS
  }

  return result.changes.reduce<FileChangeStats>(
    (acc, change) => {
      acc.removedLines +=
        change.originalRange.endLineNumberExclusive -
        change.originalRange.startLineNumber
      acc.addedLines +=
        change.modifiedRange.endLineNumberExclusive -
        change.modifiedRange.startLineNumber
      return acc
    },
    { addedLines: 0, removedLines: 0, lineStatsAvailable: true },
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
}): FileChangeStats => {
  if (!beforeExists && !afterExists) {
    return { addedLines: 0, removedLines: 0, lineStatsAvailable: true }
  }

  // 纯创建/纯删除不需要 diff，数行即可，无论多大都能给出准确数字。
  if (!beforeExists) {
    return {
      addedLines: countContentLines(afterContent),
      removedLines: 0,
      lineStatsAvailable: true,
    }
  }

  if (!afterExists) {
    return {
      addedLines: 0,
      removedLines: countContentLines(beforeContent),
      lineStatsAvailable: true,
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
  counts?: FileChangeStats
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

  const { addedLines, removedLines, lineStatsAvailable } =
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
      lineStatsAvailable,
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
    // 单文件摘要的合计就是这个文件本身，文件的行数算不出来，合计也就无从谈起。
    totalLineStatsAvailable: lineStatsAvailable,
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
  WeakMap<EditUndoSnapshot, FileChangeStats>
>()

const countSnapshotPairChangeStats = (
  firstSnapshot: EditUndoSnapshot,
  latestSnapshot: EditUndoSnapshot,
): FileChangeStats => {
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
    const counts: FileChangeStats =
      firstSnapshot && latestSnapshot
        ? countSnapshotPairChangeStats(firstSnapshot, latestSnapshot)
        : {
            addedLines: value.addedLines,
            removedLines: value.removedLines,
            lineStatsAvailable: value.lineStatsAvailable,
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
      // 累计统计是重算的，它自己的可用性说了算；只有在拿不到快照、退回逐次
      // 数字时，才沿用逐次统计聚合出来的可用性。
      lineStatsAvailable: counts.lineStatsAvailable,
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
    // 合计是逐文件求和，所以只要有一个文件的行数没算出来，合计就是残缺的。
    // 注意不能用 files.every(lineStatsAvailable)：只报告整轮 insertions/deletions
    // 的 provider（Claude CLI）把每个文件标成不可用，合计却是准确的。
    totalLineStatsAvailable: entries.every(
      ({ summary }) => summary.totalLineStatsAvailable !== false,
    ),
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
