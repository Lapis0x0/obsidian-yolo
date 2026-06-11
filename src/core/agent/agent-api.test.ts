jest.mock('../../components/chat-view/chat-runtime-inputs', () => ({
  resolveWorkspaceScopeForRuntimeInput: jest.fn(() => null),
}))

jest.mock('../../components/chat-view/chat-runtime-profiles', () => ({
  resolveChatModeRuntime: jest.fn(() => ({
    loopConfig: {
      enableTools: true,
      includeBuiltinTools: true,
      maxAutoIterations: 100,
    },
    allowedToolNames: ['server__search'],
    toolPreferences: undefined,
    bypassToolApproval: false,
  })),
}))

jest.mock('../llm/manager', () => ({
  getChatModelClient: jest.fn(() => ({
    providerClient: { id: 'provider-client' },
    model: {
      id: 'mock-model',
      providerId: 'mock-provider',
    },
  })),
}))

jest.mock('../skills/liteSkills', () => ({
  listLiteSkillEntries: jest.fn(async () => [
    {
      name: 'skill-creator',
      description: 'Create skills',
      mode: 'lazy',
      path: 'builtin://skills/skill-creator',
    },
  ]),
}))

jest.mock('../../utils/chat/requestContextBuilder', () => ({
  RequestContextBuilder: jest.fn().mockImplementation(() => ({
    compilePlainUserMessagePrompt: jest.fn(
      async ({
        prompt,
        mentionables,
        selectedSkills,
      }: {
        prompt: string
        mentionables: unknown[]
        selectedSkills?: unknown[]
      }) => ({
        promptContent: {
          prompt,
          mentionables,
          selectedSkills: selectedSkills ?? [],
        },
      }),
    ),
  })),
}))

import { TFile, TFolder } from 'obsidian'

import type { ChatUserMessage } from '../../types/chat'
import {
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'

import {
  buildAgentApiPrompt,
  conversationStateToEvents,
  narrowAllowedToolNames,
  resolveAgentApiRunInput,
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
            path: 'Boards/Flow.canvas',
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
        'Canvas context: Boards/Flow.canvas\n\n```json\n{"nodes":[]}\n```',
        'Plain context',
      ].join('\n\n'),
    )
  })

  it('resolves file, folder, skill, and text contexts into a compiled user message', async () => {
    const file = Object.assign(new TFile(), {
      path: 'Daily/2026-05-29.md',
      extension: 'md',
    })
    const folder = Object.assign(new TFolder(), {
      path: 'Projects/YOLO',
      children: [],
    })
    const app = {
      vault: {
        getFileByPath: jest.fn((path: string) =>
          path === file.path ? file : null,
        ),
        getFolderByPath: jest.fn((path: string) =>
          path === folder.path ? folder : null,
        ),
      },
    } as unknown as import('obsidian').App
    const settings = {
      currentAssistantId: 'assistant-1',
      chatModelId: 'mock-model',
      assistants: [
        {
          id: 'assistant-1',
          modelId: 'mock-model',
          toolPreferences: {},
          enabledToolNames: [],
          includeBuiltinTools: true,
          skillPreferences: {},
        },
      ],
      providers: [{ id: 'mock-provider', apiType: 'openai' }],
      mcp: {
        enableToolDisclosure: false,
      },
      continuationOptions: {
        primaryRequestTimeoutMs: 30000,
        streamFallbackRecoveryEnabled: true,
      },
      skills: {},
    } as any
    const agentService = {
      getSystemPromptSnapshotStore: jest.fn(() => null),
      getPromptSourceWatcher: jest.fn(() => ({
        getRevision: jest.fn(() => 1),
        setWatchedPaths: jest.fn(),
      })),
    } as any

    const result = await resolveAgentApiRunInput({
      request: {
        prompt: '总结这些资料',
        context: [
          { type: 'file', path: 'Daily/2026-05-29.md' },
          { type: 'folder', path: 'Projects/YOLO' },
          { type: 'skill', name: 'skill-creator' },
          { type: 'markdown', path: 'Docs/spec.md', content: '# Spec' },
          { type: 'text', content: '补充说明' },
        ],
      },
      conversationId: 'conversation-1',
      abortSignal: new AbortController().signal,
      app,
      settings,
      agentService,
      mcpManager: {} as any,
    })

    expect(result.input.messages).toHaveLength(1)
    expect(result.input.messages[0]).toMatchObject({
      role: 'user',
      content: null,
      mentionables: [
        { type: 'file', file },
        { type: 'folder', folder },
      ],
      selectedSkills: [
        {
          name: 'skill-creator',
          description: 'Create skills',
          path: 'builtin://skills/skill-creator',
        },
      ],
    })
    expect((result.input.messages[0] as ChatUserMessage).promptContent).toEqual(
      {
        prompt: [
          '总结这些资料',
          'Markdown context: Docs/spec.md\n\n```markdown\n# Spec\n```',
          '补充说明',
        ].join('\n\n'),
        mentionables: [
          { type: 'file', file },
          { type: 'folder', folder },
        ],
        selectedSkills: [
          {
            name: 'skill-creator',
            description: 'Create skills',
            path: 'builtin://skills/skill-creator',
          },
        ],
      },
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
