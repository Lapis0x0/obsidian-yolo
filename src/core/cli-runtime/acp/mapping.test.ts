import type {
  PermissionOption,
  Plan,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'

import type { ChatToolMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import {
  AcpSessionAggregator,
  buildCancelledApprovalOutcome,
  buildPendingApprovalMessages,
  mapAcpUsageUpdate,
  resolveApprovalOptionId,
  toAcpPromptBlocks,
} from './mapping'

describe('ACP session update aggregation', () => {
  it('concatenates streaming agent_message_chunk deltas into one message', () => {
    const aggregator = new AcpSessionAggregator()
    const first = aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Hel' },
      } as SessionUpdate,
      'hermes',
    )
    const second = aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'lo' },
      } as SessionUpdate,
      'hermes',
    )

    expect(first).toMatchObject([
      { role: 'assistant', id: 'acp-assistant-m1', content: 'Hel' },
    ])
    expect(second).toMatchObject([
      { role: 'assistant', id: 'acp-assistant-m1', content: 'Hello' },
    ])
  })

  it('keeps agent_thought_chunk as a separate reasoning-only message', () => {
    const aggregator = new AcpSessionAggregator()
    const messages = aggregator.apply(
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: { type: 'text', text: 'thinking...' },
      } as SessionUpdate,
      'hermes',
    )

    expect(messages).toMatchObject([
      {
        role: 'assistant',
        id: 'acp-thought-t1',
        content: '',
        reasoning: 'thinking...',
      },
    ])
  })

  it('skips user_message_chunk echoes', () => {
    const aggregator = new AcpSessionAggregator()
    expect(
      aggregator.apply(
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hi' },
        } as SessionUpdate,
        'hermes',
      ),
    ).toEqual([])
  })

  it('merges a tool_call_update patch onto the tool_call it started from', () => {
    const aggregator = new AcpSessionAggregator()
    const toolCall: ToolCall = {
      toolCallId: 'call-1',
      title: 'Reading file',
      kind: 'read',
      status: 'in_progress',
      content: [],
    }
    const [, startedTool] = aggregator.apply(
      { sessionUpdate: 'tool_call', ...toolCall } as SessionUpdate,
      'hermes',
    )
    expect(startedTool).toMatchObject({
      role: 'tool',
      toolCalls: [{ response: { status: ToolCallResponseStatus.Running } }],
    })

    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    }
    const [, completedTool] = aggregator.apply(
      { sessionUpdate: 'tool_call_update', ...update } as SessionUpdate,
      'hermes',
    ) as [unknown, ChatToolMessage]
    expect(completedTool).toMatchObject({
      id: 'acp-result-call-1',
      toolCalls: [
        {
          response: {
            status: ToolCallResponseStatus.Success,
            data: { text: 'done' },
          },
        },
      ],
    })
    // Title from the original tool_call survives — the update didn't repeat it.
    expect(completedTool.toolCalls[0].request.name).toBe('Reading file')
  })

  it('synthesizes a minimal tool call if only an update ever arrives', () => {
    const aggregator = new AcpSessionAggregator()
    const update: ToolCallUpdate = { toolCallId: 'orphan-1', status: 'failed' }
    const [, tool] = aggregator.apply(
      { sessionUpdate: 'tool_call_update', ...update } as SessionUpdate,
      'hermes',
    ) as [unknown, ChatToolMessage]
    expect(tool.toolCalls[0].response).toMatchObject({
      status: ToolCallResponseStatus.Error,
    })
  })

  it('renders a plan as a markdown checklist keyed by a stable message id', () => {
    const aggregator = new AcpSessionAggregator()
    const plan: Plan = {
      entries: [
        { content: 'Read the file', priority: 'high', status: 'completed' },
        { content: 'Write the fix', priority: 'high', status: 'in_progress' },
        { content: 'Run tests', priority: 'medium', status: 'pending' },
      ],
    }
    const messages = aggregator.apply(
      { sessionUpdate: 'plan', ...plan } as SessionUpdate,
      'hermes',
    )
    expect(messages).toMatchObject([
      {
        id: 'acp-plan',
        content: '- [x] Read the file\n- [~] Write the fix\n- [ ] Run tests',
      },
    ])
  })

  it('ignores unstable/out-of-scope update kinds without throwing', () => {
    const aggregator = new AcpSessionAggregator()
    expect(
      aggregator.apply(
        {
          sessionUpdate: 'current_mode_update',
          currentModeId: 'code',
        } as SessionUpdate,
        'hermes',
      ),
    ).toEqual([])
  })
})

