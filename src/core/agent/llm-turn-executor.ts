import { TFile } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import {
  ReasoningLevel,
  reasoningLevelToConfig,
} from '../../components/chat-view/chat-input/ReasoningSelect'
import {
  ChatAssistantMessage,
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { RequestMessage, RequestTool } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'
import { ToolCallRequest } from '../../types/tool-call.types'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import {
  estimateJsonTokens,
  formatTokenCount,
} from '../../utils/llm/contextTokenEstimate'
import { executeSingleTurn } from '../ai/single-turn'
import { BaseLLMProvider } from '../llm/base'
import {
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'

import { CONTEXT_COMPACT_TOOL_NAME } from './compaction'

type AgentLlmTurnExecutorInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  conversationId: string
  messages: ChatMessage[]
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
  private static readonly LOCAL_MEMORY_TOOL_NAMES = new Set([
    'memory_ops',
    'memory_add',
    'memory_update',
    'memory_delete',
  ])

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

  private readonly allowedToolNames?: Set<string>
  private readonly allowedSkillIds?: Set<string>
  private readonly allowedSkillNames?: Set<string>

  constructor(private readonly input: AgentLlmTurnExecutorInput) {
    this.allowedToolNames = input.allowedToolNames
      ? this.expandAllowedToolNames(input.allowedToolNames)
      : undefined
    this.allowedSkillIds = input.allowedSkillIds
      ? new Set(input.allowedSkillIds.map((id) => id.toLowerCase()))
      : undefined
    this.allowedSkillNames = input.allowedSkillNames
      ? new Set(input.allowedSkillNames.map((name) => name.toLowerCase()))
      : undefined
  }

  private expandAllowedToolNames(toolNames: string[]): Set<string> {
    const expanded = new Set<string>(toolNames)
    const localServer = getLocalFileToolServerName()
    const localFileOpsTool = `${localServer}${McpManager.TOOL_NAME_DELIMITER}fs_file_ops`
    const localMemoryOpsTool = `${localServer}${McpManager.TOOL_NAME_DELIMITER}memory_ops`
    const hasFileOpsGroup =
      expanded.has(localFileOpsTool) || expanded.has('fs_file_ops')
    const hasMemoryOpsGroup =
      expanded.has(localMemoryOpsTool) || expanded.has('memory_ops')

    if (!hasFileOpsGroup && !hasMemoryOpsGroup) {
      return expanded
    }

    if (hasFileOpsGroup) {
      for (const splitToolName of LOCAL_FS_SPLIT_ACTION_TOOL_NAMES) {
        expanded.add(
          `${localServer}${McpManager.TOOL_NAME_DELIMITER}${splitToolName}`,
        )
        expanded.add(splitToolName)
      }
    }

    if (hasMemoryOpsGroup) {
      for (const splitToolName of LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES) {
        expanded.add(
          `${localServer}${McpManager.TOOL_NAME_DELIMITER}${splitToolName}`,
        )
        expanded.add(splitToolName)
      }
    }
    return expanded
  }

  async run(): Promise<AgentLlmTurnExecutorOutput> {
    const availableTools = this.input.enableTools
      ? await this.input.mcpManager.listAvailableTools({
          includeBuiltinTools: this.input.includeBuiltinTools,
        })
      : []
    const filteredTools = availableTools.filter((tool) =>
      this.isToolAllowed(tool.name),
    )

    const hasTools = filteredTools.length > 0
    const hasMemoryTools = filteredTools.some((tool) =>
      this.isMemoryToolAvailable(tool.name),
    )
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

    const tools: RequestTool[] | undefined =
      filteredTools.length > 0
        ? filteredTools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                ...tool.inputSchema,
                properties: tool.inputSchema.properties ?? {},
              },
            },
          }))
        : undefined
    this.logModelRequestContext({ requestMessages, tools })
    const responseStart = Date.now()
    const effectiveModel = this.getEffectiveModel()
    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: uuidv4(),
      content: '',
      metadata: {
        model: effectiveModel,
        generationState: 'streaming',
      },
    }
    this.input.onAssistantMessage(assistantMessage)

    let turnResult: Awaited<ReturnType<typeof executeSingleTurn>>
    try {
      turnResult = await executeSingleTurn({
        providerClient: this.input.providerClient,
        model: effectiveModel,
        request: {
          model: effectiveModel.model,
          messages: requestMessages,
          temperature: this.input.requestParams?.temperature,
          top_p: this.input.requestParams?.top_p,
          max_tokens: this.input.requestParams?.max_tokens,
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

      assistantMessage.metadata = {
        ...assistantMessage.metadata,
        durationMs: Date.now() - responseStart,
        generationState: isAborted ? 'aborted' : 'error',
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
      usage: turnResult.usage,
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

  private isToolAllowed(toolName: string): boolean {
    if (this.isOpenSkillToolName(toolName)) {
      const hasAllowedSkills =
        (this.allowedSkillIds?.size ?? 0) > 0 ||
        (this.allowedSkillNames?.size ?? 0) > 0
      if (!hasAllowedSkills) {
        return false
      }
    }

    if (!this.allowedToolNames) {
      return true
    }
    return this.allowedToolNames.has(toolName)
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
    const effectiveModel = this.getEffectiveModel()

    console.debug(
      `[YOLO][Agent Debug] request context ${formatTokenCount(estimatedTokens)} tokens`,
    )
    console.debug('[YOLO][Agent Debug] Summary', {
      conversationId: this.input.conversationId,
      modelId: effectiveModel.id,
      providerId: effectiveModel.providerId,
      messageCount: requestMessages.length,
      toolCount: tools?.length ?? 0,
      estimatedTokens,
    })
    console.debug('[YOLO][Agent Debug] Request messages', requestMessages)
    console.debug('[YOLO][Agent Debug] Tools', tools ?? [])
  }

  private isMemoryToolAvailable(toolName: string): boolean {
    try {
      const parsed = parseToolName(toolName)
      return (
        parsed.serverName === getLocalFileToolServerName() &&
        AgentLlmTurnExecutor.LOCAL_MEMORY_TOOL_NAMES.has(parsed.toolName)
      )
    } catch {
      return AgentLlmTurnExecutor.LOCAL_MEMORY_TOOL_NAMES.has(toolName)
    }
  }

  private isOpenSkillToolName(toolName: string): boolean {
    try {
      const parsed = parseToolName(toolName)
      return (
        parsed.serverName === getLocalFileToolServerName() &&
        parsed.toolName === 'open_skill'
      )
    } catch {
      return false
    }
  }

  private getEffectiveModel(): ChatModel {
    if (!this.input.reasoningLevel) {
      return this.input.model
    }

    return {
      ...this.input.model,
      ...reasoningLevelToConfig(this.input.reasoningLevel, this.input.model),
    } as ChatModel
  }
}
