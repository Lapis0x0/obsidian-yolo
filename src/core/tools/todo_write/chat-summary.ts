import { truncateText } from '../chat-summary-support'

/**
 * Chat-surface summary for `todo_write` — ported verbatim from the
 * `toolName === 'todo_write'` branch of `ToolMessage.tsx`'s private
 * `getLocalToolSummaryText` (pre-D8). Wired into `TOOL_RENDERERS` as this
 * tool's `summary` field (phase2-migration.md D8).
 *
 * `labels` only carries the four todo-list strings this tool needs — see
 * `terminal_command/chat-summary.ts`'s doc comment for why this is a
 * structural subset rather than an import of `ToolMessage.tsx`'s
 * `ToolLabels`.
 */
export type TodoWriteSummaryLabels = {
  todoWriteCleared: string
  todoWriteAllCompleted: (count: number) => string
  todoWriteCreated: (count: number) => string
  todoWriteProgress: (done: number, total: number) => string
}

type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

const isTodoItem = (item: unknown): item is TodoItem => {
  if (!item || typeof item !== 'object') return false
  const record = item as Record<string, unknown>
  return (
    typeof record.content === 'string' &&
    (record.status === 'pending' ||
      record.status === 'in_progress' ||
      record.status === 'completed')
  )
}

export const getTodoWriteChatSummary = ({
  argumentsObject,
  labels,
}: {
  argumentsObject: Record<string, unknown> | null
  labels: TodoWriteSummaryLabels
}): string | undefined => {
  const rawTodos = Array.isArray(argumentsObject?.todos)
    ? (argumentsObject.todos as unknown[])
    : []
  const todos = rawTodos.filter(isTodoItem)

  if (todos.length === 0) return labels.todoWriteCleared
  const inProgress = todos.find((todo) => todo.status === 'in_progress')
  if (inProgress) return truncateText(inProgress.content, 60)
  const total = todos.length
  const done = todos.filter((todo) => todo.status === 'completed').length
  if (done === total) return labels.todoWriteAllCompleted(total)
  if (done === 0) return labels.todoWriteCreated(total)
  return labels.todoWriteProgress(done, total)
}
