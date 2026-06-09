import type { ChatMessage } from '../../types/chat'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { deriveTodosFromMessages } from './todos-from-messages'

export function composeAgentInjections(args: {
  baseInjections: ContextualInjection[] | undefined
  messages: ReadonlyArray<ChatMessage>
}): ContextualInjection[] {
  const todos = deriveTodosFromMessages(args.messages)
  return [
    ...(args.baseInjections ?? []),
    ...(todos.length > 0 ? [{ type: 'todo-list' as const, todos }] : []),
  ]
}
