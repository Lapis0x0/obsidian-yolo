import type { ToolRenderer } from './types'

/**
 * Explicit "no custom card" marker for `TOOL_RENDERERS`. A tool wired to
 * this renders through ToolMessage.tsx's default collapsed-card UI —
 * exactly what happens for every built-in tool today. Writing this out
 * per-entry (instead of omitting the entry, or defaulting a missing one to
 * this) is the entire point of the table: `satisfies
 * Record<BuiltinToolName, ToolRenderer>` makes forgetting a new tool a
 * compile error rather than a silent fallback (see master.md §1.4c for the
 * `hasSettings` fallback bug this pattern exists to rule out).
 *
 * Reserved for `getToolRenderer`'s fallback on names that are not built-in
 * tools at all (remote MCP tools, retired names in historical data).
 * `TOOL_RENDERERS` entries must NOT use it: it answers both `kind` and
 * `summary` at once, and a tool's header summary deserves its own decision
 * rather than arriving as a side effect of opting out of a custom card (see
 * `ToolRenderer.summary`). Write `{ kind: 'generic', summary: ... }` out.
 */
export const genericRenderer: ToolRenderer = { kind: 'generic', summary: null }
