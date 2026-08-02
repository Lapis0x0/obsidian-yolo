import type { SessionMessage } from '@yolo/claude-agent-sdk-runtime'

import type {
  ChatAssistantMessage,
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../../types/chat'
import {
  type ToolCallRequest,
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'
import { createCliToolCallRequest } from '../tool-call'
import type { CliCompactionBoundary } from '../types'

import {
  CLAUDE_ASK_USER_QUESTION_TOOL,
  mapClaudeAskUserQuestionInput,
} from './askUserQuestion'

export const CLAUDE_BASH_TOOL = 'Bash'

type ContentBlock = Record<string, unknown> & { type?: unknown }

export type ClaudeToolUse = {
  id: string
  name: string
  input: Record<string, unknown>
  parentCallId?: string
}

export type ClaudeToolResult = {
  id: string
  content: string
  isError: boolean
  structuredResult?: unknown
}

export type ClaudeTaskNotification = {
  agentId: string
  toolUseId: string
  status: string
  summary?: string
  result?: string
}

export type ClaudeSessionTranscript = {
  messages: ChatMessage[]
  compactionBoundaries: CliCompactionBoundary[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const getContentBlocks = (value: unknown): ContentBlock[] =>
  Array.isArray(value)
    ? value.filter((block): block is ContentBlock => isRecord(block))
    : []

export const extractTextContent = (value: unknown): string => {
  if (typeof value === 'string') return value
  return getContentBlocks(value)
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('')
}

export const extractThinkingContent = (value: unknown): string =>
  getContentBlocks(value)
    .flatMap((block) =>
      block.type === 'thinking' && typeof block.thinking === 'string'
        ? [block.thinking]
        : [],
    )
    .join('')

const isLocalCommandTranscriptText = (text: string): boolean =>
  text.includes('<local-command-caveat>') ||
  text.includes('<command-name>') ||
  text.includes('<local-command-stdout>') ||
  text.includes('<local-command-stderr>')

export const extractToolUses = (value: unknown): ClaudeToolUse[] =>
  getContentBlocks(value).flatMap((block) => {
    if (
      block.type !== 'tool_use' ||
      typeof block.id !== 'string' ||
      typeof block.name !== 'string'
    ) {
      return []
    }
    return [
      {
        id: block.id,
        name: block.name,
        input: isRecord(block.input) ? block.input : {},
      },
    ]
  })

const stringifyToolResult = (content: unknown): string => {
  if (typeof content === 'string') return content
  const text = extractTextContent(content)
  if (text) return text
  if (content === undefined) return ''
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return '[Unserializable tool result]'
  }
}

const readXmlTag = (text: string, tag: string): string | undefined => {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))
  return match?.[1]?.trim() || undefined
}

export const parseClaudeTaskNotification = (
  text: string,
): ClaudeTaskNotification | null => {
  if (!text.includes('<task-notification>')) return null
  const agentId = readXmlTag(text, 'task-id')
  const toolUseId = readXmlTag(text, 'tool-use-id')
  const status = readXmlTag(text, 'status')
  if (!agentId || !toolUseId || !status) return null
  return {
    agentId,
    toolUseId,
    status,
    ...(readXmlTag(text, 'summary')
      ? { summary: readXmlTag(text, 'summary') }
      : {}),
    ...(readXmlTag(text, 'result')
      ? { result: readXmlTag(text, 'result') }
      : {}),
  }
}

export const extractToolResults = (value: unknown): ClaudeToolResult[] =>
  getContentBlocks(value).flatMap((block) => {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
      return []
    }
    return [
      {
        id: block.tool_use_id,
        content: stringifyToolResult(block.content),
        isError: block.is_error === true,
      },
    ]
  })

export const toToolCallRequest = (toolUse: ClaudeToolUse): ToolCallRequest => {
  const presentationArguments =
    toolUse.name === CLAUDE_ASK_USER_QUESTION_TOOL
      ? mapClaudeAskUserQuestionInput(toolUse.input)
      : null
  const capability =
    toolUse.name === CLAUDE_ASK_USER_QUESTION_TOOL && presentationArguments
      ? ('user_question' as const)
      : toolUse.name === CLAUDE_BASH_TOOL
        ? ('command_execution' as const)
        : undefined
  return createCliToolCallRequest({
    id: toolUse.id,
    input: toolUse.input,
    metadata: {
      runtimeId: 'claude-code',
      eventType: 'tool_use',
      name: toolUse.name,
      ...(toolUse.parentCallId ? { parentCallId: toolUse.parentCallId } : {}),
      ...(capability === 'user_question' && presentationArguments
        ? {
            capability,
            presentationArguments,
          }
        : capability
          ? { capability }
          : {}),
    },
  })
}

