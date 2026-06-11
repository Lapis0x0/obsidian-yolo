import { backgroundTaskCompletionBus } from './completion-bus'
import type { BackgroundTaskCompletedEvent } from './completion-bus'

const makeEvent = (): BackgroundTaskCompletedEvent => ({
  kind: 'terminal_command',
  taskId: 'bash_test001',
  conversationId: 'conv-1',
  record: {
    taskId: 'bash_test001',
    conversationId: 'conv-1',
    source: {
      type: 'llm_tool_call',
      assistantMessageId: 'assistant-1',
      toolCallId: 'tool-1',
    },
    title: 'echo done',
    status: 'completed',
    createdAt: 1,
    completedAt: 2,
    stdoutBuffer: 'done',
    stderrBuffer: '',
    exitCode: 0,
    abortController: new AbortController(),
  },
})

describe('backgroundTaskCompletionBus', () => {
  it('notifies subscribers and respects unsubscribe', () => {
    const subscriber = jest.fn()
    const unsubscribe =
      backgroundTaskCompletionBus.subscribeCompleted(subscriber)

    const event = makeEvent()
    backgroundTaskCompletionBus.pushCompleted(event)
    expect(subscriber).toHaveBeenCalledWith(event)

    unsubscribe()
    backgroundTaskCompletionBus.pushCompleted(makeEvent())
    expect(subscriber).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers about terminal waiting events', () => {
    const subscriber = jest.fn()
    const unsubscribe = backgroundTaskCompletionBus.subscribe(subscriber)
    const completed = makeEvent()
    const runningRecord = { ...completed.record }
    delete runningRecord.completedAt
    const waiting = {
      kind: 'terminal_command_waiting' as const,
      taskId: completed.taskId,
      conversationId: completed.conversationId,
      occurredAt: 3,
      record: {
        ...runningRecord,
        status: 'running' as const,
        stdoutBuffer: 'ready',
        stderrBuffer: 'warn',
        exitCode: null,
      },
    }

    backgroundTaskCompletionBus.pushTerminalWaiting(waiting)
    expect(subscriber).toHaveBeenCalledWith(waiting)

    unsubscribe()
  })

  it('keeps completed-only subscribers isolated from terminal waiting events', () => {
    const subscriber = jest.fn()
    const unsubscribe =
      backgroundTaskCompletionBus.subscribeCompleted(subscriber)
    const completed = makeEvent()
    const runningRecord = { ...completed.record }
    delete runningRecord.completedAt

    backgroundTaskCompletionBus.pushTerminalWaiting({
      kind: 'terminal_command_waiting',
      taskId: completed.taskId,
      conversationId: completed.conversationId,
      occurredAt: 3,
      record: {
        ...runningRecord,
        status: 'running',
        stdoutBuffer: 'ready',
        stderrBuffer: '',
        exitCode: null,
      },
    })

    expect(subscriber).not.toHaveBeenCalled()

    unsubscribe()
  })
})
