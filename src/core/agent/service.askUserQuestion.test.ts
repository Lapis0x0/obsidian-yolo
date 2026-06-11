import { ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { AgentService } from './service'

jest.mock('./native-runtime', () => ({
  NativeAgentRuntime: jest.fn().mockImplementation(() => {
    return {
      abort: jest.fn(),
      run: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(() => () => {}),
    }
  }),
}))

const buildMessagesWithAwaiting = (): ChatMessage[] => [
  {
    role: 'user',
    id: 'user-1',
    content: null,
    promptContent: 'hi',
    mentionables: [],
  },
  {
    role: 'tool',
    id: 'tool-1',
    toolCalls: [
      {
        request: {
          id: 'call-1',
          name: 'yolo_local__ask_user_question',
          arguments: {
            kind: 'complete',
            value: {
              questions: [
                {
                  id: 'scope',
                  prompt: 'Which folder?',
                  inputType: 'single_select',
                  options: [
                    { id: 'projects', label: 'Projects' },
                    { id: 'archive', label: 'Archive' },
                  ],
                },
              ],
            },
          },
        },
        response: {
          status: ToolCallResponseStatus.AwaitingUserInput,
        },
      },
    ],
  },
]

describe('AgentService.answerUserQuestion (recovery path)', () => {
  it('commits the user answers to the trailing awaiting tool message', async () => {
    const service = new AgentService()
    service.replaceConversationMessages('conv', buildMessagesWithAwaiting(), [])

    const outcome = await service.answerUserQuestion({
      conversationId: 'conv',
      toolCallId: 'call-1',
      payload: {
        type: 'user_answers',
        answers: [
          {
            id: 'scope',
            question: 'Which folder?',
            inputType: 'single_select',
            value: 'projects',
          },
        ],
      },
    })

    expect(outcome.kind).toBe('needs_recovery')
    const state = service.getState('conv')
    const toolMessage = state.messages.find((m) => m.role === 'tool')
    if (!toolMessage || toolMessage.role !== 'tool') {
      throw new Error('expected tool message')
    }
    const response = toolMessage.toolCalls[0].response
    expect(response.status).toBe(ToolCallResponseStatus.Success)
    if (response.status !== ToolCallResponseStatus.Success) return
    const parsed = JSON.parse(response.data.text)
    expect(parsed.type).toBe('user_answers')
    expect(parsed.answers[0].value).toBe('projects')
  })

  it('returns not_awaiting if the call is no longer awaiting', async () => {
    const service = new AgentService()
    const messages = buildMessagesWithAwaiting()
    // Pre-mark the call as Aborted (e.g. stop-generation was clicked)
    const toolMessage = messages[1]
    if (toolMessage.role === 'tool') {
      toolMessage.toolCalls[0].response = {
        status: ToolCallResponseStatus.Aborted,
      }
    }
    service.replaceConversationMessages('conv', messages, [])

    const outcome = await service.answerUserQuestion({
      conversationId: 'conv',
      toolCallId: 'call-1',
      payload: { type: 'user_answers', answers: [] },
    })
    expect(outcome.kind).toBe('not_awaiting')
  })

  it('returns not_found for an unknown tool call id', async () => {
    const service = new AgentService()
    service.replaceConversationMessages('conv', buildMessagesWithAwaiting(), [])
    const outcome = await service.answerUserQuestion({
      conversationId: 'conv',
      toolCallId: 'missing',
      payload: { type: 'user_answers', answers: [] },
    })
    expect(outcome.kind).toBe('not_found')
  })

  it('exposes isWaitingUserInput in the run summary while awaiting', () => {
    const service = new AgentService()
    service.replaceConversationMessages('conv', buildMessagesWithAwaiting(), [])
    const summary = service.getConversationRunSummary('conv')
    expect(summary.isWaitingUserInput).toBe(true)
    expect(summary.isWaitingApproval).toBe(true)
  })

  it('abortConversation aborts awaiting user input even when no active run owns it', () => {
    const service = new AgentService()
    service.replaceConversationMessages('conv', buildMessagesWithAwaiting(), [])
    expect(service.abortConversation('conv')).toBe(true)
    const state = service.getState('conv')
    const toolMessage = state.messages.find((m) => m.role === 'tool')
    if (!toolMessage || toolMessage.role !== 'tool') {
      throw new Error('expected tool message')
    }
    expect(toolMessage.toolCalls[0].response.status).toBe(
      ToolCallResponseStatus.Aborted,
    )
    expect(state.status).toBe('aborted')
  })
})
