import type {
  AssistantToolMessageGroup,
  ChatAssistantMessage,
  ChatSubagentResultMessage,
  ChatTerminalCommandResultMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import {
  buildForegroundAgentVisualTurnPlan,
  getForegroundAgentFooterForGroup,
} from './foregroundAgentVisualTurns'

const makeUser = (id: string): ChatUserMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: id,
  mentionables: [],
})

const makeAssistant = (id: string): ChatAssistantMessage => ({
  role: 'assistant',
  id,
  content: id,
  metadata: {
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    },
  },
})

const makeTool = (id: string): ChatToolMessage => ({
  role: 'tool',
  id,
  toolCalls: [
    {
      request: {
        id: `${id}-call`,
        name: 'yolo_local__delegate_subagent',
        arguments: {
          kind: 'complete',
          value: {},
          rawText: '{}',
        },
      },
      response: {
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text: 'accepted',
        },
      },
    },
  ],
})

const makeSubagentResult = (id: string): ChatSubagentResultMessage => ({
  role: 'subagent_result',
  id,
  taskId: id,
  source: {
    type: 'llm_tool_call',
    toolCallId: 'tool-call-1',
    assistantMessageId: 'assistant-1',
  },
  title: 'Subagent',
  status: 'completed',
  content: 'done',
  durationMs: 1000,
  toolUseCount: 1,
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
  },
  delegateAssistantMessageId: 'assistant-1',
  delegateToolCallId: 'tool-call-1',
})

const makeTerminalResult = (id: string): ChatTerminalCommandResultMessage => ({
  role: 'terminal_command_result',
  id,
  taskId: id,
  source: {
    type: 'llm_tool_call',
    toolCallId: 'tool-call-1',
    assistantMessageId: 'assistant-1',
  },
  title: 'Terminal',
  status: 'completed',
  exitCode: 0,
  stdout: 'done',
  stderr: '',
  durationMs: 1000,
  delegateAssistantMessageId: 'assistant-1',
  delegateToolCallId: 'tool-call-1',
})

const group = (...messages: AssistantToolMessageGroup) => messages
const summarize = (messages: AssistantToolMessageGroup | undefined) =>
  messages?.map((message) => ({
    id: message.id,
    role: message.role,
  }))

describe('buildForegroundAgentVisualTurnPlan', () => {
  it('uses each assistant group as its own footer source by default', () => {
    const first = group(makeAssistant('assistant-1'))
    const second = group(makeAssistant('assistant-2'))

    const plan = buildForegroundAgentVisualTurnPlan([
      makeUser('user-1'),
      first,
      makeUser('user-2'),
      second,
    ])

    expect(getForegroundAgentFooterForGroup(plan, first)).toEqual({
      suppress: false,
      inlineInfoMessages: first,
    })
    expect(getForegroundAgentFooterForGroup(plan, second)).toEqual({
      suppress: false,
      inlineInfoMessages: second,
    })
  })

  it('moves pre-background main agent usage onto the continuation footer', () => {
    const beforeBackground = group(
      makeAssistant('assistant-1'),
      makeTool('tool-1'),
    )
    const backgroundResult = group(makeSubagentResult('subagent-result-1'))
    const afterBackground = group(makeAssistant('assistant-2'))

    const plan = buildForegroundAgentVisualTurnPlan([
      makeUser('user-1'),
      beforeBackground,
      backgroundResult,
      afterBackground,
    ])

    expect(getForegroundAgentFooterForGroup(plan, beforeBackground)).toEqual({
      suppress: true,
      inlineInfoMessages: beforeBackground,
    })
    expect(
      getForegroundAgentFooterForGroup(plan, backgroundResult),
    ).toBeUndefined()
    const footer = getForegroundAgentFooterForGroup(plan, afterBackground)
    expect(footer?.suppress).toBe(false)
    expect(summarize(footer?.inlineInfoMessages)).toEqual([
      { id: 'assistant-1', role: 'assistant' },
      { id: 'tool-1', role: 'tool' },
      { id: 'assistant-2', role: 'assistant' },
    ])
  })

  it('handles the real grouped shape where the background result and continuation assistant share one group', () => {
    const beforeBackground = group(
      makeAssistant('assistant-1'),
      makeTool('tool-1'),
    )
    const resultAndContinuation = group(
      makeSubagentResult('subagent-result-1'),
      makeAssistant('assistant-2'),
    )

    const plan = buildForegroundAgentVisualTurnPlan([
      makeUser('user-1'),
      beforeBackground,
      resultAndContinuation,
    ])

    expect(getForegroundAgentFooterForGroup(plan, beforeBackground)).toEqual({
      suppress: true,
      inlineInfoMessages: beforeBackground,
    })
    const footer = getForegroundAgentFooterForGroup(plan, resultAndContinuation)
    expect(footer?.suppress).toBe(false)
    expect(summarize(footer?.inlineInfoMessages)).toEqual([
      { id: 'assistant-1', role: 'assistant' },
      { id: 'tool-1', role: 'tool' },
      { id: 'assistant-2', role: 'assistant' },
    ])
  })

  it('chains multiple background continuations into the last visible footer', () => {
    const first = group(makeAssistant('assistant-1'))
    const firstBridge = group(makeSubagentResult('subagent-result-1'))
    const second = group(makeAssistant('assistant-2'))
    const secondBridge = group(makeTerminalResult('terminal-result-1'))
    const third = group(makeAssistant('assistant-3'))

    const plan = buildForegroundAgentVisualTurnPlan([
      makeUser('user-1'),
      first,
      firstBridge,
      second,
      secondBridge,
      third,
    ])

    expect(getForegroundAgentFooterForGroup(plan, first)?.suppress).toBe(true)
    expect(getForegroundAgentFooterForGroup(plan, second)?.suppress).toBe(true)
    const footer = getForegroundAgentFooterForGroup(plan, third)
    expect(footer?.suppress).toBe(false)
    expect(summarize(footer?.inlineInfoMessages)).toEqual([
      { id: 'assistant-1', role: 'assistant' },
      { id: 'assistant-2', role: 'assistant' },
      { id: 'assistant-3', role: 'assistant' },
    ])
  })

  it('does not suppress a footer until a main-agent continuation exists', () => {
    const beforeBackground = group(makeAssistant('assistant-1'))
    const backgroundResult = group(makeSubagentResult('subagent-result-1'))

    const plan = buildForegroundAgentVisualTurnPlan([
      makeUser('user-1'),
      beforeBackground,
      backgroundResult,
    ])

    expect(getForegroundAgentFooterForGroup(plan, beforeBackground)).toEqual({
      suppress: false,
      inlineInfoMessages: beforeBackground,
    })
  })

  it('finds the same footer when timeline renders a slice inside the original group', () => {
    const beforeBackground = group(
      makeAssistant('assistant-1'),
      makeTool('tool-1'),
    )
    const backgroundResult = group(makeSubagentResult('subagent-result-1'))
    const afterBackground = group(makeAssistant('assistant-2'))

    const plan = buildForegroundAgentVisualTurnPlan([
      makeUser('user-1'),
      beforeBackground,
      backgroundResult,
      afterBackground,
    ])

    expect(
      getForegroundAgentFooterForGroup(plan, group(beforeBackground[1])),
    ).toEqual({
      suppress: true,
      inlineInfoMessages: beforeBackground,
    })
  })
})
