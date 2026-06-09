import {
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import {
  buildAgentApiPrompt,
  conversationStateToEvents,
  narrowAllowedToolNames,
} from './agent-api'
import type { AgentConversationState } from './service'

describe('agent api helpers', () => {
  it('appends context blocks to the prompt in order', () => {
    expect(
      buildAgentApiPrompt({
        prompt: 'Analyze this',
        context: [
          {
            type: 'markdown',
            path: 'Notes/A.md',
            content: '# A',
          },
          {
            type: 'canvas',
            content: '{"nodes":[]}',
          },
          {
            type: 'text',
            content: 'Plain context',
          },
        ],
      }),
    ).toBe(
      [
        'Analyze this',
        'Markdown context: Notes/A.md\n\n```markdown\n# A\n```',
        'Canvas context\n\n```json\n{"nodes":[]}\n```',
        'Plain context',
      ].join('\n\n'),
    )
  })

  it('only narrows runtime allowed tools', () => {
    expect(
      narrowAllowedToolNames(
        ['yolo_local__fs_read', 'server__search'],
        ['server__search', 'server__write'],
      ),
    ).toEqual(['server__search'])

    expect(
      narrowAllowedToolNames(undefined, ['server__search']),
    ).toBeUndefined()
  })

  it('converts state snapshots into text deltas and completion events', () => {
    const previous = {
      assistantTextById: new Map<string, string>(),
      toolStatusById: new Map(),
    }
    const firstState = buildState({
      status: 'running',
      assistantContent: 'Hello',
      generationState: 'streaming',
    })

    const first = conversationStateToEvents({
      state: firstState,
      sourceUserMessageId: 'user-1',
      previous,
    })
    expect(first.events).toEqual([
      {
        type: 'state',
        conversationId: 'conversation-1',
        status: 'running',
      },
      {
        type: 'text',
        conversationId: 'conversation-1',
        messageId: 'assistant-1',
        text: 'Hello',
        delta: 'Hello',
        streaming: true,
      },
    ])

    const completed = conversationStateToEvents({
      state: buildState({
        status: 'completed',
        assistantContent: 'Hello world',
        generationState: 'completed',
      }),
      sourceUserMessageId: 'user-1',
      previous: first.nextTracker,
    })

    expect(completed.events).toEqual([
      {
        type: 'state',
        conversationId: 'conversation-1',
        status: 'completed',
      },
      {
        type: 'text',
        conversationId: 'conversation-1',
        messageId: 'assistant-1',
        text: 'Hello world',
        delta: ' world',
        streaming: false,
      },
      {
        type: 'completed',
        conversationId: 'conversation-1',
        text: 'Hello world',
      },
    ])
  })

  it('uses empty delta when assistant content shrinks', () => {
    const previous = conversationStateToEvents({
      state: buildState({
        status: 'running',
        assistantContent: 'Longer text',
        generationState: 'streaming',
      }),
      sourceUserMessageId: 'user-1',
      previous: {
        assistantTextById: new Map<string, string>(),
        toolStatusById: new Map(),
      },
    }).nextTracker

    const next = conversationStateToEvents({
      state: buildState({
        status: 'running',
        assistantContent: 'Short',
        generationState: 'streaming',
      }),
      sourceUserMessageId: 'user-1',
      previous,
    })

    expect(next.events[1]).toMatchObject({
      type: 'text',
      text: 'Short',
      delta: '',
    })
  })

  it('emits tool status changes for the source user message', () => {
    const result = conversationStateToEvents({
      state: buildState({
        status: 'running',
        assistantContent: '',
        generationState: 'streaming',
        toolStatus: ToolCallResponseStatus.PendingApproval,
      }),
      sourceUserMessageId: 'user-1',
      previous: {
        assistantTextById: new Map<string, string>(),
        toolStatusById: new Map(),
      },
    })

    expect(result.events).toContainEqual({
      type: 'tool',
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      name: 'server__search',
      status: 'awaiting_approval',
    })
  })
})

function buildState({
  status,
  assistantContent,
  generationState,
  toolStatus,
}: {
  status: AgentConversationState['status']
  assistantContent: string
  generationState: 'streaming' | 'completed'
  toolStatus?: ToolCallResponseStatus
}): AgentConversationState {
  return {
    conversationId: 'conversation-1',
    status,
    messages: [
      {
        role: 'user',
        id: 'user-1',
        content: null,
        promptContent: 'Prompt',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'assistant-1',
        content: assistantContent,
        metadata: {
          generationState,
          sourceUserMessageId: 'user-1',
        },
      },
      ...(toolStatus
        ? [
            {
              role: 'tool' as const,
              id: 'tool-message-1',
              metadata: {
                sourceUserMessageId: 'user-1',
              },
              toolCalls: [
                {
                  request: {
                    id: 'tool-1',
                    name: 'server__search',
                  },
                  response: {
                    status: toolStatus,
                  } as ToolCallResponse,
                },
              ],
            },
          ]
        : []),
    ],
  }
}
