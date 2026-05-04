import type { AsyncTaskStatus, TaskSource } from '../../../types/chat'

import type { ExternalAgentProvider } from './runner'

export type AsyncTaskRecord = {
  taskId: string
  source: TaskSource
  conversationId: string
  provider: ExternalAgentProvider
  title: string
  status: 'running' | AsyncTaskStatus
  createdAt: number
  completedAt?: number
  stdoutBuffer: string
  stderrBuffer: string
  exitCode: number | null
  abortController: AbortController
}

export class AsyncTaskRegistry {
  private readonly tasks = new Map<string, AsyncTaskRecord>()

  register(record: AsyncTaskRecord): void {
    this.tasks.set(record.taskId, record)
  }

  update(
    taskId: string,
    patch: Partial<Omit<AsyncTaskRecord, 'taskId'>>,
  ): void {
    const existing = this.tasks.get(taskId)
    if (!existing) return
    this.tasks.set(taskId, { ...existing, ...patch })
  }

  get(taskId: string): AsyncTaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  listByConversation(conversationId: string): AsyncTaskRecord[] {
    return [...this.tasks.values()].filter(
      (r) => r.conversationId === conversationId,
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
}

// 单例
export const asyncTaskRegistry = new AsyncTaskRegistry()
