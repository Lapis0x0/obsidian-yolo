import type { ChatSubagentResultMessage } from '../../types/chat'

import { serializeSubagentResultToUserMessage } from './subagentResultSerializer'

function makeMessage(
  overrides: Partial<ChatSubagentResultMessage> = {},
): ChatSubagentResultMessage {
  return {
    role: 'subagent_result',
    id: 'msg-1',
    taskId: 'sub_abc123',
    source: {
      type: 'llm_tool_call',
      toolCallId: 'tool-1',
      assistantMessageId: 'asst-1',
    },
    title: 'Research vault tags',
    status: 'completed',
    content: 'Found 3 tag patterns.',
    durationMs: 4200,
    toolUseCount: 2,
    delegateAssistantMessageId: 'asst-1',
    delegateToolCallId: 'tool-1',
    ...overrides,
  }
}

describe('serializeSubagentResultToUserMessage', () => {
  it('serializes subagent_result as a user-role background event', () => {
    const result = serializeSubagentResultToUserMessage(makeMessage())
    const content = result.content as string
    expect(content).toContain('[subagent_result taskId=sub_abc123')
    expect(content).toContain('status=completed')
    expect(content).toContain('title: Research vault tags')
    expect(content).toContain('toolUseCount: 2')
    expect(content).toContain('Found 3 tag patterns.')
  })
})
