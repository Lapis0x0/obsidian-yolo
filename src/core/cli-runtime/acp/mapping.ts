import type {
  ContentBlock,
  PermissionOption,
  Plan,
  PlanEntry,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk'

import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
} from '../../../types/chat'
import type { ContentPart } from '../../../types/llm/request'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../../types/tool-call.types'
import { createToolEditSummary } from '../../../utils/chat/editSummary'
import { createCliToolCallRequest } from '../tool-call'
import type { CliApprovalDecision, CliRuntimeId } from '../types'

const ACP_PLAN_MESSAGE_ID = 'acp-plan'

const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

/** Best-effort rendering of one ACP content block into plain/markdown text. */
export const contentBlockToText = (block: ContentBlock): string => {
  if (block.type === 'text') return block.text
  if (block.type === 'image') {
    return block.uri
      ? `![image](${block.uri})`
      : `![image](data:${block.mimeType};base64,${block.data})`
  }
  if (block.type === 'audio') return '[audio attachment]'
  if (block.type === 'resource_link') {
    return `[${block.name}](${block.uri})`
  }
  // Embedded resource: prefer inline text when the agent provided it.
  const resource = block.resource
  if (resource && 'text' in resource && typeof resource.text === 'string') {
    return resource.text
  }
  return stringify(block)
}

const toolCallContentToText = (content: readonly ToolCallContent[]): string =>
  content
    .map((item) => {
      if (item.type === 'content') return contentBlockToText(item.content)
      if (item.type === 'diff') return `Modified ${item.path}`
      return '[terminal output]'
    })
    .join('\n\n')

/**
 * Extracts a shell command string for `command_execution` presentation. ACP's
 * `rawInput` is agent-defined (`unknown`), so this only recognizes a common
 * `{ command: string }` shape and otherwise falls back to the tool call title.
 */
const extractAcpCommandText = (state: AcpToolCallState): string => {
  const rawInput = state.rawInput
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const command = (rawInput as Record<string, unknown>).command
    if (typeof command === 'string') return command
  }
  return state.title
}

const mapAcpToolKindToCapability = (
  kind: ToolKind | undefined,
): 'command_execution' | 'file_change' | undefined => {
  if (kind === 'execute') return 'command_execution'
  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    return 'file_change'
  }
  return undefined
}

const mapAcpToolCallStatusToResponseStatus = (
  status: ToolCallStatus,
):
  | ToolCallResponseStatus.Running
  | ToolCallResponseStatus.Success
  | ToolCallResponseStatus.Error => {
  if (status === 'completed') return ToolCallResponseStatus.Success
  if (status === 'failed') return ToolCallResponseStatus.Error
  return ToolCallResponseStatus.Running
}

/** Builds a `ToolEditSummary` from ACP `diff` tool-call content, reusing the
 * shared line-diff engine. ACP-driven edits happen outside YOLO's own
 * file-tool executor, so — like Codex's file-change mapping — undo is marked
 * unavailable rather than claiming a snapshot that was never captured. */
const buildAcpEditSummary = (
  content: readonly ToolCallContent[],
): ReturnType<typeof createToolEditSummary> => {
  const diffs = content.filter(
    (item): item is Extract<ToolCallContent, { type: 'diff' }> =>
      item.type === 'diff',
  )
  if (diffs.length === 0) return undefined
  const files = diffs.flatMap((diff) => {
    const summary = createToolEditSummary({
      path: diff.path,
      beforeContent: diff.oldText ?? '',
      afterContent: diff.newText,
      beforeExists: diff.oldText !== null && diff.oldText !== undefined,
      afterExists: true,
    })
    return summary ? summary.files : []
  })
  if (files.length === 0) return undefined
  const undoFiles = files.map((file) => ({
    ...file,
    undoStatus: 'unavailable' as const,
  }))
  return {
    files: undoFiles,
    totalFiles: undoFiles.length,
    totalAddedLines: undoFiles.reduce((sum, file) => sum + file.addedLines, 0),
    totalRemovedLines: undoFiles.reduce(
      (sum, file) => sum + file.removedLines,
      0,
    ),
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
    id: `acp-request-${request.id}`,
    content: '',
    toolCallRequests: [request],
    metadata: { generationState: 'completed' },
  },
  {
    role: 'tool',
    id: `acp-result-${request.id}`,
    toolCalls: [{ request, response }],
  },
]

export type AcpToolCallState = {
  toolCallId: string
  title: string
  name?: string
  kind?: ToolKind
  status: ToolCallStatus
  content: ToolCallContent[]
  rawInput?: unknown
}

