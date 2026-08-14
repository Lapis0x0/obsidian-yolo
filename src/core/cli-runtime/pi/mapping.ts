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
} from '../../../types/tool-call.types'
import { createCliToolCallRequest } from '../tool-call'
import type {
  CliCompactionBoundary,
  CliContextUsage,
  CliRuntimeEvent,
  CliRuntimeModel,
} from '../types'

import type { PiRpcRecord } from './transport'

// ---------------------------------------------------------------------------
// Small parsing helpers (mirrors the defensive style of codex/context-usage.ts)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const getRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {}

const getString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const asNonNegativeInt = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return Math.floor(value)
}

const asPositiveInt = (value: unknown): number | null => {
  const number = asNonNegativeInt(value)
  return number !== null && number > 0 ? number : null
}

const getNestedRecord = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null => {
  const value = record[key]
  return isRecord(value) ? value : null
}

const firstStringField = (
  records: Record<string, unknown>[],
  keys: string[],
): string | null => {
  for (const record of records) {
    for (const key of keys) {
      const value = getString(record[key])
      if (value) return value
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Live event mapping
// ---------------------------------------------------------------------------

export type PiMappingState = {
  assistantText: Map<string, string>
  thinkingText: Map<string, string>
  toolInputs: Map<string, Record<string, unknown>>
  toolNames: Map<string, string>
  toolOutputs: Map<string, string>
  turn: number
}

export const createPiMappingState = (): PiMappingState => ({
  assistantText: new Map(),
  thinkingText: new Map(),
  toolInputs: new Map(),
  toolNames: new Map(),
  toolOutputs: new Map(),
  turn: 0,
})

/** Called at the start of every turn — pi streams are turn-scoped. */
export const resetPiMappingState = (state: PiMappingState): void => {
  state.assistantText.clear()
  state.thinkingText.clear()
  state.toolInputs.clear()
  state.toolNames.clear()
  state.toolOutputs.clear()
  state.turn += 1
}

/**
 * `agent_settled` is the authoritative "this turn is fully done" signal —
 * unlike `agent_end`, it is not emitted while pi is still retrying/queued.
 */
export const isPiAgentSettled = (event: PiRpcRecord): boolean =>
  getString(event.type) === 'agent_settled'

/**
 * `message_end` / `turn_end` carry `stopReason === 'error'` when the turn
 * failed outright (distinct from the normal `agent_settled` completion).
 *
 * Per the documented shape (`{ type: 'message_end' | 'turn_end', message:
 * AgentMessage }`), `stopReason` lives on the nested `message` object — that
 * is checked first. `assistantMessageEvent`/top-level fields are not part of
 * that documented shape (they belong to `message_update`'s streaming-delta
 * envelope instead), but a reference pi client integration does read them
 * off `message_end`/`turn_end` too, so they stay as a fallback.
 */
export const getPiTerminalErrorMessage = (
  event: PiRpcRecord,
): string | null => {
  const type = getString(event.type)
  if (type !== 'message_end' && type !== 'turn_end') return null
  const message = getNestedRecord(event, 'message')
  const legacy =
    getNestedRecord(event, 'assistantMessageEvent') ??
    getNestedRecord(event, 'assistant_message_event')
  const records = [
    ...(message ? [message] : []),
    ...(legacy ? [legacy] : []),
    event,
  ]
  const stopReason = firstStringField(records, ['stopReason', 'stop_reason'])
  if (!stopReason || stopReason.toLowerCase() !== 'error') return null
  const direct = firstStringField(records, [
    'errorMessage',
    'error_message',
    'error',
    'message',
  ])
  if (direct) return direct
  for (const record of records) {
    const nestedError = getNestedRecord(record, 'error')
    if (nestedError) {
      const message = getString(nestedError.message)
      if (message) return message
    }
  }
  return 'pi turn failed.'
}

const extractDelta = (
  record: Record<string, unknown>,
  kind: 'text' | 'thinking',
): string | null => {
  const snakeKey = kind === 'text' ? 'text_delta' : 'thinking_delta'
  const camelKey = kind === 'text' ? 'textDelta' : 'thinkingDelta'
  const direct = getString(record[snakeKey]) ?? getString(record[camelKey])
  if (direct) return direct
  if (record.type === snakeKey || record.type === camelKey) {
    return getString(record.delta)
  }
  return null
}

const extractStreamId = (
  event: Record<string, unknown>,
  assistantEvent: Record<string, unknown>,
  turn: number,
): string =>
  getString(event.messageId) ??
  getString(event.itemId) ??
  getString(assistantEvent.messageId) ??
  getString(assistantEvent.id) ??
  `stream-${turn}`

const mapMessageUpdate = (
  event: Record<string, unknown>,
  state: PiMappingState,
  maxContextTokens: number | null,
): CliRuntimeEvent[] => {
  const assistantEvent =
    getNestedRecord(event, 'assistantMessageEvent') ??
    getNestedRecord(event, 'assistant_message_event') ??
    event
  const streamId = extractStreamId(event, assistantEvent, state.turn)
  const events: CliRuntimeEvent[] = []

  const textDelta = extractDelta(assistantEvent, 'text')
  if (textDelta) {
    const content = `${state.assistantText.get(streamId) ?? ''}${textDelta}`
    state.assistantText.set(streamId, content)
    events.push({
      type: 'message_upsert',
      message: {
        role: 'assistant',
        id: `pi-assistant-${streamId}`,
        content,
        metadata: { generationState: 'streaming' },
      },
    })
  }

  const thinkingDelta = extractDelta(assistantEvent, 'thinking')
  if (thinkingDelta) {
    const reasoning = `${state.thinkingText.get(streamId) ?? ''}${thinkingDelta}`
    state.thinkingText.set(streamId, reasoning)
    events.push({
      type: 'message_upsert',
      message: {
        role: 'assistant',
        id: `pi-thinking-${streamId}`,
        content: '',
        reasoning,
        metadata: { generationState: 'streaming' },
      },
    })
  }

  const usage = extractPiUsage(event.usage)
  if (usage) events.push({ type: 'turn_metrics', usage })
  const contextUsage = extractPiContextUsage(event.usage, maxContextTokens)
  if (contextUsage) events.push({ type: 'context_usage', usage: contextUsage })

  return events
}

const getToolRecord = (
  event: Record<string, unknown>,
): Record<string, unknown> => getNestedRecord(event, 'toolCall') ?? event

const getPiToolId = (record: Record<string, unknown>): string | null =>
  getString(record.id) ??
  getString(record.toolCallId) ??
  getString(record.callId) ??
  getString(record.call_id)

const getPiToolName = (record: Record<string, unknown>): string =>
  getString(record.name) ??
  getString(record.tool) ??
  getString(record.toolName) ??
  getString(record.tool_name) ??
  'tool'

const getPiToolInput = (
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const raw = record.input ?? record.arguments ?? record.args
  if (isRecord(raw)) return raw
  return raw !== undefined ? { value: raw } : {}
}

const extractPiToolText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(extractPiToolText).filter(Boolean).join('\n')
  }
  if (!isRecord(value)) return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return extractPiToolText(value.content)
  if (isRecord(value.partialResult)) {
    return extractPiToolText(value.partialResult.content ?? value.partialResult)
  }
  if (isRecord(value.result)) {
    return extractPiToolText(value.result.content ?? value.result)
  }
  return ''
}

const toolPair = (
  request: ToolCallRequest,
  response: ToolCallResponse,
): [ChatAssistantMessage, ChatToolMessage] => [
  {
    role: 'assistant',
    id: `pi-request-${request.id}`,
    content: '',
    toolCallRequests: [request],
    metadata: { generationState: 'completed' },
  },
  {
    role: 'tool',
    id: `pi-result-${request.id}`,
    toolCalls: [{ request, response }],
  },
]

const mapToolStart = (
  event: Record<string, unknown>,
  state: PiMappingState,
): CliRuntimeEvent[] => {
  const record = getToolRecord(event)
  const id = getPiToolId(record)
  if (!id) return []
  const input = getPiToolInput(record)
  const name = getPiToolName(record)
  state.toolInputs.set(id, input)
  state.toolNames.set(id, name)
  const request = createCliToolCallRequest({
    id,
    input,
    metadata: { runtimeId: 'pi', eventType: 'tool_execution_start', name },
  })
  const [assistant, tool] = toolPair(request, {
    status: ToolCallResponseStatus.Running,
  })
  return [
    { type: 'message_upsert', message: assistant },
    { type: 'message_upsert', message: tool },
  ]
}

/**
 * Partial tool output is not user-visible on its own (`ToolCallResponse`'s
 * `Running` variant carries no data), so this only caches the latest chunk
 * for `tool_execution_end` to fall back on if the end event's own result is
 * empty. No `CliRuntimeEvent` is emitted here.
 */
const recordToolOutput = (
  event: Record<string, unknown>,
  state: PiMappingState,
): void => {
  const record = getToolRecord(event)
  const id = getPiToolId(record)
  if (!id) return
  const content = extractPiToolText(
    record.partialResult ?? record.output ?? record.result ?? record.content,
  )
  if (content) state.toolOutputs.set(id, content)
}

const mapToolEnd = (
  event: Record<string, unknown>,
  state: PiMappingState,
): CliRuntimeEvent[] => {
  const record = getToolRecord(event)
  const id = getPiToolId(record)
  if (!id) return []
  const input = state.toolInputs.get(id) ?? getPiToolInput(record)
  const name = state.toolNames.get(id) ?? getPiToolName(record)
  const isError =
    record.isError === true || record.error === true || record.success === false
  const content =
    extractPiToolText(record.result ?? record.output ?? record.content) ||
    state.toolOutputs.get(id) ||
    ''
  state.toolInputs.delete(id)
  state.toolNames.delete(id)
  state.toolOutputs.delete(id)

  const request = createCliToolCallRequest({
    id,
    input,
    metadata: { runtimeId: 'pi', eventType: 'tool_execution_end', name },
  })
  const response: ToolCallResponse = isError
    ? {
        status: ToolCallResponseStatus.Error,
        error: content || 'Tool call failed.',
      }
    : {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: content },
      }
  const [assistant, tool] = toolPair(request, response)
  return [
    { type: 'message_upsert', message: assistant },
    { type: 'message_upsert', message: tool },
  ]
}

