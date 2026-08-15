import { defineCapability } from '../define'
import { delegateSubagentDefinition } from '../delegate_subagent/definition'

// label/description/category copied from the `delegate_subagent` entry in
// `builtinToolUiMeta.ts:139` / `:192`. The i18n keys are unchanged from the
// existing locale entries (master.md §5: don't rename existing locale keys).
// `id: 'subagent_delegation'` is a new capability id (decision 16) —
// `delegate_subagent` was already a real tool name (not a group alias like
// `memory_ops`), so unlike `memory`, this id doesn't need to disambiguate
// from an old group string; it's still renamed to keep capability ids in one
// consistent (non-tool-name) namespace, per decision 16.
//
// defaultEnabled/approval copied from master.md §3.1's capability table and
// cross-checked against the pre-refactor sources: `tool-preferences.ts:101`
// (`delegate_subagent` in `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES` ->
// defaultEnabled: false) and the `getDefaultApprovalModeForTool` fallthrough
// (`delegate_subagent` is not in `REQUIRE_APPROVAL_LOCAL_TOOLS` or the bash
// special-case -> defaultMode: 'full_access'). Not in
// `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` -> allowAlwaysAllow: true.
export const subagentDelegationCapability = defineCapability({
  id: 'subagent_delegation',
  label: {
    key: 'settings.agent.builtinDelegateSubagentLabel',
    fallback: 'Delegate Subagent',
  },
  description: {
    key: 'settings.agent.builtinDelegateSubagentDesc',
    fallback:
      'Dispatch an isolated temporary sub-agent to complete a self-contained task asynchronously.',
  },
  category: 'external',
  defaultEnabled: false,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  // Which modal opens (`SubagentConfigModal`) is decided by the UI-layer
  // `CAPABILITY_SETTINGS_LAUNCHERS` wiring table (D4), not here — see D3
  // question 3 in the phase report: the modal / `model-config.ts` resolution
  // logic is NOT modeled as a capability property.
  hasSettings: true,
  tools: [delegateSubagentDefinition],
})
