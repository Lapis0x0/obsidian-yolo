import { TFile } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import {
  ReasoningLevel,
  reasoningLevelToConfig,
} from '../../components/chat-view/chat-input/ReasoningSelect'
import { ChatAssistantMessage, ChatMessage } from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { RequestTool } from '../../types/llm/request'
import {
  Annotation,
  LLMResponseStreaming,
  ToolCallDelta,
} from '../../types/llm/response'
import { LLMProvider } from '../../types/provider.types'
import { ToolCallRequest } from '../../types/tool-call.types'
import { mergeStreamingToolArguments } from '../../utils/chat/tool-arguments'
import { PromptGenerator } from '../../utils/chat/promptGenerator'
import { BaseLLMProvider } from '../llm/base'
import { McpManager } from '../mcp/mcpManager'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
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
  modelTerminated: boolean
}

export class AgentLlmTurnExecutor {
  private static readonly LOCAL_TOOL_NAMES = new Set([
    'fs_list',
    'fs_search',
    'fs_read',
    'fs_edit',
    'fs_write',
    'open_skill',
  ])

  private readonly allowedToolNames?: Set<string>
  private readonly allowedSkillIds?: Set<string>
  private readonly allowedSkillNames?: Set<string>

  constructor(private readonly input: AgentLlmTurnExecutorInput) {
    this.allowedToolNames = input.allowedToolNames
      ? new Set(input.allowedToolNames)
      : undefined
    this.allowedSkillIds = input.allowedSkillIds
      ? new Set(input.allowedSkillIds.map((id) => id.toLowerCase()))
      : undefined
    this.allowedSkillNames = input.allowedSkillNames
      ? new Set(input.allowedSkillNames.map((name) => name.toLowerCase()))
      : undefined
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

    const shouldStream = this.input.requestParams?.stream ?? true
    if (!shouldStream) {
      return this.runNonStreaming({ requestMessages, tools })
    }

    return this.runStreaming({ requestMessages, tools })
  }

  private async runNonStreaming({
    requestMessages,
    tools,
  }: {
    requestMessages: Awaited<
      ReturnType<PromptGenerator['generateRequestMessages']>
    >
    tools: RequestTool[] | undefined
  }): Promise<AgentLlmTurnExecutorOutput> {
    const responseStart = Date.now()
    const effectiveModel = this.getEffectiveModel()
    const response = await this.input.providerClient.generateResponse(
      effectiveModel,
      {
        model: effectiveModel.model,
        messages: requestMessages,
        tools,
        tool_choice: tools ? 'auto' : undefined,
        stream: false,
        temperature: this.input.requestParams?.temperature,
        top_p: this.input.requestParams?.top_p,
        max_tokens: this.input.requestParams?.max_tokens,
      },
      {
        signal: this.input.abortSignal,
        geminiTools: this.input.geminiTools,
      },
    )

    const toolCallRequests = (response.choices[0]?.message?.tool_calls ?? [])
      .map((toolCall): ToolCallRequest | null => {
        if (!toolCall.function?.name) {
          return null
        }
        const base: ToolCallRequest = {
          id: toolCall.id ?? uuidv4(),
          name: this.normalizeToolCallName(toolCall.function.name),
        }
        return toolCall.function.arguments
          ? { ...base, arguments: toolCall.function.arguments }
          : base
      })
      .filter((item): item is ToolCallRequest => item !== null)

    const assistantMessage: ChatAssistantMessage = {
      role: 'assistant',
      id: uuidv4(),
      content: response.choices[0]?.message?.content ?? '',
      annotations: response.choices[0]?.message?.annotations,
      toolCallRequests:
        toolCallRequests.length > 0 ? toolCallRequests : undefined,
      metadata: {
        model: effectiveModel,
        usage: response.usage,
        durationMs: Date.now() - responseStart,
        generationState: this.input.abortSignal?.aborted
          ? 'aborted'
          : 'completed',
      },
    }

    this.input.onAssistantMessage(assistantMessage)

    return {
      assistantMessage,
      toolCallRequests,
      modelTerminated: this.isModelTerminationFinishReason(
        response.choices[0]?.finish_reason,
      ),
    }
  }

