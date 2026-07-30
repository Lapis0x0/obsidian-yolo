import type { ChatMessage } from '../../types/chat'

import { createYoloChatRuntimeActions } from './yolo-actions'
import type { YoloChatRuntimeActionService } from './yolo-actions'

const conversation = {
  runtimeId: 'yolo',
  conversationId: 'conversation-1',
} as const

const createService = (): jest.Mocked<YoloChatRuntimeActionService> =>
  ({
    abortConversation: jest.fn(() => true),
    abortToolCall: jest.fn(() => true),
    answerUserQuestion: jest.fn(async () => ({ kind: 'continued' })),
    approveToolCall: jest.fn(async () => true),
    cancelAskUserQuestion: jest.fn(() => true),
    rejectToolCall: jest.fn(() => true),
  }) as unknown as jest.Mocked<YoloChatRuntimeActionService>

describe('createYoloChatRuntimeActions', () => {
  it('delegates run cancellation to AgentService', async () => {
    const service = createService()
    const actions = createYoloChatRuntimeActions(service)

    await actions.cancelRun(conversation)

    expect(service.abortConversation).toHaveBeenCalledWith('conversation-1')
  })

  it('maps one-off and conversation-wide approvals to handled or stale', async () => {
    const service = createService()
    const actions = createYoloChatRuntimeActions(service)

    await expect(
      actions.approveTool({ conversation, toolCallId: 'tool-1' }),
    ).resolves.toEqual({ kind: 'handled' })
    expect(service.approveToolCall).toHaveBeenLastCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      allowForConversation: undefined,
    })

    service.approveToolCall.mockResolvedValueOnce(false)
    await expect(
      actions.approveTool({
        conversation,
        toolCallId: 'tool-2',
        allowForConversation: true,
      }),
    ).resolves.toEqual({ kind: 'stale' })
    expect(service.approveToolCall).toHaveBeenLastCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'tool-2',
      allowForConversation: true,
    })
  })

  it('maps reject and abort results without changing their synchronous service semantics', async () => {
    const service = createService()
    const abortSubagentTask = jest.fn()
    const listSubagentTasks = jest.fn(() => [])
    const actions = createYoloChatRuntimeActions(service, {
      abortSubagentTask,
      listSubagentTasks,
    })

    await expect(
      actions.rejectTool({ conversation, toolCallId: 'reject-1' }),
    ).resolves.toEqual({ kind: 'handled' })
    service.rejectToolCall.mockReturnValueOnce(false)
    await expect(
      actions.rejectTool({ conversation, toolCallId: 'reject-2' }),
    ).resolves.toEqual({ kind: 'stale' })

    await expect(
      actions.abortTool({ conversation, toolCallId: 'abort-1' }),
    ).resolves.toEqual({ kind: 'handled' })
    expect(abortSubagentTask).not.toHaveBeenCalled()
    expect(listSubagentTasks).toHaveBeenCalledWith('conversation-1')
    expect(service.abortToolCall).toHaveBeenLastCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'abort-1',
    })
    service.abortToolCall.mockReturnValueOnce(false)
    await expect(
      actions.abortTool({ conversation, toolCallId: 'abort-2' }),
    ).resolves.toEqual({ kind: 'stale' })
  })

  it('keeps subagent task cancellation inside the YOLO adapter', async () => {
    const service = createService()
    const abortSubagentTask = jest.fn()
    const listSubagentTasks = jest.fn(() => [
      {
        taskId: 'task-1',
        source: {
          type: 'llm_tool_call' as const,
          assistantMessageId: 'assistant-1',
          toolCallId: 'delegate-1',
        },
      },
    ])
    const actions = createYoloChatRuntimeActions(service, {
      abortSubagentTask,
      listSubagentTasks,
    })

    await actions.abortTool({ conversation, toolCallId: 'delegate-1' })

    expect(listSubagentTasks).toHaveBeenCalledWith('conversation-1')
    expect(abortSubagentTask).toHaveBeenCalledWith('task-1')
    expect(service.abortToolCall).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      toolCallId: 'delegate-1',
    })
  })

  it('preserves answer recovery messages and maps terminal answer outcomes', async () => {
    const service = createService()
    const actions = createYoloChatRuntimeActions(service)
    const resolvedMessages: ChatMessage[] = [
      { role: 'assistant', id: 'assistant-1', content: 'continue' },
    ]

    service.answerUserQuestion.mockResolvedValueOnce({
      kind: 'needs_recovery',
      resolvedMessages,
    })
    await expect(
      actions.answerQuestion({
        conversation,
        toolCallId: 'question-1',
        payload: { type: 'user_answers', answers: [] },
      }),
    ).resolves.toEqual({ kind: 'needs_recovery', resolvedMessages })

    service.answerUserQuestion.mockResolvedValueOnce({ kind: 'recorded' })
    await expect(
      actions.answerQuestion({
        conversation,
        toolCallId: 'question-2',
        payload: { type: 'user_answers', answers: [] },
      }),
    ).resolves.toEqual({ kind: 'handled' })

    service.answerUserQuestion.mockResolvedValueOnce({ kind: 'not_awaiting' })
    await expect(
      actions.answerQuestion({
        conversation,
        toolCallId: 'question-3',
        payload: { type: 'user_answers', answers: [] },
      }),
    ).resolves.toEqual({ kind: 'stale' })
  })

  it('delegates question cancellation and reports stale requests', async () => {
    const service = createService()
    const actions = createYoloChatRuntimeActions(service)

    await expect(
      actions.cancelQuestion({ conversation, toolCallId: 'question-1' }),
    ).resolves.toEqual({ kind: 'handled' })
    service.cancelAskUserQuestion.mockReturnValueOnce(false)
    await expect(
      actions.cancelQuestion({ conversation, toolCallId: 'question-2' }),
    ).resolves.toEqual({ kind: 'stale' })
  })

  it('rejects a non-YOLO conversation instead of dispatching it accidentally', async () => {
    const service = createService()
    const actions = createYoloChatRuntimeActions(service)

    await expect(
      actions.cancelRun({ runtimeId: 'codex', nativeSessionId: 'session-1' }),
    ).rejects.toThrow('YOLO runtime actions cannot handle codex conversations')
    expect(service.abortConversation).not.toHaveBeenCalled()
  })
})