const buildCompactionBoundaryId = (
  event: Record<string, unknown>,
  fallback: number,
): string => {
  const id = getString(event.id) ?? getString(event.compactionId)
  return `pi-compact-${id ?? fallback}`
}

let compactionCounter = 0

/**
 * Maps one raw pi RPC event line into zero or more `CliRuntimeEvent`s.
 * `agent_settled` and the `message_end`/`turn_end` error path are handled
 * separately by the runtime (they drive `run_state`, which also needs
 * runtime-local state like "was cancel() called"), so this only covers the
 * message/tool/compaction event families. `auto_retry_start`/`auto_retry_end`
 * have no corresponding UI surface yet and are intentionally ignored rather
 * than routed through a notice mechanism that doesn't exist.
 */
export const mapPiEvent = (
  event: PiRpcRecord,
  state: PiMappingState,
  maxContextTokens: number | null = null,
): CliRuntimeEvent[] => {
  switch (getString(event.type)) {
    case 'message_update':
      return mapMessageUpdate(event, state, maxContextTokens)
    case 'tool_execution_start':
      return mapToolStart(event, state)
    case 'tool_execution_update':
      recordToolOutput(event, state)
      return []
    case 'tool_execution_end':
      return mapToolEnd(event, state)
    case 'compaction_start':
      return [{ type: 'compaction_state', isCompacting: true }]
    case 'compaction_end':
      return [
        { type: 'compaction_state', isCompacting: false },
        {
          type: 'compaction_boundary',
          boundary: {
            id: buildCompactionBoundaryId(event, ++compactionCounter),
          },
        },
      ]
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Usage / context window
// ---------------------------------------------------------------------------

export const extractPiUsage = (raw: unknown): ResponseUsage | null => {
  if (!isRecord(raw)) return null
  const input = asNonNegativeInt(raw.input)
  const output = asNonNegativeInt(raw.output)
  if (input === null || output === null) return null
  const cacheRead = asNonNegativeInt(raw.cacheRead) ?? 0
  const cacheWrite = asNonNegativeInt(raw.cacheWrite) ?? 0
  const totalTokens = asNonNegativeInt(raw.totalTokens) ?? input + output
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: totalTokens,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
  }
}

export const extractPiContextUsage = (
  raw: unknown,
  maxContextTokens: number | null,
): CliContextUsage | null => {
  if (!isRecord(raw)) return null
  const promptTokens = asNonNegativeInt(raw.input)
  if (promptTokens === null) return null
  const cacheRead = asNonNegativeInt(raw.cacheRead) ?? 0
  const cacheHitRate =
    promptTokens > 0 && cacheRead > 0
      ? Math.min(1, cacheRead / promptTokens)
      : undefined
  return {
    promptTokens,
    maxContextTokens,
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
  }
}

/** Best-effort context-window lookup from a `get_state`/`get_session_stats` response. */
export const extractPiContextWindow = (response: unknown): number | null => {
  const record = getRecord(response)
  const candidates: unknown[] = [
    record.contextUsage,
    record.context_usage,
    getRecord(record.state).contextUsage,
    getRecord(record.session).contextUsage,
    record,
  ]
  for (const candidate of candidates) {
    const usage = getRecord(candidate)
    const window =
      asPositiveInt(usage.contextWindow) ??
      asPositiveInt(usage.context_window) ??
      asPositiveInt(usage.window)
    if (window !== null) return window
  }
  return null
}

// ---------------------------------------------------------------------------
// Session identity (get_state)
// ---------------------------------------------------------------------------

export type PiSessionIdentity = { sessionId?: string; sessionFile?: string }

const extractStateRecord = (response: unknown): Record<string, unknown> => {
  const record = getRecord(response)
  return getRecord(record.state ?? record.session ?? response)
}

export const extractPiSessionIdentity = (
  response: unknown,
): PiSessionIdentity | null => {
  const state = extractStateRecord(response)
  const sessionId =
    getString(state.sessionId) ??
    getString(state.session_id) ??
    getString(getRecord(state.session).id)
  const sessionFile =
    getString(state.sessionFile) ??
    getString(state.session_file) ??
    getString(state.sessionPath) ??
    getString(state.session_path) ??
    getString(state.path)
  if (!sessionId && !sessionFile) return null
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  }
}

