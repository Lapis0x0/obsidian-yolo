import type {
  McpDiscoveredCatalog,
  McpServerConfig,
} from '../../types/mcp.types'
import { getToolName } from '../mcp/tool-name-utils'

/**
 * The model-facing catalog of tools that are NOT registered in the request's
 * `tools` field. It rides the system prompt (a frozen per-conversation
 * snapshot) rather than the `tools` array, so adding a deferred tool costs a
 * name — roughly 8 tokens — instead of a full schema.
 *
 * Deliberately carries no per-tool descriptions. A catalog entry is paid for
 * by every conversation forever; the ambiguity a bare name leaves behind is
 * paid only when the model actually reaches for that server, and is resolved
 * by one batched `load_tool_schemas` round-trip. Descriptions belong at the
 * *group* level, where the cost is O(servers) rather than O(tools).
 *
 * Built from persisted discovery (`settings.mcp.discoveredCatalogs`) rather
 * than live connection state: a configured server that is currently offline
 * still appears, and calling into it reports a connection failure instead of
 * "no such tool". That also keeps the catalog — and therefore the frozen
 * prompt prefix — from churning when a server drops and reconnects.
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
 * Group label for one server. The locally configured id is user-chosen and
 * frequently opaque (`cf`, `ca`, `playright`), so the server's own reported
 * identity wins when it provided one. `title` and `description` are optional
 * in the MCP protocol and were added to it late, hence the fallback chain.
 */
const resolveGroupLabel = (
  serverId: string,
  catalog: McpDiscoveredCatalog | undefined,
): string => {
  const reported = catalog?.serverInfo
  const label = reported?.title?.trim() || reported?.name?.trim()
  return label && label.length > 0 ? label : serverId
}

export const buildDeferredToolCatalog = ({
  configuredServers,
  discoveredCatalogs,
  isDeferredAndEnabled,
}: {
  configuredServers: readonly McpServerConfig[]
  discoveredCatalogs: Readonly<Record<string, McpDiscoveredCatalog>>
  /**
   * Whether this fully-qualified tool name is both enabled for the current
   * agent and on the deferred tier. Tool policy lives with the caller; this
   * module owns only grouping and formatting.
   */
  isDeferredAndEnabled: (toolName: string) => boolean
}): DeferredToolCatalog | null => {
  const groups: string[] = []
  const allToolNames: string[] = []

  for (const server of configuredServers) {
    // Disabled servers are not addressable at all, so listing them would
    // advertise capabilities that can never resolve. Offline-but-enabled
    // servers DO stay listed — that distinction is the whole point of
    // building from configuration rather than connection state.
    if (!server.enabled) {
      continue
    }
    const catalog = discoveredCatalogs[server.id]
    if (!catalog || catalog.toolNames.length === 0) {
      continue
    }

    const toolNames = catalog.toolNames
      .map((shortName) => getToolName(server.id, shortName))
      .filter((fqn) => isDeferredAndEnabled(fqn))
      .sort()
    if (toolNames.length === 0) {
      continue
    }

    const description = catalog.serverInfo?.description?.trim()
    const heading = description
      ? `${resolveGroupLabel(server.id, catalog)} — ${description}`
      : resolveGroupLabel(server.id, catalog)
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
