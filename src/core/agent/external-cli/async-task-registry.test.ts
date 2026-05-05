// AsyncTaskRegistry 单元测试

import type { AsyncTaskRecord } from './async-task-registry'
import { AsyncTaskRegistry } from './async-task-registry'

function makeRecord(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    taskId: 'ext_test001',
    source: {
      type: 'llm_tool_call',
      toolCallId: 'tc-1',
      assistantMessageId: 'msg-1',
    },
    conversationId: 'conv-1',
    provider: 'codex',
    title: 'test task',
    status: 'running',
    createdAt: Date.now(),
    stdoutBuffer: '',
    stderrBuffer: '',
    exitCode: null,
    abortController: new AbortController(),
    ...overrides,
  }
}

describe('AsyncTaskRegistry', () => {
  let registry: AsyncTaskRegistry

  beforeEach(() => {
    registry = new AsyncTaskRegistry()
  })

  it('register and get', () => {
    const record = makeRecord()
    registry.register(record)
    expect(registry.get('ext_test001')).toEqual(record)
  })

  it('update patches fields', () => {
    const record = makeRecord()
    registry.register(record)
    registry.update('ext_test001', { status: 'completed', exitCode: 0 })
    const updated = registry.get('ext_test001')
    expect(updated?.status).toBe('completed')
    expect(updated?.exitCode).toBe(0)
    expect(updated?.taskId).toBe('ext_test001')
  })

  it('update on unknown taskId is a no-op', () => {
    expect(() =>
      registry.update('unknown', { status: 'completed' }),
    ).not.toThrow()
  })

  it('listByConversation returns matching records', () => {
    registry.register(makeRecord({ taskId: 'a', conversationId: 'conv-1' }))
    registry.register(makeRecord({ taskId: 'b', conversationId: 'conv-2' }))
    registry.register(makeRecord({ taskId: 'c', conversationId: 'conv-1' }))
    const result = registry.listByConversation('conv-1')
    expect(result.map((r) => r.taskId)).toEqual(
      expect.arrayContaining(['a', 'c']),
    )
    expect(result.length).toBe(2)
  })

  it('abort calls abortController.abort() and does not change status', () => {
    const abortController = new AbortController()
    const abortSpy = jest.spyOn(abortController, 'abort')
    const record = makeRecord({ abortController })
    registry.register(record)
    registry.abort('ext_test001')
    expect(abortSpy).toHaveBeenCalledTimes(1)
  })

  it('abort on completed task is a no-op', () => {
    const abortController = new AbortController()
    const abortSpy = jest.spyOn(abortController, 'abort')
    const record = makeRecord({ abortController, status: 'completed' })
    registry.register(record)
    registry.abort('ext_test001')
    expect(abortSpy).not.toHaveBeenCalled()
  })

  it('abortAll aborts all running tasks', () => {
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const spy1 = jest.spyOn(ac1, 'abort')
    const spy2 = jest.spyOn(ac2, 'abort')
    registry.register(makeRecord({ taskId: 'a', abortController: ac1 }))
    registry.register(makeRecord({ taskId: 'b', abortController: ac2 }))
    registry.abortAll()
    expect(spy1).toHaveBeenCalledTimes(1)
    expect(spy2).toHaveBeenCalledTimes(1)
  })
})
