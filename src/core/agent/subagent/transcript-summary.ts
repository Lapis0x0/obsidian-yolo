import type { ChatMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'

/** Successful tool calls in a subagent transcript: what a finished
 * subagent reports, and what the activity panel shows while it runs. */
export function countToolUses(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.role !== 'tool') {
      return count
    }
    return (
      count +
      message.toolCalls.filter(
        (toolCall) =>
          toolCall.response.status === ToolCallResponseStatus.Success,
      ).length
    )
  }, 0)
}

/**
 * True when the subagent's last `tool` message still has a tool call awaiting
 * user approval (or the equivalent `ask_user_question` paused state). The
 * runtime returns from `run()` in this case (loop-worker emits `done` when
 * `hasPendingTools=true`), but the work is NOT actually complete — we should
 * wait for `approveToolCall` / `rejectToolCall` to resolve it and then
 * continue, instead of pushing a (false) completion to the parent.
 */
export function hasUnresolvedApproval(messages: ChatMessage[]): boolean {
  const last = messages.at(-1)
  if (!last || last.role !== 'tool') return false
  return last.toolCalls.some(
    (toolCall) =>
      toolCall.response.status === ToolCallResponseStatus.PendingApproval ||
      toolCall.response.status === ToolCallResponseStatus.AwaitingUserInput,
  )
}
