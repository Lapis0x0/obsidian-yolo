import {
  ToolCallResponseStatus,
  type ToolEditSummary,
} from '../../types/tool-call.types'

import type { ToolLabels } from './ToolMessage'

export type ToolDisplayInfo = {
  displayName: string
  summaryText?: string
}

export type ToolHeadlineParts = {
  titleText: string
  summaryText?: string
  addedLines?: number
  removedLines?: number
}

export const getToolHeadlineParts = ({
  status,
  displayInfo,
  labels,
  editSummary,
}: {
  status: ToolCallResponseStatus
  displayInfo: ToolDisplayInfo
  labels: ToolLabels
  editSummary?: ToolEditSummary
}): ToolHeadlineParts => {
  if (status === ToolCallResponseStatus.Success) {
    return {
      titleText: displayInfo.displayName,
      summaryText: displayInfo.summaryText,
      addedLines: editSummary?.totalAddedLines,
      removedLines: editSummary?.totalRemovedLines,
    }
  }

  const statusLabels = labels.statusLabels
  const statusLabel = statusLabels[status] || labels.unknownStatus
  return {
    titleText: `${statusLabel} ${displayInfo.displayName}`,
    summaryText: displayInfo.summaryText,
  }
}

export const getToolHeadlineText = ({
  status,
  displayInfo,
  labels,
  editSummary,
}: {
  status: ToolCallResponseStatus
  displayInfo: ToolDisplayInfo
  labels: ToolLabels
  editSummary?: ToolEditSummary
}): string => {
  const headlineParts = getToolHeadlineParts({
    status,
    displayInfo,
    labels,
    editSummary,
  })

  const segments = [
    headlineParts.summaryText
      ? `${headlineParts.titleText}: ${headlineParts.summaryText}`
      : headlineParts.titleText,
  ]

  if (
    status === ToolCallResponseStatus.Success &&
    editSummary &&
    typeof headlineParts.addedLines === 'number' &&
    typeof headlineParts.removedLines === 'number'
  ) {
    if (headlineParts.addedLines > 0) {
      segments.push(`+${headlineParts.addedLines}`)
    }
    if (headlineParts.removedLines > 0) {
      segments.push(`-${headlineParts.removedLines}`)
    }
  }

  return segments.join(' ')
}
