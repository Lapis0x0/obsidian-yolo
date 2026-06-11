import type { ChatSubagentResultMessage } from '../../types/chat'
import type { RequestMessage } from '../../types/llm/request'

const TRUNCATE_LIMIT = 8000

function truncateOutput(text: string): string {
  if (text.length <= TRUNCATE_LIMIT) return text
  return (
    text.slice(0, TRUNCATE_LIMIT) +
    `\n... [truncated, total ${text.length} chars]`
  )
}

export function serializeSubagentResultToUserMessage(
  message: ChatSubagentResultMessage,
): RequestMessage {
  const durationSec = Math.round(message.durationMs / 1000)
  const lines: string[] = [
    `[subagent_result taskId=${message.taskId} status=${message.status}]`,
    `title: ${message.title}`,
    `duration: ${durationSec}s`,
    `toolUseCount: ${message.toolUseCount}`,
    '',
    'content:',
    truncateOutput(message.content),
  ]

  return {
    role: 'user',
    content: lines.join('\n'),
  }
}
