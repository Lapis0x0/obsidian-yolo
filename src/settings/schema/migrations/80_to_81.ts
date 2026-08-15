import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { McpManager } from '../../../core/mcp/mcpManager'
import { listCapabilities } from '../../../core/tools/registry'
import type { AssistantToolApprovalMode } from '../../../types/assistant.types'
import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const APPROVAL_MODE_STRICTNESS: Readonly<
  Record<AssistantToolApprovalMode, number>
> = {
  full_access: 0,
  dangerous_only: 1,
  require_approval: 2,
}

const isApprovalMode = (value: unknown): value is AssistantToolApprovalMode =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(APPROVAL_MODE_STRICTNESS, value)

/**
 * Picks the strictest of the given approval modes: `require_approval` >
 * `dangerous_only` > `full_access`. `modes` is always non-empty at both call
 * sites below.
 *
 * This is the merge rule for a capability whose member tools carried
 * different legacy approval values — today only reachable for
 * `file_editing` (`fs_edit` defaulted `full_access`, `fs_write` defaulted
 * `require_approval`; see decision 17 / §1.4 of
 * docs/plans/2026-08-15-tool-registry/master.md). Picking the strictest
 * resolves that pre-existing contradiction toward what the settings page
 * already *displayed* (an aggregated "Require approval"), rather than the
 * looser value the runtime happened to read. For every other capability
 * this is an identity transform: member values there can never actually
 * diverge (docs/plans/2026-08-15-tool-registry/master.md §2.5 — the only
 * legacy write paths for both the global group switch and each assistant's
 * per-tool preferences always wrote every member the same value).
 */
const mostStrictApprovalMode = (
  modes: readonly AssistantToolApprovalMode[],
): AssistantToolApprovalMode =>
  modes.reduce((strictest, mode) =>
    APPROVAL_MODE_STRICTNESS[mode] > APPROVAL_MODE_STRICTNESS[strictest]
      ? mode
      : strictest,
  )

/**
 * The three synthetic "group" tool names the pre-capability global toggle
 * (`AgentToolsModal.tsx`'s `handleToggleBuiltinTool`) wrote alongside every
 * member's own short name. Only these three multi-tool capabilities ever had
 * one; every 1:1 capability's sole legacy key is just its one member tool's
 * own short name, already covered by `capability.tools`. Inlined here
 * (rather than imported from `core/tools/legacy-persistence-keys.ts`)
 * because that module is deleted as part of this same migration landing —
 * see that file's own former doc comment.
 */
const LEGACY_GROUP_KEY_BY_CAPABILITY_ID: Readonly<Record<string, string>> = {
  file_editing: 'fs_edit_ops',
  memory: 'memory_ops',
  web_access: 'web_ops',
}

const isLocalFqn = (name: string, localServer: string): boolean =>
  name.startsWith(`${localServer}${McpManager.TOOL_NAME_DELIMITER}`)

/**
 * `settings.mcp.builtinToolOptions` (keyed by the old short tool/group
 * names) -> `settings.mcp.builtinCapabilityOptions` (keyed by capability
 * id). This is global *enablement* only — approval tiers have always been a
 * per-assistant concept (`toolPreferences[fqn].approvalMode`), never stored
 * here, so there is nothing to merge/carry for that field at this layer.
 *
 * Two capabilities carry tool-specific config the generic `disabled`
 * migration would otherwise drop (docs/plans/2026-08-15-tool-registry's D9
 * brief, "坑 1"): `subagent_delegation`'s `allowedModelIds` /
 * `preferredModelId` (read straight from the old `delegate_subagent` key)
 * and `terminal`'s `blockedPrefixes` (from the old `terminal_command` key).
 */
