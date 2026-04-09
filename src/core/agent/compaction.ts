import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import {
  getLatestChatConversationCompaction,
  type ChatAssistantMessage,
  type ChatConversationCompaction,
  type ChatConversationCompactionState,
  type ChatMessage,
  type ChatToolMessage,
  type ChatUserMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { RequestMessage } from '../../types/llm/request'
import type { LLMProvider } from '../../types/provider.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

const COMPACTION_SYSTEM_PROMPT = `You are summarizing a conversation so it can continue in a fresh context window.

Produce a compact but high-signal summary that preserves:
- the user's current goal
- important constraints and preferences
- decisions already made
- files, paths, or entities that matter
- work completed so far
- unresolved issues and the next best step

Rules:
- Keep the summary factual and concise.
- Do not include greetings, filler, or repeated details.
- Preserve exact file paths, ids, and tool outcomes when they matter.
- Mention failures or uncertainties explicitly.
- Write in the same language the conversation is currently using.
- Output plain Markdown only.`

export const CONTEXT_COMPACT_TOOL_NAME = 'context_compact'

export type AutoContextCompactionChatOptions = {
  autoContextCompactionEnabled: boolean
  autoContextCompactionThresholdMode: 'tokens' | 'ratio'
  autoContextCompactionThresholdTokens: number
  autoContextCompactionThresholdRatio: number
}

export const resolveAutoContextCompactionChatOptions = (chatOptions: {
  autoContextCompactionEnabled?: boolean
  autoContextCompactionThresholdMode?: 'tokens' | 'ratio'
  autoContextCompactionThresholdTokens?: number
  autoContextCompactionThresholdRatio?: number
}): AutoContextCompactionChatOptions => {
  return {
    autoContextCompactionEnabled: chatOptions.autoContextCompactionEnabled ?? false,
    autoContextCompactionThresholdMode:
      chatOptions.autoContextCompactionThresholdMode ?? 'tokens',
    autoContextCompactionThresholdTokens:
      chatOptions.autoContextCompactionThresholdTokens ?? 24000,
    autoContextCompactionThresholdRatio:
      chatOptions.autoContextCompactionThresholdRatio ?? 0.8,
  }
}

export type ShouldTriggerAutoContextCompactionInput = {
  previousMessages: ChatMessage[]
  chatOptions: AutoContextCompactionChatOptions
  compactionState: ChatConversationCompactionState
  isConversationRunActive: boolean
}

/**
 * Whether to run automatic compaction before submitting the new user message.
 * `previousMessages` must be the transcript *before* the new user turn (excludes the pending user message).
 */
export const shouldTriggerAutoContextCompaction = ({
  previousMessages,
  chatOptions,
  compactionState,
  isConversationRunActive,
}: ShouldTriggerAutoContextCompactionInput): boolean => {
  if (!chatOptions.autoContextCompactionEnabled) {
    return false
  }

  if (isConversationRunActive) {
    return false
  }

  const last = previousMessages.at(-1)
  if (!last || last.role !== 'assistant') {
    return false
  }

  const promptTokens = last.metadata?.usage?.prompt_tokens
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens)) {
    return false
  }

  const latestCompaction = getLatestChatConversationCompaction(compactionState)
  if (latestCompaction?.anchorMessageId === last.id) {
    return false
  }

  if (chatOptions.autoContextCompactionThresholdMode === 'tokens') {
    return promptTokens >= chatOptions.autoContextCompactionThresholdTokens
  }

  const maxContextTokens = last.metadata?.model?.maxContextTokens

  if (
    typeof maxContextTokens !== 'number' ||
    maxContextTokens <= 0 ||
    !Number.isFinite(maxContextTokens)
  ) {
    return false
  }

  return (
    promptTokens / maxContextTokens >=
    chatOptions.autoContextCompactionThresholdRatio
  )
}

const parseCompactOperationResult = (
  text: string,
): {
  tool: string
  toolCallId: string | null
  operation: string
} | null => {
  try {
    const parsed = JSON.parse(text) as {
      tool?: unknown
      toolCallId?: unknown
      operation?: unknown
    }
    return typeof parsed.tool === 'string' &&
      parsed.tool === CONTEXT_COMPACT_TOOL_NAME
      ? {
          tool: parsed.tool,
          toolCallId:
            typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null,
          operation:
            typeof parsed.operation === 'string' ? parsed.operation : '',
        }
      : null
  } catch {
    return null
  }
}

export const findCompactTrigger = (
  messages: ChatMessage[],
): {
  triggerToolCallId: string
  anchorMessageId: string
  retainedStartIndex: number
} | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'tool') {
      continue
    }

    const compactToolCall = message.toolCalls.find((toolCall) => {
      if (toolCall.response.status !== ToolCallResponseStatus.Success) {
        return false
      }
      const parsed = parseCompactOperationResult(toolCall.response.data.text)
      return parsed?.operation === 'compact_restart'
    })

    if (!compactToolCall) {
      continue
    }

    const retainedStartIndex =
      index > 0 && messages[index - 1]?.role === 'assistant' ? index - 1 : index

    return {
      triggerToolCallId: compactToolCall.request.id,
      anchorMessageId: message.id,
      retainedStartIndex,
    }
  }

  return null
}

