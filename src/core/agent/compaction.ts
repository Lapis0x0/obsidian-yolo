import {
  type ChatAssistantMessage,
  type ChatConversationCompaction,
  type ChatConversationCompactionState,
  type ChatMessage,
  type ChatToolMessage,
  getLatestChatConversationCompaction,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
import type { LLMProvider } from '../../types/provider.types'
import type { ReasoningLevel } from '../../types/reasoning'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

import {
  type LoadedDeferredToolSchema,
  extractLoadedDeferredToolNames,
  extractLoadedDeferredToolSchemas,
} from './tool-disclosure'

export const CONTEXT_COMPACT_TOOL_NAME = 'context_compact'

/**
 * Per-schema token ceiling for the compaction registry. Schemas bigger than
 * this are intentionally dropped — they bloat every post-compaction request,
 * and the model can always re-disclose them via `load_tool_schemas`. The injected
 * prompt in `requestContextBuilder` tells the model about this fallback.
 */
const LOADED_DEFERRED_TOOL_SCHEMA_TOKEN_LIMIT = 2000

const filterPersistableLoadedDeferredToolSchemas = async (
  schemas: LoadedDeferredToolSchema[],
): Promise<LoadedDeferredToolSchema[]> => {
  const survivors: LoadedDeferredToolSchema[] = []
  for (const schema of schemas) {
    let tokens: number
    try {
      tokens = await estimateJsonTokens(schema)
    } catch (error) {
      console.warn(
        '[YOLO][Compact] failed to estimate schema tokens; dropping',
        schema.name,
        error,
      )
      continue
    }
    if (tokens <= LOADED_DEFERRED_TOOL_SCHEMA_TOKEN_LIMIT) {
      survivors.push(schema)
    } else {
      console.debug(
        '[YOLO][Compact] dropping oversized on-demand tool schema from compaction registry',
        { name: schema.name, tokens },
      )
    }
  }
  return survivors
}

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
    autoContextCompactionEnabled:
      chatOptions.autoContextCompactionEnabled ?? false,
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
  maxContextTokens: number | undefined
  compactionState: ChatConversationCompactionState
  isConversationRunActive: boolean
}

export type LatestAssistantContextUsage = {
  assistantMessage: ChatAssistantMessage
  promptTokens: number
  maxContextTokens: number | null
  ratio: number | null
}

export const getLatestAssistantContextUsage = ({
  messages,
  maxContextTokens,
}: {
  messages: ChatMessage[]
  maxContextTokens: number | undefined
}): LatestAssistantContextUsage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }

    const promptTokens = message.metadata?.usage?.prompt_tokens
    if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens)) {
      continue
    }

    const resolvedMaxContextTokens =
      typeof maxContextTokens === 'number' &&
      maxContextTokens > 0 &&
      Number.isFinite(maxContextTokens)
        ? maxContextTokens
        : null

    return {
      assistantMessage: message,
      promptTokens,
      maxContextTokens: resolvedMaxContextTokens,
      ratio:
        resolvedMaxContextTokens === null
          ? null
          : promptTokens / resolvedMaxContextTokens,
    }
  }

  return null
}

/**
 * Whether to run automatic compaction before submitting the new user message.
 * `previousMessages` must be the transcript *before* the new user turn (excludes the pending user message).
 */
export const shouldTriggerAutoContextCompaction = ({
  previousMessages,
  chatOptions,
  maxContextTokens,
  compactionState,
  isConversationRunActive,
}: ShouldTriggerAutoContextCompactionInput): boolean => {
  if (!chatOptions.autoContextCompactionEnabled) {
    return false
  }

  if (isConversationRunActive) {
    return false
  }

  const latestContextUsage = getLatestAssistantContextUsage({
    messages: previousMessages,
    maxContextTokens,
  })
  if (!latestContextUsage) {
    return false
  }

  const { assistantMessage, promptTokens, ratio } = latestContextUsage

  const latestCompaction = getLatestChatConversationCompaction(compactionState)
  if (latestCompaction?.anchorMessageId === assistantMessage.id) {
    return false
  }

  if (chatOptions.autoContextCompactionThresholdMode === 'tokens') {
    return promptTokens >= chatOptions.autoContextCompactionThresholdTokens
  }

  if (ratio === null) {
    return false
  }

  return ratio >= chatOptions.autoContextCompactionThresholdRatio
}

