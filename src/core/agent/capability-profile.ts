import { getLocalFileToolServerName } from '../mcp/localFileToolNames'
import { getToolName } from '../mcp/tool-name-utils'

const localFileToolName = (name: string): string =>
  getToolName(getLocalFileToolServerName(), name)

/**
 * The trust tier of a single programmatic agent run: what this run may touch,
 * stated once for every caller that is not a chat surface.
 *
 * This is the shared vocabulary behind two entry points that look unrelated
 * but resolve to the same grant:
 *
 *   - Host-internal callers pass `capability` to
 *     `YoloAgentApiService.run` / `.stream` (`agent-api.ts`).
 *   - Modules pass `capability` to `host.agent.stream`, whose Host API type
 *     `YoloModuleAgentCapabilityV1` is an alias of this union so the published
 *     contract keeps its versioned name without becoming a second vocabulary.
 *
 * Chat surfaces do *not* use this type: a chat mode is a product identity
 * (persona, environment prompt, context policy, module binding) that *has* a
 * trust tier rather than *being* one, so it resolves through
 * `resolveChatModeRuntime` instead.
 */
export type YoloAgentCapability = 'none' | 'vault-read' | 'vault-write'

// fs_read/fs_list were retired in favor of the bash tool (vault search +
// read now live there — see YOLO-45). 'vault-read' requests the same 'bash'
// tool identity as 'vault-write'; the read-only constraint is carried
// separately via `bashReadOnly` below, which forces the entire run onto the
// structurally read-only bash variant (mkdir/mv/rm/rmdir excluded from the
// command set and guarded again at the fs boundary — see
// runtime-components/bash-engine/src/entry.ts).
export const AGENT_CAPABILITY_TOOL_NAMES = Object.freeze({
  bash: localFileToolName('bash'),
  edit: localFileToolName('fs_edit'),
})

const TOOLS_BY_CAPABILITY: Readonly<
  Record<YoloAgentCapability, readonly string[]>
> = Object.freeze({
  none: Object.freeze([]),
  'vault-read': Object.freeze([AGENT_CAPABILITY_TOOL_NAMES.bash]),
  'vault-write': Object.freeze([
    AGENT_CAPABILITY_TOOL_NAMES.bash,
    AGENT_CAPABILITY_TOOL_NAMES.edit,
  ]),
})

export type AgentCapabilityProfile = Readonly<{
  /** Host tool names granted at this capability tier. */
  allowedHostToolNames: readonly string[]
  /** True when the shared 'bash' tool identity must run read-only. */
  bashReadOnly: boolean
}>

/**
 * Resolves the host tool grant for a capability tier
 * (`none` / `vault-read` / `vault-write`). Shared by the programmatic run
 * entry point (`agent-api.ts`), the per-run module agent (`moduleAgent.ts`)
 * and module chat modes (`moduleChatModeRegistry.ts`) so the host-tool grant
 * paths cannot drift — in particular so `bashReadOnly` always follows
 * `capability`, never a separate flag one caller could forget.
 */
export function resolveAgentCapabilityProfile(
  capability: YoloAgentCapability,
): AgentCapabilityProfile {
  return Object.freeze({
    allowedHostToolNames: TOOLS_BY_CAPABILITY[capability],
    bashReadOnly: capability === 'vault-read',
  })
}