// ---------------------------------------------------------------------------
// Prompt construction (sendTurn)
// ---------------------------------------------------------------------------

export type PiPromptImage = { data: string; mimeType: string; type: 'image' }
export type PiPrompt = { message: string; images: PiPromptImage[] }

const DATA_URL_PATTERN = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/

/**
 * `ContentPart[]` → pi's `prompt` payload. Text stays text; `image_url` data
 * URLs become base64 `images` entries; anything else (currently only PDF
 * `document` parts, and any future part kind) degrades to an inline text
 * placeholder rather than throwing, since pi's prompt payload has no
 * dedicated attachment channel beyond images.
 */
export const toPiPrompt = (content: string | ContentPart[]): PiPrompt => {
  if (typeof content === 'string') return { message: content, images: [] }

  const textParts: string[] = []
  const images: PiPromptImage[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) textParts.push(part.text)
      continue
    }
    if (part.type === 'image_url') {
      const match = part.image_url.url.match(DATA_URL_PATTERN)
      if (match) {
        images.push({ data: match[2], mimeType: match[1], type: 'image' })
      } else {
        textParts.push(`[Image: ${part.image_url.url}]`)
      }
      continue
    }
    // 'document' (PDF) — pi's prompt payload has no attachment channel for
    // it, so degrade to a text placeholder instead of dropping it silently.
    textParts.push(`[Attachment: ${part.name}]`)
  }
  return { message: textParts.join('\n\n'), images }
}