export const applyAcpToolCall = (update: ToolCall): AcpToolCallState => ({
  toolCallId: update.toolCallId,
  title: update.title,
  name: update.name ?? undefined,
  kind: update.kind,
  status: update.status ?? 'pending',
  content: update.content ?? [],
  rawInput: update.rawInput,
})

export const applyAcpToolCallUpdate = (
  current: AcpToolCallState | undefined,
  update: ToolCallUpdate,
): AcpToolCallState => ({
  toolCallId: update.toolCallId,
  title: update.title ?? current?.title ?? update.toolCallId,
  name: update.name ?? current?.name ?? undefined,
  kind: update.kind ?? current?.kind,
  status: update.status ?? current?.status ?? 'pending',
  content: update.content ?? current?.content ?? [],
  rawInput: update.rawInput !== undefined ? update.rawInput : current?.rawInput,
})

export const mapAcpToolCallState = (
  state: AcpToolCallState,
  runtimeId: CliRuntimeId,
): [ChatAssistantMessage, ChatToolMessage] => {
  const capability = mapAcpToolKindToCapability(state.kind)
  const request = createCliToolCallRequest({
    id: state.toolCallId,
    input:
      capability === 'command_execution'
        ? { command: extractAcpCommandText(state) }
        : (state.rawInput ?? {}),
    metadata: {
      runtimeId,
      eventType: 'tool_call',
      name: state.name ?? state.title,
      ...(capability ? { capability } : {}),
    },
  })
  const responseStatus = mapAcpToolCallStatusToResponseStatus(state.status)
  const response: ToolCallResponse =
    responseStatus === ToolCallResponseStatus.Error
      ? {
          status: ToolCallResponseStatus.Error,
          error: toolCallContentToText(state.content) || 'Tool call failed.',
        }
      : responseStatus === ToolCallResponseStatus.Running
        ? { status: ToolCallResponseStatus.Running }
        : {
            status: ToolCallResponseStatus.Success,
            data: {
              type: 'text',
              text: toolCallContentToText(state.content),
              ...(capability === 'file_change'
                ? (() => {
                    const editSummary = buildAcpEditSummary(state.content)
                    return editSummary ? { metadata: { editSummary } } : {}
                  })()
                : {}),
            },
          }
  return toolPair({ request, response })
}

const renderAcpPlanEntry = (entry: PlanEntry): string => {
  const box =
    entry.status === 'completed'
      ? '[x]'
      : entry.status === 'in_progress'
        ? '[~]'
        : '[ ]'
  return `- ${box} ${entry.content}`
}

export const renderAcpPlan = (plan: Plan): string =>
  plan.entries.map(renderAcpPlanEntry).join('\n')

export const buildAcpPlanMessage = (plan: Plan): ChatAssistantMessage => ({
  role: 'assistant',
  id: ACP_PLAN_MESSAGE_ID,
  content: renderAcpPlan(plan),
  metadata: { generationState: 'completed' },
})

/**
 * Aggregates streaming `SessionUpdate` notifications into `ChatMessage`
 * upserts. Instantiated once per bound ACP session (live turns and
 * `session/load` replay share the same aggregation rules) and reset when the
 * runtime rebinds to a different session.
 */
export class AcpSessionAggregator {
  private readonly assistantText = new Map<string, string>()
  private readonly thoughtText = new Map<string, string>()
  private readonly toolCalls = new Map<string, AcpToolCallState>()

  reset(): void {
    this.assistantText.clear()
    this.thoughtText.clear()
    this.toolCalls.clear()
  }

