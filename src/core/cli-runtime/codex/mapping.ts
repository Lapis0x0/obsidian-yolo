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
import { createCliToolCallRequest } from '../tool-call'
import type { CliCompactionBoundary } from '../types'

import {
  decodeCodexExecEnvelope,
  normalizeCodexToolInput,
  splitCodexExecEnvelopeOutput,
} from './exec-envelope'
import type {
  CodexRawResponseItem,
  CodexThreadItem,
  CodexTurn,
  CodexUserInput,
} from './protocol'

const CODEX_CLIENT_USER_MESSAGE_PREFIX = 'codex-user-client-'
const CODEX_TURN_USER_MESSAGE_PREFIX = 'codex-user-turn-'
const CODEX_ITEM_USER_MESSAGE_PREFIX = 'codex-user-'
const KNOWN_CODEX_ACTIVITY_TYPES = new Set([
  'hookPrompt',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
])

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

const stringifyMcpResult = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return stringify(value)
  }
  const result = value as Record<string, unknown>
  const content = Array.isArray(result.content) ? result.content : null
  const hasStructuredContent =
    result.structuredContent !== undefined && result.structuredContent !== null
  if (!content || hasStructuredContent) return stringify(value)
  const textParts = content.flatMap((part): string[] => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return []
    const block = part as Record<string, unknown>
    return block.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : []
  })
  return textParts.length === content.length
    ? textParts.join('\n')
    : stringify(value)
}

const stringifyDynamicToolResult = (contentItems: unknown[] | null): string => {
  if (!contentItems) return ''
  const textParts = contentItems.flatMap((item): string[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const block = item as Record<string, unknown>
    return block.type === 'inputText' && typeof block.text === 'string'
      ? [block.text]
      : []
  })
  return textParts.length === contentItems.length
    ? textParts.join('\n')
    : stringify(contentItems)
}

const stringifyRawToolOutput = (output: unknown): string => {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return stringify(output)
  const textParts = output.flatMap((item): string[] =>
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    (item as Record<string, unknown>).type === 'input_text' &&
    typeof (item as Record<string, unknown>).text === 'string'
      ? [(item as Record<string, unknown>).text as string]
      : [],
  )
  return textParts.length === output.length
    ? textParts.join('\n')
    : stringify(output)
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

/**
 * Empty agent/reasoning shells on item/started are not user-visible yet; skip
 * them so Requesting stays up until deltas or a non-empty item arrives.
 * Tool-like items always emit because they already have UI.
 */
export const shouldEmitCodexItemOnStarted = (
  item: CodexThreadItem,
): boolean => {
  if (item.type === 'agentMessage') return item.text.trim().length > 0
  if (item.type === 'reasoning') {
    return [...item.summary, ...item.content].some(
      (part) => part.trim().length > 0,
    )
  }
  return true
}

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
  if (item.type === 'plan') {
    return [
      {
        role: 'assistant',
        id: `codex-plan-${item.id}`,
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
    const request = createCliToolCallRequest({
      id: item.id,
      input: { command: item.command, cwd: item.cwd },
      metadata: {
        runtimeId: 'codex',
        eventType: item.type,
        name: item.type,
        capability: 'command_execution',
      },
    })
    const output = item.aggregatedOutput ?? ''
    return toolPair({ request, response: toResponse(item, output) })
  }
  if (item.type === 'fileChange') {
    const request = createCliToolCallRequest({
      id: item.id,
      input: { changes: item.changes },
      metadata: {
        runtimeId: 'codex',
        eventType: item.type,
        name: item.type,
        capability: 'file_change',
      },
    })
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
    const request = createCliToolCallRequest({
      id: item.id,
      input: item.arguments,
      metadata: {
        runtimeId: 'codex',
        eventType: item.type,
        namespace: item.server,
        name: item.tool,
      },
    })
    return toolPair({
      request,
      response: toResponse(
        item,
        item.error ? stringify(item.error) : stringifyMcpResult(item.result),
      ),
    })
  }
  if (item.type === 'dynamicToolCall') {
    const request = createCliToolCallRequest({
      id: item.id,
      input: item.arguments,
      metadata: {
        runtimeId: 'codex',
        eventType: item.type,
        ...(item.namespace ? { namespace: item.namespace } : {}),
        name: item.tool,
      },
    })
    return toolPair({
      request,
      response: toResponse(
        {
          status:
            item.status === 'completed' && item.success === false
              ? 'failed'
              : item.status,
        },
        stringifyDynamicToolResult(item.contentItems),
      ),
    })
  }
  if (item.type === 'collabAgentToolCall') {
    const request = createCliToolCallRequest({
      id: item.id,
      input: {
        senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds,
        prompt: item.prompt,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      },
      metadata: {
        runtimeId: 'codex',
        eventType: item.type,
        namespace: 'collaboration',
        name: item.tool,
      },
    })
    const response = toResponse(item, stringify(item.agentsStates))
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
                  cliToolResult: { agentsStates: item.agentsStates },
                },
              },
            }
          : response,
    })
  }
  if (item.type === 'webSearch') {
    const request = createCliToolCallRequest({
      id: item.id,
      input: { query: item.query, action: item.action },
      metadata: {
        runtimeId: 'codex',
        eventType: item.type,
        name: item.type,
      },
    })
    return toolPair({
      request,
      response: toResponse({ status: 'completed' }, stringify(item.action)),
    })
  }
  if (item.type === 'imageView') {
    const request = createCliToolCallRequest({
      id: item.id,
      input: { path: item.path },
      metadata: {
        runtimeId: 'codex',
        eventType: item.type,
        name: item.type,
      },
    })
    return toolPair({
      request,
      response: toResponse({ status: 'completed' }, item.path),
    })
  }
  if (item.type === 'imageGeneration') {
    const request = createCliToolCallRequest({
      id: item.id,
      input: { revisedPrompt: item.revisedPrompt },
      metadata: {
        runtimeId: 'codex',
        eventType: item.type,
        name: item.type,
      },
    })
    return toolPair({
      request,
      response: toResponse(
        item,
        stringify({ result: item.result, savedPath: item.savedPath }),
      ),
    })
  }

  const activity = item as {
    id: string
    type: string
    [key: string]: unknown
  }
  if (!KNOWN_CODEX_ACTIVITY_TYPES.has(activity.type)) {
    console.warn(`[YOLO] Unadapted Codex timeline item: ${activity.type}`)
  }
  if (activity.type === 'contextCompaction') {
    return []
  }
  return [
    {
      role: 'assistant',
      id: `codex-activity-${activity.id}`,
      content: `\`\`\`json\n${stringify(activity)}\n\`\`\``,
      metadata: { generationState: 'completed' },
    },
  ]
}

