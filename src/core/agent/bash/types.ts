import type { AsyncTaskStatus, TaskSource } from '../../../types/chat'

export type BashTaskRecord = {
  taskId: string
  conversationId: string
  source: TaskSource
  title: string
  status: 'running' | AsyncTaskStatus
  createdAt: number
  completedAt?: number
  stdoutBuffer: string
  stderrBuffer: string
  exitCode: number | null
  abortController: AbortController
}
