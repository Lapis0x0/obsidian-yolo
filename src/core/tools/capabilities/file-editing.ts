import { defineCapability } from '../define'
import { fsEditDefinition } from '../fs_edit/definition'
import { fsWriteDefinition } from '../fs_write/definition'

// label/description copied from the `fs_edit_ops` group entry in
// `builtinToolUiMeta.ts` (`FILE_EDIT_GROUP_TOOL_NAME`'s label/desc) and
// `BUILTIN_TOOL_CATEGORY_MAP[FILE_EDIT_GROUP_TOOL_NAME]` (`'vault'`). The
// i18n keys are unchanged from the existing locale entries (master.md §5).
// `id: 'file_editing'` is a new capability id (decision 16), independent of
// the old `fs_edit_ops` group-name string.
//
// defaultEnabled cross-checked against the pre-refactor sources: neither
// `fs_edit` nor `fs_write` is in `BUILTIN_DEFAULT_DISABLED_TOOL_SHORT_NAMES`
// -> defaultEnabled: true. Not in `ALWAYS_ALLOW_DISABLED_TOOL_NAMES` ->
// allowAlwaysAllow: true. `fs_edit_ops` is not one of the three
// dedicated-settings tools (`AgentToolsModal.tsx`'s `hasSettings` ternary
// only names js_sandbox/terminal/subagent) and its group-row construction
// hardcodes `hasSettings: false` -> hasSettings: false.
//
// approval.defaultMode is the ONE deliberate behavior change in this whole
// migration (master.md §1.4 / §3.1 / decision 17, confirmed by the user
// 2026-08-15): the pre-refactor sources disagree with each other —
// `fs_edit` itself is absent from `REQUIRE_APPROVAL_LOCAL_TOOLS` (falls
// through to `full_access`) while `fs_write` and the `fs_edit_ops` group
// name are both present (`require_approval`) — and the settings page has
// always *displayed* "Require approval" for this row (aggregating over
// `fs_write`) while the runtime actually ran `fs_edit` with no diff review
// (reading `fs_edit`'s own mode). `require_approval` resolves that
// contradiction toward what the UI already promised, not toward the leakier
// runtime behavior. `fs_edit` gains the diff-review flow it always should
// have had; `fs_write` is unaffected (it never branched on requireReview —
// see `fs_write/definition.ts`'s doc comment).
export const fileEditingCapability = defineCapability({
  id: 'file_editing',
  label: {
    key: 'settings.agent.builtinFsEditOpsLabel',
    fallback: 'File Editing Toolset',
  },
  description: {
    key: 'settings.agent.builtinFsEditOpsDesc',
    fallback:
      'Grouped file editing tools: targeted text edits and full-file writes.',
  },
  category: 'vault',
  defaultEnabled: true,
  approval: {
    defaultMode: 'require_approval',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [fsEditDefinition, fsWriteDefinition],
})
