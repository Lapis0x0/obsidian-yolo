import type { McpTool } from '../../../../types/mcp.types'
import { asStringArray } from '../../chat-summary-support'
import type { I18nText } from '../../types'

/**
 * `load_tool_schemas` is a protocol-internal tool, not a user-authorized
 * capability: it exists solely to power the on-demand tool-disclosure
 * mechanism (see `core/agent/tool-selection.ts`'s loader-injection logic),
 * and the agent runtime intercepts calls to it before they ever reach the
 * dispatcher (`core/agent/tool-gateway.ts`). Per master.md §3.1 / D6b, it
 * therefore does NOT go through `defineTool`/`CAPABILITIES` — it has no
 * `isAvailable` or `execute` in the `BuiltinToolDefinition` sense, no
 * approval tier, and must never appear in the settings page or the per-agent
 * tool preference surface. `getLocalFileTools()`
 * (`core/mcp/localFileTools.ts`) does not include it in the returned catalog
 * for that reason; `tool-selection.ts` splices it in directly by name when
 * (and only when) on-demand disclosure is active for the request.
 */
export const LOAD_TOOL_SCHEMAS_TOOL_NAME = 'load_tool_schemas'

/**
 * Unlike `isAvailable`/`execute`, this tool IS visible mid-conversation — the
 * model can call it, and the chat transcript renders it like any other tool
 * call. So it still needs a chat-surface label, same as every registered
 * tool's `chatLabel`. Kept as a standalone export (not a `BuiltinToolDefinition`
 * field, since this isn't one) so `ToolMessage.tsx`'s `displayNames` builder
 * can fold it in next to the registry-derived tools (D7,
 * phase2-migration.md D7 item 1 note on `load_tool_schemas`). Key/fallback
 * carried over unchanged from the retired `BUILTIN_TOOL_UI_META.load_tool_schemas`
 * entry.
 */
export const LOAD_TOOL_SCHEMAS_CHAT_LABEL: I18nText = {
  key: 'settings.agent.builtinToolSearchLabel',
  fallback: 'Load Tool',
}

/**
 * Chat-surface summary for `load_tool_schemas` — ported verbatim from the
 * `toolName === 'load_tool_schemas'` branch of `ToolMessage.tsx`'s private
 * `getLocalToolSummaryText` (pre-D8). Not part of `TOOL_RENDERERS` (this
 * tool isn't a `BuiltinToolName` — see this file's own doc comment above),
 * so `ToolMessage.tsx` calls it directly, next to how it already folds in
 * `LOAD_TOOL_SCHEMAS_CHAT_LABEL` above.
 */
export const getLoadToolSchemasChatSummary = ({
  argumentsObject,
}: {
  argumentsObject: Record<string, unknown> | null
}): string | undefined => {
  const names = [
    ...(asStringArray(argumentsObject?.tools) ?? []),
    ...(asStringArray(argumentsObject?.servers) ?? []),
  ]
  if (names.length === 0) {
    return undefined
  }
  const head = names.slice(0, 2).join(', ')
  const rest = names.length - 2
  return rest > 0 ? `${head} +${rest}` : head
}

/**
 * Standalone tool definition for `load_tool_schemas`, moved here verbatim
 * from `core/mcp/localFileTools.ts` (D6b — see that migration's own note:
 * "进 internal/，不属任何 capability，固定 full_access，不出现在设置页").
 * Used by the runtime to inject the loader on demand (when
 * the filtered tool set contains any `on_demand` tool).
 */
export function getLoadToolSchemasTool(): McpTool {
  return {
    name: LOAD_TOOL_SCHEMAS_TOOL_NAME,
    description:
      'Load the full schemas for tools listed in <tool_catalog>, making them callable through yolo_local__invoke_tool in the next turn. Pass the exact tool names you need — batch several in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Fully-qualified tool names, copied verbatim from <tool_catalog> (e.g. "notion__notion-search").',
        },
        servers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional shorthand: load every deferred tool belonging to these servers. Prefer naming the individual tools you need.',
        },
      },
    },
  }
}
