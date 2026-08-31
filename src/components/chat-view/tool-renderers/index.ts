import { getBashChatSummary } from '../../../core/tools/bash/chat-summary'
import { delegateSubagentRenderer } from '../../../core/tools/delegate_subagent/ui'
import { getFileEditingPathChatSummary } from '../../../core/tools/file-editing-support'
import { getFsReadChatSummary } from '../../../core/tools/fs_read/chat-summary'
import { getJsEvalChatSummary } from '../../../core/tools/js_eval/chat-summary'
import {
  type BuiltinToolName,
  isBuiltinToolName,
} from '../../../core/tools/registry'
import { terminalCommandRenderer } from '../../../core/tools/terminal_command/ui'
import { getTodoWriteChatSummary } from '../../../core/tools/todo_write/chat-summary'
import { getWebScrapeChatSummary } from '../../../core/tools/web_scrape/chat-summary'
import { getWebSearchChatSummary } from '../../../core/tools/web_search/chat-summary'

import { genericRenderer } from './generic'
import type { ToolRenderer } from './types'

/**
 * The exhaustive chat-rendering wiring table (master.md §3.6 / D4, populated
 * D8).
 *
 * `satisfies Record<BuiltinToolName, ToolRenderer>` — not `Partial` — so
 * forgetting to wire up a newly registered tool is a compile error. Every
 * entry is explicit: `genericRenderer` for "no custom card, no summary" is
 * written out, never omitted or defaulted; tools with a header summary but
 * no custom card use `{ kind: 'generic', summary: ... }` instead of the
 * shared `genericRenderer` constant.
 *
 * `terminal_command` is the only `body`-kind entry (see
 * `core/tools/terminal_command/ui.tsx`); `delegate_subagent` is the only
 * `replace`-kind entry (D3). Every other tool is `generic` — with or
 * without a `summary` — because it renders through the default collapsed
 * card.
 *
 * Tools with no `summary` here (memory_add/update/delete, context_compact,
 * context_prune_tool_results, ask_user_question, delegate_subagent) had no
 * branch in the pre-D8 `if` chain either — their header shows only the
 * title, no summary text. `delegate_subagent` is a special case: its
 * header summary comes from `ToolMessage.tsx`'s own
 * `getDelegateSubagentSummary`, applied as a response-independent override
 * in `getHeadlineDisplayInfo` (unlike `fs_read`'s enrichment, this one
 * genuinely doesn't need the response — but it predates this table and
 * D8's scope note explicitly leaves `getHeadlineDisplayInfo`'s per-tool
 * overrides untouched, so it isn't wired here to avoid two competing
 * sources of truth for the same value).
 */
export const TOOL_RENDERERS = {
  memory_add: genericRenderer,
  memory_update: genericRenderer,
  memory_delete: genericRenderer,
  delegate_subagent: delegateSubagentRenderer,
  context_prune_tool_results: genericRenderer,
  context_compact: genericRenderer,
  todo_write: { kind: 'generic', summary: getTodoWriteChatSummary },
  ask_user_question: genericRenderer,
  fs_read: { kind: 'generic', summary: getFsReadChatSummary },
  fs_edit: { kind: 'generic', summary: getFileEditingPathChatSummary },
  fs_write: { kind: 'generic', summary: getFileEditingPathChatSummary },
  web_search: { kind: 'generic', summary: getWebSearchChatSummary },
  web_scrape: { kind: 'generic', summary: getWebScrapeChatSummary },
  js_eval: { kind: 'generic', summary: getJsEvalChatSummary },
  terminal_command: terminalCommandRenderer,
  bash: { kind: 'generic', summary: getBashChatSummary },
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
export type {
  ToolChatSummaryFn,
  ToolChatSummaryLabels,
  ToolRenderer,
  ToolRendererProps,
} from './types'
