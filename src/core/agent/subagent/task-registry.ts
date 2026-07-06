import type { SubagentTaskRecord } from './types'

const DEFAULT_MAX_COMPLETED_RECORDS = 50

export type SubagentTaskRegistrySubscriber = (
  records: SubagentTaskRecord[],
) => void

export class SubagentTaskRegistry {
  private readonly tasks = new Map<string, SubagentTaskRecord>()
  private readonly compactedTaskIds = new Set<string>()
  private readonly subscribers = new Set<SubagentTaskRegistrySubscriber>()

  constructor(
    private readonly maxCompletedRecords = DEFAULT_MAX_COMPLETED_RECORDS,
  ) {}

  register(record: SubagentTaskRecord): void {
    this.tasks.set(record.taskId, record)
    this.compactedTaskIds.delete(record.taskId)
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

  compactCompleted(taskId: string): void {
    const existing = this.tasks.get(taskId)
    if (!existing || existing.status === 'running') return
    const compactResult = existing.result
      ? (() => {
          const { transcript: _transcript, ...result } = existing.result
          return result
        })()
      : undefined

    this.tasks.set(taskId, {
      ...existing,
      abortController: new AbortController(),
      liveTranscript: undefined,
      result: compactResult,
    })
    this.compactedTaskIds.add(taskId)
    this.pruneCompletedRecords()
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

  private pruneCompletedRecords(): void {
    const completedRecords = [...this.compactedTaskIds]
      .map((taskId) => this.tasks.get(taskId))
      .filter(
        (record): record is SubagentTaskRecord =>
          record !== undefined && record.status !== 'running',
      )
      .sort(
        (a, b) =>
          (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt),
      )

    const recordsToRemove = completedRecords.length - this.maxCompletedRecords
    for (let index = 0; index < recordsToRemove; index += 1) {
      const taskId = completedRecords[index].taskId
      this.tasks.delete(taskId)
      this.compactedTaskIds.delete(taskId)
    }
  }
}

export const subagentTaskRegistry = new SubagentTaskRegistry()
