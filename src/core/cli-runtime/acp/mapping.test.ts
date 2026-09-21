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
  buildFileChangeRowsFromContent,
  buildFileChangeRowsFromTexts,
} from '../../tools/file-change-rows'

import {
  AcpSessionAggregator,
  buildCancelledApprovalOutcome,
  buildPendingApprovalMessages,
  extractAcpThoughtLevelState,
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

describe('ACP file-change diffs', () => {
  const apply = (
    aggregator: AcpSessionAggregator,
    update: SessionUpdate,
  ): ChatToolMessage =>
    (aggregator.apply(update, 'hermes') as [unknown, ChatToolMessage])[1]

  const editSummaryOf = (tool: ChatToolMessage) => {
    const response = tool.toolCalls[0].response
    return response.status === ToolCallResponseStatus.Success
      ? response.data.metadata?.editSummary
      : undefined
  }

  const startEdit = (
    aggregator: AcpSessionAggregator,
    diffs: Array<{ path: string; oldText?: string | null; newText: string }>,
  ) =>
    apply(aggregator, {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-1',
      title: 'Edit note.md',
      kind: 'edit',
      status: 'pending',
      content: diffs.map((diff) => ({ type: 'diff' as const, ...diff })),
    })

  const complete = (aggregator: AcpSessionAggregator) =>
    apply(aggregator, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'Edited.' } },
      ],
    })

  it('records every path in the vault-relative form, whatever form the agent reported', () => {
    // CodeBuddy reports absolute paths, Hermes paths relative to its cwd.
    const aggregator = new AcpSessionAggregator('live', '/vault')
    startEdit(aggregator, [
      { path: '/vault/notes/a.md', oldText: 'a\n', newText: 'b\n' },
      { path: 'notes/b.md', oldText: 'a\n', newText: 'b\n' },
      { path: '/elsewhere/c.md', oldText: 'a\n', newText: 'b\n' },
    ])
    const tool = complete(aggregator)

    const paths = ['notes/a.md', 'notes/b.md', '/elsewhere/c.md']
    expect(editSummaryOf(tool)?.files.map((file) => file.path)).toEqual(paths)
    expect(
      tool.toolCalls[0].request.metadata?.fileChangeRows?.map(
        (file) => file.path,
      ),
    ).toEqual(paths)
  })

  it('keeps the diff from tool_call after the completing update replaces content', () => {
    // Hermes' real sequence: the diff rides on the pending tool_call, and the
    // completing update swaps content for plain result text.
    const aggregator = new AcpSessionAggregator()
    startEdit(aggregator, [
      { path: '/vault/note.md', oldText: 'a\nb\n', newText: 'a\nc\nd\n' },
    ])
    const tool = complete(aggregator)

    const response = tool.toolCalls[0].response
    expect(response).toMatchObject({
      status: ToolCallResponseStatus.Success,
      data: { text: 'Edited.' },
    })
    expect(editSummaryOf(tool)).toEqual({
      files: [
        {
          path: '/vault/note.md',
          addedLines: 2,
          removedLines: 1,
          lineStatsAvailable: true,
          operation: 'edit',
          undoStatus: 'unavailable',
          reviewRoundId: undefined,
        },
      ],
      totalFiles: 1,
      totalAddedLines: 2,
      totalRemovedLines: 1,
      undoStatus: 'unavailable',
    })
    expect(
      aggregator.getToolCall('edit-1')?.diffs.map((diff) => diff.newText),
    ).toEqual(['a\nc\nd\n'])
  })

  it('treats oldText: null as a new file', () => {
    const aggregator = new AcpSessionAggregator()
    startEdit(aggregator, [
      { path: '/vault/new.md', oldText: null, newText: 'x\ny' },
    ])
    expect(editSummaryOf(complete(aggregator))?.files).toEqual([
      expect.objectContaining({
        operation: 'create',
        addedLines: 2,
        removedLines: 0,
        lineStatsAvailable: true,
      }),
    ])
  })

  it('does not count an omitted oldText as a creation', () => {
    const aggregator = new AcpSessionAggregator()
    startEdit(aggregator, [{ path: '/vault/note.md', newText: 'x\ny\n' }])
    const summary = editSummaryOf(complete(aggregator))

    expect(summary?.files).toEqual([
      expect.objectContaining({
        path: '/vault/note.md',
        operation: 'edit',
        lineStatsAvailable: false,
      }),
    ])
    expect(summary?.totalLineStatsAvailable).toBe(false)
  })

  it('merges repeated reports per path: first known oldText, latest newText', () => {
    const aggregator = new AcpSessionAggregator()
    startEdit(aggregator, [
      { path: '/vault/a.md', oldText: 'one\n', newText: 'two\n' },
      { path: '/vault/b.md', newText: 'b1\n' },
    ])
    apply(aggregator, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'in_progress',
      content: [
        {
          type: 'diff',
          path: '/vault/a.md',
          oldText: 'two\n',
          newText: 'three\n',
        },
        { type: 'diff', path: '/vault/b.md', oldText: 'b0\n', newText: 'b2\n' },
      ],
    })
    complete(aggregator)

    expect(aggregator.getToolCall('edit-1')?.diffs).toEqual([
      { path: '/vault/a.md', oldText: 'one\n', newText: 'three\n' },
      { path: '/vault/b.md', oldText: 'b0\n', newText: 'b2\n' },
    ])
  })

  it('keeps a known new-file null over a later re-report', () => {
    const aggregator = new AcpSessionAggregator()
    startEdit(aggregator, [
      { path: '/vault/new.md', oldText: null, newText: 'v1' },
    ])
    apply(aggregator, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      content: [
        {
          type: 'diff',
          path: '/vault/new.md',
          oldText: 'v1',
          newText: 'v2',
        },
      ],
    })
    expect(editSummaryOf(complete(aggregator))?.files[0]).toMatchObject({
      operation: 'create',
      addedLines: 1,
    })
  })

  const rowsOf = (tool: ChatToolMessage) =>
    tool.toolCalls[0].request.metadata?.fileChangeRows

  it('builds file-change rows from each oldText form', () => {
    const aggregator = new AcpSessionAggregator()
    const pendingTool = startEdit(aggregator, [
      { path: '/vault/edited.md', oldText: 'a\nb\n', newText: 'a\nc\n' },
      { path: '/vault/new.md', oldText: null, newText: 'x\ny\n' },
      { path: '/vault/unknown.md', newText: 'z\n' },
    ])
    const expected = [
      // A string is the prior content: a real diff.
      buildFileChangeRowsFromTexts('/vault/edited.md', 'a\nb\n', 'a\nc\n'),
      // `null` is a new file: everything added.
      buildFileChangeRowsFromTexts('/vault/new.md', '', 'x\ny\n'),
      // Omitted says nothing about the prior state: written content only.
      buildFileChangeRowsFromContent('/vault/unknown.md', 'z\n'),
    ]
    expect(expected.map((file) => file.completeness)).toEqual([
      'diff',
      'diff',
      'afterOnly',
    ])

    // Present while the call is still running…
    expect(pendingTool.toolCalls[0].response.status).toBe(
      ToolCallResponseStatus.Running,
    )
    expect(rowsOf(pendingTool)).toEqual(expected)
    // …and kept after the completing update replaces `content`.
    const completed = complete(aggregator)
    expect(rowsOf(completed)).toEqual(expected)
    expect(
      completed.toolCalls[0].request.metadata?.cliToolCall?.capability,
    ).toBe('file_change')
  })

  it('treats a call with a diff as a file change even without an edit kind', () => {
    const aggregator = new AcpSessionAggregator()
    const tool = apply(aggregator, {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-2',
      title: 'patch',
      content: [
        { type: 'diff', path: '/vault/a.md', oldText: 'a', newText: 'b' },
      ],
    })
    expect(tool.toolCalls[0].request.metadata?.cliToolCall?.capability).toBe(
      'file_change',
    )
    expect(rowsOf(tool)).toEqual([
      buildFileChangeRowsFromTexts('/vault/a.md', 'a', 'b'),
    ])
  })

  it('attaches no rows to a file-change call that reported no diff', () => {
    const aggregator = new AcpSessionAggregator()
    startEdit(aggregator, [])
    expect(rowsOf(complete(aggregator))).toBeUndefined()
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

  /**
   * Shaped after a real CodeBuddy permission request: ACP types this payload
   * as a ToolCallUpdate, so the agent sends only what changed and leaves the
   * title and kind it already announced in the preceding `tool_call`.
   */
  const incrementalRequest: RequestPermissionRequest = {
    sessionId: 'sess-1',
    toolCall: {
      toolCallId: 'chatcmpl-tool-90ed',
      rawInput: { command: 'echo hi', description: 'Run echo' },
    },
    options: [],
  }

  const announced = {
    toolCallId: 'chatcmpl-tool-90ed',
    title: 'Bash',
    name: 'Bash',
    kind: 'execute' as const,
    status: 'in_progress' as const,
    content: [],
    diffs: [],
    rawInput: {},
  }

  it('falls back to the tool call id when nothing was announced for it', () => {
    const [, tool] = buildPendingApprovalMessages(incrementalRequest, 'hermes')

    expect(tool.toolCalls[0].request.name).toBe('chatcmpl-tool-90ed')
    expect(
      tool.toolCalls[0].request.metadata?.cliToolCall?.capability,
    ).toBeUndefined()
  })

  it('names the card from the state the agent already announced', () => {
    const [, tool] = buildPendingApprovalMessages(
      incrementalRequest,
      'codebuddy',
      announced,
    )

    expect(tool.toolCalls[0].request.name).toBe('Bash')
    expect(tool.toolCalls[0].request.metadata?.cliToolCall).toMatchObject({
      name: 'Bash',
      capability: 'command_execution',
    })
  })

  it('still prefers a field the request itself carries over the remembered one', () => {
    const [, tool] = buildPendingApprovalMessages(
      {
        ...incrementalRequest,
        toolCall: { ...incrementalRequest.toolCall, title: 'Renamed' },
      },
      'codebuddy',
      { ...announced, name: undefined },
    )

    expect(tool.toolCalls[0].request.name).toBe('Renamed')
  })

  it('keeps the request’s own rawInput rather than the announced placeholder', () => {
    const [, tool] = buildPendingApprovalMessages(
      incrementalRequest,
      'codebuddy',
      announced,
    )

    // `announced.rawInput` is the empty object the agent opened the call
    // with; the request carries the arguments the user is approving.
    expect(tool.toolCalls[0].request.arguments).toMatchObject({
      kind: 'complete',
      value: { command: 'echo hi' },
    })
  })

  it('carries the diff the approval request itself reports as file-change rows', () => {
    // Hermes: a separate toolCallId, the diff on the request's own content.
    const [, tool] = buildPendingApprovalMessages(
      {
        sessionId: 'sess-1',
        toolCall: {
          toolCallId: 'edit-approval-1',
          title: 'Approve edit: test.md',
          content: [
            {
              type: 'diff',
              path: '/vault/test.md',
              oldText: 'a\n',
              newText: 'b\n',
            },
          ],
        },
        options: [],
      },
      'hermes',
    )
    expect(tool.toolCalls[0]).toMatchObject({
      request: {
        metadata: {
          cliToolCall: { capability: 'file_change' },
          fileChangeRows: [
            buildFileChangeRowsFromTexts('/vault/test.md', 'a\n', 'b\n'),
          ],
        },
      },
      response: { status: ToolCallResponseStatus.PendingApproval },
    })
  })

  it('carries the diff an earlier notification reported for the same call', () => {
    // CodeBuddy: the request is an increment and reports no content itself.
    const [, tool] = buildPendingApprovalMessages(
      {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'edit-3', rawInput: { path: 'x.md' } },
        options: [],
      },
      'codebuddy',
      {
        toolCallId: 'edit-3',
        title: 'Write',
        kind: 'edit',
        status: 'pending',
        content: [],
        diffs: [{ path: '/vault/x.md', oldText: null, newText: 'new\n' }],
      },
    )
    expect(tool.toolCalls[0].request.metadata?.fileChangeRows).toEqual([
      buildFileChangeRowsFromTexts('/vault/x.md', '', 'new\n'),
    ])
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

describe('extractAcpThoughtLevelState', () => {
  /**
   * Shaped after what CodeBuddy actually returns from `session/new`: the
   * reserved `thought_level` category alongside the mode and model
   * selectors that share the same `configOptions` array.
   */
  const response = {
    sessionId: 's1',
    configOptions: [
      {
        type: 'select',
        id: 'mode',
        name: 'Permission Mode',
        category: 'mode',
        currentValue: 'default',
        options: [{ value: 'default', name: 'Always Ask' }],
      },
      {
        type: 'select',
        id: 'thought_level',
        name: 'Deep Thinking',
        category: 'thought_level',
        currentValue: 'high',
        options: [
          {
            value: 'disabled',
            name: 'Off',
            description: 'No extended thinking',
          },
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High', description: 'Deep reasoning' },
          { value: 'enabled', name: 'On (default)' },
        ],
      },
    ],
  }

  it('picks the thought_level option out of the shared config list', () => {
    const state = extractAcpThoughtLevelState(response)

    expect(state?.optionId).toBe('thought_level')
    expect(state?.currentValue).toBe('high')
    expect(state?.options).toEqual([
      { id: 'disabled', description: 'No extended thinking' },
      { id: 'low' },
      { id: 'high', description: 'Deep reasoning' },
      { id: 'enabled' },
    ])
  })

  it('collects every value id so a write can be validated before sending', () => {
    expect([
      ...(extractAcpThoughtLevelState(response)?.valueIds ?? []),
    ]).toEqual(['disabled', 'low', 'high', 'enabled'])
  })

  it('flattens grouped select options in the order the agent listed them', () => {
    const state = extractAcpThoughtLevelState({
      configOptions: [
        {
          type: 'select',
          id: 'thought_level',
          category: 'thought_level',
          currentValue: 'fast',
          options: [
            {
              group: 'cheap',
              name: 'Cheap',
              options: [{ value: 'fast', name: 'Fast' }],
            },
            {
              group: 'deep',
              name: 'Deep',
              options: [{ value: 'slow', name: 'Slow' }],
            },
          ],
        },
      ],
    })

    expect(state?.options.map((option) => option.id)).toEqual(['fast', 'slow'])
  })

  it('ignores a boolean option that claims the category', () => {
    expect(
      extractAcpThoughtLevelState({
        configOptions: [
          {
            type: 'boolean',
            id: 'thinking',
            category: 'thought_level',
            currentValue: true,
          },
        ],
      }),
    ).toBeNull()
  })

  it('returns null for agents that advertise no config options at all', () => {
    expect(extractAcpThoughtLevelState({ sessionId: 's1' })).toBeNull()
    expect(extractAcpThoughtLevelState(null)).toBeNull()
  })
})