const migrateBuiltinToolOptions = (
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const mcp = isRecord(data.mcp) ? data.mcp : {}
  const legacyOptions = isRecord(mcp.builtinToolOptions)
    ? mcp.builtinToolOptions
    : {}

  const nextOptions: Record<string, unknown> = {}
  for (const capability of listCapabilities()) {
    const legacyKeys: string[] = [
      LEGACY_GROUP_KEY_BY_CAPABILITY_ID[capability.id],
      ...capability.tools.map((tool) => tool.name),
    ].filter((key): key is string => typeof key === 'string')

    // Matches the pre-D9 runtime aggregation exactly
    // (`builtinCapabilityRows.ts`'s `enabled` / `McpManager.
    // isLocalToolPersistedEnabled`'s per-group checks): disabled if *any*
    // legacy key (group key, if this capability had one, or any member) was
    // explicitly disabled.
    const anyDisabled = legacyKeys.some((key) => {
      const entry = legacyOptions[key]
      return isRecord(entry) && entry.disabled === true
    })

    const entry: Record<string, unknown> = { disabled: anyDisabled }

    if (capability.id === 'subagent_delegation') {
      const legacy = legacyOptions.delegate_subagent
      if (isRecord(legacy)) {
        if (Array.isArray(legacy.allowedModelIds)) {
          entry.allowedModelIds = legacy.allowedModelIds
        }
        if (typeof legacy.preferredModelId === 'string') {
          entry.preferredModelId = legacy.preferredModelId
        }
      }
    }

    if (capability.id === 'terminal') {
      const legacy = legacyOptions.terminal_command
      if (isRecord(legacy) && Array.isArray(legacy.blockedPrefixes)) {
        entry.blockedPrefixes = legacy.blockedPrefixes
      }
    }

    nextOptions[capability.id] = entry
  }

  const { builtinToolOptions: _legacy, ...restMcp } = mcp

  return {
    ...data,
    mcp: {
      ...restMcp,
      builtinCapabilityOptions: nextOptions,
    },
  }
}

/**
 * One assistant's `toolPreferences` (FQN-keyed, `yolo_local__<shortname>`)
 * -> `builtinCapabilityPreferences` (capability-id-keyed). Per capability:
 *
 *   - Collect every member tool's legacy entry that is actually present.
 *     "Present" mirrors `getAssistantToolPreferences` exactly — that helper
 *     resolves an assistant's effective preferences as
 *     `{ ...fromEnabledToolNames, ...toolPreferences }`, so a built-in tool
 *     listed only in the legacy `enabledToolNames` array is just as much a
 *     real, enabled grant as one with its own `toolPreferences` entry. A
 *     migration that read only `toolPreferences` would silently revoke those.
 *   - `enabled` = true only if every *present* member's `enabled !== false`.
 *   - `approvalMode` = the strictest of every present member's approval
 *     value (`mostStrictApprovalMode`), falling back per-member to that
 *     tool's own legacy default when a present entry's `approvalMode` is
 *     itself missing/invalid.
 *   - **No member present at all -> `enabled: false`**, NOT the capability's
 *     `defaultEnabled`. This is the one place the D9 plan text
 *     (phase2-migration.md: "若旧值缺失 → 用 capability 的 defaultEnabled")
 *     is wrong about runtime semantics, and getting it wrong turns
 *     capabilities *on* that were off. `getEnabledAssistantToolNames`'s own
 *     doc comment is explicit: it "returns the explicit `enabled: true`
 *     entries from `toolPreferences` — no fill-in, no implicit defaults",
 *     so an absent entry has always meant the tool is unavailable at
 *     runtime, whatever its capability's default says. This is not
 *     hypothetical: an assistant created before `bash` shipped (2026-08-08,
 *     schema v79) has no `yolo_local__bash` entry in either source, so
 *     Vault Shell is off for it today — and `vault_shell.defaultEnabled` is
 *     `true`, so the plan's rule would silently grant it a shell that can
 *     `rm`/`mv`. Verified against real `data.json`: 2 of its 3 assistants
 *     are in exactly that state.
 *
 *     `approvalMode` still falls back to `approval.defaultMode` here, which
 *     matches `getAssistantToolApprovalMode`'s own fallback to
 *     `getDefaultApprovalModeForTool` and is inert while `enabled` is false.
 *   - A resolved `approvalMode` outside the capability's own `allowedModes`
 *     (defensive only — not reachable from real data, since every legacy
 *     value is one of the three tiers and every capability but `vault_shell`
 *     allows exactly `full_access`/`require_approval`) falls back to
 *     `defaultMode`.
 *
 * Every `yolo_local__*` entry is then stripped from both `toolPreferences`
 * and `enabledToolNames` — including retired short names
 * (`fs_list`/`fs_search`/...) that don't belong to any capability and so
 * never contributed a source value above. Remote MCP entries in both are
 * left completely untouched.
 */
