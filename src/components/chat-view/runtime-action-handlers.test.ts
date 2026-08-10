import type { ChatRuntimeActions } from '../../core/cli-runtime'
import type { ChatMessage } from '../../types/chat'

import {
  handleRuntimeQuestionResult,
  handleRuntimeToolAbort,
  handleRuntimeToolApproval,
  handleRuntimeToolRejection,
} from './runtime-action-handlers'

const conversation = {
  runtimeId: 'yolo',
  conversationId: 'conversation-1',
} as const

const createActions = (): jest.Mocked<ChatRuntimeActions> =>
  ({
    cancelRun: jest.fn(async () => undefined),
    approveTool: jest.fn(async () => ({ kind: 'handled' })),
    rejectTool: jest.fn(async () => ({ kind: 'handled' })),
    abortTool: jest.fn(async () => ({ kind: 'handled' })),
    answerQuestion: jest.fn(async () => ({ kind: 'handled' })),
    cancelQuestion: jest.fn(async () => ({ kind: 'handled' })),
  }) as unknown as jest.Mocked<ChatRuntimeActions>

describe('runtime action handlers', () => {
  it('passes conversation-wide approval through the runtime contract', async () => {
    const actions = createActions()

    await handleRuntimeToolApproval({
      actions,
      conversation,
      toolCallId: 'tool-1',
      allowForConversation: true,
    })

    expect(actions.approveTool.mock.calls).toEqual([
      [
        {
          conversation,
          toolCallId: 'tool-1',
          allowForConversation: true,
        },
      ],
    ])
  })

  it('tries approval recovery before showing a stale request', async () => {
    const actions = createActions()
    actions.approveTool.mockResolvedValue({ kind: 'stale' })
    const recover = jest.fn(async () => true)
    const onStale = jest.fn()

    await handleRuntimeToolApproval({
      actions,
      conversation,
      toolCallId: 'tool-1',
      recover,
      onStale,
    })

    expect(recover).toHaveBeenCalledTimes(1)
    expect(onStale).not.toHaveBeenCalled()

    recover.mockResolvedValueOnce(false)
    await handleRuntimeToolApproval({
      actions,
      conversation,
      toolCallId: 'tool-1',
      recover,
      onStale,
    })
    expect(onStale).toHaveBeenCalledTimes(1)
  })

  it('keeps stale reject and abort fallbacks at the UI boundary', async () => {
    const actions = createActions()
    actions.rejectTool.mockResolvedValue({ kind: 'stale' })
    actions.abortTool.mockResolvedValue({ kind: 'stale' })
    const onRejectStale = jest.fn()
    const onAbortStale = jest.fn()

    await handleRuntimeToolRejection({
      actions,
      conversation,
      toolCallId: 'tool-1',
      onStale: onRejectStale,
    })
    await handleRuntimeToolAbort({
      actions,
      conversation,
      toolCallId: 'tool-2',
      onStale: onAbortStale,
    })

    expect(onRejectStale).toHaveBeenCalledTimes(1)
    expect(onAbortStale).toHaveBeenCalledTimes(1)
  })

  it('routes question recovery and stale results without backend knowledge', () => {
    const resolvedMessages: ChatMessage[] = [
      { role: 'assistant', id: 'assistant-1', content: 'continue' },
    ]
    const onRecovery = jest.fn()
    const onStale = jest.fn()

    handleRuntimeQuestionResult({
      result: { kind: 'needs_recovery', resolvedMessages },
      onRecovery,
      onStale,
    })
    expect(onRecovery).toHaveBeenCalledWith(resolvedMessages)
    expect(onStale).not.toHaveBeenCalled()

    handleRuntimeQuestionResult({
      result: { kind: 'stale' },
      onRecovery,
      onStale,
    })
    expect(onStale).toHaveBeenCalledTimes(1)

    handleRuntimeQuestionResult({
      result: { kind: 'handled' },
      onRecovery,
      onStale,
    })
    expect(onRecovery).toHaveBeenCalledTimes(1)
    expect(onStale).toHaveBeenCalledTimes(1)
  })
})
