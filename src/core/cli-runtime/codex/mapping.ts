import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../../types/chat'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
  type ToolCallRequest,
  type ToolCallResponse,
} from '../../../types/tool-call.types'

import type { CodexThreadItem, CodexTurn, CodexUserInput } from './protocol'

const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

const userInputText = (content: CodexUserInput[]): string =>
  content
    .map((part) => (part.type === 'text' ? part.text : `[Image: ${part.url}]`))
    .join('\n\n')

const toResponse = (
  item: { status: string },
  output: string,
): ToolCallResponse => {
  const status = item.status.toLowerCase()
  if (status.includes('fail') || status.includes('error')) {
    return { status: ToolCallResponseStatus.Error, error: output || status }
  }
  if (
    status.includes('progress') ||
    status.includes('running') ||
    status.includes('pending')
  ) {
    return { status: ToolCallResponseStatus.Running }
  }
  return {
    status: ToolCallResponseStatus.Success,
    data: { type: 'text', text: output },
  }
}

const toolPair = ({
  request,
  response,
}: {
  request: ToolCallRequest
  response: ToolCallResponse
}): [ChatAssistantMessage, ChatToolMessage] => [
  {
    role: 'assistant',
    id: `codex-request-${request.id}`,
    content: '',
    toolCallRequests: [request],
    metadata: { generationState: 'completed' },
  },
  {
    role: 'tool',
    id: `codex-result-${request.id}`,
    toolCalls: [{ request, response }],
  },
]

export const mapCodexItem = (item: CodexThreadItem): ChatMessage[] => {
  if (item.type === 'userMessage') {
    const message: ChatUserMessage = {
      role: 'user',
      id: `codex-user-${item.id}`,
      content: null,
      promptContent: userInputText(item.content),
      mentionables: [],
    }
    return [message]
  }
  if (item.type === 'agentMessage') {
    return [
      {
        role: 'assistant',
        id: `codex-assistant-${item.id}`,
        content: item.text,
        metadata: { generationState: 'completed' },
      },
    ]
  }
  if (item.type === 'reasoning') {
    return [
      {
        role: 'assistant',
        id: `codex-reasoning-${item.id}`,
        content: '',
        reasoning: [...item.summary, ...item.content].join('\n\n'),
        metadata: { generationState: 'completed' },
      },
    ]
  }
  if (item.type === 'commandExecution') {
    const request: ToolCallRequest = {
      id: item.id,
      name: 'codex_command_execution',
      arguments: createCompleteToolCallArguments({
        value: { command: item.command, cwd: item.cwd },
      }),
    }
    const output = item.aggregatedOutput ?? ''
    return toolPair({ request, response: toResponse(item, output) })
  }
  if (item.type === 'fileChange') {
    const request: ToolCallRequest = {
      id: item.id,
      name: 'codex_file_change',
      arguments: createCompleteToolCallArguments({
        value: { changes: item.changes },
      }),
    }
    return toolPair({
      request,
      response: toResponse(item, stringify(item.changes)),
    })
  }
  if (item.type === 'mcpToolCall') {
    const request: ToolCallRequest = {
      id: item.id,
      name: `codex_mcp__${item.server}__${item.tool}`,
      arguments: createCompleteToolCallArguments({
        value:
          item.arguments && typeof item.arguments === 'object'
            ? (item.arguments as Record<string, unknown>)
            : { value: item.arguments },
      }),
    }
    return toolPair({
      request,
      response: toResponse(item, stringify(item.result ?? item.error)),
    })
  }
  return []
}

export const mapCodexTurns = (turns: CodexTurn[]): ChatMessage[] =>
  turns.flatMap((turn) => turn.items.flatMap(mapCodexItem))

export const buildPendingToolMessages = ({
  requestId,
  toolCallId,
  name,
  argumentsValue,
  responseStatus,
}: {
  requestId: string | number
  toolCallId: string
  name: string
  argumentsValue: Record<string, unknown>
  responseStatus:
    | ToolCallResponseStatus.PendingApproval
    | ToolCallResponseStatus.AwaitingUserInput
}): [ChatAssistantMessage, ChatToolMessage] => {
  const request: ToolCallRequest = {
    id: toolCallId,
    name,
    arguments: createCompleteToolCallArguments({ value: argumentsValue }),
    metadata: { argumentDiagnostics: { deliveryMode: `codex:${requestId}` } },
  }
  return toolPair({ request, response: { status: responseStatus } })
}
