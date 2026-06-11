import type { ChatTerminalCommandResultMessage } from '../../types/chat'
import type { RequestMessage } from '../../types/llm/request'

export function serializeTerminalCommandResultToUserMessage(
  message: ChatTerminalCommandResultMessage,
): RequestMessage {
  const parts = [
    `[terminal_command_result taskId=${message.taskId} status=${message.status} exitCode=${message.exitCode ?? 'null'}]`,
    `Command: ${message.title}`,
    `Duration: ${message.durationMs}ms`,
  ]

  if (message.stderr.trim()) {
    parts.push(`Stderr:\n${message.stderr}`)
  }
  if (message.stdout.trim()) {
    parts.push(`Stdout:\n${message.stdout}`)
  }
  if (!message.stdout.trim() && !message.stderr.trim()) {
    parts.push('Output: (empty)')
  }

  return {
    role: 'user',
    content: parts.join('\n\n'),
  }
}
