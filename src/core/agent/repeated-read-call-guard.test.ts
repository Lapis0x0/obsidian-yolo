import type { ChatToolMessage } from '../../types/chat'
import type { ToolCallResponse } from '../../types/tool-call.types'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import {
  applyRepeatedReadCallGuard,
  createRepeatedReadCallGuardState,
  createRepeatedReadCallTermination,
  createRepeatedReadCallWarning,
} from './repeated-read-call-guard'

type ToolMessageEntry = {
  id: string
  name?: string
  args?: Record<string, unknown>
  status?: ToolCallResponseStatus
}

const createResponse = (status?: ToolCallResponseStatus): ToolCallResponse => {
  if (status === ToolCallResponseStatus.Error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: 'failed',
    }
  }

  return {
    status: ToolCallResponseStatus.Success,
    data: { type: 'text', text: 'file content' },
  }
}

const createToolMessage = (entries: ToolMessageEntry[]): ChatToolMessage => ({
  role: 'tool',
  id: 'tool-message',
  toolCalls: entries.map((entry) => ({
    request: {
      id: entry.id,
      name: entry.name ?? 'yolo_local__fs_read',
      arguments: createCompleteToolCallArguments({
        value: entry.args ?? { paths: ['Daily.md'] },
      }),
    },
    response: createResponse(entry.status),
  })),
})

const getError = (message: ChatToolMessage): string => {
  const response = message.toolCalls[0]?.response
  if (response?.status !== ToolCallResponseStatus.Error) {
    throw new Error('expected Error response')
  }
  return response.error
}

const createGuardRunner = () => {
  let state = createRepeatedReadCallGuardState()

  return (entries: ToolMessageEntry[]) => {
    const result = applyRepeatedReadCallGuard({
      state,
      toolMessage: createToolMessage(entries),
    })
    state = result.state
    return result
  }
}

describe('repeated read call guard', () => {
  it('replaces the third consecutive identical fs_read success with a warning', () => {
    const runGuard = createGuardRunner()

    runGuard([{ id: 'call-1' }])
    runGuard([{ id: 'call-2' }])

    const result = runGuard([{ id: 'call-3' }])

    expect(result.forceStopReason).toBeUndefined()
    expect(getError(result.toolMessage)).toBe(createRepeatedReadCallWarning())
  })

  it('stops after the warned fs_read signature succeeds again', () => {
    const runGuard = createGuardRunner()

    for (let index = 1; index <= 3; index += 1) {
      runGuard([{ id: `call-${index}` }])
    }

    const result = runGuard([{ id: 'call-4' }])

    expect(result.forceStopReason).toBe('repeated_read_call')
    expect(getError(result.toolMessage)).toBe(
      createRepeatedReadCallTermination(),
    )
  })

  it('treats argument objects with different key order as the same read', () => {
    const runGuard = createGuardRunner()

    runGuard([
      {
        id: 'call-1',
        args: {
          paths: ['Daily.md'],
          operation: { type: 'lines', startLine: 1 },
        },
      },
    ])
    runGuard([
      {
        id: 'call-2',
        args: {
          operation: { startLine: 1, type: 'lines' },
          paths: ['Daily.md'],
        },
      },
    ])

    const result = runGuard([
      {
        id: 'call-3',
        args: {
          paths: ['Daily.md'],
          operation: { type: 'lines', startLine: 1 },
        },
      },
    ])

    expect(getError(result.toolMessage)).toBe(createRepeatedReadCallWarning())
  })

  it('resets when fs_read arguments change', () => {
    const runGuard = createGuardRunner()

    runGuard([{ id: 'call-1' }])
    runGuard([{ id: 'call-2' }])
    const result = runGuard([
      {
        id: 'call-3',
        args: {
          paths: ['Daily.md'],
          operation: { type: 'lines', startLine: 1 },
        },
      },
    ])

    expect(result.toolMessage.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Success,
    )
    expect(result.forceStopReason).toBeUndefined()
  })

  it('resets when a different tool succeeds', () => {
    const runGuard = createGuardRunner()

    runGuard([{ id: 'call-1' }])
    runGuard([{ id: 'call-2' }])
    runGuard([{ id: 'call-3', name: 'yolo_local__fs_search' }])
    const result = runGuard([{ id: 'call-4' }])

    expect(result.toolMessage.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Success,
    )
    expect(result.forceStopReason).toBeUndefined()
  })

  it('does not count failed fs_read responses', () => {
    const runGuard = createGuardRunner()

    runGuard([{ id: 'call-1' }])
    runGuard([{ id: 'call-2', status: ToolCallResponseStatus.Error }])
    const result = runGuard([{ id: 'call-3' }])

    expect(result.toolMessage.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Success,
    )
    expect(result.forceStopReason).toBeUndefined()
  })
})
