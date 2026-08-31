import type { McpTool } from '../../types/mcp.types'
import type { ToolCallResponse } from '../../types/tool-call.types'

/**
 * An in-process tool "server" registered directly with `McpManager`, without
 * a transport connection. Its tools are addressed the same way remote MCP
 * tools are (`serverName__toolName`, see `tool-name-utils.ts`) and are
 * reachable through the same `listAvailableTools` / `callTool` /
 * `abortToolCall` surface.
 *
 * Intended for host-native tool sets that live in the same process as the
 * manager for the lifetime of a single run — e.g. a module registering a
 * scoped tool set before calling `agent.stream` (see the `tools` field
 * planned for `YoloModuleAgentRequestV1` in `modules/host-sdk.d.ts`).
 *
 * Local file tools (bash/fs_edit/fs_read/...) are NOT implemented through
 * this registry. Their call surface needs manager-owned context (settings,
 * openApplyReview, the RAG engine, workspace scope, conversation history,
 * ...) that this deliberately minimal contract does not carry, and unifying
 * them would mean leaking that internal context through a contract meant to
 * stay simple for external registrants. They keep their existing special
 * case in `mcpManager.ts`; this registry is a second, parallel source of
 * in-process tools.
 */
export type InProcessToolServer = {
  /**
   * Tool schemas for this server, using their short (unprefixed) names. Read
   * synchronously and on demand — implementations should keep this cheap, as
   * it may be called once per `listAvailableTools`/`callTool`/
   * `isToolExecutionAllowed` invocation.
   */
  listTools(): McpTool[]

  /**
   * Invoke one tool by its short (unprefixed) name. Implementations should
   * respect `signal` for cancellation where practical, but do not need a
   * top-level try/catch purely to avoid crashing the caller — a thrown or
   * rejected error is converted into an `Error`-status `ToolCallResponse` by
   * `McpManager.callTool`.
   */
  callTool(params: {
    toolName: string
    args: Record<string, unknown>
    signal: AbortSignal
  }): Promise<ToolCallResponse>
}
