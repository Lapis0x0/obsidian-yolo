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
 */
export const CAPABILITIES = [
  memoryCapability,
  subagentDelegationCapability,
  contextPruningCapability,
  contextCompactionCapability,
  todoListCapability,
  userQuestionsCapability,
  fileReadingCapability,
  fileEditingCapability,
  webAccessCapability,
  jsSandboxCapability,
  terminalCapability,
  vaultShellCapability,
] as const
