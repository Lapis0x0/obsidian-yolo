import { contextCompactDefinition } from '../context_compact/definition'
import { defineCapability } from '../define'

// label/description copied from the `context_compact` entry in
// `builtinToolUiMeta.ts`; category from `BUILTIN_TOOL_CATEGORY_MAP`
// (`'context'`). The i18n keys are unchanged from the existing locale entries
// (master.md §5: don't rename existing locale keys). `id: 'context_compaction'`
// is a new capability id (decision 16). Kept as its own capability rather
// than merged with `context_pruning` per decision 20.
//
// defaultEnabled/approval cross-checked the same way as `context_pruning`:
// `context_compact` is in `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES` ->
// defaultEnabled: false; not in `FULL_ACCESS_LOCAL_TOOLS` /
// `REQUIRE_APPROVAL_LOCAL_TOOLS` / the bash special-case -> defaultMode:
// 'full_access'; not in `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` ->
// allowAlwaysAllow: true; not one of the three dedicated-settings tools ->
// hasSettings: false.
export const contextCompactionCapability = defineCapability({
  id: 'context_compaction',
  label: {
    key: 'settings.agent.builtinContextCompactLabel',
    fallback: 'Compact Context',
  },
  description: {
    key: 'settings.agent.builtinContextCompactDesc',
    fallback:
      'Compress earlier conversation history into a summary and continue in a fresh context window.',
  },
  category: 'context',
  defaultEnabled: false,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [contextCompactDefinition],
})
