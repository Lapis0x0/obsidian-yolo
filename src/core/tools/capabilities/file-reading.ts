import { defineCapability } from '../define'
import { fsReadDefinition } from '../fs_read/definition'

// label/description copied from the `fs_read` entry in `builtinToolUiMeta.ts`;
// category from `BUILTIN_TOOL_CATEGORY_MAP` (`'vault'`). The i18n keys are
// unchanged from the existing locale entries (master.md §5). `id:
// 'file_reading'` is a new capability id (decision 16) for this 1:1 tool
// (decision 14).
//
// defaultEnabled/approval cross-checked against the pre-refactor sources:
// `fs_read` is NOT in `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES` ->
// defaultEnabled: true. Not in `FULL_ACCESS_LOCAL_TOOLS`,
// `REQUIRE_APPROVAL_LOCAL_TOOLS` (that set only has `FILE_EDIT_GROUP_TOOL_NAME`,
// the web split-action tools, and `terminal_command`), or the bash
// special-case -> defaultMode falls through to 'full_access'. Not in
// `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` -> allowAlwaysAllow: true. Not one of
// the three dedicated-settings tools -> hasSettings: false. Matches
// master.md §3.1's capability table row for `file_reading` exactly.
export const fileReadingCapability = defineCapability({
  id: 'file_reading',
  label: {
    key: 'settings.agent.builtinFsReadLabel',
    fallback: 'Read File',
  },
  description: {
    key: 'settings.agent.builtinFsReadDesc',
    fallback:
      'Read vault files, skills, or open web pages by path with full-file or line-range operations.',
  },
  category: 'vault',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [fsReadDefinition],
})
