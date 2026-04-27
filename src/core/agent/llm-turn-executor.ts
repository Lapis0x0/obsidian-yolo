import { TFile } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import {
  ChatAssistantMessage,
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { RequestMessage, RequestTool } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'
import {
  ReasoningLevel,
  resolveRequestReasoningLevel,
} from '../../types/reasoning'
import { ToolCallRequest } from '../../types/tool-call.types'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import {
  estimateJsonTokens,
  formatTokenCount,
} from '../../utils/llm/contextTokenEstimate'
import { executeSingleTurn } from '../ai/single-turn'
import { BaseLLMProvider } from '../llm/base'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'

import { CONTEXT_COMPACT_TOOL_NAME } from './compaction'
import { selectAllowedTools } from './tool-selection'

type AgentLlmTurnExecutorInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  conversationId: string
  messages: ChatMessage[]
  branchId?: string
  sourceUserMessageId?: string
  branchLabel?: string
  compaction?: ChatConversationCompactionLike | null
  enableTools: boolean
  includeBuiltinTools: boolean
  allowedToolNames?: string[]
  allowedSkillIds?: string[]
  allowedSkillNames?: string[]
  abortSignal?: AbortSignal
  reasoningLevel?: ReasoningLevel
  requestParams?: {
    stream?: boolean
    temperature?: number
    top_p?: number
    max_tokens?: number
    primaryRequestTimeoutMs?: number
    streamFallbackRecoveryEnabled?: boolean
  }
  maxContextOverride?: number
  currentFileContextMode?: 'full' | 'summary'
  currentFileOverride?: TFile | null
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  onAssistantMessage: (message: ChatAssistantMessage) => void
}

type AgentLlmTurnExecutorOutput = {
  assistantMessage: ChatAssistantMessage
  toolCallRequests: ToolCallRequest[]
  hasAssistantOutput: boolean
}

export class AgentLlmTurnExecutor {
  private static readonly LOCAL_TOOL_NAMES = new Set([
    'fs_list',
    'fs_search',
    'fs_read',
    'context_prune_tool_results',
    CONTEXT_COMPACT_TOOL_NAME,
    'fs_edit',
    'fs_create_file',
    'fs_delete_file',
    'fs_create_dir',
    'fs_delete_dir',
    'fs_move',
    'memory_add',
    'memory_update',
    'memory_delete',
    'open_skill',
  ])

  constructor(private readonly input: AgentLlmTurnExecutorInput) {}

  async run(): Promise<AgentLlmTurnExecutorOutput> {
    const availableTools = this.input.enableTools
      ? await this.input.mcpManager.listAvailableTools({
          includeBuiltinTools: this.input.includeBuiltinTools,
        })
      : []
    const {
      hasTools,
      hasMemoryTools,
      requestTools: tools,
    } = selectAllowedTools({
      availableTools,
      allowedToolNames: this.input.allowedToolNames,
      allowedSkillIds: this.input.allowedSkillIds,
      allowedSkillNames: this.input.allowedSkillNames,
    })
    const requestMessages =
      await this.input.requestContextBuilder.generateRequestMessages({
        messages: this.input.messages,
        hasTools,
        hasMemoryTools,
        maxContextOverride: this.input.maxContextOverride,
        model: this.input.model,
        conversationId: this.input.conversationId,
        compaction: this.input.compaction,
        currentFileContextMode: this.input.currentFileContextMode,
        currentFileOverride: this.input.currentFileOverride,
      })

    this.logModelRequestContext({ requestMessages, tools })
    const responseStart = Date.now()
    const model = this.input.model
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: uuidv4(),
      content: '',
      metadata: {
        model,
        generationState: 'streaming',
        branchConversationId: this.input.conversationId,
        sourceUserMessageId: this.input.sourceUserMessageId,
        branchId: this.input.branchId,
        branchModelId: model.id,
        branchLabel:
          this.input.branchLabel ?? model.name ?? model.model ?? model.id,
      },
    }
    this.input.onAssistantMessage(assistantMessage)

