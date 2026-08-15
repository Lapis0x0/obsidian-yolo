import { contextPruneToolResultsDefinition } from '../context_prune_tool_results/definition'
import { defineCapability } from '../define'

// label/description copied from the `context_prune_tool_results` entry in
// `builtinToolUiMeta.ts`; category from `BUILTIN_TOOL_CATEGORY_MAP`
// (`'context'`). The i18n keys are unchanged from the existing locale entries
// (master.md §5: don't rename existing locale keys). `id: 'context_pruning'`
// is a new capability id (decision 16). Kept as its own capability rather
// than merged with `context_compaction` per decision 20 — the user explicitly
// rejected combining the two context tools.
//
// defaultEnabled/approval cross-checked against the pre-refactor sources:
// `tool-preferences.ts`'s `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES`
// contains `context_prune_tool_results` -> defaultEnabled: false. It is not
// in `FULL_ACCESS_LOCAL_TOOLS`, `REQUIRE_APPROVAL_LOCAL_TOOLS`, or the bash
// special-case -> defaultMode falls through to 'full_access'. Not in
// `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` -> allowAlwaysAllow: true. Not one of
// the three tools with a dedicated settings modal (js_sandbox / terminal /
// subagent_delegation in `AgentToolsModal.tsx:114-117`) -> hasSettings: false.
export const contextPruningCapability = defineCapability({
  id: 'context_pruning',
  label: {
    key: 'settings.agent.builtinContextPruneToolResultsLabel',
    fallback: 'Prune Tool Results',
  },
  description: {
    key: 'settings.agent.builtinContextPruneToolResultsDesc',
    fallback:
      'Exclude selected historical tool results, or prune all prunable tool results at once, from future model-visible context without deleting chat history.',
  },
  category: 'context',
  defaultEnabled: false,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [contextPruneToolResultsDefinition],
})
