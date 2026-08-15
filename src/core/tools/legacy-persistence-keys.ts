/**
 * TRANSITIONAL — delete this whole file once D9's settings migration
 * (`80_to_81`, docs/plans/2026-08-15-tool-registry/phase2-migration.md D9)
 * lands.
 *
 * It exists for exactly one reason: persistence
 * (`settings.mcp.builtinToolOptions` and each assistant's own
 * `toolPreferences`) still stores built-in tool enablement/approval under the
 * OLD pre-capability keys — the three synthetic "group" tool names
 * (`fs_edit_ops` / `memory_ops` / `web_ops`) plus each member tool's own
 * short name for those three, or the bare tool short name for every 1:1
 * capability. D9 rewrites that persisted shape to be keyed by capability id;
 * until then, every reader/writer of the old shape needs to know which
 * legacy keys correspond to which capability. This module is that single
 * source, so the mapping is derived from `CAPABILITIES` rather than
 * hand-duplicated at each call site (master.md decision 12 — the group names
 * are not tools or capabilities, just legacy dict keys, and must not be
 * treated as either after D7).
 */

import { getCapability } from './registry'

/**
 * The three legacy "virtual tool name" group keys. Exported under their
 * original names because callers across `core/agent` and `core/mcp` still
 * read/write these literal persistence keys — only their meaning ("this used
 * to be presented as its own tool") is retired by the capability model.
 */
export const FILE_EDIT_GROUP_TOOL_NAME = 'fs_edit_ops'
export const MEMORY_OPS_GROUP_TOOL_NAME = 'memory_ops'
export const WEB_OPS_GROUP_TOOL_NAME = 'web_ops'

const LEGACY_GROUP_KEY_BY_CAPABILITY_ID: Readonly<Record<string, string>> = {
  file_editing: FILE_EDIT_GROUP_TOOL_NAME,
  memory: MEMORY_OPS_GROUP_TOOL_NAME,
  web_access: WEB_OPS_GROUP_TOOL_NAME,
}

/**
 * Every key the pre-capability persistence layer used to store this
 * capability's enablement/approval under: the legacy group key plus every
 * member tool's own short name for the three multi-tool capabilities
 * (`file_editing`, `memory`, `web_access`); just the single tool's short name
 * for every 1:1 capability. Member names are derived from `capability.tools`,
 * never hand-maintained as a second list — a second list is exactly the
 * silent-drift failure this refactor exists to remove (master.md §1.4b).
 *
 * Returns an empty array for an unknown capability id.
 */
export function getLegacyPersistenceKeysForCapability(
  capabilityId: string,
): readonly string[] {
  const capability = getCapability(capabilityId)
  if (!capability) {
    return []
  }
  const memberNames = capability.tools.map((tool) => tool.name)
  const groupKey = LEGACY_GROUP_KEY_BY_CAPABILITY_ID[capabilityId]
  return groupKey ? [groupKey, ...memberNames] : memberNames
}

/**
 * `web_access`'s member tool short names on their own, without the group
 * key — kept as a standalone export for the one remaining consumer
 * (`tool-display-count.ts`) that groups by member names only. Derived from
 * the registry, not hand-maintained.
 */
export const WEB_OPS_SPLIT_ACTION_TOOL_NAMES: readonly string[] =
  getCapability('web_access')?.tools.map((tool) => tool.name) ?? []