const parseCompactOperationResult = (
  text: string,
): {
  tool: string
  toolCallId: string | null
  operation: string
  instruction: string | null
} | null => {
  try {
    const parsed = JSON.parse(text) as {
      tool?: unknown
      toolCallId?: unknown
      operation?: unknown
      instruction?: unknown
    }
    return typeof parsed.tool === 'string' &&
      parsed.tool === CONTEXT_COMPACT_TOOL_NAME
      ? {
          tool: parsed.tool,
          toolCallId:
            typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null,
          operation:
            typeof parsed.operation === 'string' ? parsed.operation : '',
          instruction:
            typeof parsed.instruction === 'string' &&
            parsed.instruction.trim().length > 0
              ? parsed.instruction.trim()
              : null,
        }
      : null
  } catch {
    return null
  }
}

/**
 * Extract the optional `instruction` focus hint from a compaction tool result.
 * Returns null when the tool call is not a successful `compact_restart`.
 */
export const findCompactInstruction = (
  toolMessage: ChatToolMessage,
): string | null => {
  for (const toolCall of toolMessage.toolCalls) {
    if (toolCall.response.status !== ToolCallResponseStatus.Success) {
      continue
    }
    const parsed = parseCompactOperationResult(toolCall.response.data.text)
    if (parsed?.operation === 'compact_restart') {
      return parsed.instruction
    }
  }
  return null
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

export const getLastAssistantPromptTokens = (
  messages: ChatMessage[],
): number | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'assistant') {
      continue
    }
    const tokens = message.metadata?.usage?.prompt_tokens
    return typeof tokens === 'number' && tokens > 0 ? tokens : null
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

export const buildCompactedConversationState = async ({
  messages,
  summary,
  summaryModelId,
}: {
  messages: ChatMessage[]
  summary: string
  summaryModelId?: string
}): Promise<ChatConversationCompaction | null> => {
  const trigger = findCompactTrigger(messages)
  if (!trigger) {
    return null
  }

  const loadedDeferredToolNames = [
    ...extractLoadedDeferredToolNames({ messages }),
  ].sort()
  const loadedDeferredToolSchemas =
    await filterPersistableLoadedDeferredToolSchemas(
      extractLoadedDeferredToolSchemas({ messages }),
    )

  return {
    anchorMessageId: trigger.anchorMessageId,
    triggerToolCallId: trigger.triggerToolCallId,
    summary,
    compactedAt: Date.now(),
    summaryModelId,
    compactedMessageCount: trigger.retainedStartIndex,
    ...(loadedDeferredToolNames.length > 0 ? { loadedDeferredToolNames } : {}),
    ...(loadedDeferredToolSchemas.length > 0
      ? { loadedDeferredToolSchemas }
      : {}),
  }
}

export const buildManualCompactionState = async ({
  messages,
  summary,
  summaryModelId,
}: {
  messages: ChatMessage[]
  summary: string
  summaryModelId?: string
}): Promise<ChatConversationCompaction | null> => {
  const anchorMessageId = messages.at(-1)?.id
  if (!anchorMessageId) {
    return null
  }

  const loadedDeferredToolNames = [
    ...extractLoadedDeferredToolNames({ messages }),
  ].sort()
  const loadedDeferredToolSchemas =
    await filterPersistableLoadedDeferredToolSchemas(
      extractLoadedDeferredToolSchemas({ messages }),
    )

  return {
    anchorMessageId,
    summary,
    compactedAt: Date.now(),
    summaryModelId,
    compactedMessageCount: messages.length,
    ...(loadedDeferredToolNames.length > 0 ? { loadedDeferredToolNames } : {}),
    ...(loadedDeferredToolSchemas.length > 0
      ? { loadedDeferredToolSchemas }
      : {}),
  }
}

/**
 * Build the structured compaction instruction appended after the cache-warm
 * prefix. The model is told to pause the task and emit a fixed-section summary
 * wrapped in `<summary>`. Only model-facing instructions live here.
 */
const buildCompactionInstructionMessage = (
  focusInstruction: string | null,
): RequestMessage => {
  const focusBlock = focusInstruction
    ? `\n<focus_instruction>${focusInstruction}</focus_instruction>\n`
    : ''
  return {
    role: 'user',
    content: `CRITICAL: You are now in COMPACTION MODE. The task above is paused.
- Do NOT continue the task. Do NOT call any tools — tool calls are rejected.
- Respond with PLAIN TEXT ONLY: a <summary> block with the fixed sections below.
- Write in the same language the conversation is currently using.
- Summarize only the CONVERSATION facts needed to resume. Ignore the system
  prompt, tool schemas, and tool-disclosure boilerplate — do not summarize them.

Produce a high-signal summary that loses nothing needed to resume. Sections:

1. 当前目标 (Current Goal) — 用户最新的显式意图，逐字引用关键句。
2. 已做决策与理由 (Decisions & Rationale) — 拍板了什么、为什么。
3. 尝试与失败记录 (Trial & Error Log) — 每个试过的方案 + 失败/放弃的具体原因。不得省略。
4. 所有 user 消息 (All User Messages) — 按时间逐字列出全部非 tool-result 的 user 消息，原文保留，尤其中途的更正、偏好覆盖、意图变化。
5. 关键实体 (Key Entities) — 文件路径、版本号、ID、关键工具结果，精确。
6. 已完成工作 (Work Completed)
7. 未解决项 (Unresolved) — 悬而未决、待确认、已知风险。
8. 下一步 (Next Step) — 与最近显式请求直接对齐；附最近对话的逐字引用以防漂移。
${focusBlock}
Output format: <summary> ... </summary>`,
  }
}

