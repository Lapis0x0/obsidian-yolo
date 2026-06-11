import type { ChatMessage, TaskSource } from '../../../types/chat'
import type { ResponseUsage } from '../../../types/llm/response'

export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'aborted'

export type SubagentAcceptedResult = {
  accepted: true
  taskId: string
  title: string
  status: 'running'
  note: string
  modelName?: string
}

export type SubagentResult = {
  taskId: string
  status: 'completed' | 'failed' | 'aborted'
  content: string
  activityLog?: string
  durationMs: number
  toolUseCount: number
  usage?: ResponseUsage
  prompt?: string
  modelName?: string
  transcript?: ChatMessage[]
}

export type SubagentTaskRecord = {
  taskId: string
  conversationId: string
  source: TaskSource
  title: string
  status: SubagentTaskStatus
  createdAt: number
  completedAt?: number
  prompt: string
  result?: SubagentResult
  liveTranscript?: ChatMessage[]
  activityLog?: string
  error?: string
  abortController: AbortController
}
