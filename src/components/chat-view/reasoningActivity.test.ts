import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatToolMessage,
} from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { isReasoningActivityActive } from './reasoningActivity'

const reasoningMessage = (id: string): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content: '',
  reasoning: `Reasoning ${id}`,
  metadata: { generationState: 'completed' },
})

const toolRequestMessage: ChatAssistantMessage = {
  role: 'assistant',
  id: 'tool-request',
  content: '',
  toolCallRequests: [{ id: 'tool-1', name: 'any_tool' }],
  metadata: { generationState: 'completed' },
}

const toolResultMessage: ChatToolMessage = {
  role: 'tool',
  id: 'tool-result',
  toolCalls: [
    {
      request: { id: 'tool-1', name: 'any_tool' },
      response: { status: ToolCallResponseStatus.Running },
    },
  ],
}

const isActive = (
  messages: AssistantToolMessageGroup,
  messageIndex = 0,
  isRunActive = true,
): boolean => isReasoningActivityActive({ messages, messageIndex, isRunActive })

describe('reasoning timeline activity', () => {
  it('keeps the latest reasoning-only message active during a run', () => {
    expect(isActive([reasoningMessage('reasoning-1')])).toBe(true)
  })

  it('settles reasoning when later assistant text appears', () => {
    expect(
      isActive([
        reasoningMessage('reasoning-1'),
        {
          role: 'assistant',
          id: 'commentary',
          content: 'I will run the checks now.',
          metadata: { generationState: 'streaming' },
        },
      ]),
    ).toBe(false)
  })

  it('settles reasoning when a generic tool request or result appears', () => {
    expect(
      isActive([reasoningMessage('reasoning-1'), toolRequestMessage]),
    ).toBe(false)
    expect(isActive([reasoningMessage('reasoning-1'), toolResultMessage])).toBe(
      false,
    )
  })

  it('moves activity to the newest reasoning message', () => {
    const messages = [
      reasoningMessage('reasoning-1'),
      reasoningMessage('reasoning-2'),
    ]
    expect(isActive(messages, 0)).toBe(false)
    expect(isActive(messages, 1)).toBe(true)
  })

  it('does not keep reasoning active after the run ends', () => {
    expect(isActive([reasoningMessage('reasoning-1')], 0, false)).toBe(false)
  })
})
