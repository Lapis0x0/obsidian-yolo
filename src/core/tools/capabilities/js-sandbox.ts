import { defineCapability } from '../define'
import { jsEvalDefinition } from '../js_eval/definition'

// label/description copied from the `js_eval` entry in `builtinToolUiMeta.ts`;
// category from `BUILTIN_TOOL_CATEGORY_MAP` (`'external'`). The i18n keys are
// unchanged from the existing locale entries (master.md §5). `id:
// 'js_sandbox'` is a new capability id (decision 16) for this 1:1 tool
// (decision 14).
//
// defaultEnabled/approval cross-checked against the pre-refactor sources:
// `JS_SANDBOX_TOOL_NAME` ('js_eval') IS in
// `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES` -> defaultEnabled: false. Not in
// `FULL_ACCESS_LOCAL_TOOLS` / `REQUIRE_APPROVAL_LOCAL_TOOLS` (that set only
// has `FILE_EDIT_GROUP_TOOL_NAME`, the split fs_edit/fs_write names, and
// `terminal_command` — `js_eval` is explicitly called out as "not in this
// set" by that file's own comment: "JS 隔离执行不在此集合中；它和终端命令一样
// 服从 Agent 保存的审批模式") or the bash special-case -> defaultMode falls
// through to 'full_access'. Not in `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` ->
// allowAlwaysAllow: true. IS one of the three dedicated-settings tools
// (`AgentToolsModal.tsx`'s `hasSettings` ternary) -> hasSettings: true, wired
// to `JsSandboxConfigModal` via `CAPABILITY_SETTINGS_LAUNCHERS`.
export const jsSandboxCapability = defineCapability({
  id: 'js_sandbox',
  label: {
    key: 'settings.agent.builtinJsEvalLabel',
    fallback: 'Analysis Sandbox',
  },
  description: {
    key: 'settings.agent.builtinJsEvalDesc',
    fallback:
      'Run JavaScript in an isolated sandbox for precise computation, batch statistics, and data processing; grant retrieval, vault read-only, and network capabilities individually.',
  },
  category: 'external',
  defaultEnabled: false,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: true,
  tools: [jsEvalDefinition],
})
