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
import { webAccessCapability } from './web-access'

/**
 * The single registration point for all built-in capabilities.
 *
 * Phase 1 (D1-D4) registered the two skeleton-validating samples (`memory`,
 * `subagent_delegation`). D6 migrates the remaining 10 capabilities in
 * batches; this array grows with each batch. Once all of D6 lands, add them
 * here — this is the only place a new capability needs to be registered.
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
] as const
