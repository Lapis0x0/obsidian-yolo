import { defineCapability } from '../define'
import { memoryAddDefinition } from '../memory_add/definition'
import { memoryDeleteDefinition } from '../memory_delete/definition'
import { memoryUpdateDefinition } from '../memory_update/definition'

// label/description/category copied from the `memory_ops` group entries in
// `builtinToolUiMeta.ts` (`MEMORY_OPS_GROUP_TOOL_NAME` label/desc and
// `BUILTIN_TOOL_CATEGORY_MAP[MEMORY_OPS_GROUP_TOOL_NAME]`). The i18n keys are
// unchanged from the existing locale entries (master.md §5: don't rename
// existing locale keys). `id: 'memory'` is a new capability id, independent
// of the i18n key and of the old `memory_ops` group-name string (decision 16).
export const memoryCapability = defineCapability({
  id: 'memory',
  label: {
    key: 'settings.agent.builtinMemoryOpsLabel',
    fallback: 'Memory Toolset',
  },
  description: {
    key: 'settings.agent.builtinMemoryOpsDesc',
    fallback: 'Grouped memory operations: add, update, and delete memory.',
  },
  category: 'context',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [memoryAddDefinition, memoryUpdateDefinition, memoryDeleteDefinition],
})