export const mapCodexTranscript = (
  turns: CodexTurn[],
  cwd?: string,
): {
  messages: ChatMessage[]
  compactionBoundaries: CliCompactionBoundary[]
} => {
  const messages: ChatMessage[] = []
  const compactionBoundaries: CliCompactionBoundary[] = []
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'contextCompaction') {
        compactionBoundaries.push({
          id: `codex-compact-${item.id}`,
          afterMessageId: messages.at(-1)?.id ?? null,
        })
        continue
      }
      messages.push(...mapCodexItem(item, cwd, turn.id))
    }
  }
  return { messages, compactionBoundaries }
}

export const mapCodexTurns = (
  turns: CodexTurn[],
  cwd?: string,
): ChatMessage[] => mapCodexTranscript(turns, cwd).messages

const parseRawToolInput = (
  item: CodexRawResponseItem,
): Record<string, unknown> => {
  const rawInput =
    item.type === 'custom_tool_call'
      ? item.input
      : item.type === 'function_call'
        ? item.arguments
        : ''
  if (item.type === 'custom_tool_call') return { raw: rawInput }
  try {
    const parsed = JSON.parse(rawInput) as unknown
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed }
  } catch {
    return { raw: rawInput }
  }
}

const rawToolCapability = (
  name: string,
): 'command_execution' | 'file_change' | 'user_question' | undefined => {
  if (name === 'exec_command') return 'command_execution'
  if (name === 'apply_patch') return 'file_change'
  if (name === 'request_user_input') return 'user_question'
  return undefined
}

const createRawToolRequest = ({
  id,
  name,
  input,
  eventType,
}: {
  id: string
  name: string
  input: Record<string, unknown>
  eventType: string
}): ToolCallRequest =>
  createCliToolCallRequest({
    id,
    input,
    metadata: {
      runtimeId: 'codex',
      eventType,
      name,
      ...(rawToolCapability(name)
        ? { capability: rawToolCapability(name)! }
        : {}),
    },
  })

export const mapCodexRawToolCall = (
  item: Extract<
    CodexRawResponseItem,
    { type: 'custom_tool_call' | 'function_call' }
  >,
): {
  requests: ToolCallRequest[]
  messages: ChatMessage[]
} => {
  const rawInput = parseRawToolInput(item)
  const decoded =
    item.name === 'exec' && item.type === 'custom_tool_call'
      ? decodeCodexExecEnvelope(item.input)
      : null
  const normalizedCalls = decoded ?? [
    {
      name: item.name,
      input: normalizeCodexToolInput(item.name, rawInput),
    },
  ]
  const requests = normalizedCalls.map((call, index) =>
    createRawToolRequest({
      id:
        normalizedCalls.length === 1
          ? item.call_id
          : `${item.call_id}:${index + 1}`,
      name: call.name,
      input: call.input,
      eventType: item.type,
    }),
  )
  return {
    requests,
    messages: requests.flatMap((request) =>
      toolPair({
        request,
        response: { status: ToolCallResponseStatus.Running },
      }),
    ),
  }
}

export const mapCodexRawToolOutput = (
  item: Extract<
    CodexRawResponseItem,
    { type: 'custom_tool_call_output' | 'function_call_output' }
  >,
  requests: readonly ToolCallRequest[],
): ChatToolMessage[] => {
  const splitOutput = splitCodexExecEnvelopeOutput(item.output, requests.length)
  return requests.map((request, index) => ({
    role: 'tool',
    id: `codex-result-${request.id}`,
    toolCalls: [
      {
        request,
        response: {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: stringifyRawToolOutput(
              splitOutput?.[index] ??
                (index === requests.length - 1 ? item.output : ''),
            ),
          },
        },
      },
    ],
  }))
}

export const buildPendingToolMessages = ({
  requestId,
  toolCallId,
  name,
  argumentsValue,
  responseStatus,
  cliToolCall,
}: {
  requestId: string | number
  toolCallId: string
  name: string
  argumentsValue: Record<string, unknown>
  responseStatus:
    | ToolCallResponseStatus.PendingApproval
    | ToolCallResponseStatus.AwaitingUserInput
  cliToolCall?: NonNullable<ToolCallRequest['metadata']>['cliToolCall']
}): [ChatAssistantMessage, ChatToolMessage] => {
  const request: ToolCallRequest = {
    id: toolCallId,
    name,
    arguments: createCompleteToolCallArguments({ value: argumentsValue }),
    metadata: {
      argumentDiagnostics: { deliveryMode: `codex:${requestId}` },
      ...(cliToolCall ? { cliToolCall } : {}),
    },
  }
  return toolPair({ request, response: { status: responseStatus } })
}