// ---------------------------------------------------------------------------
// Model catalog (get_available_models)
// ---------------------------------------------------------------------------

const PI_THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number]

const normalizeThinkingLevel = (value: unknown): PiThinkingLevel | null => {
  const normalized = getString(value)?.toLowerCase()
  return normalized &&
    (PI_THINKING_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as PiThinkingLevel)
    : null
}

const sortThinkingLevels = (levels: PiThinkingLevel[]): PiThinkingLevel[] =>
  [...levels].sort(
    (left, right) =>
      PI_THINKING_LEVELS.indexOf(left) - PI_THINKING_LEVELS.indexOf(right),
  )

const extractThinkingLevels = (
  record: Record<string, unknown>,
): PiThinkingLevel[] => {
  const raw =
    record.thinkingLevels ??
    record.thinking_levels ??
    record.reasoningLevels ??
    record.reasoning_levels
  if (Array.isArray(raw)) {
    const levels = [
      ...new Set(
        raw
          .map(normalizeThinkingLevel)
          .filter((level): level is PiThinkingLevel => level !== null),
      ),
    ]
    if (levels.length > 0) return sortThinkingLevels(levels)
  }
  const supportsReasoning =
    record.reasoning === true ||
    record.supportsReasoning === true ||
    record.thinking === true ||
    record.canReason === true
  return supportsReasoning ? [...PI_THINKING_LEVELS] : ['off']
}