describe('ACP session update aggregation — multi-turn fallback id scoping', () => {
  it('scopes fallback stream/thought ids to the turn epoch, so a second live turn does not append onto the first', () => {
    const aggregator = new AcpSessionAggregator('live')
    aggregator.beginTurn()
    const turn1 = aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'first turn answer' },
      } as SessionUpdate,
      'hermes',
    )
    expect(turn1).toMatchObject([
      { id: 'acp-assistant-stream-1', content: 'first turn answer' },
    ])

    aggregator.beginTurn()
    const turn2 = aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'second turn answer' },
      } as SessionUpdate,
      'hermes',
    )
    // A distinct message id, and critically not the first turn's already
    // "completed" text with the second turn's text appended onto it.
    expect(turn2).toMatchObject([
      { id: 'acp-assistant-stream-2', content: 'second turn answer' },
    ])
  })

  it('does the same for agent_thought_chunk fallback ids', () => {
    const aggregator = new AcpSessionAggregator('live')
    aggregator.beginTurn()
    aggregator.apply(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking about turn 1' },
      } as SessionUpdate,
      'hermes',
    )
    aggregator.beginTurn()
    const turn2 = aggregator.apply(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking about turn 2' },
      } as SessionUpdate,
      'hermes',
    )
    expect(turn2).toMatchObject([
      { id: 'acp-thought-thought-2', reasoning: 'thinking about turn 2' },
    ])
  })

  it('scopes explicit messageIds per turn so a recycled protocol id does not edit the previous turn', () => {
    const aggregator = new AcpSessionAggregator('live')
    aggregator.beginTurn()
    aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'a' },
      } as SessionUpdate,
      'hermes',
    )
    aggregator.beginTurn()
    const second = aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'b' },
      } as SessionUpdate,
      'hermes',
    )
    expect(second).toMatchObject([{ id: 'acp-assistant-m1@2', content: 'b' }])
  })

  it('starts a new assistant message for text that arrives after tool calls', () => {
    const aggregator = new AcpSessionAggregator('live')
    aggregator.beginTurn()
    const preamble = aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: '好的，我来测试一下主要工具：' },
      } as SessionUpdate,
      'hermes',
    )
    aggregator.apply(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'ls',
        kind: 'execute',
        status: 'in_progress',
        content: [],
      } as SessionUpdate,
      'hermes',
    )
    const after = aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: '一切正常。' },
      } as SessionUpdate,
      'hermes',
    )

    expect(preamble).toMatchObject([
      { id: 'acp-assistant-m1@1', content: '好的，我来测试一下主要工具：' },
    ])
    expect(after).toMatchObject([
      { id: 'acp-assistant-m1@1.1', content: '一切正常。' },
    ])
  })

  it('resets the epoch on reset()', () => {
    const aggregator = new AcpSessionAggregator('live')
    aggregator.beginTurn()
    aggregator.beginTurn()
    aggregator.reset()
    aggregator.beginTurn()
    const messages = aggregator.apply(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'x' },
      } as SessionUpdate,
      'hermes',
    )
    expect(messages).toMatchObject([{ id: 'acp-assistant-stream-1' }])
  })
})

describe('ACP session update aggregation — replay mode', () => {
  it('aggregates user_message_chunk into a ChatUserMessage instead of dropping it', () => {
    const aggregator = new AcpSessionAggregator('replay')
    const messages = aggregator.apply(
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'u1',
        content: { type: 'text', text: 'what does this function do?' },
      } as SessionUpdate,
      'hermes',
    )
    expect(messages).toEqual([
      {
        role: 'user',
        id: 'acp-user-u1',
        content: null,
        promptContent: 'what does this function do?',
        mentionables: [],
      },
    ])
  })

  it('accumulates chunks sharing the same explicit messageId', () => {
    const aggregator = new AcpSessionAggregator('replay')
    aggregator.apply(
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'u1',
        content: { type: 'text', text: 'part one ' },
      } as SessionUpdate,
      'hermes',
    )
    const second = aggregator.apply(
      {
        sessionUpdate: 'user_message_chunk',
        messageId: 'u1',
        content: { type: 'text', text: 'part two' },
      } as SessionUpdate,
      'hermes',
    )
    expect(second).toMatchObject([
      { id: 'acp-user-u1', promptContent: 'part one part two' },
    ])
  })

  it('replaying a full multi-turn session recovers every user turn and keeps assistant deltas separated per turn', () => {
    const aggregator = new AcpSessionAggregator('replay')
    const collected: ReturnType<typeof aggregator.apply> = []
    const feed = (update: SessionUpdate) =>
      collected.push(...aggregator.apply(update, 'hermes'))

    // Turn 1 — no messageId on either side (some agents omit it in replay).
    feed({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'turn one question' },
    } as SessionUpdate)
    feed({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'turn one answer' },
    } as SessionUpdate)
    // Turn 2.
    feed({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'turn two question' },
    } as SessionUpdate)
    feed({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'turn two answer' },
    } as SessionUpdate)

    const userMessages = collected.filter((message) => message.role === 'user')
    expect(userMessages).toHaveLength(2)
    expect(userMessages[0]).toMatchObject({
      promptContent: 'turn one question',
    })
    expect(userMessages[1]).toMatchObject({
      promptContent: 'turn two question',
    })

    const assistantMessages = collected.filter(
      (message) => message.role === 'assistant',
    )
    // Two distinct assistant messages, not one turn's text appended onto
    // the other's under a shared fallback id.
    const distinctIds = new Set(assistantMessages.map((message) => message.id))
    expect(distinctIds.size).toBe(2)
    expect(assistantMessages[0]).toMatchObject({ content: 'turn one answer' })
    expect(assistantMessages[1]).toMatchObject({ content: 'turn two answer' })
  })

  it('still suppresses user_message_chunk in live mode (default constructor)', () => {
    const aggregator = new AcpSessionAggregator()
    expect(
      aggregator.apply(
        {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hi' },
        } as SessionUpdate,
        'hermes',
      ),
    ).toEqual([])
  })
})

