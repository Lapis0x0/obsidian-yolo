import { defineCapability } from '../define'
import { terminalCommandDefinition } from '../terminal_command/definition'

// label/description copied from the `terminal_command` entry in
// `builtinToolUiMeta.ts`; category from `BUILTIN_TOOL_CATEGORY_MAP`
// (`'external'`). The i18n keys are unchanged from the existing locale
// entries (master.md §5). `id: 'terminal'` is a new capability id (decision
// 16) for this 1:1 tool (decision 14).
//
// defaultEnabled/approval cross-checked against the pre-refactor sources:
// `terminal_command` IS in `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES` ->
// defaultEnabled: false. IS in `REQUIRE_APPROVAL_LOCAL_TOOLS` ->
// defaultMode: 'require_approval'. IS in `ALWAYS_ALLOW_DISABLED_TOOL_NAMES`
// -> allowAlwaysAllow: false (master.md §3.1: "禁止 always-allow 的能力：
// terminal、vault_shell"). IS one of the three dedicated-settings tools
// (`AgentToolsModal.tsx`'s `hasSettings` ternary) -> hasSettings: true,
// wired to `TerminalCommandConfigModal` via `CAPABILITY_SETTINGS_LAUNCHERS`.
export const terminalCapability = defineCapability({
  id: 'terminal',
  label: {
    key: 'settings.agent.builtinTerminalCommandLabel',
    fallback: 'Terminal Commands',
  },
  description: {
    key: 'settings.agent.builtinTerminalCommandDesc',
    fallback: 'Run commands in the local terminal. Desktop-only.',
  },
  category: 'external',
  defaultEnabled: false,
  approval: {
    defaultMode: 'require_approval',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: false,
  },
  hasSettings: true,
  tools: [terminalCommandDefinition],
})
