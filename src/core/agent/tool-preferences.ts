import {
  Assistant,
  AssistantToolApprovalMode,
  AssistantToolDisclosureMode,
  AssistantToolPreference,
} from '../../types/assistant.types'
import type { McpTool } from '../../types/mcp.types'
import {
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  USER_FACING_LOCAL_TOOL_SHORT_NAMES,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'
import { getMcpToolSchemaTokenCost } from '../mcp/toolCatalogTokenCache'
import {
  getCapability,
  getCapabilityForTool,
  listCapabilities,
} from '../tools/registry'

export const DEFAULT_ASSISTANT_TOOL_APPROVAL_MODE: AssistantToolApprovalMode =
  'require_approval'
export const DEFAULT_ASSISTANT_TOOL_DISCLOSURE_MODE: AssistantToolDisclosureMode =
  'always'
export const SERVER_TOOL_DISCLOSURE_AUTO_TOKEN_THRESHOLD = 2000

export const resolveDefaultDisclosureModeForServer = (
  serverTokenBudget: number | undefined,
): AssistantToolDisclosureMode => {
  if (
    typeof serverTokenBudget !== 'number' ||
    !Number.isFinite(serverTokenBudget)
  ) {
    return DEFAULT_ASSISTANT_TOOL_DISCLOSURE_MODE
  }
  return serverTokenBudget >= SERVER_TOOL_DISCLOSURE_AUTO_TOKEN_THRESHOLD
    ? 'on_demand'
    : 'always'
}

export const buildServerToolTokenBudgets = async (
  serverToolsMap: ReadonlyMap<string, readonly McpTool[]>,
  estimateJsonTokens: (value: unknown) => Promise<number>,
): Promise<Map<string, number>> => {
  const budgets = new Map<string, number>()
  const localServerName = getLocalFileToolServerName()

  await Promise.all(
    [...serverToolsMap.entries()].map(async ([serverName, tools]) => {
      if (serverName === localServerName || tools.length === 0) {
        return
      }
      const costs = await Promise.all(
        tools.map((tool) =>
          getMcpToolSchemaTokenCost(tool, estimateJsonTokens),
        ),
      )
      budgets.set(
        serverName,
        costs.reduce((sum, cost) => sum + cost, 0),
      )
    }),
  )

  return budgets
}

/**
 * Full set of user-facing built-in tool FQNs that default to on. Used by the
 * settings migration and `getDefaultEnabledForTool` to seed `toolPreferences`
 * for new or upgrading agents. Runtime never fills these in at read time —
 * `toolPreferences` is the single source of truth for per-agent state, and
 * the migration is the only path that writes defaults into it.
 *
 * D7 (docs/plans/2026-08-15-tool-registry/phase2-migration.md D7 item 5):
 * "default off" used to be a hand-maintained deny-list
 * (`BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES`) that had to be kept in sync
 * with each capability's own `defaultEnabled` by inspection. It is now read
 * directly off the owning capability via `getCapabilityForTool` — every
 * {@link USER_FACING_LOCAL_TOOL_SHORT_NAMES} entry (which already excludes
 * the protocol-only `load_tool_schemas`) is a real `CAPABILITIES` member, so
 * the `?? false` fallback only matters for a short name that somehow isn't
 * registered, which the registry's own module-load assertions rule out.
 */
const USER_FACING_LOCAL_TOOL_SHORT_NAME_SET: ReadonlySet<string> = new Set(
  USER_FACING_LOCAL_TOOL_SHORT_NAMES,
)

export const BUILTIN_DEFAULT_ENABLED_TOOL_FQNS: readonly string[] =
  USER_FACING_LOCAL_TOOL_SHORT_NAMES.filter(
    (shortName) => getCapabilityForTool(shortName)?.defaultEnabled ?? false,
  ).map(
    (shortName) =>
      `${getLocalFileToolServerName()}${McpManager.TOOL_NAME_DELIMITER}${shortName}`,
  )

const isLocalFileToolFqn = (toolName: string): boolean => {
  try {
    const { serverName } = parseToolName(toolName)
    return serverName === getLocalFileToolServerName()
  } catch {
    return false
  }
}

/**
 * The default `enabled` value that the **settings migration** writes for a
 * tool when no explicit preference exists. User-facing built-in
 * `yolo_local__*` tools default on (modulo the deny-list); third-party MCP
 * tools and protocol-only tools (e.g. `load_tool_schemas`) default off.
 *
 * Runtime no longer consults this at read time — it is consulted only by
 * the migration that seeds `toolPreferences`. After migration, that map is
 * the single source of truth.
 */
export const getDefaultEnabledForTool = (toolName: string): boolean => {
  try {
    const { serverName, toolName: shortName } = parseToolName(toolName)
    if (serverName !== getLocalFileToolServerName()) {
      return false
    }
    if (!USER_FACING_LOCAL_TOOL_SHORT_NAME_SET.has(shortName)) {
      return false
    }
    return getCapabilityForTool(shortName)?.defaultEnabled ?? false
  } catch {
    return false
  }
}

/**
 * Default disclosure mode for a tool when the user has not customized it.
 *
 * Built-in `yolo_local__*` tools default to `always`: they total ~3.9K tokens
 * across ~13 tools, stub-izing them saves little and only adds a first-use
 * latency hit. Third-party MCP server tools also fall back to `always` here;
 * runtime callers that have the current server token budget pass it through
 * `getAssistantToolDisclosureMode` for automatic server-level selection.
 *
 * `load_tool_schemas` is a protocol-only tool injected by `selectAllowedTools`
 * when on-demand disclosure is in use; it is not a user-configurable surface
 * and never appears in `toolPreferences`.
 */
export const getDefaultDisclosureModeForTool = (
  toolName: string,
): AssistantToolDisclosureMode => {
  try {
    const { serverName } = parseToolName(toolName)
    if (serverName === getLocalFileToolServerName()) {
      return 'always'
    }
    return DEFAULT_ASSISTANT_TOOL_DISCLOSURE_MODE
  } catch {
    return DEFAULT_ASSISTANT_TOOL_DISCLOSURE_MODE
  }
}

/**
 * D7 (phase2-migration.md D7 items 5-7): this used to consult three
 * independent side tables (`FULL_ACCESS_LOCAL_TOOLS`,
 * `REQUIRE_APPROVAL_LOCAL_TOOLS`, plus a bash-specific `if`) that each had to
 * be kept in sync with the capability model by hand. It now reads a single
 * fact — the owning capability's `approval.defaultMode` — off the registry,
 * via {@link getCapabilityForTool}. This is also where bash's old
 * `parsedToolName === BASH_TOOL_NAME` special case (D6 batch 7) folds away:
 * `bash` is `vault_shell`'s only member, so the generic lookup already
 * returns `vault_shell`'s `dangerous_only` default for it — no separate
 * branch needed.
 */
export const getDefaultApprovalModeForTool = (
  toolName: string,
): AssistantToolApprovalMode => {
  try {
    const { serverName, toolName: parsedToolName } = parseToolName(toolName)
    if (serverName !== getLocalFileToolServerName()) {
      return 'require_approval'
    }

    // `load_tool_schemas` is the one local tool that is not a `CAPABILITIES`
    // member (master.md §3.1: "内部协议工具（不属任何 capability）") — it's
    // injected by the on-demand tool disclosure mechanism, not a
    // user-configurable capability, so `getCapabilityForTool` can never
    // resolve it. It has always run at `full_access` (the old
    // `FULL_ACCESS_LOCAL_TOOLS` set's only member); that value is asserted
    // explicitly here rather than falling through to the generic "unknown
    // tool" default below, since the two happen to coincide only by
    // coincidence.
    if (parsedToolName === LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME) {
      return 'full_access'
    }

    const capability = getCapabilityForTool(parsedToolName)
    if (capability) {
      return capability.approval.defaultMode
    }

    // Unknown local tool short name — e.g. a retired name like
    // `fs_list`/`fs_search` (see master.md decision 10) that can still show
    // up in historical `toolPreferences` data. Matches the pre-refactor
    // fallthrough (`REQUIRE_APPROVAL_LOCAL_TOOLS.has(...) ?
    // 'require_approval' : 'full_access'`), which defaulted to full_access
    // for any short name outside that explicit require-approval set.
    return 'full_access'
  } catch {
    return DEFAULT_ASSISTANT_TOOL_APPROVAL_MODE
  }
}

/**
 * Builds a freshly-seeded FQN-keyed `toolPreferences` map: every default-on
 * built-in tool FQN gets an explicit `{ enabled, approvalMode }` entry.
 *
 * As of the `80_to_81` settings migration (D9,
 * docs/plans/2026-08-15-tool-registry/phase2-migration.md D9), built-in
 * capability state no longer lives in `toolPreferences` at all — creation
 * paths (default assistant, "new agent" UI) seed
 * {@link buildDefaultBuiltinCapabilityPreferences} instead. This function is
 * kept **only** because the historical v60→v61 and v78→v79 migrations
 * (`settings/schema/migrations/60_to_61.ts`, `78_to_79.ts`) call it — those
 * files are frozen snapshots of what schema versions 61/79 looked like and
 * must keep producing FQN-keyed `toolPreferences` entries exactly as they
 * always have, since `80_to_81` runs after them in the same migration chain
 * and expects to find (and then strip) that shape.
 */
export const buildDefaultBuiltinToolPreferences = (): Record<
  string,
  AssistantToolPreference
> => {
  const result: Record<string, AssistantToolPreference> = {}
  for (const fqn of BUILTIN_DEFAULT_ENABLED_TOOL_FQNS) {
    result[fqn] = {
      enabled: true,
      approvalMode: getDefaultApprovalModeForTool(fqn),
    }
  }
  return result
}

/**
 * Builds a freshly-seeded capability-id-keyed `builtinCapabilityPreferences`
 * map: every registered capability gets an explicit
 * `{ enabled, approvalMode }` entry at its own declared defaults. This is
 * the current creation-path seed (default assistant, "new agent" UI) — the
 * capability-model successor to {@link buildDefaultBuiltinToolPreferences}
 * above, which now serves only the frozen pre-D9 migration chain.
 *
 * Explicit seeding (rather than leaving the map empty and relying on the
 * read-time fallback that {@link resolveBuiltinCapabilityPreference} already
 * provides for a missing entry) keeps a freshly-created assistant's on-disk
 * state identical in shape to what the `80_to_81` migration produces for a
 * pre-existing one — every capability id present — rather than introducing
 * a second, sparser shape that happens to resolve to the same values.
 */
export const buildDefaultBuiltinCapabilityPreferences = (): Record<
  string,
  AssistantToolPreference
> => {
  const result: Record<string, AssistantToolPreference> = {}
  for (const capability of listCapabilities()) {
    result[capability.id] = {
      enabled: capability.defaultEnabled,
      approvalMode: capability.approval.defaultMode,
    }
  }
  return result
}

/**
 * Resolves a single capability's effective per-assistant state: the
 * assistant's own explicit `builtinCapabilityPreferences[capabilityId]`
 * entry if present, otherwise the capability's own declared defaults. Used
 * by every read path below instead of duplicating the same
 * explicit-or-default fallback three times.
 *
 * Falls back to the global `DEFAULT_ASSISTANT_TOOL_APPROVAL_MODE` /
 * `enabled: false` only for a `capabilityId` the registry doesn't recognize
 * — structurally unreachable for any id this module derives from
 * `listCapabilities()`/`getCapabilityForTool()` itself, but kept as a safe
 * floor for hand-rolled callers passing an arbitrary string.
 */
const resolveBuiltinCapabilityPreference = (
  assistant: Pick<Assistant, 'builtinCapabilityPreferences'> | null | undefined,
  capabilityId: string,
): { enabled: boolean; approvalMode: AssistantToolApprovalMode } => {
  const capability = getCapability(capabilityId)
  const explicit = assistant?.builtinCapabilityPreferences?.[capabilityId]
  return {
    enabled: explicit?.enabled ?? capability?.defaultEnabled ?? false,
    approvalMode:
      explicit?.approvalMode ??
      capability?.approval.defaultMode ??
      DEFAULT_ASSISTANT_TOOL_APPROVAL_MODE,
  }
}

export const buildAssistantToolPreferencesFromEnabledToolNames = (
  enabledToolNames?: string[],
): Record<string, AssistantToolPreference> => {
  if (!enabledToolNames || enabledToolNames.length === 0) {
    return {}
  }

  return enabledToolNames.reduce<Record<string, AssistantToolPreference>>(
    (acc, toolName) => {
      acc[toolName] = {
        enabled: true,
        approvalMode: getDefaultApprovalModeForTool(toolName),
      }
      return acc
    },
    {},
  )
}

export const getAssistantToolPreferences = (
  assistant?: Pick<Assistant, 'toolPreferences' | 'enabledToolNames'> | null,
): Record<string, AssistantToolPreference> => {
  const fromEnabledToolNames =
    buildAssistantToolPreferencesFromEnabledToolNames(
      assistant?.enabledToolNames,
    )

  return {
    ...fromEnabledToolNames,
    ...(assistant?.toolPreferences ?? {}),
  }
}

/**
 * The set of tool FQNs the runtime treats as enabled for this assistant.
 *
 * Remote MCP tools: the explicit `enabled: true` entries from
 * `toolPreferences` — no fill-in, no implicit defaults there. The settings
 * migration is responsible for making sure every remote tool the assistant
 * ever explicitly touched has an explicit entry by the time runtime reads
 * it, so this function can safely treat an absent remote entry as disabled.
 *
 * Built-in tools: expanded from `builtinCapabilityPreferences` (D9,
 * docs/plans/2026-08-15-tool-registry/phase2-migration.md D9) — every
 * *enabled* capability's member tools all count as enabled, resolved via
 * {@link resolveBuiltinCapabilityPreference} (explicit per-assistant entry,
 * or the capability's own default when absent). `toolPreferences` no longer
 * carries built-in entries at all as of that migration.
 *
 * Honors `includeBuiltinTools`: when false, built-in tools are excluded from
 * the result entirely (the capability expansion loop below is skipped),
 * matching what the runtime actually exposes.
 *
 * Does NOT consult `enableTools`; callers gate on that at a higher level so
 * the helper remains useful inside the editor (where the master switch may be
 * temporarily off while the user is staging changes).
 */
export const getEnabledAssistantToolNames = (
  assistant?: Pick<
    Assistant,
    | 'toolPreferences'
    | 'enabledToolNames'
    | 'includeBuiltinTools'
    | 'builtinCapabilityPreferences'
  > | null,
): string[] => {
  const toolPreferences = getAssistantToolPreferences(assistant)
  const includeBuiltinTools = assistant?.includeBuiltinTools !== false
  const result = new Set<string>()

  for (const [toolName, preference] of Object.entries(toolPreferences)) {
    if (!preference.enabled) continue
    if (!includeBuiltinTools && isLocalFileToolFqn(toolName)) continue
    result.add(toolName)
  }

  if (includeBuiltinTools) {
    const localServer = getLocalFileToolServerName()
    for (const capability of listCapabilities()) {
      if (
        !resolveBuiltinCapabilityPreference(assistant, capability.id).enabled
      ) {
        continue
      }
      for (const tool of capability.tools) {
        result.add(
          `${localServer}${McpManager.TOOL_NAME_DELIMITER}${tool.name}`,
        )
      }
    }
  }

  return [...result]
}

/**
 * Subset of `getEnabledAssistantToolNames` that returns only tools the user
 * has *explicitly* turned on (i.e. `toolPreferences[name].enabled === true`).
 * Used by persistence paths to keep the legacy `enabledToolNames` array as a
 * snapshot of user intent rather than baking in derived defaults that should
 * stay implicit and re-derive at read time.
 */
export const getExplicitlyEnabledAssistantToolNames = (
  assistant?: Pick<Assistant, 'toolPreferences' | 'enabledToolNames'> | null,
): string[] => {
  const toolPreferences = getAssistantToolPreferences(assistant)
  return Object.entries(toolPreferences)
    .filter(([, preference]) => preference.enabled)
    .map(([toolName]) => toolName)
}

/**
 * Drop every `toolPreferences` / `enabledToolNames` entry whose serverName is
 * not in `knownServerNames`. Used to keep agent state in sync when an MCP
 * server is deleted, and by the v61→v62 migration to clean historical orphans
 * left behind by past deletes that didn't cascade.
 *
 * `knownServerNames` must include `yolo_local` and every entry currently in
 * `settings.mcp.servers`. Anything else is considered an orphan: the FQN
 * references a server the user can no longer see or configure, so the
 * preference is dead weight that only bloats data.json and confuses UI counts.
 */
export const pruneOrphanedAssistantToolPreferences = <
  T extends Pick<
    Assistant,
    'toolPreferences' | 'enabledToolNames' | 'toolServerPreferences'
  >,
>(
  assistant: T,
  knownServerNames: ReadonlySet<string>,
): T => {
  const isKnown = (fqn: string): boolean => {
    try {
      return knownServerNames.has(parseToolName(fqn).serverName)
    } catch {
      return false
    }
  }

  const prefs = assistant.toolPreferences
  let nextPrefs = prefs
  if (prefs && typeof prefs === 'object') {
    const filtered: Record<string, AssistantToolPreference> = {}
    let changed = false
    for (const [fqn, value] of Object.entries(prefs)) {
      if (isKnown(fqn)) {
        filtered[fqn] = value
      } else {
        changed = true
      }
    }
    if (changed) nextPrefs = filtered
  }

  const names = assistant.enabledToolNames
  let nextNames = names
  if (Array.isArray(names)) {
    const filtered = names.filter(isKnown)
    if (filtered.length !== names.length) nextNames = filtered
  }

  const serverPrefs = assistant.toolServerPreferences
  let nextServerPrefs = serverPrefs
  if (serverPrefs && typeof serverPrefs === 'object') {
    const filtered = Object.fromEntries(
      Object.entries(serverPrefs).filter(([serverName]) =>
        knownServerNames.has(serverName),
      ),
    )
    if (Object.keys(filtered).length !== Object.keys(serverPrefs).length) {
      nextServerPrefs = filtered
    }
  }

  if (
    nextPrefs === prefs &&
    nextNames === names &&
    nextServerPrefs === serverPrefs
  ) {
    return assistant
  }
  return {
    ...assistant,
    toolPreferences: nextPrefs,
    enabledToolNames: nextNames,
    toolServerPreferences: nextServerPrefs,
  }
}

/**
 * Rewrite every `toolPreferences` / `enabledToolNames` entry whose serverName
 * equals `oldServerName` so its FQN uses `newServerName` instead. Used when
 * the user renames an MCP server in the edit modal — without this, the rename
 * would orphan all per-tool preferences for that server and the next
 * `pruneOrphanedAssistantToolPreferences` would silently drop them.
 */
export const renameAssistantToolPreferencesServer = <
  T extends Pick<
    Assistant,
    'toolPreferences' | 'enabledToolNames' | 'toolServerPreferences'
  >,
>(
  assistant: T,
  oldServerName: string,
  newServerName: string,
): T => {
  if (oldServerName === newServerName) return assistant

  const rewrite = (fqn: string): string => {
    try {
      const { serverName, toolName } = parseToolName(fqn)
      if (serverName !== oldServerName) return fqn
      return `${newServerName}${McpManager.TOOL_NAME_DELIMITER}${toolName}`
    } catch {
      return fqn
    }
  }

  const prefs = assistant.toolPreferences
  let nextPrefs = prefs
  if (prefs && typeof prefs === 'object') {
    const rebuilt: Record<string, AssistantToolPreference> = {}
    let changed = false
    for (const [fqn, value] of Object.entries(prefs)) {
      const nextKey = rewrite(fqn)
      if (nextKey !== fqn) changed = true
      rebuilt[nextKey] = value
    }
    if (changed) nextPrefs = rebuilt
  }

  const names = assistant.enabledToolNames
  let nextNames = names
  if (Array.isArray(names)) {
    let changed = false
    const seen = new Set<string>()
    const rebuilt: string[] = []
    for (const name of names) {
      const nextName = rewrite(name)
      if (nextName !== name) changed = true
      if (seen.has(nextName)) {
        changed = true
        continue
      }
      seen.add(nextName)
      rebuilt.push(nextName)
    }
    if (changed) nextNames = rebuilt
  }

  const serverPrefs = assistant.toolServerPreferences
  let nextServerPrefs = serverPrefs
  if (serverPrefs && typeof serverPrefs === 'object') {
    const existing = serverPrefs[oldServerName]
    if (existing) {
      const { [oldServerName]: _old, ...rest } = serverPrefs
      nextServerPrefs = {
        ...rest,
        [newServerName]: existing,
      }
    }
  }

  if (
    nextPrefs === prefs &&
    nextNames === names &&
    nextServerPrefs === serverPrefs
  ) {
    return assistant
  }
  return {
    ...assistant,
    toolPreferences: nextPrefs,
    enabledToolNames: nextNames,
    toolServerPreferences: nextServerPrefs,
  }
}

/**
 * As of the `80_to_81` settings migration (D9,
 * docs/plans/2026-08-15-tool-registry/phase2-migration.md D9), a built-in
 * tool's enablement is owned by its capability's
 * `builtinCapabilityPreferences` entry, not `toolPreferences` — resolved via
 * {@link getCapabilityForTool} (FQN's short name -> owning capability) and
 * {@link resolveBuiltinCapabilityPreference}. A local short name the
 * registry doesn't recognize (the protocol-only `load_tool_schemas`, or a
 * retired name like `fs_list` that can still appear in historical chat
 * state) falls through to the generic `toolPreferences` lookup below, which
 * mirrors the pre-D9 behavior for those names (never present there, so
 * always `false`). Remote MCP tools were never affected by this migration
 * and keep reading `toolPreferences` exactly as before.
 */
export const isAssistantToolEnabled = (
  assistant:
    | Pick<
        Assistant,
        'toolPreferences' | 'enabledToolNames' | 'builtinCapabilityPreferences'
      >
    | null
    | undefined,
  toolName: string,
): boolean => {
  try {
    const { serverName, toolName: shortName } = parseToolName(toolName)
    if (serverName === getLocalFileToolServerName()) {
      const capability = getCapabilityForTool(shortName)
      if (capability) {
        return resolveBuiltinCapabilityPreference(assistant, capability.id)
          .enabled
      }
    }
  } catch {
    // Fall through to the generic lookup below.
  }

  const toolPreferences = getAssistantToolPreferences(assistant)
  return toolPreferences[toolName]?.enabled ?? false
}

/**
 * Same split as {@link isAssistantToolEnabled}: a recognized built-in short
 * name resolves its approval tier off `builtinCapabilityPreferences` via its
 * owning capability; everything else (remote MCP tools, and local names the
 * registry doesn't recognize) falls through to the pre-D9 paths unchanged —
 * server-level `toolServerPreferences` for remote tools, and
 * `toolPreferences` + `getDefaultApprovalModeForTool` for anything else.
 */
export const getAssistantToolApprovalMode = (
  assistant:
    | Pick<
        Assistant,
        | 'toolPreferences'
        | 'enabledToolNames'
        | 'toolServerPreferences'
        | 'builtinCapabilityPreferences'
      >
    | null
    | undefined,
  toolName: string,
): AssistantToolApprovalMode => {
  try {
    const { serverName, toolName: shortName } = parseToolName(toolName)
    if (serverName !== getLocalFileToolServerName()) {
      return (
        assistant?.toolServerPreferences?.[serverName]?.approvalMode ??
        'require_approval'
      )
    }
    const capability = getCapabilityForTool(shortName)
    if (capability) {
      return resolveBuiltinCapabilityPreference(assistant, capability.id)
        .approvalMode
    }
  } catch {
    // Fall through to legacy per-tool/default handling.
  }

  const toolPreferences = getAssistantToolPreferences(assistant)
  return (
    toolPreferences[toolName]?.approvalMode ??
    getDefaultApprovalModeForTool(toolName)
  )
}

export const getAssistantToolDisclosureMode = (
  assistant:
    | Pick<
        Assistant,
        'toolPreferences' | 'enabledToolNames' | 'toolServerPreferences'
      >
    | null
    | undefined,
  toolName: string,
  options?: {
    enableToolDisclosure?: boolean
    serverToolTokenBudgets?: ReadonlyMap<string, number>
  },
): AssistantToolDisclosureMode => {
  if (options?.enableToolDisclosure === false) {
    return 'always'
  }

  // Built-in tools are part of the agent's core capabilities (~3.9K tokens
  // total) and are always loaded. Disclosure is an MCP-only concept now;
  // any stale `on_demand` value in toolPreferences for a built-in is ignored.
  let parsedServerName: string | null = null
  try {
    const { serverName } = parseToolName(toolName)
    parsedServerName = serverName
    if (serverName === getLocalFileToolServerName()) {
      return 'always'
    }
  } catch {
    // Fall through to default handling below.
  }

  if (parsedServerName) {
    const explicitMode =
      assistant?.toolServerPreferences?.[parsedServerName]?.disclosureMode
    if (explicitMode) return explicitMode
    return resolveDefaultDisclosureModeForServer(
      options?.serverToolTokenBudgets?.get(parsedServerName),
    )
  }
  return getDefaultDisclosureModeForTool(toolName)
}
