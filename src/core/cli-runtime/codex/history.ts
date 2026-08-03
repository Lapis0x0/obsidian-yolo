import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatUserMessage,
} from '../../../types/chat'
import type { ToolCallRequest } from '../../../types/tool-call.types'
import type { CliCompactionBoundary } from '../types'

import {
  mapCodexItem,
  mapCodexRawToolCall,
  mapCodexRawToolOutput,
} from './mapping'
import type { CodexRawResponseItem } from './protocol'

type JsonRecord = Record<string, unknown>

type HistoryRecord = {
  type?: unknown
  payload?: unknown
}

export type CodexSessionTranscript = {
  messages: ChatMessage[]
  compactionBoundaries: CliCompactionBoundary[]
}

const CONTROL_BLOCK_TAGS = [
  'recommended_plugins',
  'system_instruction',
  'environment_context',
  'turn_aborted',
  'user-preferences',
  'subagent_notification',
  'skill',
]

const AGENTS_INSTRUCTIONS_PREFIX = '# AGENTS.md instructions'
const AGENTS_INSTRUCTIONS_CLOSE_TAG = '</INSTRUCTIONS>'

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const readString = (record: JsonRecord, key: string): string | null =>
  typeof record[key] === 'string' ? record[key] : null

const stripLeadingTaggedBlock = (
  text: string,
  tagName: string,
): string | null => {
  const openTag = `<${tagName}>`
  if (!text.startsWith(openTag)) return null
  const closeTag = `</${tagName}>`
  const closeIndex = text.indexOf(closeTag, openTag.length)
  return closeIndex < 0 ? '' : text.slice(closeIndex + closeTag.length)
}

const extractVisibleUserText = (text: string): string | null => {
  let remaining = text.trimStart()
  while (remaining) {
    if (remaining.startsWith(AGENTS_INSTRUCTIONS_PREFIX)) {
      const closeIndex = remaining.indexOf(AGENTS_INSTRUCTIONS_CLOSE_TAG)
      remaining =
        closeIndex < 0
          ? ''
          : remaining
              .slice(closeIndex + AGENTS_INSTRUCTIONS_CLOSE_TAG.length)
              .trimStart()
      continue
    }
    let stripped = false
    for (const tagName of CONTROL_BLOCK_TAGS) {
      const next = stripLeadingTaggedBlock(remaining, tagName)
      if (next === null) continue
      remaining = next.trimStart()
      stripped = true
      break
    }
    if (!stripped) break
  }
  const visible = remaining.trim()
  return visible || null
}

const readTextParts = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .flatMap((part): string[] => {
          const record = asRecord(part)
          const text = record ? readString(record, 'text') : null
          return text ? [text] : []
        })
        .join('')
    : ''

const createUserMessage = (
  payload: JsonRecord,
  currentTurnId: string | null,
  lineIndex: number,
): ChatUserMessage | null => {
  const rawText = readString(payload, 'message')
  if (!rawText) return null
  const visibleText = extractVisibleUserText(rawText)
  if (!visibleText) return null
  const clientId = readString(payload, 'client_id')
  return {
    role: 'user',
    id: clientId
      ? `codex-user-client-${clientId}`
      : currentTurnId
        ? `codex-user-turn-${currentTurnId}`
        : `codex-history-user-${lineIndex}`,
    content: null,
    promptContent: visibleText,
    mentionables: [],
  }
}

const createAssistantMessage = (
  payload: JsonRecord,
  lineIndex: number,
): ChatAssistantMessage | null => {
  if (readString(payload, 'role') !== 'assistant') return null
  const content = readTextParts(payload.content)
  if (!content) return null
  return {
    role: 'assistant',
    id: `codex-history-assistant-${lineIndex}`,
    content,
    metadata: { generationState: 'completed' },
  }
}

const createReasoningMessage = (
  payload: JsonRecord,
  lineIndex: number,
): ChatAssistantMessage | null => {
  const reasoning = [
    readTextParts(payload.summary),
    readTextParts(payload.content),
    readString(payload, 'text') ?? '',
  ]
    .filter(Boolean)
    .join('\n\n')
  if (!reasoning) return null
  return {
    role: 'assistant',
    id: `codex-history-reasoning-${lineIndex}`,
    content: '',
    reasoning,
    metadata: { generationState: 'completed' },
  }
}

const toRawToolCall = (
  payload: JsonRecord,
): Extract<
  CodexRawResponseItem,
  { type: 'custom_tool_call' | 'function_call' }
> | null => {
  const type = readString(payload, 'type')
  const callId = readString(payload, 'call_id')
  const name = readString(payload, 'name')
  if (!callId || !name) return null
  if (type === 'custom_tool_call') {
    return {
      type,
      call_id: callId,
      name,
      input: readString(payload, 'input') ?? '',
      ...(readString(payload, 'status')
        ? { status: readString(payload, 'status')! }
        : {}),
    }
  }
  if (type === 'function_call') {
    return {
      type,
      call_id: callId,
      name,
      arguments: readString(payload, 'arguments') ?? '',
      ...(readString(payload, 'status')
        ? { status: readString(payload, 'status')! }
        : {}),
    }
  }
  return null
}

