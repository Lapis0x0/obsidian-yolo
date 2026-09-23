import { defineCapability } from '../define'
import { delegateSubagentDefinition } from '../delegate_subagent/definition'

// label/description/category copied from the `delegate_subagent` entry in
// `builtinToolUiMeta.ts:139` / `:192`. The i18n keys are unchanged from the
// existing locale entries (existing locale keys are never renamed).
// `id: 'subagent_delegation'` is a new capability id — `delegate_subagent`
// was already a real tool name (not a group alias like `memory_ops`), so
// unlike `memory`, this id doesn't need to disambiguate from an old group
// string; it's still renamed to keep capability ids in one consistent
// (non-tool-name) namespace.
//
// defaultEnabled/approval cross-checked against the pre-refactor sources: `tool-preferences.ts:101`
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
  chatModes: ['ask', 'agent', 'max'],
  defaultEnabled: false,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  // Which modal opens (`SubagentConfigModal`) is decided by the UI-layer
  // `CAPABILITY_SETTINGS_LAUNCHERS` wiring table, not here: the modal /
  // `model-config.ts` resolution logic is NOT modeled as a capability
  // property.
  hasSettings: true,
  tools: [delegateSubagentDefinition],
})
