// LLM 序列化层快照测试：external_agent_result → user-role text

import type { ChatExternalAgentResultMessage } from '../../types/chat'

import { serializeExternalAgentResultToUserMessage } from './externalAgentResultSerializer'

function makeMessage(
  overrides: Partial<ChatExternalAgentResultMessage> = {},
): ChatExternalAgentResultMessage {
  return {
    role: 'external_agent_result',
    id: 'msg-1',
    taskId: 'ext_abc123',
    source: {
      type: 'llm_tool_call',
      toolCallId: 'tc-1',
      assistantMessageId: 'assistant-msg-1',
    },
    provider: 'codex',
    title: 'Investigate failing sync tests',
    status: 'completed',
    exitCode: 0,
    stdout: 'All tests pass.',
    stderr: 'Running tests...\nDone.',
    durationMs: 142000,
    delegateAssistantMessageId: 'assistant-msg-1',
    delegateToolCallId: 'tc-1',
    ...overrides,
  }
}

describe('serializeExternalAgentResultToUserMessage', () => {
  it('serializes to user-role message', () => {
    const result = serializeExternalAgentResultToUserMessage(makeMessage())
    expect(result.role).toBe('user')
    expect(typeof result.content).toBe('string')
  })

  it('includes taskId, status, exitCode in header', () => {
    const result = serializeExternalAgentResultToUserMessage(makeMessage())
    const content = result.content as string
    expect(content).toContain('[external_agent_result taskId=ext_abc123')
    expect(content).toContain('status=completed')
    expect(content).toContain('exitCode=0')
  })

  it('includes title, provider, duration', () => {
    const result = serializeExternalAgentResultToUserMessage(makeMessage())
    const content = result.content as string
    expect(content).toContain('title: Investigate failing sync tests')
    expect(content).toContain('provider: codex')
    expect(content).toContain('duration: 142s')
  })

  it('includes stdout and stderr', () => {
    const result = serializeExternalAgentResultToUserMessage(makeMessage())
    const content = result.content as string
    expect(content).toContain('stdout:')
    expect(content).toContain('All tests pass.')
    expect(content).toContain('stderr:')
    expect(content).toContain('Running tests...')
  })

  it('truncates stdout exceeding 8000 chars', () => {
    const longStdout = 'x'.repeat(9000)
    const result = serializeExternalAgentResultToUserMessage(
      makeMessage({ stdout: longStdout }),
    )
    const content = result.content as string
    expect(content).toContain('... [truncated, total 9000 chars]')
    const stdoutPart = content.split('stdout:')[1]?.split('stderr:')[0] ?? ''
    expect(stdoutPart.length).toBeLessThan(8100)
  })

  it('does not truncate stdout under 8000 chars', () => {
    const shortStdout = 'y'.repeat(100)
    const result = serializeExternalAgentResultToUserMessage(
      makeMessage({ stdout: shortStdout }),
    )
    const content = result.content as string
    expect(content).not.toContain('truncated')
  })

  it('handles failed status with null exitCode', () => {
    const result = serializeExternalAgentResultToUserMessage(
      makeMessage({ status: 'failed', exitCode: null }),
    )
    const content = result.content as string
    expect(content).toContain('status=failed')
    expect(content).toContain('exitCode=null')
  })
})
