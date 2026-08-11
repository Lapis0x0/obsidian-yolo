import { getLocalFileToolServerName } from '../mcp/localFileToolNames'
import { getToolName } from '../mcp/tool-name-utils'

import type { YoloModuleAgentCapabilityV1 } from './types'

const localFileToolName = (name: string): string =>
  getToolName(getLocalFileToolServerName(), name)

// fs_read/fs_list were retired in favor of the bash tool (vault search +
// read now live there — see YOLO-45). 'vault-read' requests the same 'bash'
// tool identity as 'vault-write'; the read-only constraint is carried
// separately via `bashReadOnly` below, which forces the entire run onto the
// structurally read-only bash variant (mkdir/mv/rm/rmdir excluded from the
// command set and guarded again at the fs boundary — see
// runtime-components/bash-engine/src/entry.ts).
export const MODULE_CAPABILITY_TOOL_NAMES = Object.freeze({
  bash: localFileToolName('bash'),
  edit: localFileToolName('fs_edit'),
})

const TOOLS_BY_CAPABILITY: Readonly<
  Record<YoloModuleAgentCapabilityV1, readonly string[]>
> = Object.freeze({
  none: Object.freeze([]),
  'vault-read': Object.freeze([MODULE_CAPABILITY_TOOL_NAMES.bash]),
  'vault-write': Object.freeze([
    MODULE_CAPABILITY_TOOL_NAMES.bash,
    MODULE_CAPABILITY_TOOL_NAMES.edit,
  ]),
})

export type ModuleCapabilityProfile = Readonly<{
  /** Host tool names granted at this capability tier. */
  allowedHostToolNames: readonly string[]
  /** True when the shared 'bash' tool identity must run read-only. */
  bashReadOnly: boolean
}>

/**
 * Resolves the host tool grant for a module agent capability tier
 * (`none` / `vault-read` / `vault-write`). Shared by the per-run module
 * agent (`moduleAgent.ts`) and module chat modes (`moduleChatModeRegistry.ts`)
 * so the two host-tool grant paths cannot drift — in particular so
 * `bashReadOnly` always follows `capability`, never a separate flag that
 * could be forgotten by one of the two callers.
 */
export function resolveModuleCapabilityProfile(
  capability: YoloModuleAgentCapabilityV1,
): ModuleCapabilityProfile {
  return Object.freeze({
    allowedHostToolNames: TOOLS_BY_CAPABILITY[capability],
    bashReadOnly: capability === 'vault-read',
  })
}
