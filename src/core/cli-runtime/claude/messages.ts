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
  metadata: { generationState: 'completed' },
})

const createToolMessage = ({
  id,
  requests,
  results,
}: {
  id: string
  requests: Map<string, ToolCallRequest>
  results: ClaudeToolResult[]
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
          data: { type: 'text', text: result.content },
        },
  })),
})

export const hydrateClaudeSessionMessages = (
  messages: SessionMessage[],
): ChatMessage[] => {
  const hydrated: ChatMessage[] = []
  const requests = new Map<string, ToolCallRequest>()
  const completedTools = new Set<string>()

  for (const message of messages) {
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
      for (const result of toolResults) completedTools.add(result.id)
      hydrated.push(
        createToolMessage({ id: message.uuid, requests, results: toolResults }),
      )
      continue
    }

    const promptContent = extractTextContent(nativeMessage.content)
    if (promptContent) {
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

  return hydrated
}

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
