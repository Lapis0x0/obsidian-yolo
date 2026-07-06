import {
  Assistant,
  AssistantToolApprovalMode,
  AssistantToolDisclosureMode,
  AssistantToolPreference,
} from '../../types/assistant.types'
import type { RequestTool } from '../../types/llm/request'
import type { McpTool } from '../../types/mcp.types'
import { JS_SANDBOX_TOOL_NAME } from '../mcp/jsSandboxTool'
import {
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  USER_FACING_LOCAL_TOOL_SHORT_NAMES,
  getLocalFileToolServerName,
} from '../mcp/localFileTools'
import { McpManager } from '../mcp/mcpManager'
import { parseToolName } from '../mcp/tool-name-utils'

export const DEFAULT_ASSISTANT_TOOL_APPROVAL_MODE: AssistantToolApprovalMode =
  'require_approval'
export const DEFAULT_ASSISTANT_TOOL_DISCLOSURE_MODE: AssistantToolDisclosureMode =
  'always'
export const SERVER_TOOL_DISCLOSURE_AUTO_TOKEN_THRESHOLD = 2000

/**
 * 这些工具永远不允许"始终允许"（always-allow）模式。
 * UI 侧应隐藏这些工具的 allowForThisChat 按钮。
 */
export const ALWAYS_ALLOW_DISABLED_TOOL_NAMES: readonly string[] = [
  'terminal_command',
]

/**
 * local tool 中需要 require_approval 的工具名集合。
 * JS 隔离执行不在此集合中；它和终端命令一样服从 Agent 保存的审批模式。
 */
const REQUIRE_APPROVAL_LOCAL_TOOLS: ReadonlySet<string> = new Set([
  'fs_file_ops',
  ...LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  'terminal_command',
])

const FULL_ACCESS_LOCAL_TOOLS: ReadonlySet<string> = new Set([
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
])

const buildToolTokenPayload = (tools: readonly McpTool[]): RequestTool[] =>
  tools.map((tool) => ({
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
      budgets.set(
        serverName,
        await estimateJsonTokens(buildToolTokenPayload(tools)),
      )
    }),
  )

  return budgets
}

/**
 * Built-in tools that default to **off** even when the user has never
 * customized preferences. Kept here as the single source of truth so both UI
 * and runtime read the same policy.
 */
export const BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES: ReadonlySet<string> =
  new Set([
    'context_prune_tool_results',
    'context_compact',
    'delegate_subagent',
    JS_SANDBOX_TOOL_NAME,
    'terminal_command',
  ])

/**
 * Full set of user-facing built-in tool FQNs that default to on. Used by the
 * settings migration and `getDefaultEnabledForTool` to seed `toolPreferences`
 * for new or upgrading agents. Runtime never fills these in at read time —
 * `toolPreferences` is the single source of truth for per-agent state, and
 * the migration is the only path that writes defaults into it.
 *
 * Derived from {@link USER_FACING_LOCAL_TOOL_SHORT_NAMES} (which already
 * excludes the protocol-only `load_tool_schemas`) minus the deny-list above.
 */
const USER_FACING_LOCAL_TOOL_SHORT_NAME_SET: ReadonlySet<string> = new Set(
  USER_FACING_LOCAL_TOOL_SHORT_NAMES,
)

export const BUILTIN_DEFAULT_ENABLED_TOOL_FQNS: readonly string[] =
  USER_FACING_LOCAL_TOOL_SHORT_NAMES.filter(
    (shortName) => !BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES.has(shortName),
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
    return !BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES.has(shortName)
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

export const getDefaultApprovalModeForTool = (
  toolName: string,
): AssistantToolApprovalMode => {
  try {
    const { serverName, toolName: parsedToolName } = parseToolName(toolName)
    if (serverName !== getLocalFileToolServerName()) {
      return 'require_approval'
    }

    if (FULL_ACCESS_LOCAL_TOOLS.has(parsedToolName)) {
      return 'full_access'
    }

    return REQUIRE_APPROVAL_LOCAL_TOOLS.has(parsedToolName)
      ? 'require_approval'
      : 'full_access'
  } catch {
    return DEFAULT_ASSISTANT_TOOL_APPROVAL_MODE
  }
}

/**
 * Builds the freshly-seeded `toolPreferences` map for a new assistant: every
 * default-on built-in tool FQN gets an explicit `{ enabled, approvalMode,
 * disclosureMode }` entry. This is the single helper used by creation paths
 * (default assistant, "new agent" UI) and the v60→v61 migration to keep the
 * "toolPreferences is the only source of truth" invariant intact — without
 * it, newly-created agents would surface zero built-in tools at runtime.
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
      disclosureMode: getDefaultDisclosureModeForTool(fqn),
    }
  }
  return result
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
        disclosureMode: getDefaultDisclosureModeForTool(toolName),
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
 * Returns the explicit `enabled: true` entries from `toolPreferences` — no
 * fill-in, no implicit defaults. The settings migration is responsible for
 * making sure every internal tool has an explicit entry by the time runtime
 * reads it, so this function can safely treat absent entries as disabled.
 *
 * Honors `includeBuiltinTools`: when false, internal `yolo_local__*` tools
 * are dropped from the result regardless of their preference, matching what
 * the runtime actually exposes.
 *
 * Does NOT consult `enableTools`; callers gate on that at a higher level so
 * the helper remains useful inside the editor (where the master switch may be
 * temporarily off while the user is staging changes).
 */
export const getEnabledAssistantToolNames = (
  assistant?: Pick<
    Assistant,
    'toolPreferences' | 'enabledToolNames' | 'includeBuiltinTools'
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

export const isAssistantToolEnabled = (
  assistant:
    | Pick<Assistant, 'toolPreferences' | 'enabledToolNames'>
    | null
    | undefined,
  toolName: string,
): boolean => {
  const toolPreferences = getAssistantToolPreferences(assistant)
  return toolPreferences[toolName]?.enabled ?? false
}

export const getAssistantToolApprovalMode = (
  assistant:
    | Pick<
        Assistant,
        'toolPreferences' | 'enabledToolNames' | 'toolServerPreferences'
      >
    | null
    | undefined,
  toolName: string,
): AssistantToolApprovalMode => {
  try {
    const { serverName } = parseToolName(toolName)
    if (serverName !== getLocalFileToolServerName()) {
      return (
        assistant?.toolServerPreferences?.[serverName]?.approvalMode ??
        'require_approval'
      )
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
    | Pick<Assistant, 'toolPreferences' | 'enabledToolNames'>
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

  const toolPreferences = getAssistantToolPreferences(assistant)
  const explicitMode = toolPreferences[toolName]?.disclosureMode
  if (explicitMode) {
    return explicitMode
  }
  if (parsedServerName) {
    return resolveDefaultDisclosureModeForServer(
      options?.serverToolTokenBudgets?.get(parsedServerName),
    )
  }
  return getDefaultDisclosureModeForTool(toolName)
}
