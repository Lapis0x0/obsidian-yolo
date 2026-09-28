import type { YoloSettings } from '../../settings/schema/setting.types'
import {
  type ChatAssistantMessage,
  type ChatConversationCompaction,
  type ChatConversationCompactionState,
  type ChatMessage,
  type ChatToolMessage,
  getCompactionRetainedStartIndex,
  getLatestChatConversationCompaction,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { RequestMessage, RequestTool } from '../../types/llm/request'
import type { LLMProvider } from '../../types/provider.types'
import type { ReasoningLevel } from '../../types/reasoning'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import {
  ESTIMATED_IMAGE_TOKENS,
  estimateJsonTokens,
  normalizeJsonValue,
} from '../../utils/llm/contextTokenEstimate'
import { resolveEffectiveMaxContextTokens } from '../../utils/llm/model-capability-registry'
import {
  providerOwnsConversationContext,
  resolveChatModelProvider,
} from '../../utils/llm/provider-config'
import { isRequestErrorNonRetryable } from '../ai/requestRetry'
import { executeSingleTurn } from '../ai/single-turn'
import type { BaseLLMProvider } from '../llm/base'

import {
  type LoadedDeferredToolSchema,
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

/**
 * Context window assumed when neither the model config nor the known-model
 * registry states one. Practically every current model offers at least this.
 */
const ASSUMED_CONTEXT_WINDOW_TOKENS = 200_000
const DEFAULT_AUTO_CONTEXT_COMPACTION_RATIO = 0.9

/**
 * Runtime input for forced compaction: before each LLM request the runtime
 * compacts once the estimated request size reaches `thresholdTokens`.
 */
export type AutoContextCompactionInput = {
  thresholdTokens: number
}

/**
 * Resolve forced compaction for one model from current settings. Undefined
 * when the user turned it off, or when the provider keeps the conversation in
 * its own session — the messages YOLO would compact are then only a copy, and
 * the context that fills up is out of reach.
 */
export const resolveAutoContextCompactionInput = ({
  settings,
  model,
}: {
  settings: Pick<YoloSettings, 'chatOptions' | 'providers'>
  model: ChatModel
}): AutoContextCompactionInput | undefined => {
  if (!(settings.chatOptions.autoContextCompactionEnabled ?? true)) {
    return undefined
  }
  const provider = resolveChatModelProvider(settings, model)
  if (provider && providerOwnsConversationContext(provider)) {
    return undefined
  }
  const ratio =
    settings.chatOptions.autoContextCompactionThresholdRatio ??
    DEFAULT_AUTO_CONTEXT_COMPACTION_RATIO
  const contextWindow =
    resolveEffectiveMaxContextTokens(model) ?? ASSUMED_CONTEXT_WINDOW_TOKENS
  return { thresholdTokens: Math.floor(contextWindow * ratio) }
}

export type LatestAssistantContextUsage = {
  assistantMessage: ChatAssistantMessage
  promptTokens: number
  maxContextTokens: number | null
  ratio: number | null
  cacheHitRate?: number
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

    const usage = message.metadata?.usage
    const promptTokens = usage?.prompt_tokens
    if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens)) {
      continue
    }

    const resolvedMaxContextTokens =
      typeof maxContextTokens === 'number' &&
      maxContextTokens > 0 &&
      Number.isFinite(maxContextTokens)
        ? maxContextTokens
        : null
    const cacheReadTokens = usage?.cache_read_input_tokens
    const cacheHitRate =
      typeof cacheReadTokens === 'number' &&
      Number.isFinite(cacheReadTokens) &&
      cacheReadTokens >= 0 &&
      promptTokens > 0
        ? Math.min(1, cacheReadTokens / promptTokens)
        : null

    return {
      assistantMessage: message,
      promptTokens,
      maxContextTokens: resolvedMaxContextTokens,
      ratio:
        resolvedMaxContextTokens === null
          ? null
          : promptTokens / resolvedMaxContextTokens,
      ...(cacheHitRate !== null ? { cacheHitRate } : {}),
    }
  }

  return null
}

