import type {
  McpDiscoveredCatalog,
  McpServerConfig,
  McpTool,
} from '../../types/mcp.types'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
import { getToolName, parseToolName } from '../mcp/tool-name-utils'

/**
 * One group in the model-facing catalog: a set of tools addressed under a
 * common prefix, with whatever human-readable identity we have for it.
 */
export type ToolSetDescriptor = {
  /** Prefix used to build fully-qualified names. */
  id: string
  /** Group heading. Falls back to `id` when nothing better is known. */
  label: string
  /** One line about the whole set. O(sets), never O(tools) — see below. */
  description?: string
  /** Short (unprefixed) tool names. */
  toolNames: string[]
}

/**
 * The model-facing catalog of tools that are NOT registered in the request's
 * `tools` field. It rides the system prompt (a frozen per-conversation
 * snapshot) rather than the `tools` array, so adding a deferred tool costs a
 * name — roughly 8 tokens — instead of a full schema.
 *
 * Deliberately carries no per-tool descriptions. A catalog entry is paid for
 * by every conversation forever; the ambiguity a bare name leaves behind is
 * paid only when the model actually reaches for that set, and is resolved by
 * one batched `load_tool_schemas` round-trip. Descriptions belong at the
 * *group* level, where the cost is O(sets) rather than O(tools).
 */
export type DeferredToolCatalog = {
  /** System-prompt text. Empty catalogs produce `null`, not an empty section. */
  text: string
  /** Fully-qualified names listed, sorted. The system-prompt fingerprint input. */
  toolNames: string[]
}

const CATALOG_INSTRUCTION = [
  'Tools below are available but their schemas are not loaded.',
  'To use one, first call `yolo_local__load_tool_schemas` with the exact names you need',
  '(batch several in one call), then call it through `yolo_local__invoke_tool`.',
].join(' ')

/**
 * MCP tool sets, built from *configuration* rather than connection state.
 *
 * A configured server that is currently offline still appears, so the catalog
 * — and with it the frozen prompt prefix — does not churn when a server drops
 * and reconnects. Calling into an offline server reports a connection failure,
 * which is more useful to the model than the tool silently not existing.
 *
 * Disabled servers are dropped: they are not addressable at all, so listing
 * them would advertise a capability that can never resolve.
 */
export const describeMcpToolSets = ({
  configuredServers,
  discoveredCatalogs,
}: {
  configuredServers: readonly McpServerConfig[]
  discoveredCatalogs: Readonly<Record<string, McpDiscoveredCatalog>>
}): ToolSetDescriptor[] => {
  const sets: ToolSetDescriptor[] = []
  for (const server of configuredServers) {
    if (!server.enabled) continue
    const catalog = discoveredCatalogs[server.id]
    if (!catalog || catalog.toolNames.length === 0) continue

    // The locally configured id is user-chosen and frequently opaque (`cf`,
    // `ca`, `playright`), so the server's own reported identity wins when it
    // provided one. `title` and `description` are optional in the MCP protocol
    // and were added to it late, hence the fallback chain.
    const reported = catalog.serverInfo
    const label = reported?.title?.trim() || reported?.name?.trim() || server.id
    const description = reported?.description?.trim()
    sets.push({
      id: server.id,
      label,
      ...(description ? { description } : {}),
      toolNames: catalog.toolNames,
    })
  }
  return sets
}

/**
 * In-process tool sets — module-registered tools, addressed under the same
 * `server__tool` scheme but served without a transport.
 *
 * Unlike MCP these need no persisted discovery: `InProcessToolServer.listTools`
 * is synchronous, so a set is either present because its owner is active, or
 * absent because it is not. There is no offline state to paper over.
 */
export const describeInProcessToolSets = ({
  availableTools,
  configuredServerIds,
}: {
  availableTools: readonly McpTool[]
  /** MCP server ids, so their tools are not described twice. */
  configuredServerIds: ReadonlySet<string>
}): ToolSetDescriptor[] => {
  const localServerName = getLocalFileToolServerName()
  const byServer = new Map<string, string[]>()
  for (const tool of availableTools) {
    let serverName: string
    let shortName: string
    try {
      ;({ serverName, toolName: shortName } = parseToolName(tool.name))
    } catch {
      continue
    }
    if (serverName === localServerName || configuredServerIds.has(serverName)) {
      continue
    }
    const bucket = byServer.get(serverName) ?? []
    bucket.push(shortName)
    byServer.set(serverName, bucket)
  }
  return [...byServer.entries()].map(([id, toolNames]) => ({
    id,
    label: id,
    toolNames,
  }))
}

export const buildDeferredToolCatalog = ({
  toolSets,
  isDeferredAndEnabled,
}: {
  toolSets: readonly ToolSetDescriptor[]
  /**
   * Whether this fully-qualified tool name is both enabled for the current
   * agent and on the deferred tier. Tool policy lives with the caller; this
   * module owns only grouping and formatting.
   */
  isDeferredAndEnabled: (toolName: string) => boolean
}): DeferredToolCatalog | null => {
  const groups: string[] = []
  const allToolNames: string[] = []

  for (const set of [...toolSets].sort((a, b) => a.id.localeCompare(b.id))) {
    const toolNames = set.toolNames
      .map((shortName) => getToolName(set.id, shortName))
      .filter((fqn) => isDeferredAndEnabled(fqn))
      .sort()
    if (toolNames.length === 0) continue

    const heading = set.description
      ? `${set.label} — ${set.description}`
      : set.label
    groups.push([heading, ...toolNames.map((name) => `  ${name}`)].join('\n'))
    allToolNames.push(...toolNames)
  }

  if (groups.length === 0) {
    return null
  }

  return {
    text: `<tool_catalog>\n${CATALOG_INSTRUCTION}\n\n${groups.join('\n\n')}\n</tool_catalog>`,
    toolNames: allToolNames.sort(),
  }
}
