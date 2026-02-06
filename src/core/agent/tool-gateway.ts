import { McpTool } from '../../types/mcp.types'
import {
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { McpManager } from '../mcp/mcpManager'

type CompletedToolCallResponse = Extract<
  ToolCallResponse,
  {
    status:
      | ToolCallResponseStatus.Success
      | ToolCallResponseStatus.Error
      | ToolCallResponseStatus.Aborted
  }
>

export class AgentToolGateway {
  constructor(private readonly mcpManager: McpManager) {}

  async listTools({
    includeBuiltinTools,
  }: {
    includeBuiltinTools: boolean
  }): Promise<McpTool[]> {
    return this.mcpManager.listAvailableTools({ includeBuiltinTools })
  }

  isExecutionAllowed({
    requestToolName,
    conversationId,
    requestArgs,
  }: {
    requestToolName: string
    conversationId: string
    requestArgs?: Record<string, unknown> | string
  }): boolean {
    return this.mcpManager.isToolExecutionAllowed({
      requestToolName,
      conversationId,
      requestArgs,
    })
  }

  async callTool({
    name,
    args,
    id,
    signal,
  }: {
    name: string
    args?: Record<string, unknown> | string
    id?: string
    signal?: AbortSignal
  }): Promise<CompletedToolCallResponse> {
    return this.mcpManager.callTool({
      name,
      args,
      id,
      signal,
    })
  }

  abortToolCall(id: string): boolean {
    return this.mcpManager.abortToolCall(id)
  }
}
