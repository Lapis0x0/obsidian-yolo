import type { ChatToolMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  applyRepeatedToolFailureGuard,
  createRepeatedToolFailureGuardState,
  createRepeatedToolFailureTermination,
  createRepeatedToolFailureWarning,
} from './repeated-tool-failure-guard'

type ToolMessageEntry = {
  id: string
  name: string
  status: ToolCallResponseStatus
  error?: string
}

const createToolMessage = (entries: ToolMessageEntry[]): ChatToolMessage => ({
  role: 'tool',
  id: 'tool-message',
  toolCalls: entries.map((entry) => ({
    request: {
      id: entry.id,
      name: entry.name,
    },
    response:
      entry.status === ToolCallResponseStatus.Success
        ? {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: 'ok' },
          }
        : entry.status === ToolCallResponseStatus.Error
          ? {
              status: ToolCallResponseStatus.Error,
              error: entry.error ?? 'failed',
            }
          : { status: entry.status },
  })),
})

const getError = (message: ChatToolMessage, index = 0): string => {
  const response = message.toolCalls[index]?.response
  if (response?.status !== ToolCallResponseStatus.Error) {
    throw new Error('expected Error response')
  }
  return response.error
}

const createGuardRunner = () => {
  let state = createRepeatedToolFailureGuardState()

  return (entries: ToolMessageEntry[]) => {
    const result = applyRepeatedToolFailureGuard({
      state,
      toolMessage: createToolMessage(entries),
    })
    state = result.state
    return result
  }
}

describe('repeated tool failure guard', () => {
  it('adds a warning on the third consecutive Error from the same tool', () => {
    const runGuard = createGuardRunner()

    runGuard([
      {
        id: 'call-1',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])
    runGuard([
      {
        id: 'call-2',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])

    const result = runGuard([
      {
        id: 'call-3',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])

    expect(result.forceStopReason).toBeUndefined()
    expect(getError(result.toolMessage)).toContain(
      createRepeatedToolFailureWarning('server__tool_a'),
    )
  })

  it('stops after the warned tool returns Error again', () => {
    const runGuard = createGuardRunner()

    for (let index = 1; index <= 3; index += 1) {
      runGuard([
        {
          id: `call-${index}`,
          name: 'server__tool_a',
          status: ToolCallResponseStatus.Error,
        },
      ])
    }

    const result = runGuard([
      {
        id: 'call-4',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])

    expect(result.forceStopReason).toBe('repeated_tool_failure')
    expect(getError(result.toolMessage)).toContain(
      createRepeatedToolFailureTermination('server__tool_a'),
    )
  })

  it('resets the count when a different tool returns Error', () => {
    const runGuard = createGuardRunner()

    runGuard([
      {
        id: 'call-1',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])
    runGuard([
      {
        id: 'call-2',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])
    runGuard([
      {
        id: 'call-3',
        name: 'server__tool_b',
        status: ToolCallResponseStatus.Error,
      },
    ])

    const result = runGuard([
      {
        id: 'call-4',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])

    expect(getError(result.toolMessage)).not.toContain(
      createRepeatedToolFailureWarning('server__tool_a'),
    )
    expect(result.forceStopReason).toBeUndefined()
  })

  it('resets the count when the same tool succeeds', () => {
    const runGuard = createGuardRunner()

    runGuard([
      {
        id: 'call-1',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])
    runGuard([
      {
        id: 'call-2',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])
    runGuard([
      {
        id: 'call-3',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Success,
      },
    ])

    const result = runGuard([
      {
        id: 'call-4',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])

    expect(getError(result.toolMessage)).not.toContain(
      createRepeatedToolFailureWarning('server__tool_a'),
    )
    expect(result.forceStopReason).toBeUndefined()
  })

  it('does not count non-Error tool responses as failures', () => {
    const runGuard = createGuardRunner()

    const statuses = [
      ToolCallResponseStatus.Rejected,
      ToolCallResponseStatus.Aborted,
      ToolCallResponseStatus.PendingApproval,
      ToolCallResponseStatus.AwaitingUserInput,
    ]

    for (const [index, status] of statuses.entries()) {
      runGuard([
        {
          id: `call-${index}`,
          name: 'server__tool_a',
          status,
        },
      ])
    }

    const result = runGuard([
      {
        id: 'call-error',
        name: 'server__tool_a',
        status: ToolCallResponseStatus.Error,
      },
    ])

    expect(getError(result.toolMessage)).not.toContain(
      createRepeatedToolFailureWarning('server__tool_a'),
    )
    expect(result.forceStopReason).toBeUndefined()
  })
})
