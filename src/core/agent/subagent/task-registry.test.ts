import type { ChatMessage } from '../../../types/chat'

import { SubagentTaskRegistry } from './task-registry'
import type { SubagentResult, SubagentTaskRecord } from './types'

const makeTranscript = (id: string): ChatMessage[] => [
  {
    role: 'assistant',
    id,
    content: `assistant ${id}`,
  },
]

const makeRecord = (
  taskId: string,
  overrides: Partial<SubagentTaskRecord> = {},
): SubagentTaskRecord => {
  const createdAt = overrides.createdAt ?? 1
  const status = overrides.status ?? 'completed'
  const transcript = makeTranscript(taskId)
  const result: SubagentResult = {
    taskId,
    status: status === 'running' ? 'completed' : status,
    content: `result ${taskId}`,
    activityLog: `activity ${taskId}`,
    durationMs: 123,
    toolUseCount: 2,
    prompt: `prompt ${taskId}`,
    modelName: 'test-model',
    transcript,
  }

  return {
    taskId,
    conversationId: 'conv-1',
    source: {
      type: 'llm_tool_call',
      toolCallId: `tool-${taskId}`,
      assistantMessageId: `assistant-${taskId}`,
    },
    title: `Task ${taskId}`,
    status,
    createdAt,
    completedAt: status === 'running' ? undefined : createdAt + 1,
    prompt: `prompt ${taskId}`,
    result,
    liveTranscript: transcript,
    activityLog: result.activityLog,
    abortController: new AbortController(),
    ...overrides,
  }
}

describe('SubagentTaskRegistry', () => {
  it('drops completed task heavy references while keeping summary fields', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('sub_1')
    registry.register(record)

    registry.compactCompleted(record.taskId)

    const compacted = registry.get(record.taskId)
    expect(compacted).toMatchObject({
      taskId: record.taskId,
      conversationId: record.conversationId,
      title: record.title,
      status: 'completed',
      prompt: record.prompt,
      activityLog: record.activityLog,
    })
    expect(compacted?.liveTranscript).toBeUndefined()
    expect(compacted?.abortController).toBeInstanceOf(AbortController)
    expect(compacted?.abortController).not.toBe(record.abortController)
    expect(compacted?.result).toMatchObject({
      taskId: record.taskId,
      status: 'completed',
      content: record.result?.content,
      activityLog: record.result?.activityLog,
      durationMs: record.result?.durationMs,
      toolUseCount: record.result?.toolUseCount,
      prompt: record.result?.prompt,
      modelName: record.result?.modelName,
    })
    expect(compacted?.result?.transcript).toBeUndefined()
  })

  it('keeps running records untouched', () => {
    const registry = new SubagentTaskRegistry()
    const record = makeRecord('sub_running', { status: 'running' })
    registry.register(record)

    registry.compactCompleted(record.taskId)

    expect(registry.get(record.taskId)?.liveTranscript).toBe(
      record.liveTranscript,
    )
    expect(registry.get(record.taskId)?.abortController).toBe(
      record.abortController,
    )
  })

  it('prunes old completed records without removing running tasks', () => {
    const registry = new SubagentTaskRegistry(2)
    const running = makeRecord('sub_running', {
      status: 'running',
      createdAt: 0,
    })
    registry.register(running)

    for (let index = 1; index <= 3; index += 1) {
      const record = makeRecord(`sub_${index}`, { createdAt: index })
      registry.register(record)
      registry.compactCompleted(record.taskId)
    }

    expect(registry.get('sub_1')).toBeUndefined()
    expect(registry.get('sub_2')).toBeDefined()
    expect(registry.get('sub_3')).toBeDefined()
    expect(registry.get(running.taskId)).toBe(running)
  })

  it('does not prune completed records that have not been compacted', () => {
    const registry = new SubagentTaskRegistry(1)
    const pendingMergeRecord = makeRecord('sub_pending_merge', { createdAt: 0 })
    registry.register(pendingMergeRecord)

    for (let index = 1; index <= 2; index += 1) {
      const record = makeRecord(`sub_merged_${index}`, { createdAt: index })
      registry.register(record)
      registry.compactCompleted(record.taskId)
    }

    expect(registry.get(pendingMergeRecord.taskId)).toBe(pendingMergeRecord)
    expect(registry.get('sub_merged_1')).toBeUndefined()
    expect(registry.get('sub_merged_2')).toBeDefined()
  })
})