const toRawToolOutput = (
  payload: JsonRecord,
): Extract<
  CodexRawResponseItem,
  { type: 'custom_tool_call_output' | 'function_call_output' }
> | null => {
  const type = readString(payload, 'type')
  const callId = readString(payload, 'call_id')
  if (!callId) return null
  if (type === 'custom_tool_call_output') {
    return {
      type,
      call_id: callId,
      output: Array.isArray(payload.output)
        ? (payload.output as Extract<
            CodexRawResponseItem,
            { type: 'custom_tool_call_output' }
          >['output'])
        : typeof payload.output === 'string'
          ? payload.output
          : '',
    }
  }
  if (type === 'function_call_output') {
    return {
      type,
      call_id: callId,
      output:
        typeof payload.output === 'string' || Array.isArray(payload.output)
          ? payload.output
          : '',
    }
  }
  return null
}

const mapStructuredToolItem = (payload: JsonRecord): ChatMessage[] => {
  const type = readString(payload, 'type')
  const id = readString(payload, 'call_id') ?? readString(payload, 'id')
  if (!id) return []
  if (type === 'mcp_tool_call') {
    return mapCodexItem({
      type: 'mcpToolCall',
      id,
      server: readString(payload, 'server') ?? '',
      tool: readString(payload, 'tool') ?? 'tool',
      status: readString(payload, 'status') ?? 'completed',
      arguments: payload.arguments,
      result: payload.result,
      error: payload.error,
    })
  }
  if (type === 'web_search_call') {
    const action = asRecord(payload.action)
    const query = action
      ? (readString(action, 'query') ??
        (Array.isArray(action.queries) && typeof action.queries[0] === 'string'
          ? action.queries[0]
          : ''))
      : ''
    return mapCodexItem({
      type: 'webSearch',
      id,
      query,
      action: payload.action,
    })
  }
  return []
}

const upsertMessage = (messages: ChatMessage[], message: ChatMessage): void => {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) messages.push(message)
  else messages[index] = message
}

/**
 * Parses the durable Codex transcript instead of relying on thread/read's
 * intentionally smaller high-level item projection. The JSONL is the only
 * history surface that contains raw custom/function tool calls and outputs.
 */
export const parseCodexSessionTranscript = (
  content: string,
): CodexSessionTranscript => {
  const messages: ChatMessage[] = []
  const compactionBoundaries: CliCompactionBoundary[] = []
  const toolRequests = new Map<string, ToolCallRequest[]>()
  let currentTurnId: string | null = null

  for (const [lineIndex, line] of content.split('\n').entries()) {
    if (!line.trim()) continue
    let parsed: HistoryRecord
    try {
      parsed = JSON.parse(line) as HistoryRecord
    } catch {
      continue
    }
    const payload = asRecord(parsed.payload)
    if (!payload) continue
    const payloadType = readString(payload, 'type')

    if (parsed.type === 'event_msg') {
      if (payloadType === 'task_started') {
        currentTurnId = readString(payload, 'turn_id')
      } else if (payloadType === 'task_complete') {
        currentTurnId = null
      } else if (payloadType === 'user_message') {
        const message = createUserMessage(payload, currentTurnId, lineIndex)
        if (message) upsertMessage(messages, message)
      } else if (payloadType === 'context_compacted') {
        compactionBoundaries.push({
          id: `codex-compact-history-${lineIndex}`,
          afterMessageId: messages.at(-1)?.id ?? null,
        })
      }
      continue
    }
    if (parsed.type !== 'response_item') continue

    if (payloadType === 'message') {
      const message = createAssistantMessage(payload, lineIndex)
      if (message) messages.push(message)
      continue
    }
    if (payloadType === 'reasoning') {
      const message = createReasoningMessage(payload, lineIndex)
      if (message) messages.push(message)
      continue
    }

    const toolCall = toRawToolCall(payload)
    if (toolCall) {
      const mapped = mapCodexRawToolCall(toolCall)
      toolRequests.set(toolCall.call_id, mapped.requests)
      for (const message of mapped.messages) upsertMessage(messages, message)
      continue
    }

    const toolOutput = toRawToolOutput(payload)
    if (toolOutput) {
      const requests = toolRequests.get(toolOutput.call_id)
      if (!requests) continue
      for (const message of mapCodexRawToolOutput(toolOutput, requests)) {
        upsertMessage(messages, message)
      }
      continue
    }

    for (const message of mapStructuredToolItem(payload)) {
      upsertMessage(messages, message)
    }
  }

  return { messages, compactionBoundaries }
}

export const parseCodexSessionContent = (content: string): ChatMessage[] =>
  parseCodexSessionTranscript(content).messages

export const loadCodexSessionTranscript = async (
  sessionPath: string,
): Promise<CodexSessionTranscript | null> => {
  try {
    // eslint-disable-next-line import/no-nodejs-modules -- Codex history is loaded only behind the desktop CLI runtime boundary
    const { readFile } = await import('node:fs/promises')
    return parseCodexSessionTranscript(await readFile(sessionPath, 'utf8'))
  } catch (error) {
    console.warn('[YOLO] Failed to read Codex session transcript', {
      sessionPath,
      error,
    })
    return null
  }
}
