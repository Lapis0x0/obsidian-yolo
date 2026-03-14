import { TFile } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import {
  ReasoningLevel,
  reasoningLevelToConfig,
} from '../../components/chat-view/chat-input/ReasoningSelect'
import { ChatAssistantMessage, ChatMessage } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { RequestTool } from '../../types/llm/request'
import { LLMProvider } from '../../types/provider.types'
import { ToolCallRequest } from '../../types/tool-call.types'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { executeSingleTurn } from '../ai/single-turn'
import { BaseLLMProvider } from '../llm/base'
import {
  getLocalFileToolServerName,
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'

type AgentLlmTurnExecutorInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  promptGenerator: PromptGenerator
  mcpManager: McpManager
  conversationId: string
  messages: ChatMessage[]
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
    'fs_edit',
    'fs_create_file',
    'fs_delete_file',
    'fs_create_dir',
    'fs_delete_dir',
    'fs_move',
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
    if (!expanded.has(localFileOpsTool) && !expanded.has('fs_file_ops')) {
      return expanded
    }

    for (const splitToolName of LOCAL_FS_SPLIT_ACTION_TOOL_NAMES) {
      expanded.add(
        `${localServer}${McpManager.TOOL_NAME_DELIMITER}${splitToolName}`,
      )
      expanded.add(splitToolName)
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
    const requestMessages =
      await this.input.promptGenerator.generateRequestMessages({
        messages: this.input.messages,
        hasTools,
        maxContextOverride: this.input.maxContextOverride,
        model: this.input.model,
        conversationId: this.input.conversationId,
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

    const turnResult = await executeSingleTurn({
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
        this.input.onAssistantMessage(assistantMessage)
      },
    })

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
      hasAssistantOutput:
        assistantMessage.content.trim().length > 0 ||
        (assistantMessage.reasoning?.trim().length ?? 0) > 0,
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
