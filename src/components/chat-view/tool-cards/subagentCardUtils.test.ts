import type { ChatSubagentResultMessage } from '../../../types/chat'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

import { resolveSubagentEffectiveStatus } from './subagentCardUtils'

const acceptedResponse: ToolCallResponse = {
  status: ToolCallResponseStatus.Success,
  data: {
    type: 'text',
    text: JSON.stringify({
      accepted: true,
      taskId: 'sub_card_1',
      title: 'Investigate',
      status: 'running',
      note: '',
    }),
  },
}

const makeResultMessage = (
  status: ChatSubagentResultMessage['status'],
): ChatSubagentResultMessage => ({
  role: 'subagent_result',
  id: 'subagent-result-1',
  taskId: 'sub_card_1',
  source: {
    type: 'llm_tool_call',
    toolCallId: 'delegate-1',
    assistantMessageId: 'assistant-1',
  },
  title: 'Investigate',
  status,
  content: 'done',
  durationMs: 1000,
  toolUseCount: 0,
  delegateAssistantMessageId: 'assistant-1',
  delegateToolCallId: 'delegate-1',
})

const liveStream = (status: 'starting' | 'running' | 'done') =>
  ({
    stdout: '',
    stderr: '',
    status,
    source: 'live',
  }) as const

describe('resolveSubagentEffectiveStatus', () => {
  it('maps a persisted subagent result to its terminal status', () => {
    expect(
      resolveSubagentEffectiveStatus({
        subagentResult: makeResultMessage('completed'),
        stream: null,
        response: acceptedResponse,
      }),
    ).toBe(ToolCallResponseStatus.Success)
    expect(
      resolveSubagentEffectiveStatus({
        subagentResult: makeResultMessage('aborted'),
        stream: null,
        response: acceptedResponse,
      }),
    ).toBe(ToolCallResponseStatus.Aborted)
    expect(
      resolveSubagentEffectiveStatus({
        subagentResult: makeResultMessage('failed'),
        stream: null,
        response: acceptedResponse,
      }),
    ).toBe(ToolCallResponseStatus.Error)
  })

  it('keeps a running live stream as running and falls back to the response once done', () => {
    expect(
      resolveSubagentEffectiveStatus({
        stream: liveStream('running'),
        response: acceptedResponse,
      }),
    ).toBe(ToolCallResponseStatus.Running)
    expect(
      resolveSubagentEffectiveStatus({
        stream: liveStream('done'),
        response: acceptedResponse,
      }),
    ).toBe(ToolCallResponseStatus.Success)
    expect(
      resolveSubagentEffectiveStatus({
        stream: null,
        response: { status: ToolCallResponseStatus.Aborted },
      }),
    ).toBe(ToolCallResponseStatus.Aborted)
  })

  it('treats a running registry record as running even without a live stream (#647)', () => {
    expect(
      resolveSubagentEffectiveStatus({
        stream: null,
        response: acceptedResponse,
        taskStatus: 'running',
      }),
    ).toBe(ToolCallResponseStatus.Running)
    // A recycled "done" stream snapshot must not hide a still-running task.
    expect(
      resolveSubagentEffectiveStatus({
        stream: liveStream('done'),
        response: acceptedResponse,
        taskStatus: 'running',
      }),
    ).toBe(ToolCallResponseStatus.Running)
  })

  it('lets a persisted result win over a stale running registry record', () => {
    expect(
      resolveSubagentEffectiveStatus({
        subagentResult: makeResultMessage('completed'),
        stream: null,
        response: acceptedResponse,
        taskStatus: 'running',
      }),
    ).toBe(ToolCallResponseStatus.Success)
  })

  it('does not promote a settled registry record to running', () => {
    expect(
      resolveSubagentEffectiveStatus({
        stream: null,
        response: acceptedResponse,
        taskStatus: 'completed',
      }),
    ).toBe(ToolCallResponseStatus.Success)
  })
})
