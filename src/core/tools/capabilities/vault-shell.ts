import { bashDefinition } from '../bash/definition'
import { defineCapability } from '../define'

// label/description copied from the `bash` entry in `builtinToolUiMeta.ts`;
// category from `BUILTIN_TOOL_CATEGORY_MAP` (`'vault'`). The i18n keys are
// unchanged from the existing locale entries (master.md §5). `id:
// 'vault_shell'` is a new capability id (decision 16) for this 1:1 tool
// (decision 14).
//
// defaultEnabled/approval cross-checked against the pre-refactor sources:
// `BASH_TOOL_NAME` ('bash') is NOT in
// `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES` -> defaultEnabled: true. Its
// default approval mode is `getDefaultApprovalModeForTool`'s own
// `parsedToolName === BASH_TOOL_NAME` special case (`tool-preferences.ts`,
// around line 205) -> defaultMode: 'dangerous_only' — the ONLY built-in
// capability with a third approval tier, hence `allowedModes` carries all
// three (`full_access` / `dangerous_only` / `require_approval`), matching
// `bashToolApprovalOptions` in `AgentsSectionContent.tsx`. IS in
// `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` (alongside `terminal_command`) ->
// allowAlwaysAllow: false (master.md §3.1: "禁止 always-allow 的能力：
// terminal、vault_shell"). NOT one of the three dedicated-settings tools
// (`AgentToolsModal.tsx`'s `hasSettings` ternary only lists
// js_eval/terminal_command/delegate_subagent) -> hasSettings: false.
//
// This batch (D6 batch 7) wires `tool-preferences.ts`'s `dangerous_only`
// special case and `AgentsSectionContent.tsx`'s `bashToolApprovalOptions` to
// read their values from this capability's `approval` field rather than
// carrying an independent literal — see those files' own comments. The old
// tables (`REQUIRE_APPROVAL_LOCAL_TOOLS`, `ALWAYS_ALLOW_DISABLED_TOOL_NAMES`,
// the hardcoded three-option array) are NOT deleted; that collapse is D7.
export const vaultShellCapability = defineCapability({
  id: 'vault_shell',
  label: {
    key: 'settings.agent.builtinBashLabel',
    fallback: 'Bash (Vault Shell)',
  },
  description: {
    key: 'settings.agent.builtinBashDesc',
    fallback:
      'A virtual shell for vault search and inspection, plus mkdir/mv/rm path operations. Content edits stay on Text Editing / Write File.',
  },
  category: 'vault',
  defaultEnabled: true,
  approval: {
    defaultMode: 'dangerous_only',
    allowedModes: ['full_access', 'dangerous_only', 'require_approval'],
    allowAlwaysAllow: false,
  },
  hasSettings: false,
  tools: [bashDefinition],
})