/**
 * pi's `set_model` RPC identifies a model by `{ provider, modelId }` — the
 * same bare model id can exist under more than one provider, so the id alone
 * is not a valid host-side selection key. `CliRuntimeModel.id` is opaque to
 * the rest of the host, so it encodes `provider/modelId` here and nowhere
 * else needs to know the scheme; `decodePiModelId` reverses it right before
 * the `set_model` call.
 */
export const encodePiModelId = (provider: string, modelId: string): string =>
  `${provider}/${modelId}`

export type PiDecodedModelId = { provider: string; modelId: string }

export const decodePiModelId = (encoded: string): PiDecodedModelId | null => {
  const slashIndex = encoded.indexOf('/')
  if (slashIndex <= 0 || slashIndex >= encoded.length - 1) return null
  return {
    provider: encoded.slice(0, slashIndex),
    modelId: encoded.slice(slashIndex + 1),
  }
}

/**
 * `get_available_models` → `CliRuntimeModel[]`. `reasoningEfforts` includes
 * every thinking level the model reports, `'off'` included for API
 * completeness — `CliRuntimeControls` already filters `'off'` out of the
 * picker itself (its `'auto'` entry covers "let pi decide"). Entries without
 * a `provider` are skipped: pi's `set_model` has no way to select them.
 */
export const mapPiModels = (response: unknown): CliRuntimeModel[] => {
  const record = getRecord(response)
  const list = Array.isArray(response)
    ? response
    : Array.isArray(record.models)
      ? record.models
      : []
  const seen = new Set<string>()
  const models: CliRuntimeModel[] = []
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const provider = getString(raw.provider)
    const rawId =
      getString(raw.id) ?? getString(raw.modelId) ?? getString(raw.model)
    if (!provider || !rawId) continue
    const id = encodePiModelId(provider, rawId)
    if (seen.has(id)) continue
    seen.add(id)
    const label =
      getString(raw.label) ??
      getString(raw.displayName) ??
      getString(raw.name) ??
      rawId
    const description = getString(raw.description)
    const defaultLevel = normalizeThinkingLevel(
      raw.defaultThinkingLevel ?? raw.default_thinking_level,
    )
    models.push({
      id,
      label,
      ...(description ? { description } : {}),
      reasoningEfforts: extractThinkingLevels(raw).map((level) => ({
        id: level,
      })),
      ...(defaultLevel ? { defaultReasoningEffort: defaultLevel } : {}),
      ...(raw.isDefault === true || raw.default === true
        ? { isDefault: true }
        : {}),
    })
  }
  return models
}

/**
 * Restores the provider/model pi already has selected (from `get_state`'s
 * `model` field, a full `Model` object) as our encoded id, so a resumed
 * session's first `getConfiguration()` reflects what pi is actually running
 * instead of defaulting to the catalog's first entry and forcing a spurious
 * `set_model` on the next turn.
 */
export type PiCurrentModelState = {
  modelId: string
  thinkingLevel: PiThinkingLevel | null
}

export const extractPiCurrentModelState = (
  response: unknown,
): PiCurrentModelState | null => {
  const state = extractStateRecord(response)
  const model = getNestedRecord(state, 'model')
  if (!model) return null
  const provider = getString(model.provider)
  const rawId =
    getString(model.id) ?? getString(model.modelId) ?? getString(model.model)
  if (!provider || !rawId) return null
  const thinkingLevel = normalizeThinkingLevel(
    state.thinkingLevel ?? state.thinking_level,
  )
  return {
    modelId: encodePiModelId(provider, rawId),
    thinkingLevel,
  }
}

// ---------------------------------------------------------------------------
// History hydration (get_entries)
// ---------------------------------------------------------------------------

type PiSessionEntry = {
  id?: string
  parentId?: string
  type: string
  message: Record<string, unknown>
  raw: Record<string, unknown>
}

type PiNormalizedEntries = { entries: PiSessionEntry[]; leafId: string | null }

