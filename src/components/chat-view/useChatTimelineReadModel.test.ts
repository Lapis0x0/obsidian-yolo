jest.mock('lodash.isequal', () => {
  const actual = jest.requireActual('lodash.isequal') as unknown
  return { __esModule: true, default: actual }
})

import type {
  ChatAssistantMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'

import {
  EMPTY_CHAT_TIMELINE_READ_MODEL,
  findAssistantGroupRenderKeyForRunAnchor,
  materializeChatTimelineReadModel,
} from './useChatTimelineReadModel'

const makeUserMessage = (id: string): ChatUserMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: null,
  mentionables: [],
})

const makeAssistantMessage = (
  id: string,
  content: string,
): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content,
})

const makeToolMessage = (id: string): ChatToolMessage => ({
  role: 'tool',
  id,
  toolCalls: [],
})

describe('materializeChatTimelineReadModel', () => {
  it('reuses the previous model when messages are structurally unchanged', () => {
    const user = makeUserMessage('user-1')
    const assistant = makeAssistantMessage('assistant-1', 'hello')
    const first = materializeChatTimelineReadModel({
      messages: [user, assistant],
      assistantGroupBoundaryMessageIds: [],
      previous: EMPTY_CHAT_TIMELINE_READ_MODEL,
    })

    const second = materializeChatTimelineReadModel({
      messages: [{ ...user }, { ...assistant }],
      assistantGroupBoundaryMessageIds: [],
      previous: first,
    })

    expect(second).toBe(first)
    expect(second.revisionsById.get('user-1')).toBe(1)
    expect(second.revisionsById.get('assistant-1')).toBe(1)
  })

  it('increments only the changed message revision', () => {
    const user = makeUserMessage('user-1')
    const assistant = makeAssistantMessage('assistant-1', 'hello')
    const first = materializeChatTimelineReadModel({
      messages: [user, assistant],
      assistantGroupBoundaryMessageIds: [],
      previous: EMPTY_CHAT_TIMELINE_READ_MODEL,
    })

    const second = materializeChatTimelineReadModel({
      messages: [user, { ...assistant, content: 'hello world' }],
      assistantGroupBoundaryMessageIds: [],
      previous: first,
    })

    expect(second).not.toBe(first)
    expect(second.messagesById.get('user-1')).toBe(user)
    expect(second.revisionsById.get('user-1')).toBe(1)
    expect(second.revisionsById.get('assistant-1')).toBe(2)
    expect(second.groupedChatMessages.at(1)).not.toBe(
      first.groupedChatMessages.at(1),
    )
  })

  it('reuses assistant/tool groups when member revisions are unchanged', () => {
    const user = makeUserMessage('user-1')
    const assistant = makeAssistantMessage('assistant-1', 'hello')
    const tool = makeToolMessage('tool-1')
    const first = materializeChatTimelineReadModel({
      messages: [user, assistant, tool],
      assistantGroupBoundaryMessageIds: [],
      previous: EMPTY_CHAT_TIMELINE_READ_MODEL,
    })
    const firstGroup = first.groupedChatMessages.at(1)

    const second = materializeChatTimelineReadModel({
      messages: [user, { ...assistant }, { ...tool }],
      assistantGroupBoundaryMessageIds: [],
      previous: first,
    })

    expect(Array.isArray(firstGroup)).toBe(true)
    expect(second).toBe(first)
    expect(second.groupedChatMessages.at(1)).toBe(firstGroup)
    expect(second.groupRevisionsById.get('assistant-1')).toBe(4)
  })
})

describe('findAssistantGroupRenderKeyForRunAnchor', () => {
  it('does not bind a new run to the previous completed assistant group', () => {
    const previousUser = makeUserMessage('user-1')
    const previousAssistant: ChatAssistantMessage = {
      ...makeAssistantMessage('assistant-1', 'previous answer'),
      metadata: {
        generationState: 'completed',
        sourceUserMessageId: previousUser.id,
      },
    }
    const currentUser = makeUserMessage('user-2')
    const readModel = materializeChatTimelineReadModel({
      messages: [previousUser, previousAssistant, currentUser],
      assistantGroupBoundaryMessageIds: [],
      previous: EMPTY_CHAT_TIMELINE_READ_MODEL,
    })

    expect(
      findAssistantGroupRenderKeyForRunAnchor({
        groupedChatMessages: readModel.groupedChatMessages,
        anchorMessageId: currentUser.id,
      }),
    ).toBeNull()
  })

  it('binds the run after its assistant group appears and keeps it through tools', () => {
    const user = makeUserMessage('user-1')
    const assistant: ChatAssistantMessage = {
      ...makeAssistantMessage('assistant-1', ''),
      metadata: {
        generationState: 'streaming',
        sourceUserMessageId: user.id,
      },
    }
    const tool: ChatToolMessage = {
      ...makeToolMessage('tool-1'),
      metadata: { sourceUserMessageId: user.id },
    }
    const streamingModel = materializeChatTimelineReadModel({
      messages: [user, assistant],
      assistantGroupBoundaryMessageIds: [],
      previous: EMPTY_CHAT_TIMELINE_READ_MODEL,
    })
    const toolModel = materializeChatTimelineReadModel({
      messages: [
        user,
        {
          ...assistant,
          metadata: { ...assistant.metadata, generationState: 'completed' },
        },
        tool,
      ],
      assistantGroupBoundaryMessageIds: [],
      previous: streamingModel,
    })

    expect(
      findAssistantGroupRenderKeyForRunAnchor({
        groupedChatMessages: streamingModel.groupedChatMessages,
        anchorMessageId: user.id,
      }),
    ).toBe(assistant.id)
    expect(
      findAssistantGroupRenderKeyForRunAnchor({
        groupedChatMessages: toolModel.groupedChatMessages,
        anchorMessageId: user.id,
      }),
    ).toBe(assistant.id)
  })
})
