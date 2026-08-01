import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../../types/chat'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  type ToolEditOperation,
  type ToolEditSummary,
  createCompleteToolCallArguments,
} from '../../../types/tool-call.types'

import type { CodexThreadItem, CodexTurn, CodexUserInput } from './protocol'

const CODEX_CLIENT_USER_MESSAGE_PREFIX = 'codex-user-client-'
const CODEX_TURN_USER_MESSAGE_PREFIX = 'codex-user-turn-'
const CODEX_ITEM_USER_MESSAGE_PREFIX = 'codex-user-'

export type CodexUserMessageLocator =
  | { kind: 'client'; id: string }
  | { kind: 'turn'; id: string }
  | { kind: 'item'; id: string }

export const parseCodexUserMessageId = (
  messageId: string,
): CodexUserMessageLocator => {
  if (messageId.startsWith(CODEX_CLIENT_USER_MESSAGE_PREFIX)) {
    return {
      kind: 'client',
      id: messageId.slice(CODEX_CLIENT_USER_MESSAGE_PREFIX.length),
    }
  }
  if (messageId.startsWith(CODEX_TURN_USER_MESSAGE_PREFIX)) {
    return {
      kind: 'turn',
      id: messageId.slice(CODEX_TURN_USER_MESSAGE_PREFIX.length),
    }
  }
  return {
    kind: 'item',
    id: messageId.startsWith(CODEX_ITEM_USER_MESSAGE_PREFIX)
      ? messageId.slice(CODEX_ITEM_USER_MESSAGE_PREFIX.length)
      : messageId,
  }
}

export const toCodexClientUserMessageId = (messageId: string): string => {
  const locator = parseCodexUserMessageId(messageId)
  return locator.kind === 'client' ? locator.id : messageId
}

const getCodexUserMessageId = (
  item: Extract<CodexThreadItem, { type: 'userMessage' }>,
  turnId?: string,
): string =>
  item.clientId
    ? `${CODEX_CLIENT_USER_MESSAGE_PREFIX}${item.clientId}`
    : turnId
      ? `${CODEX_TURN_USER_MESSAGE_PREFIX}${turnId}`
      : `${CODEX_ITEM_USER_MESSAGE_PREFIX}${item.id}`

const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

const toWorkspaceRelativePath = (path: string, cwd?: string): string => {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedCwd = cwd?.replace(/\\/g, '/').replace(/\/$/, '')
  return normalizedCwd && normalizedPath.startsWith(`${normalizedCwd}/`)
    ? normalizedPath.slice(normalizedCwd.length + 1)
    : normalizedPath
}

const userInputText = (content: CodexUserInput[]): string =>
  content
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'image') return `[Image: ${part.url}]`
      return `[Skill: ${part.name}]`
    })
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

const countUnifiedDiffLines = (
  diff: string,
): { addedLines: number; removedLines: number } => {
  let addedLines = 0
  let removedLines = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) addedLines += 1
    else if (line.startsWith('-')) removedLines += 1
  }
  return { addedLines, removedLines }
}

const toEditOperation = (
  kind: Extract<
    CodexThreadItem,
    { type: 'fileChange' }
  >['changes'][number]['kind'],
): ToolEditOperation => {
  if (kind.type === 'add') return 'create'
  if (kind.type === 'delete') return 'delete'
  return 'edit'
}

const buildFileChangeEditSummary = (
  changes: Extract<CodexThreadItem, { type: 'fileChange' }>['changes'],
  cwd?: string,
): ToolEditSummary => {
  const files = changes.map((change) => ({
    path: toWorkspaceRelativePath(change.path, cwd),
    ...countUnifiedDiffLines(change.diff),
    operation: toEditOperation(change.kind),
    undoStatus: 'unavailable' as const,
  }))
  return {
    files,
    totalFiles: files.length,
    totalAddedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    totalRemovedLines: files.reduce((sum, file) => sum + file.removedLines, 0),
    undoStatus: 'unavailable',
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

export const mapCodexItem = (
  item: CodexThreadItem,
  cwd?: string,
  turnId?: string,
): ChatMessage[] => {
  if (item.type === 'userMessage') {
    const message: ChatUserMessage = {
      role: 'user',
      id: getCodexUserMessageId(item, turnId),
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
    const response = toResponse(item, stringify(item.changes))
    return toolPair({
      request,
      response:
        response.status === ToolCallResponseStatus.Success
          ? {
              ...response,
              data: {
                ...response.data,
                metadata: {
                  ...response.data.metadata,
                  editSummary: buildFileChangeEditSummary(item.changes, cwd),
                },
              },
            }
          : response,
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

export const mapCodexTurns = (
  turns: CodexTurn[],
  cwd?: string,
): ChatMessage[] =>
  turns.flatMap((turn) =>
    turn.items.flatMap((item) => mapCodexItem(item, cwd, turn.id)),
  )

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