/**
 * Rough token count without a tokenizer: ASCII at ~4 chars per token, every
 * other character (CJK and the like) as one token. It only has to tell
 * whether the next request crosses the threshold, and runs on every turn.
 */
const estimateTextTokensRoughly = (text: string): number => {
  let asciiChars = 0
  let otherChars = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 128) {
      asciiChars += 1
    } else {
      otherChars += 1
    }
  }
  return Math.ceil(asciiChars / 4) + otherChars
}

const estimateMessageTokensRoughly = (message: ChatMessage): number => {
  // A user message's editor state is display-only; the request carries its
  // compiled prompt.
  const payload = message.role === 'user' ? message.promptContent : message
  const { value, imageCount, pdfTokenEstimate } = normalizeJsonValue(payload)
  return (
    estimateTextTokensRoughly(JSON.stringify(value) ?? '') +
    imageCount * ESTIMATED_IMAGE_TOKENS +
    pdfTokenEstimate
  )
}

/**
 * Estimated size of the next request: the latest provider-reported usage
 * (input + output of that call) plus a rough count of everything appended
 * after it — tool results, injected user messages — which no provider has
 * measured yet. Usage from before the latest compaction anchor describes the
 * uncompacted context and is ignored; null when no usable report exists.
 */
export const estimateNextRequestContextTokens = ({
  messages,
  compactionState,
}: {
  messages: ChatMessage[]
  compactionState: ChatConversationCompactionState
}): number | null => {
  const latestCompaction = getLatestChatConversationCompaction(compactionState)
  const anchorIndex = latestCompaction
    ? messages.findIndex(
        (message) => message.id === latestCompaction.anchorMessageId,
      )
    : -1

  for (let index = messages.length - 1; index > anchorIndex; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }
    const usage = message.metadata?.usage
    if (
      typeof usage?.prompt_tokens !== 'number' ||
      !Number.isFinite(usage.prompt_tokens)
    ) {
      continue
    }
    const completionTokens =
      typeof usage.completion_tokens === 'number' &&
      Number.isFinite(usage.completion_tokens)
        ? usage.completion_tokens
        : 0
    return messages
      .slice(index + 1)
      .reduce(
        (total, later) => total + estimateMessageTokensRoughly(later),
        usage.prompt_tokens + completionTokens,
      )
  }

  return null
}

/**
 * Where forced compaction starts keeping messages verbatim. Mid-run that is
 * the latest assistant turn with its tool results (the working state the next
 * request continues from); at the start of a run it is the user message(s)
 * that opened it, which must reach the model unsummarized. Null when the
 * layout matches neither, or nothing new lies before it to summarize.
 */
export const findForcedCompactionRetainedStartIndex = ({
  messages,
  compactionState,
  midRun,
}: {
  messages: ChatMessage[]
  compactionState: ChatConversationCompactionState
  midRun: boolean
}): number | null => {
  let retainedStartIndex = -1
  if (midRun) {
    retainedStartIndex = messages.length - 1
    while (
      retainedStartIndex >= 0 &&
      messages[retainedStartIndex].role !== 'assistant'
    ) {
      retainedStartIndex -= 1
    }
  } else if (messages.at(-1)?.role === 'user') {
    retainedStartIndex = messages.length - 1
    while (messages[retainedStartIndex - 1]?.role === 'user') {
      retainedStartIndex -= 1
    }
  }
  if (retainedStartIndex <= 0) {
    return null
  }

  // Something must move from the verbatim part into the summary; otherwise
  // compacting again would only restate the previous summary.
  const latestCompaction = getLatestChatConversationCompaction(compactionState)
  const previousRetainedStartIndex = latestCompaction
    ? (getCompactionRetainedStartIndex(messages, latestCompaction) ?? 0)
    : 0
  return retainedStartIndex > previousRetainedStartIndex
    ? retainedStartIndex
    : null
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
Earlier parts of this conversation have been compacted.
Everything before the retained messages has been compressed into the summary below.
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
    ...(loadedDeferredToolSchemas.length > 0
      ? { loadedDeferredToolSchemas }
      : {}),
  }
}

