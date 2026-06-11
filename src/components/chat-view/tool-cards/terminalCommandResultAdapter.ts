import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { getToolName } from '../../../core/mcp/tool-name-utils'
import type {
  ChatTerminalCommandResultMessage,
  ChatToolMessage,
} from '../../../types/chat'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

export function buildSynthToolMessageFromTerminalCommandResult(
  message: ChatTerminalCommandResultMessage,
): ChatToolMessage {
  return {
    role: 'tool',
    id: message.id,
    toolCalls: [
      {
        request: buildSynthRequest(message),
        response: buildSynthResponse(message),
      },
    ],
  }
}

function buildSynthRequest(
  message: ChatTerminalCommandResultMessage,
): ToolCallRequest {
  return {
    id: `result-${message.taskId}`,
    name: getToolName(getLocalFileToolServerName(), 'terminal_command'),
    arguments: {
      kind: 'complete',
      value: {
        command: message.title,
        background: true,
        stderr: message.stderr ?? '',
        stdout: message.stdout ?? '',
      },
    },
  }
}

function buildSynthResponse(
  message: ChatTerminalCommandResultMessage,
): ToolCallResponse {
  const stdout = message.stdout ?? ''
  const stderr = message.stderr ?? ''
  const combined =
    stderr && stdout ? `${stderr}\n---\n${stdout}` : stderr || stdout

  switch (message.status) {
    case 'running':
      return {
        status: ToolCallResponseStatus.Running,
      }
    case 'completed':
      return {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: combined },
      }
    case 'cancelled':
    case 'killed_by_shutdown':
      return {
        status: ToolCallResponseStatus.Aborted,
        data: combined ? { type: 'text', text: combined } : undefined,
      }
    case 'timed_out':
      return {
        status: ToolCallResponseStatus.Error,
        error: combined ? `Timed out.\n${combined}` : 'Timed out.',
      }
    case 'failed':
      return {
        status: ToolCallResponseStatus.Error,
        error: combined ? `Failed.\n${combined}` : 'Failed.',
      }
  }
}