  private async runStreaming({
    requestMessages,
    tools,
  }: {
    requestMessages: Awaited<
      ReturnType<PromptGenerator['generateRequestMessages']>
    >
    tools: RequestTool[] | undefined
  }): Promise<AgentLlmTurnExecutorOutput> {
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

    let responseToolCalls: Record<number, ToolCallDelta> = {}
    let finishReason: string | null = null
    try {
      const responseIterable = await this.input.providerClient.streamResponse(
        effectiveModel,
        {
          model: effectiveModel.model,
          messages: requestMessages,
          tools,
          tool_choice: tools ? 'auto' : undefined,
          stream: true,
          temperature: this.input.requestParams?.temperature,
          top_p: this.input.requestParams?.top_p,
          max_tokens: this.input.requestParams?.max_tokens,
        },
        {
          signal: this.input.abortSignal,
          geminiTools: this.input.geminiTools,
        },
      )

      for await (const chunk of responseIterable) {
        const chunkFinishReason = chunk.choices[0]?.finish_reason
        if (chunkFinishReason) {
          finishReason = chunkFinishReason
        }

        responseToolCalls = this.processChunk({
          chunk,
          responseToolCalls,
          assistantMessage,
        })
      }
    } catch (error) {
      const message = String(
        error instanceof Error ? error.message : String(error),
      )
      if (/protocol error|unexpected EOF|incomplete envelope/i.test(message)) {
        return this.runNonStreaming({ requestMessages, tools })
      }
      throw error
    }

    const toolCallRequests = this.buildToolCallRequests(responseToolCalls)
    assistantMessage.toolCallRequests =
      toolCallRequests.length > 0 ? toolCallRequests : undefined
    assistantMessage.metadata = {
      ...assistantMessage.metadata,
      durationMs: Date.now() - responseStart,
      generationState: this.input.abortSignal?.aborted
        ? 'aborted'
        : 'completed',
    }
    this.input.onAssistantMessage(assistantMessage)

    return {
      assistantMessage,
      toolCallRequests,
      modelTerminated: this.isModelTerminationFinishReason(finishReason),
    }
  }

  private processChunk({
    chunk,
    responseToolCalls,
    assistantMessage,
  }: {
    chunk: LLMResponseStreaming
    responseToolCalls: Record<number, ToolCallDelta>
    assistantMessage: ChatAssistantMessage
  }): Record<number, ToolCallDelta> {
    const content = chunk.choices[0]?.delta?.content ?? ''
    const reasoning = chunk.choices[0]?.delta?.reasoning
    const toolCalls = chunk.choices[0]?.delta?.tool_calls
    const annotations = chunk.choices[0]?.delta?.annotations

    const updatedToolCalls = toolCalls
      ? this.mergeToolCallDeltas(toolCalls, responseToolCalls)
      : responseToolCalls

    assistantMessage.content += content
    if (reasoning) {
      assistantMessage.reasoning = `${assistantMessage.reasoning ?? ''}${reasoning}`
    }
    assistantMessage.annotations = this.mergeAnnotations(
      assistantMessage.annotations,
      annotations,
    )
    assistantMessage.metadata = {
      ...assistantMessage.metadata,
      usage: chunk.usage ?? assistantMessage.metadata?.usage,
    }
    this.input.onAssistantMessage(assistantMessage)

    return updatedToolCalls
  }

  private mergeToolCallDeltas(
    toolCalls: ToolCallDelta[],
    existingToolCalls: Record<number, ToolCallDelta>,
  ): Record<number, ToolCallDelta> {
    const merged = { ...existingToolCalls }
    for (const toolCall of toolCalls) {
      const { index } = toolCall
      if (!merged[index]) {
        merged[index] = toolCall
        continue
      }

      const mergedToolCall: ToolCallDelta = {
        index,
        id: merged[index].id ?? toolCall.id,
        type: merged[index].type ?? toolCall.type,
      }

      if (merged[index].function || toolCall.function) {
        const existingArgs = merged[index].function?.arguments
        const newArgs = toolCall.function?.arguments
        mergedToolCall.function = {
          name: merged[index].function?.name ?? toolCall.function?.name,
          arguments: mergeStreamingToolArguments({ existingArgs, newArgs }),
        }
      }

      merged[index] = mergedToolCall
    }

    return merged
  }

  private mergeAnnotations(
    prevAnnotations?: Annotation[],
    newAnnotations?: Annotation[],
  ): Annotation[] | undefined {
    if (!prevAnnotations) {
      return newAnnotations
    }
    if (!newAnnotations) {
      return prevAnnotations
    }
    const merged = [...prevAnnotations]
    for (const incoming of newAnnotations) {
      if (
        !merged.find(
          (item) => item.url_citation.url === incoming.url_citation.url,
        )
      ) {
        merged.push(incoming)
      }
    }
    return merged
  }

  private buildToolCallRequests(
    responseToolCalls: Record<number, ToolCallDelta>,
  ): ToolCallRequest[] {
    return Object.values(responseToolCalls)
      .map((toolCall) => {
        if (!toolCall.function?.name) {
          return null
        }
        const base: ToolCallRequest = {
          id: toolCall.id ?? uuidv4(),
          name: this.normalizeToolCallName(toolCall.function.name),
        }
        return toolCall.function.arguments
          ? { ...base, arguments: toolCall.function.arguments }
          : base
      })
      .filter((item): item is ToolCallRequest => item !== null)
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

  private isModelTerminationFinishReason(
    finishReason: string | null | undefined,
  ): boolean {
    if (!finishReason) {
      return false
    }
    const normalized = finishReason.toLowerCase()
    if (
      normalized === 'tool_calls' ||
      normalized === 'tool_call' ||
      normalized === 'function_call'
    ) {
      return false
    }
    return true
  }
}
