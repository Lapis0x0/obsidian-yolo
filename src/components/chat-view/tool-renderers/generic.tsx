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
 */
export const genericRenderer: ToolRenderer = { kind: 'generic' }