const createUserMessage = (
  message: SessionMessage,
  promptContent: string,
): ChatUserMessage => ({
  role: 'user',
  id: message.uuid,
  content: null,
  promptContent,
  mentionables: [],
})

const createAssistantMessage = (
  message: SessionMessage,
  nativeMessage: Record<string, unknown>,
  toolUses: ClaudeToolUse[],
): ChatAssistantMessage => ({
  role: 'assistant',
  id: message.uuid,
  content: extractTextContent(nativeMessage.content),
  ...(extractThinkingContent(nativeMessage.content)
    ? { reasoning: extractThinkingContent(nativeMessage.content) }
    : {}),
  ...(toolUses.length > 0
    ? { toolCallRequests: toolUses.map(toToolCallRequest) }
    : {}),
  metadata: {
    generationState: 'completed',
    ...(message.parent_tool_use_id
      ? { cliSubagentParentCallId: message.parent_tool_use_id }
      : {}),
  },
})

const createToolMessage = ({
  id,
  requests,
  results,
  structuredResult,
}: {
  id: string
  requests: Map<string, ToolCallRequest>
  results: ClaudeToolResult[]
  structuredResult?: unknown
}): ChatToolMessage => ({
  role: 'tool',
  id,
  toolCalls: results.map((result) => ({
    request:
      requests.get(result.id) ??
      ({ id: result.id, name: 'unknown' } satisfies ToolCallRequest),
    response: result.isError
      ? {
          status: ToolCallResponseStatus.Error,
          error: result.content,
        }
      : {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: result.content,
            ...((result.structuredResult ?? structuredResult) !== undefined
              ? {
                  metadata: {
                    cliToolResult: result.structuredResult ?? structuredResult,
                  },
                }
              : {}),
          },
        },
  })),
})

const updateHydratedTaskNotification = (
  hydrated: ChatMessage[],
  notification: ClaudeTaskNotification,
): boolean => {
  for (let index = hydrated.length - 1; index >= 0; index -= 1) {
    const message = hydrated[index]
    if (message?.role !== 'tool') continue
    const toolCallIndex = message.toolCalls.findIndex(
      ({ request }) => request.id === notification.toolUseId,
    )
    if (toolCallIndex < 0) continue
    const toolCalls = [...message.toolCalls]
    const toolCall = toolCalls[toolCallIndex]
    if (!toolCall) return false
    const failed =
      notification.status === 'failed' || notification.status === 'errored'
    const previousStructured =
      toolCall.response.status === ToolCallResponseStatus.Success
        ? isRecord(toolCall.response.data.metadata?.cliToolResult)
          ? toolCall.response.data.metadata.cliToolResult
          : null
        : null
    toolCalls[toolCallIndex] = {
      request: toolCall.request,
      response: failed
        ? {
            status: ToolCallResponseStatus.Error,
            error:
              notification.result ||
              notification.summary ||
              notification.status,
          }
        : {
            status: ToolCallResponseStatus.Success,
            data: {
              type: 'text',
              text: notification.result || notification.summary || '',
              metadata: {
                cliToolResult: {
                  ...(previousStructured ?? {}),
                  ...notification,
                },
              },
            },
          },
    }
    hydrated[index] = { ...message, toolCalls }
    return true
  }
  return false
}

