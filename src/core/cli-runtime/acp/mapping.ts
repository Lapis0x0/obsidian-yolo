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
  Usage,
  UsageUpdate,
} from '@agentclientprotocol/sdk'

import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../../types/chat'
import type { ContentPart } from '../../../types/llm/request'
import type { ResponseUsage } from '../../../types/llm/response'
import {
  type ToolCallRequest,
  type ToolCallResponse,
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../../types/tool-call.types'
import { createToolEditSummary } from '../../../utils/chat/editSummary'
import { createCliToolCallRequest } from '../tool-call'
import type {
  CliApprovalDecision,
  CliContextUsage,
  CliRuntimeId,
  CliRuntimeModel,
} from '../types'

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
 * Per-turn token counts for the assistant footer. ACP's own field docs
 * describe these as session-cumulative, but agents report what their provider
 * returned for the turn (Hermes passes through the turn's `prompt_tokens` /
 * `completion_tokens`), and the wire carries no way to tell the two apart —
 * so this maps them as the turn metrics the footer expects.
 */
export const mapAcpTurnUsage = (usage: Usage): ResponseUsage => ({
  prompt_tokens: usage.inputTokens,
  completion_tokens: usage.outputTokens,
  total_tokens: usage.totalTokens,
  ...(usage.cachedReadTokens
    ? { cache_read_input_tokens: usage.cachedReadTokens }
    : {}),
  ...(usage.cachedWriteTokens
    ? { cache_creation_input_tokens: usage.cachedWriteTokens }
    : {}),
})

/**
 * ACP reports context pressure as a `used`/`size` pair, with no per-category
 * breakdown and no cache statistics — an agent that estimates rather than
 * counts (Hermes does) still reports through this same shape, so the ring
 * shows an approximation for those agents.
 */
export const mapAcpUsageUpdate = (
  update: UsageUpdate,
): CliContextUsage | null => {
  if (!Number.isFinite(update.used) || update.used < 0) return null
  const maxContextTokens =
    Number.isFinite(update.size) && update.size > 0 ? update.size : null
  return {
    promptTokens: Math.floor(update.used),
    maxContextTokens:
      maxContextTokens === null ? null : Math.floor(maxContextTokens),
  }
}

/**
 * `live`: streaming a prompt this client itself just sent — every
 * `user_message_chunk` echo is suppressed unconditionally. For a normal
 * turn it is redundant with the local optimistic user message; for a
 * synthetic prompt the runtime injects on its own (e.g. `compact()`
 * sending Hermes's `/compress`) there never was a local user message to
 * begin with, and none should appear — suppressing the echo either way is
 * exactly what both cases need.
 * `replay`: hydrating a stored session via `session/load` — there is no
 * local user message to fall back on, so `user_message_chunk` is the only
 * source of user turns and must be aggregated into `ChatUserMessage`s.
 */
export type AcpSessionAggregatorMode = 'live' | 'replay'

/**
 * Aggregates streaming `SessionUpdate` notifications into `ChatMessage`
 * upserts. Instantiated once per bound ACP session (live turns and
 * `session/load` replay share the same aggregation rules, only differing on
 * `user_message_chunk` per `mode`) and reset when the runtime rebinds to a
 * different session.
 */
export class AcpSessionAggregator {
  private readonly assistantText = new Map<string, string>()
  private readonly thoughtText = new Map<string, string>()
  private readonly userText = new Map<string, string>()
  private readonly toolCalls = new Map<string, AcpToolCallState>()
  /**
   * Scopes the ids used when aggregating live chunks. ACP only requires that
   * chunks of the same message share a `messageId`, not that the id is unique
   * across turns — so both omitted ids and recycled explicit ids are keyed
   * by `turnSequence`. Advanced once per live turn (`beginTurn`) and once
   * per id-less `user_message_chunk` in replay.
   */
  private turnSequence = 0
  /**
   * After a `tool_call`, later `agent_message_chunk`s are a new assistant
   * bubble — otherwise every delta in the turn shares one id and the UI
   * paints the whole answer above the tools.
   */
  private textSegment = 0
  private splitNextAssistantText = false

  constructor(private readonly mode: AcpSessionAggregatorMode = 'live') {}

  reset(): void {
    this.assistantText.clear()
    this.thoughtText.clear()
    this.userText.clear()
    this.toolCalls.clear()
    this.turnSequence = 0
    this.textSegment = 0
    this.splitNextAssistantText = false
  }

  /** Advances the aggregation epoch. Call once per live turn, before the prompt is sent. */
  beginTurn(): void {
    this.turnSequence += 1
    this.textSegment = 0
    this.splitNextAssistantText = false
  }

  /**
   * Fallback ids are already epoch-scoped (`stream-1`). Explicit `messageId`s
   * must be too: ACP only requires that chunks of the same message share an
   * id, not that the id is unique across turns. Hermes (and others) recycle
   * the same value, which would otherwise upsert into the previous turn.
   */
  // ACP delivers `messageId` as `string | null | undefined`; absent and
  // explicitly-null both mean "no id", and `?.trim()` collapses them together.
  private scopeLiveMessageId(
    messageId: string | null | undefined,
    kind: string,
  ): string {
    const explicit = messageId?.trim()
    if (!explicit) return `${kind}-${this.turnSequence}`
    if (this.turnSequence === 0) return explicit
    return `${explicit}@${this.turnSequence}`
  }

  private scopeAssistantTextId(messageId: string | null | undefined): string {
    if (this.splitNextAssistantText) {
      this.textSegment += 1
      this.splitNextAssistantText = false
    }
    const base = this.scopeLiveMessageId(messageId, 'stream')
    return this.textSegment > 0 ? `${base}.${this.textSegment}` : base
  }

  apply(update: SessionUpdate, runtimeId: CliRuntimeId): ChatMessage[] {
    if (update.sessionUpdate === 'user_message_chunk') {
      if (this.mode === 'live') {
        // Echo of the prompt we just sent; the local user message already covers it.
        return []
      }
      if (!update.messageId) this.turnSequence += 1
      this.textSegment = 0
      this.splitNextAssistantText = false
      const messageId = update.messageId ?? `user-${this.turnSequence}`
      const text = `${this.userText.get(messageId) ?? ''}${contentBlockToText(update.content)}`
      this.userText.set(messageId, text)
      const message: ChatUserMessage = {
        role: 'user',
        id: `acp-user-${messageId}`,
        content: null,
        promptContent: text,
        mentionables: [],
      }
      return [message]
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      const messageId = this.scopeAssistantTextId(update.messageId)
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
      const messageId = this.scopeLiveMessageId(update.messageId, 'thought')
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
      this.splitNextAssistantText = true
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
    // current_mode_update / config_option_update / session_info_update:
    // unstable or out of scope for v1 (no UI surface yet) — ignored rather
    // than guessed at. `usage_update` produces no message either, but it does
    // feed the context ring; the runtime reads it through `mapAcpUsageUpdate`.
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

// ---------------------------------------------------------------------------
// Session model state
// ---------------------------------------------------------------------------

/**
 * `session/new` and `session/load` responses may carry the agent's model list
 * as `models: { availableModels, currentModelId }` — the ACP model-selection
 * extension (paired with the `session/set_model` request) that Hermes and
 * other agents speak. The current SDK's typed responses omit the field (the
 * spec is migrating it to `configOptions`), so this reads the raw shape
 * defensively; `null` means the agent doesn't report models and the host
 * keeps its picker in the default-model placeholder state.
 */
export type AcpSessionModelState = Readonly<{
  models: CliRuntimeModel[]
  currentModelId: string | null
}>

export const extractAcpSessionModelState = (
  response: unknown,
): AcpSessionModelState | null => {
  if (typeof response !== 'object' || response === null) return null
  const models = (response as { models?: unknown }).models
  if (typeof models !== 'object' || models === null) return null
  const { availableModels, currentModelId } = models as {
    availableModels?: unknown
    currentModelId?: unknown
  }
  if (!Array.isArray(availableModels)) return null
  const mapped: CliRuntimeModel[] = []
  for (const raw of availableModels) {
    if (typeof raw !== 'object' || raw === null) continue
    const { modelId, name, description } = raw as {
      modelId?: unknown
      name?: unknown
      description?: unknown
    }
    if (typeof modelId !== 'string' || modelId.length === 0) continue
    mapped.push({
      id: modelId,
      label: typeof name === 'string' && name.length > 0 ? name : modelId,
      ...(typeof description === 'string' && description.length > 0
        ? { description }
        : {}),
      reasoningEfforts: [],
    })
  }
  if (mapped.length === 0) return null
  return {
    models: mapped,
    currentModelId:
      typeof currentModelId === 'string' && currentModelId.length > 0
        ? currentModelId
        : null,
  }
}
