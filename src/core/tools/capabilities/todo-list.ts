import { defineCapability } from '../define'
import { todoWriteDefinition } from '../todo_write/definition'

// label/description copied from the `todo_write` entry in
// `builtinToolUiMeta.ts`; category from `BUILTIN_TOOL_CATEGORY_MAP`
// (`'context'`). The i18n keys are unchanged from the existing locale
// entries (master.md §5). `id: 'todo_list'` is a new capability id
// (decision 16) for this 1:1 tool (decision 14: single-tool capabilities are
// still explicit, no exceptions).
//
// defaultEnabled/approval cross-checked against the pre-refactor sources:
// `todo_write` is NOT in `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES` ->
// defaultEnabled: true. Not in `FULL_ACCESS_LOCAL_TOOLS` /
// `REQUIRE_APPROVAL_LOCAL_TOOLS` / the bash special-case -> defaultMode:
// 'full_access'. Not in `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` ->
// allowAlwaysAllow: true. Not one of the three dedicated-settings tools
// (`AgentToolsModal.tsx:114-117`) -> hasSettings: false.
export const todoListCapability = defineCapability({
  id: 'todo_list',
  label: {
    key: 'settings.agent.builtinTodoWriteLabel',
    fallback: 'Task List',
  },
  description: {
    key: 'settings.agent.builtinTodoWriteDesc',
    fallback:
      'Let the agent plan and track multi-step task progress autonomously. Agent mode only.',
  },
  category: 'context',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [todoWriteDefinition],
})