const readFiniteNumber = (
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

const readClaudeCompactionBoundary = (
  message: SessionMessage,
): {
  boundary: Omit<CliCompactionBoundary, 'afterMessageId'>
  summaryMessageId?: string
} | null => {
  const record = message as unknown as Record<string, unknown>
  if (record.type !== 'system' || record.subtype !== 'compact_boundary') {
    return null
  }
  const metadata = isRecord(record.compactMetadata)
    ? record.compactMetadata
    : isRecord(record.compact_metadata)
      ? record.compact_metadata
      : {}
  const preservedSegment = isRecord(metadata.preservedSegment)
    ? metadata.preservedSegment
    : isRecord(metadata.preserved_segment)
      ? metadata.preserved_segment
      : null
  const uuid = typeof record.uuid === 'string' ? record.uuid : 'unknown'
  const trigger =
    metadata.trigger === 'manual' || metadata.trigger === 'auto'
      ? metadata.trigger
      : undefined
  const preTokens = readFiniteNumber(metadata, 'preTokens', 'pre_tokens')
  const postTokens = readFiniteNumber(metadata, 'postTokens', 'post_tokens')
  return {
    boundary: {
      id: `claude-compact-${uuid}`,
      ...(trigger ? { trigger } : {}),
      ...(preTokens !== undefined ? { preTokens } : {}),
      ...(postTokens !== undefined ? { postTokens } : {}),
    },
    ...(typeof preservedSegment?.anchorUuid === 'string'
      ? { summaryMessageId: preservedSegment.anchorUuid }
      : typeof preservedSegment?.anchor_uuid === 'string'
        ? { summaryMessageId: preservedSegment.anchor_uuid }
        : {}),
  }
}

export const hydrateClaudeSessionTranscript = (
  messages: SessionMessage[],
): ClaudeSessionTranscript => {
  const hydrated: ChatMessage[] = []
  const compactionBoundaries: CliCompactionBoundary[] = []
  const hiddenCompactionSummaryMessageIds = new Set<string>()
  const requests = new Map<string, ToolCallRequest>()
  const completedTools = new Set<string>()

  for (const message of messages) {
    const compaction = readClaudeCompactionBoundary(message)
    if (compaction) {
      compactionBoundaries.push({
        ...compaction.boundary,
        afterMessageId: hydrated.at(-1)?.id ?? null,
      })
      if (compaction.summaryMessageId) {
        hiddenCompactionSummaryMessageIds.add(compaction.summaryMessageId)
      }
      continue
    }
    if (hiddenCompactionSummaryMessageIds.has(message.uuid)) continue
    if (!isRecord(message.message)) {
      continue
    }
    const nativeMessage = message.message
    if (message.type === 'assistant') {
      const toolUses = extractToolUses(nativeMessage.content).map((toolUse) =>
        message.parent_tool_use_id
          ? { ...toolUse, parentCallId: message.parent_tool_use_id }
          : toolUse,
      )
      for (const toolUse of toolUses) {
        requests.set(toolUse.id, toToolCallRequest(toolUse))
      }
      hydrated.push(createAssistantMessage(message, nativeMessage, toolUses))
      continue
    }
    if (message.type !== 'user') continue

    const toolResults = extractToolResults(nativeMessage.content)
    if (toolResults.length > 0) {
      const structuredResult =
        (
          message as SessionMessage & {
            tool_use_result?: unknown
            toolUseResult?: unknown
          }
        ).tool_use_result ??
        (message as SessionMessage & { toolUseResult?: unknown }).toolUseResult
      for (const result of toolResults) completedTools.add(result.id)
      hydrated.push(
        createToolMessage({
          id: message.uuid,
          requests,
          results: toolResults,
          ...(structuredResult !== undefined ? { structuredResult } : {}),
        }),
      )
      continue
    }

    const promptContent = extractTextContent(nativeMessage.content)
    const notification = parseClaudeTaskNotification(promptContent)
    if (notification) {
      updateHydratedTaskNotification(hydrated, notification)
      continue
    }
    if (promptContent && !isLocalCommandTranscriptText(promptContent)) {
      hydrated.push(createUserMessage(message, promptContent))
    }
  }

  for (const [toolUseId, request] of requests) {
    if (completedTools.has(toolUseId)) continue
    hydrated.push({
      role: 'tool',
      id: `claude-tool-${toolUseId}`,
      toolCalls: [
        {
          request,
          response: { status: ToolCallResponseStatus.Running },
        },
      ],
    })
  }

  return { messages: hydrated, compactionBoundaries }
}

export const hydrateClaudeSessionMessages = (
  messages: SessionMessage[],
): ChatMessage[] => hydrateClaudeSessionTranscript(messages).messages

export const reconcileFinalText = (
  streamed: string,
  finalText: string,
): string => {
  if (!finalText) return streamed
  if (!streamed) return finalText
  if (finalText.startsWith(streamed)) return finalText
  if (streamed.startsWith(finalText)) return streamed
  return finalText
}