const SUMMARY_TAG_RE = /<summary>([\s\S]*?)<\/summary>/i

/**
 * Extract the `<summary>...</summary>` body. When the model omits the tags,
 * fall back to the trimmed full text — this is parse robustness, not a degraded
 * business path.
 */
const parseSummaryFromResponse = (content: string): string => {
  const match = SUMMARY_TAG_RE.exec(content)
  if (match && match[1]) {
    return match[1].trim()
  }
  return content.trim()
}

/**
 * Generate a compaction summary by letting the MAIN model self-summarize on top
 * of its cache-warm prefix.
 *
 * - `requestMessages` is the provider-ready prefix the main line just sent
 *   (path 1) or a freshly rebuilt prefix (paths 2/3). It is forwarded
 *   byte-for-byte so the out-of-band request hits the same provider cache.
 * - `turnMessages` are the in-flight assistant+tool messages of the triggering
 *   turn (path 1 only); empty for paths 2/3.
 * - `focusInstruction` is the `context_compact` tool's `instruction` hint.
 *
 * Uses `purpose: 'standard'` (NOT auxiliary — that strips provider features and
 * breaks prefix parity) and forwards the same `tools` with `tool_choice: 'none'`
 * so the tools block stays in the cache prefix while tool calls are forbidden.
 */
export const createConversationCompactionSummary = async ({
  providerClient,
  model,
  requestMessages,
  turnMessages = [],
  focusInstruction = null,
  tools,
  reasoningLevel,
  debugTraceId,
}: {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  requestMessages: RequestMessage[]
  turnMessages?: RequestMessage[]
  focusInstruction?: string | null
  tools?: RequestTool[]
  reasoningLevel?: ReasoningLevel
  debugTraceId?: string
}): Promise<string> => {
  const messages: RequestMessage[] = [
    ...requestMessages,
    ...turnMessages,
    buildCompactionInstructionMessage(focusInstruction),
  ]

  console.debug('[YOLO][Compact] starting summary generation', {
    modelId: model.id,
    prefixMessageCount: requestMessages.length,
    turnMessageCount: turnMessages.length,
    hasFocusInstruction: focusInstruction !== null,
  })

  const runCompaction = async (): Promise<string> => {
    const response = await executeSingleTurn({
      providerClient,
      model,
      request: {
        model: model.model,
        messages,
        ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
      },
      tools,
      // Keep the tools block in the cache prefix but forbid calls. Only sent
      // when tools exist — some providers reject tool_choice without tools.
      tool_choice: tools && tools.length > 0 ? 'none' : undefined,
      stream: false,
      purpose: 'standard',
      debugTraceId,
    })

    // Several providers (Gemini, OpenAI-compatible via extra_body, Bedrock) do
    // not honor tool_choice:'none'. Rather than depend on it, accept any
    // non-empty summary text and ignore stray tool calls; only empty fails.
    const summary = parseSummaryFromResponse(response.content)
    if (summary.length === 0) {
      throw new Error('[YOLO][Compact] model returned an empty summary')
    }
    return summary
  }

  let summary: string
  try {
    summary = await runCompaction()
  } catch (firstError) {
    console.warn(
      '[YOLO][Compact] summary generation failed; retrying once',
      firstError,
    )
    try {
      summary = await runCompaction()
    } catch (secondError) {
      const firstMsg =
        firstError instanceof Error ? firstError.message : String(firstError)
      const secondMsg =
        secondError instanceof Error ? secondError.message : String(secondError)
      throw new Error(
        `[YOLO][Compact] summary generation failed after retry. first: ${firstMsg}; second: ${secondMsg}`,
      )
    }
  }

  console.debug('[YOLO][Compact] summary generation completed', {
    modelId: model.id,
    summaryLength: summary.length,
    summary,
  })

  return summary
}
