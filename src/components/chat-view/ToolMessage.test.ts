import { ToolCallResponseStatus } from '../../types/tool-call.types'

import type { ToolLabels } from './ToolMessage'
import { getToolHeadlineParts, getToolHeadlineText } from './toolHeadline'

describe('ToolMessage headline helpers', () => {
  const labels: ToolLabels = {
    statusLabels: {
      [ToolCallResponseStatus.PendingApproval]: 'Call',
      [ToolCallResponseStatus.Rejected]: 'Rejected',
      [ToolCallResponseStatus.Running]: 'Running',
      [ToolCallResponseStatus.Success]: '',
      [ToolCallResponseStatus.Error]: 'Failed',
      [ToolCallResponseStatus.Aborted]: 'Aborted',
    },
    unknownStatus: 'Unknown',
    displayNames: {},
    writeActionLabels: {},
    target: 'Target',
    scope: 'Scope',
    query: 'Query',
    path: 'Path',
    paths: 'paths',
    parameters: 'Parameters',
    noParameters: 'No parameters',
    result: 'Result',
    error: 'Error',
    allow: 'Allow',
    reject: 'Reject',
    abort: 'Abort',
    allowForThisChat: 'Allow for this chat',
  }

  it('appends edit deltas after the path for successful edit calls', () => {
    const displayInfo = {
      displayName: 'Text editing',
      summaryText: 'Folder/Internal Transaction Closed-loop Design Schedule.md',
    }

    expect(
      getToolHeadlineText({
        status: ToolCallResponseStatus.Success,
        displayInfo,
        labels,
        editSummary: {
          files: [],
          totalFiles: 1,
          totalAddedLines: 8,
          totalRemovedLines: 0,
          undoStatus: 'available',
        },
      }),
    ).toBe(
      'Text editing: Folder/Internal Transaction Closed-loop Design Schedule.md +8 -0',
    )
  })

  it('separates title, path, and deltas for header layout', () => {
    expect(
      getToolHeadlineParts({
        status: ToolCallResponseStatus.Success,
        displayInfo: {
          displayName: 'Text editing',
          summaryText: 'schedule.md',
        },
        labels,
        editSummary: {
          files: [],
          totalFiles: 1,
          totalAddedLines: 3,
          totalRemovedLines: 1,
          undoStatus: 'available',
        },
      }),
    ).toEqual({
      titleText: 'Text editing',
      summaryText: 'schedule.md',
      addedLines: 3,
      removedLines: 1,
    })
  })
})
