import type { McpTool } from '../../../../types/mcp.types'

/**
 * `load_tool_schemas` is a protocol-internal tool, not a user-authorized
 * capability: it exists solely to power the on-demand tool-disclosure
 * mechanism (see `core/agent/tool-selection.ts`'s loader-injection logic),
 * and the agent runtime intercepts calls to it before they ever reach the
 * dispatcher (`core/agent/tool-gateway.ts`). Per master.md §3.1 / D6b, it
 * therefore does NOT go through `defineTool`/`CAPABILITIES` — it has no
 * `isAvailable`, `chatLabel`, or `execute` in the `BuiltinToolDefinition`
 * sense, no approval tier, and must never appear in the settings page or the
 * per-agent tool preference surface. `getLocalFileTools()`
 * (`core/mcp/localFileTools.ts`) does not include it in the returned catalog
 * for that reason; `tool-selection.ts` splices it in directly by name when
 * (and only when) on-demand disclosure is active for the request.
 */
export const LOAD_TOOL_SCHEMAS_TOOL_NAME = 'load_tool_schemas'

/**
 * Standalone tool definition for `load_tool_schemas`, moved here verbatim
 * from `core/mcp/localFileTools.ts` (D6b — see that migration's own note:
 * "进 internal/，不属任何 capability，固定 full_access，不出现在设置页").
 * Used by the runtime to inject the loader on demand (when
 * `enableToolDisclosure=true` AND the filtered tool set contains any
 * `on_demand` tool).
 */
export function getLoadToolSchemasTool(): McpTool {
  return {
    name: LOAD_TOOL_SCHEMAS_TOOL_NAME,
    description:
      'Load full schemas for all on-demand tools belonging to the given MCP servers, making them callable in the next turn. Pass MCP server names (the prefix before "__" in any stub tool name) — batch multiple servers when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'MCP server names whose on-demand tools should be loaded (e.g. "context7", "deepwiki").',
        },
      },
      required: ['servers'],
    },
  }
}