const normalizePiEntries = (response: unknown): PiNormalizedEntries => {
  const record = getRecord(response)
  const list = Array.isArray(response)
    ? response
    : Array.isArray(record.entries)
      ? record.entries
      : []
  // `leafId` only applies when `get_entries` returned the documented
  // `{ entries, leafId }` envelope — a bare array response has no such field.
  const leafId = Array.isArray(response)
    ? null
    : (getString(record.leafId) ?? getString(record.leaf_id))
  const entries: PiSessionEntry[] = []
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const type = getString(raw.type) ?? getString(raw.kind) ?? ''
    if (type === 'session') continue // header line, not a content entry
    const id = getString(raw.id)
    const parentId = getString(raw.parentId) ?? getString(raw.parent_id)
    entries.push({
      ...(id ? { id } : {}),
      ...(parentId ? { parentId } : {}),
      type,
      message: getRecord(raw.message),
      raw,
    })
  }
  return { entries, leafId }
}

const isToolResultEntry = (entry: PiSessionEntry): boolean =>
  entry.type === 'toolResult' ||
  entry.type === 'tool_result' ||
  getString(entry.message.role) === 'toolResult' ||
  getString(entry.message.role) === 'tool_result'

const isUserEntry = (entry: PiSessionEntry): boolean =>
  getString(entry.message.role) === 'user' || entry.type === 'user'

const getToolResultCallId = (entry: PiSessionEntry): string | null =>
  getString(entry.message.toolCallId) ??
  getString(entry.message.tool_call_id) ??
  getString(entry.message.id) ??
  getString(entry.raw.toolCallId) ??
  getString(entry.raw.tool_call_id) ??
  getString(entry.raw.id)

const extractContentParts = (
  message: Record<string, unknown>,
): Record<string, unknown>[] => {
  const raw = message.content ?? message.parts ?? message.blocks
  return Array.isArray(raw) ? raw.filter(isRecord) : []
}

const getToolCallPartId = (part: Record<string, unknown>): string | null => {
  const type = getString(part.type)
  if (
    type !== 'toolCall' &&
    type !== 'tool_call' &&
    type !== 'toolUse' &&
    type !== 'tool_use'
  ) {
    return null
  }
  return (
    getString(part.id) ?? getString(part.toolCallId) ?? getString(part.callId)
  )
}

const extractPlainText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(extractPlainText).filter(Boolean).join('')
  }
  if (!isRecord(value)) return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  return ''
}

const collectToolCallIds = (entries: PiSessionEntry[]): Set<string> => {
  const ids = new Set<string>()
  for (const entry of entries) {
    for (const part of extractContentParts(entry.message)) {
      const id = getToolCallPartId(part)
      if (id) ids.add(id)
    }
  }
  return ids
}

/**
 * pi session entries are a tree (parent-linked, forkable); only the current
 * branch — the path from the leaf entry back to the root — belongs in
 * `CliSessionHydration.messages`. Sessions with no branching (no entry has a
 * `parentId`) are already linear and returned unchanged.
 *
 * `get_entries` is append-only, so the active branch's leaf is not
 * necessarily the last array element — navigation can leave the current
 * branch pointed at an earlier entry while later (now-abandoned) entries
 * remain appended after it. The response's own `leafId` is authoritative for
 * where the active branch currently ends; the last entry is only a fallback
 * for the (undocumented) case where `leafId` is absent.
 */
const resolvePiActiveBranch = (
  entries: PiSessionEntry[],
  leafId: string | null,
): PiSessionEntry[] => {
  const withIds = entries.filter(
    (entry): entry is PiSessionEntry & { id: string } => !!entry.id,
  )
  if (withIds.length === 0) return entries
  const hasBranchGraph = withIds.some(
    (entry) => !!entry.parentId && !isToolResultEntry(entry),
  )
  if (!hasBranchGraph) return entries

  const byId = new Map(withIds.map((entry) => [entry.id, entry] as const))
  const leaf =
    (leafId ? byId.get(leafId) : undefined) ?? withIds[withIds.length - 1]
  const path: PiSessionEntry[] = []
  const seen = new Set<string>()
  let current: PiSessionEntry | undefined = leaf
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  path.reverse()

  const activeIds = new Set(
    path.map((entry) => entry.id).filter((id): id is string => !!id),
  )
  const activeToolCallIds = collectToolCallIds(path)
  return entries.filter((entry) => {
    if (entry.id && activeIds.has(entry.id)) return true
    if (isToolResultEntry(entry)) {
      const callId = getToolResultCallId(entry)
      return !!callId && activeToolCallIds.has(callId)
    }
    return false
  })
}

