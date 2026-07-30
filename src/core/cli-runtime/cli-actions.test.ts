import { createCliChatRuntimeActions } from './cli-actions'
import type { CliRuntime } from './types'

const conversation = {
  runtimeId: 'codex',
  nativeSessionId: 'session-1',
} as const

const createRuntime = (): jest.Mocked<CliRuntime> =>
  ({
    runtimeId: 'codex',
    listSessions: jest.fn(async () => []),
    openSession: jest.fn(),
    ensureReady: jest.fn(),
    sendTurn: jest.fn(),
    cancel: jest.fn(async () => undefined),
    respondApproval: jest.fn(async () => true),
    respondQuestion: jest.fn(async () => true),
    subscribe: jest.fn(() => () => undefined),
    dispose: jest.fn(),
  }) as unknown as jest.Mocked<CliRuntime>

describe('createCliChatRuntimeActions', () => {
  it('maps tool approvals and rejection to the provider runtime', async () => {
    const runtime = createRuntime()
    const actions = createCliChatRuntimeActions(() => runtime)

    await expect(
      actions.approveTool({ conversation, toolCallId: 'approval-1' }),
    ).resolves.toEqual({ kind: 'handled' })
    await expect(
      actions.approveTool({
        conversation,
        toolCallId: 'approval-2',
        allowForConversation: true,
      }),
    ).resolves.toEqual({ kind: 'handled' })
    await expect(
      actions.rejectTool({ conversation, toolCallId: 'approval-3' }),
    ).resolves.toEqual({ kind: 'handled' })

    expect(runtime.respondApproval.mock.calls).toEqual([
      [{ requestId: 'approval-1', decision: 'approve_once' }],
      [{ requestId: 'approval-2', decision: 'approve_for_session' }],
      [{ requestId: 'approval-3', decision: 'reject' }],
    ])
  })

  it('reports stale provider requests without treating them as success', async () => {
    const runtime = createRuntime()
    runtime.respondApproval.mockResolvedValueOnce(false)
    runtime.respondQuestion.mockResolvedValueOnce(false)
    const actions = createCliChatRuntimeActions(() => runtime)

    await expect(
      actions.rejectTool({ conversation, toolCallId: 'stale-approval' }),
    ).resolves.toEqual({ kind: 'stale' })
    await expect(
      actions.answerQuestion({
        conversation,
        toolCallId: 'stale-question',
        payload: { type: 'user_answers', answers: [] },
      }),
    ).resolves.toEqual({ kind: 'stale' })
  })

  it('answers questions and cancels an accepted question by ending the turn', async () => {
    const runtime = createRuntime()
    const actions = createCliChatRuntimeActions(() => runtime)
    const payload = { type: 'user_answers', answers: [] }

    await expect(
      actions.answerQuestion({
        conversation,
        toolCallId: 'question-1',
        payload,
      }),
    ).resolves.toEqual({ kind: 'handled' })
    await expect(
      actions.cancelQuestion({ conversation, toolCallId: 'question-2' }),
    ).resolves.toEqual({ kind: 'handled' })

    expect(runtime.respondQuestion.mock.calls).toEqual([
      [{ requestId: 'question-1', answer: payload }],
      [{ requestId: 'question-2', answer: null }],
    ])
    expect(runtime.cancel.mock.calls).toHaveLength(1)
  })

  it('uses runtime cancellation for run and tool aborts', async () => {
    const runtime = createRuntime()
    const actions = createCliChatRuntimeActions(() => runtime)

    await actions.cancelRun(conversation)
    await expect(
      actions.abortTool({ conversation, toolCallId: 'tool-1' }),
    ).resolves.toEqual({ kind: 'handled' })

    expect(runtime.cancel.mock.calls).toHaveLength(2)
  })

  it('rejects unavailable and YOLO conversations', async () => {
    const actions = createCliChatRuntimeActions(() => undefined)

    await expect(actions.cancelRun(conversation)).rejects.toThrow(
      'codex CLI runtime is not available',
    )
    await expect(
      actions.cancelRun({ runtimeId: 'yolo', conversationId: 'chat-1' }),
    ).rejects.toThrow('cannot handle YOLO')
  })
})
