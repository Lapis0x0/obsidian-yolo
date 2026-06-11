// Legacy display adapter for persisted external_agent_result messages.
// Synthesizes a terminal_command tool card so old conversations stay readable.

import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { getToolName } from '../../../core/mcp/tool-name-utils'
import type {
  ChatExternalAgentResultMessage,
  ChatToolMessage,
} from '../../../types/chat'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

export function buildSynthToolMessageFromResult(
  message: ChatExternalAgentResultMessage,
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
  message: ChatExternalAgentResultMessage,
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
  message: ChatExternalAgentResultMessage,
): ToolCallResponse {
  const stdout = message.stdout ?? ''
  const stderr = message.stderr ?? ''
  const combined =
    stderr && stdout ? `${stderr}\n---\n${stdout}` : stderr || stdout

  switch (message.status) {
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
    case 'timed_out': {
      const prefix = `Timed out${
        message.exitCode != null ? ` (exit ${message.exitCode})` : ''
      }.`
      return {
        status: ToolCallResponseStatus.Error,
        error: combined ? `${prefix}\n${combined}` : prefix,
      }
    }
    case 'failed': {
      const prefix =
        message.exitCode != null
          ? `Failed (exit ${message.exitCode}).`
          : 'Failed.'
      return {
        status: ToolCallResponseStatus.Error,
        error: combined ? `${prefix}\n${combined}` : prefix,
      }
    }
  }
}