const migrateAssistantBuiltinCapabilities = (
  assistant: Record<string, unknown>,
): Record<string, unknown> => {
  const legacyPreferences = isRecord(assistant.toolPreferences)
    ? assistant.toolPreferences
    : {}
  const localServer = getLocalFileToolServerName()
  // The second legacy grant source, exactly as `getAssistantToolPreferences`
  // reads it: `enabledToolNames` entries are folded in *under*
  // `toolPreferences`, so they grant a tool but never override an explicit
  // entry.
  const legacyEnabledToolNames = new Set(
    Array.isArray(assistant.enabledToolNames)
      ? assistant.enabledToolNames.filter(
          (name): name is string => typeof name === 'string',
        )
      : [],
  )

  const builtinCapabilityPreferences: Record<string, unknown> = {}

  for (const capability of listCapabilities()) {
    const presentMembers: {
      enabled: boolean
      approvalMode: AssistantToolApprovalMode
    }[] = []

    for (const tool of capability.tools) {
      const fqn = `${localServer}${McpManager.TOOL_NAME_DELIMITER}${tool.name}`
      const entry = legacyPreferences[fqn]
      if (isRecord(entry)) {
        presentMembers.push({
          enabled: entry.enabled !== false,
          approvalMode: isApprovalMode(entry.approvalMode)
            ? entry.approvalMode
            : capability.approval.defaultMode,
        })
        continue
      }
      if (legacyEnabledToolNames.has(fqn)) {
        // `buildAssistantToolPreferencesFromEnabledToolNames` synthesizes
        // exactly this: enabled, at the tool's default approval mode.
        presentMembers.push({
          enabled: true,
          approvalMode: capability.approval.defaultMode,
        })
      }
    }

    const enabled =
      presentMembers.length > 0 &&
      presentMembers.every((member) => member.enabled)

    let approvalMode =
      presentMembers.length > 0
        ? mostStrictApprovalMode(presentMembers.map((m) => m.approvalMode))
        : capability.approval.defaultMode

    if (
      !(capability.approval.allowedModes as readonly string[]).includes(
        approvalMode,
      )
    ) {
      approvalMode = capability.approval.defaultMode
    }

    builtinCapabilityPreferences[capability.id] = { enabled, approvalMode }
  }

  const nextToolPreferences: Record<string, unknown> = {}
  for (const [fqn, value] of Object.entries(legacyPreferences)) {
    if (isLocalFqn(fqn, localServer)) continue
    nextToolPreferences[fqn] = value
  }

  const next: Record<string, unknown> = {
    ...assistant,
    builtinCapabilityPreferences,
    toolPreferences: nextToolPreferences,
  }

  if (Array.isArray(assistant.enabledToolNames)) {
    next.enabledToolNames = assistant.enabledToolNames.filter(
      (name) => typeof name === 'string' && !isLocalFqn(name, localServer),
    )
  }

  return next
}

/**
 * v80->v81: collapse the pre-capability persistence shape (short tool/group
 * names) into the capability-keyed shape everywhere built-in tool
 * enablement/approval is stored (docs/plans/2026-08-15-tool-registry, D9).
 *
 * Two independent layers, both handled here:
 *   - Global: `settings.mcp.builtinToolOptions` -> `builtinCapabilityOptions`.
 *   - Per-assistant: each assistant's `toolPreferences` built-in entries ->
 *     its own new `builtinCapabilityPreferences`.
 *
 * Remote MCP data (`toolPreferences` entries for non-`yolo_local__` FQNs,
 * `toolServerPreferences`, each server's own `toolOptions`) is never touched
 * by either half.
 */
export const migrateFrom80To81: SettingMigration['migrate'] = (data) => {
  let next: Record<string, unknown> = { ...data, version: 81 }

  next = migrateBuiltinToolOptions(next)

  if (Array.isArray(next.assistants)) {
    next.assistants = next.assistants.map((assistant) =>
      isRecord(assistant)
        ? migrateAssistantBuiltinCapabilities(assistant)
        : assistant,
    )
  }

  return next
}
