import { contextCompactionCapability } from './context-compaction'
import { contextPruningCapability } from './context-pruning'
import { fileEditingCapability } from './file-editing'
import { fileReadingCapability } from './file-reading'
import { jsSandboxCapability } from './js-sandbox'
import { memoryCapability } from './memory'
import { subagentDelegationCapability } from './subagent-delegation'
import { terminalCapability } from './terminal'
import { todoListCapability } from './todo-list'
import { userQuestionsCapability } from './user-questions'
import { vaultShellCapability } from './vault-shell'
import { webAccessCapability } from './web-access'

/**
 * The single registration point for all built-in capabilities.
 *
 * Phase 1 (D1-D4) registered the two skeleton-validating samples (`memory`,
 * `subagent_delegation`). D6 migrated the remaining 10 capabilities in
 * batches; `vault_shell` (batch 7) is the last of them. This is the only
 * place a new capability needs to be registered.
 *
 * Registration order is also display order (D7,
 * docs/plans/2026-08-15-tool-registry/phase2-migration.md D7 item 3): the
 * settings page renders capabilities within a category in this array's
 * order, with no separate `BUILTIN_TOOL_DISPLAY_ORDER` table. Order below is
 * grouped by category and matches the pre-D7 display order exactly —
 * vault: fs_read -> bash -> fs_edit_ops; context: context_prune_tool_results
 * -> context_compact -> ask_user_question -> todo_write -> memory_ops;
 * external: web_ops -> js_eval -> terminal_command -> delegate_subagent (see
 * master.md §3.1's category column plus the external category's former
 * `BUILTIN_TOOL_DISPLAY_ORDER` list, and the vault/context orders' former
 * natural-registration/DOM order) — see the D7 capability-row-order
 * regression test in `AgentsSectionContent.capability-rows.test.ts`.
 */
export const CAPABILITIES = [
  fileReadingCapability,
  vaultShellCapability,
  fileEditingCapability,
  contextPruningCapability,
  contextCompactionCapability,
  userQuestionsCapability,
  todoListCapability,
  memoryCapability,
  webAccessCapability,
  jsSandboxCapability,
  terminalCapability,
  subagentDelegationCapability,
] as const
