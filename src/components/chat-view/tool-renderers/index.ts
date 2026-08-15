import { delegateSubagentRenderer } from '../../../core/tools/delegate_subagent/ui'
import {
  type BuiltinToolName,
  isBuiltinToolName,
} from '../../../core/tools/registry'

import { genericRenderer } from './generic'
import type { ToolRenderer } from './types'

/**
 * The exhaustive chat-rendering wiring table (master.md §3.6 / D4).
 *
 * `satisfies Record<BuiltinToolName, ToolRenderer>` — not `Partial` — so
 * forgetting to wire up a newly registered tool is a compile error. Every
 * entry is explicit: `genericRenderer` for "no custom card" is written out,
 * never omitted or defaulted.
 *
 * Only 4 entries today because `BuiltinToolName` is derived from the
 * `CAPABILITIES` array (registry.ts), which so far only has `memory` (D2)
 * and `subagent_delegation` (D3) registered. As D6 registers the remaining
 * 10 capabilities, `BuiltinToolName` grows and this table must grow with
 * it — that growth is exactly what this `satisfies` clause enforces.
 */
export const TOOL_RENDERERS = {
  memory_add: genericRenderer,
  memory_update: genericRenderer,
  memory_delete: genericRenderer,
  delegate_subagent: delegateSubagentRenderer,
  context_prune_tool_results: genericRenderer,
  context_compact: genericRenderer,
  todo_write: genericRenderer,
  ask_user_question: genericRenderer,
  fs_read: genericRenderer,
  fs_edit: genericRenderer,
  fs_write: genericRenderer,
  web_search: genericRenderer,
  web_scrape: genericRenderer,
  js_eval: genericRenderer,
  terminal_command: genericRenderer,
} satisfies Record<BuiltinToolName, ToolRenderer>

/**
 * Safe by-name lookup for callers that only have a `string` (a remote MCP
 * tool name, or a retired built-in tool name still present in historical
 * conversation data — see master.md decision 10). Never index
 * `TOOL_RENDERERS` directly with an unchecked `string`.
 */
export const getToolRenderer = (name: string): ToolRenderer =>
  isBuiltinToolName(name) ? TOOL_RENDERERS[name] : genericRenderer

export { genericRenderer } from './generic'
export type { ToolRenderer, ToolRendererProps } from './types'
