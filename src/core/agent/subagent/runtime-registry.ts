import type { McpManager } from '../../mcp/mcpManager'
import type { NativeAgentRuntime } from '../native-runtime'

/**
 * Session-level registry that maps a running subagent's `taskId` to its live
 * runtime + the parent-conversation context needed to route approval signals
 * back into it. Used by the approval-routing flow:
 *
 *   1. `runChildAgent` registers an entry on start; unregisters on finalize.
 *   2. While a subagent's tool call is in `PendingApproval`, the SubagentCard
 *      renders an inline approval block whose buttons call into
 *      `AgentService.approveToolCall` / `rejectToolCall`.
 *   3. The service first checks this registry by `toolCallId`; if a match is
 *      found, the approval action targets the subagent's runtime directly —
 *      bypassing the parent-conversation continuation path.
 *
 * See `docs/plans/2026-06-18-subagent-tool-approval-routing.md`.
 */
export type SubagentRuntimeEntry = {
  taskId: string
  runtime: NativeAgentRuntime
  /**
   * The McpManager the subagent runs against (forwarded from the parent
   * context). The service uses this for `callTool` / `allowToolForConversation`
   * during approval handling.
   */
  mcpManager: McpManager
  /** Parent conversation id — used as the approval scope for `mcpManager`. */
  parentConversationId: string
  /** Parent toolCallId hosting this subagent's SubagentCard, for back-refs. */
  parentToolCallId: string
  /**
   * Continue running the subagent loop once every call in the paused parallel
   * batch is settled. Safe to call after each individual decision; the child
   * runner no-ops while another call is pending or running.
   */
  resumeRun: () => Promise<void>
}

class SubagentRuntimeRegistry {
  private readonly byTaskId = new Map<string, SubagentRuntimeEntry>()

  register(entry: SubagentRuntimeEntry): void {
    this.byTaskId.set(entry.taskId, entry)
  }

  unregister(taskId: string): void {
    this.byTaskId.delete(taskId)
  }

  getByTaskId(taskId: string): SubagentRuntimeEntry | undefined {
    return this.byTaskId.get(taskId)
  }

  /**
   * Find the registry entry whose runtime currently hosts a tool call with
   * this id. Walks each runtime's messages — there are at most a handful of
   * concurrent subagents per session, so an O(N) scan is fine. Returns
   * `undefined` if the toolCallId is not in any subagent's transcript (the
   * caller falls back to the parent-conversation path).
   */
  findByToolCallId(toolCallId: string): SubagentRuntimeEntry | undefined {
    for (const entry of this.byTaskId.values()) {
      if (entry.runtime.findToolCall(toolCallId)) {
        return entry
      }
    }
    return undefined
  }

  list(): SubagentRuntimeEntry[] {
    return [...this.byTaskId.values()]
  }
}

export const subagentRuntimeRegistry = new SubagentRuntimeRegistry()
