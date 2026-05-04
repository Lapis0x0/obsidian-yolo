import type { ChatExternalAgentResultMessage } from '../../types/chat'
import type { RequestMessage } from '../../types/llm/request'

const TRUNCATE_LIMIT = 8000

function truncateOutput(text: string): string {
  if (text.length <= TRUNCATE_LIMIT) return text
  return (
    text.slice(0, TRUNCATE_LIMIT) +
    `\n... [truncated, total ${text.length} chars]`
  )
}

export function serializeExternalAgentResultToUserMessage(
  message: ChatExternalAgentResultMessage,
): RequestMessage {
  const durationSec = Math.round(message.durationMs / 1000)
  const lines: string[] = [
    `[external_agent_result taskId=${message.taskId} status=${message.status} exitCode=${message.exitCode ?? 'null'}]`,
    `title: ${message.title}`,
    `provider: ${message.provider}`,
    `duration: ${durationSec}s`,
    '',
    'stdout:',
    truncateOutput(message.stdout),
    '',
    'stderr:',
    truncateOutput(message.stderr),
  ]

  return {
    role: 'user',
    content: lines.join('\n'),
  }
}