/**
 * Compaction anchored on `messages[anchorIndex]`, the point the chat shows it
 * at. Everything before `retainedStartIndex` goes into the summary; without
 * one, everything up to the anchor does (manual compaction).
 */
export const buildAnchoredCompactionState = async ({
  messages,
  anchorIndex,
  retainedStartIndex,
  summary,
  summaryModelId,
}: {
  messages: ChatMessage[]
  anchorIndex: number
  retainedStartIndex?: number
  summary: string
  summaryModelId?: string
}): Promise<ChatConversationCompaction | null> => {
  const anchorMessageId = messages[anchorIndex]?.id
  if (!anchorMessageId) {
    return null
  }
  const retainedFromMessageId =
    retainedStartIndex !== undefined && retainedStartIndex <= anchorIndex
      ? messages[retainedStartIndex]?.id
      : undefined

  const loadedDeferredToolSchemas =
    await filterPersistableLoadedDeferredToolSchemas(
      extractLoadedDeferredToolSchemas({ messages }),
    )

  return {
    anchorMessageId,
    summary,
    compactedAt: Date.now(),
    summaryModelId,
    compactedMessageCount: retainedFromMessageId
      ? retainedStartIndex
      : anchorIndex + 1,
    ...(retainedFromMessageId ? { retainedFromMessageId } : {}),
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
const buildCompactionInstructionMessage = (): RequestMessage => {
  return {
    role: 'user',
    content: `The task above is paused for context compaction. Instead of continuing it, reply with a <summary> block in the sections below; tool calls are ignored this turn.
- Write in the language the conversation is currently using.
- Summarize only the conversation facts needed to resume, not the system prompt, tool schemas, or tool-disclosure text.

Produce a high-signal summary that loses nothing needed to resume. Sections:

1. 当前目标 (Current Goal) — 用户最新的显式意图，逐字引用关键句。
2. 已做决策与理由 (Decisions & Rationale) — 拍板了什么、为什么。
3. 尝试与失败记录 (Trial & Error Log) — 每个试过的方案 + 失败/放弃的具体原因。不得省略。
4. 所有 user 消息 (All User Messages) — 按时间逐字列出全部非 tool-result 的 user 消息，原文保留，尤其中途的更正、偏好覆盖、意图变化。
5. 关键实体 (Key Entities) — 文件路径、版本号、ID、关键工具结果，精确。
6. 已完成工作 (Work Completed)
7. 未解决项 (Unresolved) — 悬而未决、待确认、已知风险。
8. 下一步 (Next Step) — 与最近显式请求直接对齐；附最近对话的逐字引用以防漂移。

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
 *
 * Uses `purpose: 'standard'` (NOT lightweight — that strips provider features and
 * breaks prefix parity) and forwards the same `tools` with `tool_choice: 'none'`
 * so the tools block stays in the cache prefix while tool calls are forbidden.
 */
export const createConversationCompactionSummary = async ({
  providerClient,
  model,
  requestMessages,
  turnMessages = [],
  tools,
  reasoningLevel,
  debugTraceId,
}: {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  requestMessages: RequestMessage[]
  turnMessages?: RequestMessage[]
  tools?: RequestTool[]
  reasoningLevel?: ReasoningLevel
  debugTraceId?: string
}): Promise<string> => {
  const messages: RequestMessage[] = [
    ...requestMessages,
    ...turnMessages,
    buildCompactionInstructionMessage(),
  ]

  console.debug('[YOLO][Compact] starting summary generation', {
    modelId: model.id,
    prefixMessageCount: requestMessages.length,
    turnMessageCount: turnMessages.length,
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
      deliveryMode: 'buffered',
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
    if (isRequestErrorNonRetryable(firstError)) {
      throw firstError
    }
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
