import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type { NativeAgentRuntime } from '../native-runtime'

import {
  autoRejectPendingApprovals,
  buildSubagentContinuationInput,
  hasUnsettledApprovalBatch,
} from './runner'

const makeRuntime = (
  toolMessage: {
    role: 'tool'
    toolCalls: Array<{
      request: { id: string; name: string }
      response: { status: ToolCallResponseStatus; error?: string }
    }>
  } | null,
) => {
  const setToolCallResponse = jest.fn()
  return {
    runtime: {
      getSnapshot: jest.fn().mockReturnValue({
        messages: toolMessage ? [toolMessage] : [],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      }),
      setToolCallResponse,
    } as unknown as NativeAgentRuntime,
    setToolCallResponse,
  }
}

describe('autoRejectPendingApprovals', () => {
  it('rejects only PendingApproval calls and leaves others intact', () => {
    const { runtime, setToolCallResponse } = makeRuntime({
      role: 'tool',
      toolCalls: [
        {
          request: { id: 'pending-1', name: 'tool' },
          response: { status: ToolCallResponseStatus.PendingApproval },
        },
        {
          request: { id: 'running-1', name: 'tool' },
          response: { status: ToolCallResponseStatus.Running },
        },
        {
          request: { id: 'pending-2', name: 'tool' },
          response: { status: ToolCallResponseStatus.PendingApproval },
        },
      ],
    })

    autoRejectPendingApprovals(runtime)

    expect(setToolCallResponse).toHaveBeenCalledTimes(2)
    expect(setToolCallResponse).toHaveBeenCalledWith(
      'pending-1',
      expect.objectContaining({
        status: ToolCallResponseStatus.Error,
        error: expect.stringContaining('5 minutes'),
      }),
    )
    expect(setToolCallResponse).toHaveBeenCalledWith(
      'pending-2',
      expect.any(Object),
    )
    // Running call must not be touched.
    expect(setToolCallResponse).not.toHaveBeenCalledWith(
      'running-1',
      expect.any(Object),
    )
  })

  it('is a no-op when the last message is not a tool message', () => {
    const { runtime, setToolCallResponse } = makeRuntime(null)
    autoRejectPendingApprovals(runtime)
    expect(setToolCallResponse).not.toHaveBeenCalled()
  })

  it('is a no-op when no tool calls are pending', () => {
    const { runtime, setToolCallResponse } = makeRuntime({
      role: 'tool',
      toolCalls: [
        {
          request: { id: 'done-1', name: 'tool' },
          response: { status: ToolCallResponseStatus.Success },
        },
      ],
    })
    autoRejectPendingApprovals(runtime)
    expect(setToolCallResponse).not.toHaveBeenCalled()
  })
})

describe('hasUnsettledApprovalBatch', () => {
  const messagesWithStatuses = (statuses: ToolCallResponseStatus[]) =>
    [
      {
        role: 'tool' as const,
        id: 'tool-message',
        toolCalls: statuses.map((status, index) => ({
          request: { id: `call-${index}`, name: 'tool' },
          response: { status },
        })),
      },
    ] as Parameters<typeof hasUnsettledApprovalBatch>[0]

  it.each([
    ToolCallResponseStatus.PendingApproval,
    ToolCallResponseStatus.AwaitingUserInput,
    ToolCallResponseStatus.Running,
  ])('keeps the batch paused while a call is %s', (status) => {
    expect(
      hasUnsettledApprovalBatch(
        messagesWithStatuses([ToolCallResponseStatus.Success, status]),
      ),
    ).toBe(true)
  })

  it('allows the batch to resume after every call is terminal', () => {
    expect(
      hasUnsettledApprovalBatch(
        messagesWithStatuses([
          ToolCallResponseStatus.Success,
          ToolCallResponseStatus.Rejected,
          ToolCallResponseStatus.Error,
        ]),
      ),
    ).toBe(false)
  })
})

describe('buildSubagentContinuationInput', () => {
  it('keeps the original request prefix instead of replaying runtime messages', () => {
    const requestMessages = [{ role: 'user', content: 'original prompt' }]
    const input = {
      messages: requestMessages,
      requestMessages,
      conversationId: 'sub-test',
    } as unknown as Parameters<typeof buildSubagentContinuationInput>[0]

    const continuation = buildSubagentContinuationInput(input)

    expect(continuation.messages).toBe(requestMessages)
    expect(continuation.requestMessages).toBe(requestMessages)
  })

  it('freezes messages as the request prefix when no explicit prefix exists', () => {
    const messages = [{ role: 'user', content: 'original prompt' }]
    const input = {
      messages,
      conversationId: 'sub-test',
    } as unknown as Parameters<typeof buildSubagentContinuationInput>[0]

    const continuation = buildSubagentContinuationInput(input)

    expect(continuation.requestMessages).toBe(messages)
  })
})
