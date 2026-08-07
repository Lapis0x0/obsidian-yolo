import {
  BUILTIN_DEFAULT_ENABLED_TOOL_FQNS,
  getDefaultApprovalModeForTool,
} from '../../../core/agent/tool-preferences'
import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v78→v79: purely additive schema bump, plus seeding the new `bash` tool.
 *
 * - `builtinToolProvider` enum gains `'deepseek'`.
 * - `builtinTools` gains an optional `deepseek` sub-key (model-level toggle
 *   for DeepSeek's server-side web search).
 * - The virtual `bash` tool replaces `fs_list`/`fs_search`/`fs_read`/
 *   `fs_create_dir`/`fs_delete`/`fs_move` (see YOLO-45). Same fill-in as the
 *   v60→v61 migration: every assistant missing an entry for a currently
 *   default-on built-in FQN gets `{ enabled: true, approvalMode }` written in
 *   — today that only ever adds `bash` for assistants that already migrated
 *   through v61 (everything else they had is already explicit and untouched).
 *   Stale `toolPreferences` entries for the six retired tool names are left
 *   alone; they're simply never read again.
 *
 * Existing v78 data is forward-compatible — every new field is optional and
 * old values stay valid.
 */
export const migrateFrom78To79: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 79 }

  if (!Array.isArray(next.assistants)) {
    return next
  }

  next.assistants = next.assistants.map((assistant: unknown) => {
    if (!isRecord(assistant)) return assistant

    const existing = isRecord(assistant.toolPreferences)
      ? assistant.toolPreferences
      : {}

    const sanitized: Record<string, unknown> = { ...existing }
    let changed = false
    for (const fqn of BUILTIN_DEFAULT_ENABLED_TOOL_FQNS) {
      if (Object.prototype.hasOwnProperty.call(sanitized, fqn)) continue
      sanitized[fqn] = {
        enabled: true,
        approvalMode: getDefaultApprovalModeForTool(fqn),
      }
      changed = true
    }

    if (!changed) return assistant

    return {
      ...assistant,
      toolPreferences: sanitized,
    }
  })

  return next
}