const buildUserMessage = (
  entry: PiSessionEntry,
  index: number,
): ChatUserMessage => ({
  role: 'user',
  id: entry.id ?? `pi-user-${index}`,
  content: null,
  promptContent: extractPlainText(
    entry.message.content ?? entry.message.text ?? entry.message.message,
  ),
  mentionables: [],
})

const buildAssistantEntry = (
  entry: PiSessionEntry,
  index: number,
): { assistant: ChatAssistantMessage; tool: ChatToolMessage | null } => {
  const parts = extractContentParts(entry.message)
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolCallRequests: ToolCallRequest[] = []

  if (parts.length > 0) {
    for (const part of parts) {
      const type = getString(part.type)
      if (type === 'thinking' || type === 'reasoning') {
        const text = extractPlainText(
          part.thinking ?? part.text ?? part.content,
        )
        if (text) thinkingParts.push(text)
        continue
      }
      const toolId = getToolCallPartId(part)
      if (toolId) {
        const name =
          getString(part.name) ??
          getString(part.tool) ??
          getString(part.toolName) ??
          'tool'
        toolCallRequests.push(
          createCliToolCallRequest({
            id: toolId,
            input: getPiToolInput(part),
            metadata: { runtimeId: 'pi', eventType: 'history', name },
          }),
        )
        continue
      }
      const text = extractPlainText(part.text ?? part.content)
      if (text) textParts.push(text)
    }
  } else {
    const text = extractPlainText(entry.message.content ?? entry.message.text)
    if (text) textParts.push(text)
  }

  const assistant: ChatAssistantMessage = {
    role: 'assistant',
    id: entry.id ?? `pi-assistant-${index}`,
    content: textParts.join(''),
    ...(thinkingParts.length > 0
      ? { reasoning: thinkingParts.join('\n\n') }
      : {}),
    ...(toolCallRequests.length > 0 ? { toolCallRequests } : {}),
    metadata: { generationState: 'completed' },
  }
  const tool: ChatToolMessage | null =
    toolCallRequests.length > 0
      ? {
          role: 'tool',
          id: `pi-result-${entry.id ?? index}`,
          toolCalls: toolCallRequests.map((request) => ({
            request,
            response: { status: ToolCallResponseStatus.Running },
          })),
        }
      : null
  return { assistant, tool }
}

const findLastRunningToolCall = (
  messages: ChatMessage[],
  toolCallId: string,
): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'tool') continue
    if (message.toolCalls.some((call) => call.request.id === toolCallId)) {
      return index
    }
  }
  return -1
}

const applyToolResultEntry = (
  messages: ChatMessage[],
  entry: PiSessionEntry,
): void => {
  const toolCallId = getToolResultCallId(entry)
  if (!toolCallId) return
  const index = findLastRunningToolCall(messages, toolCallId)
  if (index < 0) return
  const message = messages[index] as ChatToolMessage
  const isError = entry.message.isError === true || entry.message.error === true
  const content = extractPiToolText(
    entry.message.result ?? entry.message.content ?? entry.message.output,
  )
  const response: ToolCallResponse = isError
    ? {
        status: ToolCallResponseStatus.Error,
        error: content || 'Tool call failed.',
      }
    : {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: content },
      }
  messages[index] = {
    ...message,
    toolCalls: message.toolCalls.map((call) =>
      call.request.id === toolCallId ? { ...call, response } : call,
    ),
  }
}

export type PiSessionHydrationContent = {
  messages: ChatMessage[]
  compactionBoundaries: CliCompactionBoundary[]
}

export type PiRewriteCheckpoint = {
  /** Parent entry to keep as the forked leaf. `null` starts a fresh session. */
  resumeAt: string | null
  userIndex: number
}

const sliceLinearPrefix = (
  entries: PiSessionEntry[],
  resumeAt: string,
): PiSessionEntry[] => {
  const index = entries.findIndex((entry) => entry.id === resumeAt)
  if (index < 0) return []
  let end = index + 1
  while (end < entries.length && isToolResultEntry(entries[end])) end += 1
  return entries.slice(0, end)
}

/**
 * Locate the native entry to replace when the user rewrites a sent turn.
 * Hydrated conversations use pi entry ids; live turns use YOLO user-message
 * ids recorded by `sendTurn`, matched by ordinal against the active branch.
 */