describe('ACP approval decision mapping', () => {
  const options: PermissionOption[] = [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'deny-once', name: 'Reject once', kind: 'reject_once' },
  ]

  it('maps approve_once to the allow_once option', () => {
    expect(resolveApprovalOptionId(options, 'approve_once')).toBe('once')
  })

  it('maps approve_for_session to allow_always', () => {
    expect(resolveApprovalOptionId(options, 'approve_for_session')).toBe(
      'always',
    )
  })

  it('falls back approve_for_session to allow_once when session-scoped is unavailable', () => {
    const onlyOnce = options.filter((option) => option.kind !== 'allow_always')
    expect(resolveApprovalOptionId(onlyOnce, 'approve_for_session')).toBe(
      'once',
    )
  })

  it('maps reject to reject_once', () => {
    expect(resolveApprovalOptionId(options, 'reject')).toBe('deny-once')
  })

  it('falls back reject to reject_always when reject_once is unavailable', () => {
    const onlyAlways: PermissionOption[] = [
      { optionId: 'deny-always', name: 'Reject always', kind: 'reject_always' },
    ]
    expect(resolveApprovalOptionId(onlyAlways, 'reject')).toBe('deny-always')
  })

  it('returns null when no option of an acceptable kind was offered', () => {
    expect(resolveApprovalOptionId([], 'approve_once')).toBeNull()
  })

  it('builds the ACP-mandated cancelled outcome', () => {
    expect(buildCancelledApprovalOutcome()).toEqual({
      outcome: { outcome: 'cancelled' },
    })
  })
})

describe('buildPendingApprovalMessages', () => {
  it('surfaces a command_execution capability with an extracted command', () => {
    const request: RequestPermissionRequest = {
      sessionId: 'sess-1',
      toolCall: {
        toolCallId: 'call-1',
        title: 'Run tests',
        kind: 'execute',
        rawInput: { command: 'npm test' },
      },
      options: [],
    }
    const [, tool] = buildPendingApprovalMessages(request, 'hermes')
    expect(tool.toolCalls[0]).toMatchObject({
      request: {
        metadata: {
          cliToolCall: { capability: 'command_execution', runtimeId: 'hermes' },
        },
        arguments: { kind: 'complete', value: { command: 'npm test' } },
      },
      response: { status: ToolCallResponseStatus.PendingApproval },
    })
  })
})

describe('toAcpPromptBlocks', () => {
  it('passes plain string content through as a single text block', () => {
    expect(toAcpPromptBlocks('hello')).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })

  it('returns no blocks for empty string content', () => {
    expect(toAcpPromptBlocks('')).toEqual([])
  })

  it('decodes a base64 data URL image into an ACP image block', () => {
    expect(
      toAcpPromptBlocks([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ]),
    ).toEqual([{ type: 'image', mimeType: 'image/png', data: 'QUJD' }])
  })

  it('falls back a non-data-url image to a resource_link', () => {
    expect(
      toAcpPromptBlocks([
        {
          type: 'image_url',
          image_url: { url: 'https://example.com/cat.png' },
        },
      ]),
    ).toEqual([
      {
        type: 'resource_link',
        uri: 'https://example.com/cat.png',
        name: 'image',
      },
    ])
  })

  it('throws for PDF attachments, which ACP has no content type for', () => {
    expect(() =>
      toAcpPromptBlocks([
        {
          type: 'document',
          mediaType: 'application/pdf',
          name: 'doc.pdf',
          data: 'AAAA',
        },
      ]),
    ).toThrow(/does not support PDF attachments/)
  })
})

describe('mapAcpUsageUpdate', () => {
  it('maps used/size onto the context ring inputs', () => {
    expect(
      mapAcpUsageUpdate({
        used: 12_345,
        size: 200_000,
      }),
    ).toEqual({ promptTokens: 12_345, maxContextTokens: 200_000 })
  })

  it('keeps the used count when the agent reports no window size', () => {
    expect(
      mapAcpUsageUpdate({
        used: 4_096,
        size: 0,
      }),
    ).toEqual({ promptTokens: 4_096, maxContextTokens: null })
  })

  it('drops an unusable used count rather than showing a wrong ring', () => {
    expect(
      mapAcpUsageUpdate({
        used: Number.NaN,
        size: 200_000,
      }),
    ).toBeNull()
  })
})
