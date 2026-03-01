import { v4 as uuidv4 } from 'uuid'

import { ChatToolMessage } from '../../types/chat'
import { McpTool } from '../../types/mcp.types'
import {
  ToolCallRequest,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { McpManager } from '../mcp/mcpManager'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
import { parseToolName } from '../mcp/tool-name-utils'

export class AgentToolGateway {
  private readonly allowedToolNames?: Set<string>
  private readonly allowedSkillIds?: Set<string>
  private readonly allowedSkillNames?: Set<string>

  constructor(
    private readonly mcpManager: McpManager,
    options?: {
      allowedToolNames?: string[]
      allowedSkillIds?: string[]
      allowedSkillNames?: string[]
    },
  ) {
    this.allowedToolNames = options?.allowedToolNames
      ? new Set(options.allowedToolNames)
      : undefined
    this.allowedSkillIds = options?.allowedSkillIds
      ? new Set(options.allowedSkillIds.map((id) => id.toLowerCase()))
      : undefined
    this.allowedSkillNames = options?.allowedSkillNames
      ? new Set(options.allowedSkillNames.map((name) => name.toLowerCase()))
      : undefined
  }

  async listTools({
    includeBuiltinTools,
  }: {
    includeBuiltinTools: boolean
  }): Promise<McpTool[]> {
    return this.mcpManager.listAvailableTools({ includeBuiltinTools })
  }

  createToolMessage({
    toolCallRequests,
    conversationId,
  }: {
    toolCallRequests: ToolCallRequest[]
    conversationId: string
  }): ChatToolMessage {
    return {
      role: 'tool',
      id: uuidv4(),
      toolCalls: toolCallRequests.map((request) => ({
        request,
        response: {
          status: this.shouldAutoExecuteTool({ request, conversationId })
            ? ToolCallResponseStatus.Running
            : ToolCallResponseStatus.PendingApproval,
        },
      })),
    }
  }

  async executeAutoToolCalls({
    toolMessage,
    signal,
  }: {
    toolMessage: ChatToolMessage
    signal?: AbortSignal
  }): Promise<ChatToolMessage> {
    const nextToolCalls = [...toolMessage.toolCalls]
    const runnableIndexes = nextToolCalls
      .map((toolCall, index) => ({ index, toolCall }))
      .filter(
        ({ toolCall }) =>
          toolCall.response.status === ToolCallResponseStatus.Running,
      )

    const results = await Promise.allSettled(
      runnableIndexes.map(({ toolCall }) =>
        this.mcpManager.callTool({
          name: toolCall.request.name,
          args: toolCall.request.arguments,
          id: toolCall.request.id,
          signal,
        }),
      ),
    )

    results.forEach((result, idx) => {
      const targetIndex = runnableIndexes[idx].index
      if (result.status === 'fulfilled') {
        nextToolCalls[targetIndex] = {
          ...nextToolCalls[targetIndex],
          response: result.value,
        }
        return
      }

      nextToolCalls[targetIndex] = {
        ...nextToolCalls[targetIndex],
        response: {
          status: ToolCallResponseStatus.Error,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        },
      }
    })

    return {
      ...toolMessage,
      toolCalls: nextToolCalls,
    }
  }

  hasPendingToolCalls(toolMessage: ChatToolMessage): boolean {
    return toolMessage.toolCalls.some((toolCall) =>
      [
        ToolCallResponseStatus.PendingApproval,
        ToolCallResponseStatus.Running,
      ].includes(toolCall.response.status),
    )
  }

  abortToolCall(id: string): boolean {
    return this.mcpManager.abortToolCall(id)
  }

  private shouldAutoExecuteTool({
    request,
    conversationId,
  }: {
    request: ToolCallRequest
    conversationId: string
  }): boolean {
    if (!this.isToolAllowed(request.name)) {
      return false
    }
    if (!this.isSkillPermissionAllowed(request)) {
      return false
    }

    return this.mcpManager.isToolExecutionAllowed({
      requestToolName: request.name,
      conversationId,
      requestArgs: request.arguments,
    })
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

  private parseToolArguments(
    args?: Record<string, unknown> | string,
  ): Record<string, unknown> {
    if (!args) {
      return {}
    }
    if (typeof args === 'string') {
      if (args.trim().length === 0) {
        return {}
      }
      try {
        const parsed = JSON.parse(args)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        return {}
      }
      return {}
    }
    return args
  }

  private isSkillPermissionAllowed(request: ToolCallRequest): boolean {
    try {
      const parsed = parseToolName(request.name)
      if (
        parsed.serverName !== getLocalFileToolServerName() ||
        parsed.toolName !== 'open_skill'
      ) {
        return true
      }

      if (!this.allowedSkillIds && !this.allowedSkillNames) {
        return false
      }

      const args = this.parseToolArguments(request.arguments)
      const id = typeof args.id === 'string' ? args.id.trim().toLowerCase() : ''
      const name =
        typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''

      const allowedById = Boolean(id) && Boolean(this.allowedSkillIds?.has(id))
      const allowedByName =
        Boolean(name) && Boolean(this.allowedSkillNames?.has(name))

      return allowedById || allowedByName
    } catch {
      return true
    }
  }
}