export const findCompactToolCallId = (
  toolMessage: ChatToolMessage,
): string | null => {
  for (const toolCall of toolMessage.toolCalls) {
    if (toolCall.response.status !== ToolCallResponseStatus.Success) {
      continue
    }

    const parsed = parseCompactOperationResult(toolCall.response.data.text)
    if (parsed?.operation === 'compact_restart') {
      return toolCall.request.id
    }
  }

  return null
}

export const buildCompactionSummaryMessage = (
  compaction: ChatConversationCompaction,
): RequestMessage => {
  return {
    role: 'user',
    content: `<context_compaction>
You previously triggered \`${CONTEXT_COMPACT_TOOL_NAME}\` in this conversation.
Everything before the retained tool boundary has been compressed into the summary below.
Treat it as authoritative background context for continuing the same task.

<summary>
${compaction.summary}
</summary>
</context_compaction>`,
  }
}

export const buildCompactionResumeMessage = (): RequestMessage => {
  return {
    role: 'user',
    content: `<context_compaction_resume>
The compaction step has completed.
Resume the task that was active immediately before compaction.
Use the summary above as background context and the retained assistant/tool boundary as the latest working state.
Do not stop at saying the compaction succeeded.
Do not ask the user to repeat context unless information is actually missing.
Continue the task from the most useful next step.
</context_compaction_resume>`,
  }
}

export const buildCompactedConversationState = ({
  messages,
  summary,
  summaryModelId,
}: {
  messages: ChatMessage[]
  summary: string
  summaryModelId?: string
}): ChatConversationCompaction | null => {
  const trigger = findCompactTrigger(messages)
  if (!trigger) {
    return null
  }

  return {
    anchorMessageId: trigger.anchorMessageId,
    triggerToolCallId: trigger.triggerToolCallId,
    summary,
    compactedAt: Date.now(),
    summaryModelId,
  }
}

export const buildManualCompactionState = ({
  messages,
  summary,
  summaryModelId,
}: {
  messages: ChatMessage[]
  summary: string
  summaryModelId?: string
}): ChatConversationCompaction | null => {
  const anchorMessageId = messages.at(-1)?.id
  if (!anchorMessageId) {
    return null
  }

  return {
    anchorMessageId,
    summary,
    compactedAt: Date.now(),
    summaryModelId,
  }
}

export const getCompactionSummarySourceMessages = (
  messages: ChatMessage[],
  options?: {
    retainLatestToolBoundary?: boolean
  },
): ChatMessage[] => {
  if (options?.retainLatestToolBoundary === false) {
    return messages
  }

  const trigger = findCompactTrigger(messages)
  if (!trigger) {
    return messages
  }

  return messages.slice(0, trigger.retainedStartIndex)
}

const stringifyUserMessage = (message: ChatUserMessage): string => {
  const text = message.promptContent
    ? typeof message.promptContent === 'string'
      ? message.promptContent
      : message.promptContent
          .map((part) => (part.type === 'text' ? part.text : '[image]'))
          .join('\n')
    : message.content
      ? editorStateToPlainText(message.content)
      : ''

  return text.trim().length > 0 ? text.trim() : '[empty user message]'
}

const stringifyAssistantMessage = (message: ChatAssistantMessage): string => {
  const parts: string[] = []
  if (message.content.trim().length > 0) {
    parts.push(message.content.trim())
  }
  if ((message.toolCallRequests?.length ?? 0) > 0) {
    parts.push(
      `Tool calls:\n${message.toolCallRequests
        ?.map((toolCall) => `- ${toolCall.name} (${toolCall.id})`)
        .join('\n')}`,
    )
  }
  return parts.join('\n\n').trim() || '[empty assistant message]'
}

const stringifyToolMessage = (message: ChatToolMessage): string => {
  return message.toolCalls
    .map((toolCall) => {
      const outcome =
        toolCall.response.status === ToolCallResponseStatus.Success
          ? toolCall.response.data.text
          : toolCall.response.status === ToolCallResponseStatus.Error
            ? `Error: ${toolCall.response.error}`
            : toolCall.response.status
      return `Tool ${toolCall.request.name} (${toolCall.request.id})\n${outcome}`
    })
    .join('\n\n')
}

const buildCompactionTranscript = (messages: ChatMessage[]): string => {
  return messages
    .map((message) => {
      switch (message.role) {
        case 'user':
          return `## User\n${stringifyUserMessage(message)}`
        case 'assistant':
          return `## Assistant\n${stringifyAssistantMessage(message)}`
        case 'tool':
          return `## Tool\n${stringifyToolMessage(message)}`
        default:
          return ''
      }
    })
    .join('\n\n')
}

export const createConversationCompactionSummary = async ({
  providerClient,
  model,
  messages,
  retainLatestToolBoundary,
}: {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  messages: ChatMessage[]
  retainLatestToolBoundary?: boolean
}): Promise<string> => {
  const source = getCompactionSummarySourceMessages(messages, {
    retainLatestToolBoundary,
  })
  const transcript = buildCompactionTranscript(source)

  console.debug('[YOLO][Compact] starting summary generation', {
    modelId: model.id,
    messageCount: source.length,
    transcriptLength: transcript.length,
  })

  const response = await executeSingleTurn({
    providerClient,
    model,
    request: {
      model: model.model,
      messages: [
        { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `<conversation_transcript>\n${transcript}\n</conversation_transcript>`,
        },
      ],
    },
    stream: false,
  })

  const summary = response.content.trim()

  console.debug('[YOLO][Compact] summary generation completed', {
    modelId: model.id,
    summaryLength: summary.length,
    summary,
  })

  return summary
}