  apply(update: SessionUpdate, runtimeId: CliRuntimeId): ChatMessage[] {
    if (update.sessionUpdate === 'user_message_chunk') {
      // Echo of the prompt we just sent; the local user message already covers it.
      return []
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      const messageId = update.messageId ?? 'stream'
      const text = `${this.assistantText.get(messageId) ?? ''}${contentBlockToText(update.content)}`
      this.assistantText.set(messageId, text)
      return [
        {
          role: 'assistant',
          id: `acp-assistant-${messageId}`,
          content: text,
          metadata: { generationState: 'streaming' },
        },
      ]
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const messageId = update.messageId ?? 'thought'
      const text = `${this.thoughtText.get(messageId) ?? ''}${contentBlockToText(update.content)}`
      this.thoughtText.set(messageId, text)
      return [
        {
          role: 'assistant',
          id: `acp-thought-${messageId}`,
          content: '',
          reasoning: text,
          metadata: { generationState: 'streaming' },
        },
      ]
    }
    if (update.sessionUpdate === 'tool_call') {
      const state = applyAcpToolCall(update)
      this.toolCalls.set(state.toolCallId, state)
      return mapAcpToolCallState(state, runtimeId)
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const state = applyAcpToolCallUpdate(
        this.toolCalls.get(update.toolCallId),
        update,
      )
      this.toolCalls.set(state.toolCallId, state)
      return mapAcpToolCallState(state, runtimeId)
    }
    if (update.sessionUpdate === 'plan') {
      return [buildAcpPlanMessage(update)]
    }
    // plan_update / plan_removed / available_commands_update /
    // current_mode_update / config_option_update / session_info_update /
    // usage_update: unstable or out of scope for v1 (no UI surface yet) —
    // ignored rather than guessed at.
    return []
  }
}

/** Upserts by message id, matching the controller's own upsert semantics. */
export const upsertAcpMessage = (
  messages: ChatMessage[],
  message: ChatMessage,
): void => {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) messages.push(message)
  else messages[index] = message
}

export const buildPendingApprovalMessages = (
  request: RequestPermissionRequest,
  runtimeId: CliRuntimeId,
): [ChatAssistantMessage, ChatToolMessage] => {
  const toolCall = request.toolCall
  const title = toolCall.title ?? toolCall.toolCallId
  const state: AcpToolCallState = {
    toolCallId: toolCall.toolCallId,
    title,
    name: toolCall.name ?? undefined,
    kind: toolCall.kind ?? undefined,
    status: toolCall.status ?? 'pending',
    content: toolCall.content ?? [],
    rawInput: toolCall.rawInput,
  }
  const capability = mapAcpToolKindToCapability(state.kind)
  const argumentsValue =
    capability === 'command_execution'
      ? { command: extractAcpCommandText(state) }
      : ((state.rawInput as Record<string, unknown> | undefined) ?? {})
  const toolCallRequest: ToolCallRequest = {
    id: toolCall.toolCallId,
    name: state.name ?? title,
    arguments: createCompleteToolCallArguments({ value: argumentsValue }),
    metadata: {
      cliToolCall: {
        runtimeId,
        eventType: 'requestPermission',
        name: state.name ?? title,
        ...(capability ? { capability } : {}),
      },
    },
  }
  return toolPair({
    request: toolCallRequest,
    response: { status: ToolCallResponseStatus.PendingApproval },
  })
}

/** ACP text/image content blocks for an outgoing `session/prompt` request. */
export const toAcpPromptBlocks = (
  content: string | ContentPart[],
): ContentBlock[] => {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return content.map((part): ContentBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image_url') {
      const dataUrlMatch = part.image_url.url.match(
        /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/,
      )
      if (dataUrlMatch) {
        return {
          type: 'image',
          mimeType: dataUrlMatch[1],
          data: dataUrlMatch[2],
        }
      }
      return {
        type: 'resource_link',
        uri: part.image_url.url,
        name: 'image',
      }
    }
    throw new Error('This ACP runtime does not support PDF attachments.')
  })
}

/**
 * Maps our three-tier approval decision onto one of the `PermissionOption`s
 * the agent offered for this specific request:
 *  - `approve_once` -> the `allow_once` option
 *  - `approve_for_session` -> `allow_always`, falling back to `allow_once`
 *    when the agent didn't offer a session-scoped option
 *  - `reject` -> `reject_once`, falling back to `reject_always`
 * Returns `null` when no option of an acceptable kind was offered at all.
 */
export const resolveApprovalOptionId = (
  options: readonly PermissionOption[],
  decision: CliApprovalDecision,
): string | null => {
  const byKind = (kind: PermissionOption['kind']): string | null =>
    options.find((option) => option.kind === kind)?.optionId ?? null

  if (decision === 'approve_once') {
    return byKind('allow_once') ?? byKind('allow_always')
  }
  if (decision === 'approve_for_session') {
    return byKind('allow_always') ?? byKind('allow_once')
  }
  return byKind('reject_once') ?? byKind('reject_always')
}

/**
 * Per ACP's cancellation contract: "If the client cancels the prompt turn
 * via `session/cancel`, it MUST respond to [a pending `requestPermission`]
 * with `RequestPermissionOutcome::Cancelled`."
 */
export const buildCancelledApprovalOutcome = (): RequestPermissionResponse => ({
  outcome: { outcome: 'cancelled' },
})
