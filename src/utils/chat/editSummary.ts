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

import { editUndoSnapshotStore } from './editUndoSnapshotStore'

export type GroupEditSummaryEntry = {
  toolMessageId: string
  toolCallId: string
  summary: ToolEditSummary
}

export type GroupEditSummaryPathItem = {
  path: string
  addedLines: number
  removedLines: number
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

const LINE_DIFF_OPTIONS: ILinesDiffComputerOptions = {
  ignoreTrimWhitespace: false,
  computeMoves: false,
  maxComputationTimeMs: 0,
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

export const createToolEditSummary = ({
  path,
  beforeContent,
  afterContent,
  beforeExists = true,
  afterExists = true,
  reviewRoundId,
}: {
  path: string
  beforeContent: string
  afterContent: string
  beforeExists?: boolean
  afterExists?: boolean
  reviewRoundId?: string
}): ToolEditSummary | undefined => {
  if (beforeExists === afterExists && beforeContent === afterContent) {
    return undefined
  }

  const { addedLines, removedLines } = countFileChangeStats({
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
        ? countFileChangeStats({
            beforeContent: firstSnapshot.beforeContent,
            afterContent: latestSnapshot.afterContent,
            beforeExists: firstSnapshot.beforeExists,
            afterExists: latestSnapshot.afterExists,
          })
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
