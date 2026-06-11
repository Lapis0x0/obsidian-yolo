import type { SubagentTaskRecord } from './types'

export type SubagentTaskRegistrySubscriber = (
  records: SubagentTaskRecord[],
) => void

export class SubagentTaskRegistry {
  private readonly tasks = new Map<string, SubagentTaskRecord>()
  private readonly subscribers = new Set<SubagentTaskRegistrySubscriber>()

  register(record: SubagentTaskRecord): void {
    this.tasks.set(record.taskId, record)
    this.emit()
  }

  update(
    taskId: string,
    patch: Partial<Omit<SubagentTaskRecord, 'taskId'>>,
  ): void {
    const existing = this.tasks.get(taskId)
    if (!existing) return
    this.tasks.set(taskId, { ...existing, ...patch })
    this.emit()
  }

  get(taskId: string): SubagentTaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  list(): SubagentTaskRecord[] {
    return [...this.tasks.values()]
  }

  listByConversation(conversationId: string): SubagentTaskRecord[] {
    return [...this.tasks.values()].filter(
      (record) => record.conversationId === conversationId,
    )
  }

  abort(taskId: string): void {
    const record = this.tasks.get(taskId)
    if (!record || record.status !== 'running') return
    record.abortController.abort()
  }

  abortAllForConversation(conversationId: string): void {
    for (const record of this.tasks.values()) {
      if (
        record.conversationId === conversationId &&
        record.status === 'running'
      ) {
        record.abortController.abort()
      }
    }
  }

  abortAll(): void {
    for (const record of this.tasks.values()) {
      if (record.status === 'running') {
        record.abortController.abort()
      }
    }
  }

  subscribe(subscriber: SubagentTaskRegistrySubscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber(this.list())
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  private emit(): void {
    const snapshot = this.list()
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }
}

export const subagentTaskRegistry = new SubagentTaskRegistry()
