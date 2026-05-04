// 把异步派遣完成的内部消息（ChatExternalAgentResultMessage）合成成一条
// 普通的 ChatToolMessage，喂给 <ToolMessage> 组件复用整套 UI（可折叠
// header、headline summary、展开后的 ExternalAgentToolCard 等）。
//
// 这样异步结果的视觉与同步派遣完成的工具卡片完全一致，唯一区别是
// 状态徽章显示「已完成 / 失败 / 取消 / 超时」而非「执行中」。

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
  const request = buildSynthRequest(message)
  const response = buildSynthResponse(message)
  return {
    role: 'tool',
    id: message.id,
    toolCalls: [{ request, response }],
  }
}

function buildSynthRequest(
  message: ChatExternalAgentResultMessage,
): ToolCallRequest {
  // 用 taskId 作为 toolCallId — 不会命中 stream bus snapshot，自然走 fallback。
  // arguments 仅放 provider + 一个简短 prompt（title），让 headline summary
  // 能拼出 "{provider} | {title}" 而不是裸 stdout 的前 80 字。
  return {
    id: `result-${message.taskId}`,
    // 必须用完整 server-qualified 名（如 yolo_local__delegate_external_agent），
    // 否则 ToolMessage 的 parseToolName / displayNames 找不到友好标签，
    // headline 会退化成 raw tool name。
    name: getToolName(
      getLocalFileToolServerName(),
      'delegate_external_agent',
    ),
    arguments: {
      kind: 'complete',
      value: {
        provider: message.provider,
        prompt: message.title,
      },
    },
  }
}

function buildSynthResponse(
  message: ChatExternalAgentResultMessage,
): ToolCallResponse {
  const stdout = message.stdout ?? ''
  const stderr = message.stderr ?? ''
  // ExternalAgentToolCard 在 fallback 路径下只会读 response.data.text，
  // 所以把 stderr 作为 progress 上下文拼到 stdout 前面，再用 --- 分隔。
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