    let turnResult: Awaited<ReturnType<typeof executeSingleTurn>>
    try {
      const resolvedReasoning = resolveRequestReasoningLevel(
        this.input.model,
        this.input.reasoningLevel,
      )
      turnResult = await executeSingleTurn({
        providerClient: this.input.providerClient,
        model: this.input.model,
        request: {
          model: this.input.model.model,
          messages: requestMessages,
          temperature: this.input.requestParams?.temperature,
          top_p: this.input.requestParams?.top_p,
          max_tokens: this.input.requestParams?.max_tokens,
          ...(resolvedReasoning !== undefined
            ? { reasoningLevel: resolvedReasoning }
            : {}),
        },
        tools,
        signal: this.input.abortSignal,
        stream: this.input.requestParams?.stream ?? true,
        primaryRequestTimeoutMs:
          this.input.requestParams?.primaryRequestTimeoutMs,
        streamFallbackRecoveryEnabled:
          this.input.requestParams?.streamFallbackRecoveryEnabled,
        geminiTools: this.input.geminiTools,
        onStreamDelta: ({ contentDelta, reasoningDelta, chunk, toolCalls }) => {
          if (contentDelta) {
            assistantMessage.content += contentDelta
          }
          if (reasoningDelta) {
            assistantMessage.reasoning = `${assistantMessage.reasoning ?? ''}${reasoningDelta}`
          }
          if (toolCalls && toolCalls.length > 0) {
            const streamedToolCallRequests = toolCalls
              .map((toolCall) => {
                const name = toolCall.function?.name?.trim()
                if (!name) {
                  return null
                }

                const normalizedName = this.normalizeToolCallName(name)

                return {
                  id:
                    toolCall.id ??
                    `${assistantMessage.id}-stream-tool-${toolCall.index}`,
                  name: normalizedName,
                  arguments: toolCall.function?.arguments,
                  metadata: toolCall.metadata,
                }
              })
              .filter((toolCall): toolCall is NonNullable<typeof toolCall> =>
                Boolean(toolCall),
              )

            if (streamedToolCallRequests.length > 0) {
              assistantMessage.toolCallRequests = streamedToolCallRequests
            }
          }
          if (chunk.usage) {
            assistantMessage.metadata = {
              ...assistantMessage.metadata,
              usage: chunk.usage,
            }
          }
          if (chunk.choices?.[0]?.delta?.providerMetadata) {
            assistantMessage.metadata = {
              ...assistantMessage.metadata,
              providerMetadata: chunk.choices[0].delta.providerMetadata,
            }
          }
          this.input.onAssistantMessage(assistantMessage)
        },
      })
    } catch (error) {
      const isAborted =
        this.input.abortSignal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      const errorMessage = isAborted
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error ?? 'Unknown error')

      assistantMessage.metadata = {
        ...assistantMessage.metadata,
        durationMs: Date.now() - responseStart,
        generationState: isAborted ? 'aborted' : 'error',
        errorMessage,
      }
      this.input.onAssistantMessage(assistantMessage)
      throw error
    }

    if (!this.input.requestParams?.stream) {
      assistantMessage.content = turnResult.content
      assistantMessage.reasoning = turnResult.reasoning
    } else if (!assistantMessage.content && turnResult.content) {
      assistantMessage.content = turnResult.content
    }

    assistantMessage.annotations = turnResult.annotations
    assistantMessage.metadata = {
      ...assistantMessage.metadata,
      usage: turnResult.usage ?? assistantMessage.metadata?.usage,
      durationMs: Date.now() - responseStart,
      generationState: this.input.abortSignal?.aborted
        ? 'aborted'
        : 'completed',
      providerMetadata: turnResult.providerMetadata,
    }

    const toolCallRequests = turnResult.toolCalls.map((toolCall) => ({
      id: toolCall.id ?? uuidv4(),
      name: this.normalizeToolCallName(toolCall.name),
      arguments: toolCall.arguments,
      metadata: toolCall.metadata,
    }))

    assistantMessage.toolCallRequests =
      toolCallRequests.length > 0 ? toolCallRequests : undefined
    this.input.onAssistantMessage(assistantMessage)

    return {
      assistantMessage,
      toolCallRequests,
      hasAssistantOutput: assistantMessage.content.trim().length > 0,
    }
  }

  private normalizeToolCallName(toolName: string): string {
    if (toolName.includes(McpManager.TOOL_NAME_DELIMITER)) {
      return toolName
    }
    if (!AgentLlmTurnExecutor.LOCAL_TOOL_NAMES.has(toolName)) {
      return toolName
    }
    return `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${toolName}`
  }

  private logModelRequestContext({
    requestMessages,
    tools,
  }: {
    requestMessages: RequestMessage[]
    tools: RequestTool[] | undefined
  }): void {
    if (
      !this.input.requestContextBuilder.isModelRequestContextLoggingEnabled?.()
    ) {
      return
    }

    const estimatedTokens = estimateJsonTokens({
      messages: requestMessages,
      tools,
    })
    const model = this.input.model

    console.debug(
      `[YOLO][Agent Debug] request context ${formatTokenCount(estimatedTokens)} tokens`,
    )
    console.debug('[YOLO][Agent Debug] Summary', {
      conversationId: this.input.conversationId,
      modelId: model.id,
      providerId: model.providerId,
      messageCount: requestMessages.length,
      toolCount: tools?.length ?? 0,
      estimatedTokens,
    })
    console.debug('[YOLO][Agent Debug] Request messages', requestMessages)
    console.debug('[YOLO][Agent Debug] Tools', tools ?? [])
  }
}
