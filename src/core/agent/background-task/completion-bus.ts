import type { BashTaskRecord } from '../bash/types'
import type { SubagentTaskRecord } from '../subagent/types'

export type BackgroundTaskCompletedEvent =
  | {
      kind: 'subagent'
      taskId: string
      conversationId: string
      record: SubagentTaskRecord
    }
  | {
      kind: 'terminal_command'
      taskId: string
      conversationId: string
      record: BashTaskRecord
    }

export type BackgroundTaskTerminalWaitingEvent = {
  kind: 'terminal_command_waiting'
  taskId: string
  conversationId: string
  occurredAt: number
  record: BashTaskRecord
}

export type BackgroundTaskEvent =
  | BackgroundTaskCompletedEvent
  | BackgroundTaskTerminalWaitingEvent

type BackgroundTaskSubscriber = (event: BackgroundTaskEvent) => void
type BackgroundTaskCompletedSubscriber = (
  event: BackgroundTaskCompletedEvent,
) => void

class BackgroundTaskCompletionBus {
  private readonly subscribers = new Set<BackgroundTaskSubscriber>()

  subscribe(fn: BackgroundTaskSubscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  subscribeCompleted(fn: BackgroundTaskCompletedSubscriber): () => void {
    return this.subscribe((event) => {
      if (event.kind !== 'terminal_command_waiting') {
        fn(event)
      }
    })
  }

  pushCompleted(event: BackgroundTaskCompletedEvent): void {
    for (const fn of this.subscribers) {
      fn(event)
    }
  }

  pushTerminalWaiting(event: BackgroundTaskTerminalWaitingEvent): void {
    for (const fn of this.subscribers) {
      fn(event)
    }
  }
}

export const backgroundTaskCompletionBus = new BackgroundTaskCompletionBus()