export const resolvePiRewriteCheckpoint = (
  response: unknown,
  sourceUserMessageId: string,
  sentUserMessageIds: readonly string[] = [],
): PiRewriteCheckpoint => {
  const normalized = normalizePiEntries(response)
  const branch = resolvePiActiveBranch(normalized.entries, normalized.leafId)
  const userEntries = branch.filter(
    (entry): entry is PiSessionEntry & { id: string } =>
      isUserEntry(entry) && !!entry.id,
  )
  let userIndex = userEntries.findIndex(
    (entry) => entry.id === sourceUserMessageId,
  )
  if (userIndex < 0) {
    userIndex = sentUserMessageIds.indexOf(sourceUserMessageId)
  }
  if (userIndex < 0 || userIndex >= userEntries.length) {
    throw new Error('The selected pi user message no longer exists.')
  }
  if (userIndex === 0) return { resumeAt: null, userIndex: 0 }

  const target = userEntries[userIndex]
  if (target.parentId && branch.some((entry) => entry.id === target.parentId)) {
    return { resumeAt: target.parentId, userIndex }
  }
  const targetPos = branch.findIndex((entry) => entry.id === target.id)
  for (let index = targetPos - 1; index >= 0; index -= 1) {
    const candidate = branch[index]
    if (candidate?.id && !isToolResultEntry(candidate)) {
      return { resumeAt: candidate.id, userIndex }
    }
  }
  return { resumeAt: null, userIndex }
}

/**
 * Entries (as originally returned by `get_entries`) that belong on a fork
 * whose leaf is `resumeAt`, including tool results attached to that prefix.
 */
export const collectPiForkRawEntries = (
  response: unknown,
  resumeAt: string,
): Record<string, unknown>[] => {
  const normalized = normalizePiEntries(response)
  const hasBranchGraph = normalized.entries.some(
    (entry) => !!entry.id && !!entry.parentId && !isToolResultEntry(entry),
  )
  if (
    hasBranchGraph &&
    !normalized.entries.some((entry) => entry.id === resumeAt)
  ) {
    throw new Error(`Pi fork checkpoint not found: ${resumeAt}`)
  }
  const selected = hasBranchGraph
    ? resolvePiActiveBranch(normalized.entries, resumeAt)
    : sliceLinearPrefix(normalized.entries, resumeAt)
  if (
    selected.length === 0 ||
    !selected.some((entry) => entry.id === resumeAt)
  ) {
    throw new Error(`Pi fork checkpoint not found: ${resumeAt}`)
  }
  return selected.map((entry) => entry.raw)
}

export const buildPiForkSessionContent = ({
  entries,
  sessionId,
  timestamp,
  cwd,
  parentSession,
}: {
  entries: readonly Record<string, unknown>[]
  sessionId: string
  timestamp: string
  cwd: string
  parentSession: string
}): string => {
  const header = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp,
    cwd,
    parentSession,
  }
  return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/**
 * `get_entries` → `CliSessionHydration`. Only the current branch is mapped
 * (see `resolvePiActiveBranch`); tool calls embedded in an assistant entry's
 * content parts become one `ChatToolMessage` with a `Running` placeholder
 * per call, resolved in place once the matching `toolResult` entry is seen.
 */
export const mapPiEntriesToHydration = (
  response: unknown,
): PiSessionHydrationContent => {
  const normalized = normalizePiEntries(response)
  const entries = resolvePiActiveBranch(normalized.entries, normalized.leafId)
  const messages: ChatMessage[] = []
  const compactionBoundaries: CliCompactionBoundary[] = []

  entries.forEach((entry, index) => {
    if (isToolResultEntry(entry)) {
      applyToolResultEntry(messages, entry)
      return
    }
    if (entry.type === 'compaction') {
      compactionBoundaries.push({
        id: `pi-compact-${entry.id ?? index}`,
        afterMessageId: messages.at(-1)?.id ?? null,
      })
      return
    }
    const role =
      getString(entry.message.role) ??
      (entry.type === 'user' || entry.type === 'assistant' ? entry.type : null)
    if (role === 'user') {
      messages.push(buildUserMessage(entry, index))
      return
    }
    if (role === 'assistant') {
      const { assistant, tool } = buildAssistantEntry(entry, index)
      messages.push(assistant)
      if (tool) messages.push(tool)
    }
    // Other entry kinds (branch summaries, custom messages, …) are skipped
    // in v1 — best-effort hydration, not full session-file fidelity.
  })

  return { messages, compactionBoundaries }
}
