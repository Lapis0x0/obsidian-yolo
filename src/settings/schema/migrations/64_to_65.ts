import type { SettingMigration } from '../setting.types'

/**
 * v64→v65: collapse the fs write tool family.
 *
 *   - `fs_create_file` → `fs_write` (rename; create-or-overwrite semantics)
 *   - `fs_delete_file` + `fs_delete_dir` → `fs_delete` (merge)
 *   - `fs_create_dir` / `fs_move` unchanged
 *
 * Tool state lives in three places, all keyed by tool name in either the bare
 * form (`fs_create_file`) or the fully-qualified form
 * (`yolo_local__fs_create_file`). This migration remaps all three:
 *
 *   1. `assistants[].toolPreferences` — per-agent enabled / approvalMode /
 *      disclosureMode. The merge into `fs_delete` uses a conservative union
 *      (see mergeDeletePreference).
 *   2. `mcp.builtinToolOptions` — `{ disabled? }` per tool; `fs_delete` is
 *      disabled if either legacy delete tool was disabled.
 *   3. `assistants[].enabledToolNames` — stores the group name `fs_file_ops`
 *      (unchanged), but any leftover split FQN is renamed defensively.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const FQN_PREFIX = 'yolo_local__'

const WRITE_PROVIDER = 'fs_create_file'
const DELETE_FILE = 'fs_delete_file'
const DELETE_DIR = 'fs_delete_dir'

const WRITE_TARGET = 'fs_write'
const DELETE_TARGET = 'fs_delete'

/** Split a key into its optional FQN prefix and the bare tool short name. */
const splitKey = (key: string): { prefix: string; shortName: string } => {
  if (key.startsWith(FQN_PREFIX)) {
    return { prefix: FQN_PREFIX, shortName: key.slice(FQN_PREFIX.length) }
  }
  return { prefix: '', shortName: key }
}

/** Rename a single tool key (bare or FQN), preserving its prefix form. */
const renameToolKey = (key: string): string => {
  const { prefix, shortName } = splitKey(key)
  if (shortName === WRITE_PROVIDER) {
    return `${prefix}${WRITE_TARGET}`
  }
  if (shortName === DELETE_FILE || shortName === DELETE_DIR) {
    return `${prefix}${DELETE_TARGET}`
  }
  return key
}

type ToolPreference = {
  enabled?: boolean
  approvalMode?: 'full_access' | 'require_approval'
  disclosureMode?: 'always' | 'on_demand'
}

const asToolPreference = (value: unknown): ToolPreference =>
  isRecord(value) ? (value as ToolPreference) : {}

/**
 * Conservative union of the two legacy delete-tool preferences:
 *   - enabled: only if BOTH delete tools were enabled. A missing `enabled`
 *     field — or a missing preference entry entirely — counts as `false`, to
 *     match the runtime default (`toolPreferences[x]?.enabled ?? false` in
 *     getAssistantToolEnabled). The merged fs_delete grants both file and
 *     folder deletion, so it stays enabled only when the user had both.
 *   - approvalMode: require_approval if EITHER required it
 *   - disclosureMode: on_demand (more hidden) if EITHER was on_demand
 */
const mergeDeletePreference = (
  a: ToolPreference | undefined,
  b: ToolPreference | undefined,
): ToolPreference => {
  const present = [a, b].filter((p): p is ToolPreference => p !== undefined)
  if (present.length === 0) {
    return {}
  }

  const result: ToolPreference = {}

  // A missing side (undefined) is an absent preference → not enabled.
  result.enabled = (a?.enabled ?? false) && (b?.enabled ?? false)

  if (present.some((p) => p.approvalMode === 'require_approval')) {
    result.approvalMode = 'require_approval'
  } else if (present.some((p) => p.approvalMode === 'full_access')) {
    result.approvalMode = 'full_access'
  }

  if (present.some((p) => p.disclosureMode === 'on_demand')) {
    result.disclosureMode = 'on_demand'
  } else if (present.some((p) => p.disclosureMode === 'always')) {
    result.disclosureMode = 'always'
  }

  return result
}

/**
 * Resolve a write key on collision. A `fs_write` key present at the 64→65
 * boundary can only be a default seeded by an earlier migration step running
 * against current (post-rename) defaults — no real pre-v65 data used the
 * `fs_write` name — so a legacy `fs_create_file` value always wins.
 */
const resolveWrite = (bucket: {
  legacy?: unknown
  existing?: unknown
}): unknown => (bucket.legacy !== undefined ? bucket.legacy : bucket.existing)

/**
 * Remap a `{ [toolKey]: ToolPreference }` record. Collapses the legacy delete
 * keys (in whichever prefix form they appear) into a single `fs_delete` key
 * per prefix form, and renames `fs_create_file` → `fs_write`.
 */
const remapToolPreferences = (
  preferences: Record<string, unknown>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = {}
  // Collect delete preferences per prefix form so FQN and bare keys merge
  // independently (they target different config surfaces).
  const deleteByPrefix = new Map<
    string,
    { file?: ToolPreference; dir?: ToolPreference }
  >()
  // Collect write preferences per prefix so a legacy `fs_create_file` value can
  // win over any pre-existing `fs_write` on collision (see resolveWrite below).
  const writeByPrefix = new Map<
    string,
    { legacy?: unknown; existing?: unknown }
  >()

  for (const [key, value] of Object.entries(preferences)) {
    const { prefix, shortName } = splitKey(key)
    if (shortName === DELETE_FILE || shortName === DELETE_DIR) {
      const bucket = deleteByPrefix.get(prefix) ?? {}
      if (shortName === DELETE_FILE) {
        bucket.file = asToolPreference(value)
      } else {
        bucket.dir = asToolPreference(value)
      }
      deleteByPrefix.set(prefix, bucket)
      continue
    }
    if (shortName === WRITE_PROVIDER || shortName === WRITE_TARGET) {
      const bucket = writeByPrefix.get(prefix) ?? {}
      if (shortName === WRITE_PROVIDER) {
        bucket.legacy = value
      } else {
        bucket.existing = value
      }
      writeByPrefix.set(prefix, bucket)
      continue
    }
    next[key] = value
  }

  for (const [prefix, bucket] of deleteByPrefix.entries()) {
    next[`${prefix}${DELETE_TARGET}`] = mergeDeletePreference(
      bucket.file,
      bucket.dir,
    )
  }

  for (const [prefix, bucket] of writeByPrefix.entries()) {
    const resolved = resolveWrite(bucket)
    if (resolved !== undefined) {
      next[`${prefix}${WRITE_TARGET}`] = resolved
    }
  }

  return next
}

type BuiltinToolOption = { disabled?: boolean }

const remapBuiltinToolOptions = (
  options: Record<string, unknown>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = {}
  const deleteByPrefix = new Map<string, boolean>()
  const writeByPrefix = new Map<
    string,
    { legacy?: unknown; existing?: unknown }
  >()

  for (const [key, value] of Object.entries(options)) {
    const { prefix, shortName } = splitKey(key)
    if (shortName === DELETE_FILE || shortName === DELETE_DIR) {
      const option = isRecord(value) ? (value as BuiltinToolOption) : {}
      const prev = deleteByPrefix.get(prefix) ?? false
      deleteByPrefix.set(prefix, prev || option.disabled === true)
      continue
    }
    if (shortName === WRITE_PROVIDER || shortName === WRITE_TARGET) {
      const bucket = writeByPrefix.get(prefix) ?? {}
      if (shortName === WRITE_PROVIDER) {
        bucket.legacy = value
      } else {
        bucket.existing = value
      }
      writeByPrefix.set(prefix, bucket)
      continue
    }
    next[key] = value
  }

  for (const [prefix, disabled] of deleteByPrefix.entries()) {
    next[`${prefix}${DELETE_TARGET}`] = disabled ? { disabled: true } : {}
  }

  for (const [prefix, bucket] of writeByPrefix.entries()) {
    const resolved = resolveWrite(bucket)
    if (resolved !== undefined) {
      next[`${prefix}${WRITE_TARGET}`] = resolved
    }
  }

  return next
}

export const migrateFrom64To65: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 65 }

  if (Array.isArray(next.assistants)) {
    next.assistants = next.assistants.map((assistant: unknown) => {
      if (!isRecord(assistant)) {
        return assistant
      }

      const assistantRecord = { ...assistant }

      if (Array.isArray(assistantRecord.enabledToolNames)) {
        const renamed = (assistantRecord.enabledToolNames as unknown[]).map(
          (name) => (typeof name === 'string' ? renameToolKey(name) : name),
        )
        // Renaming both legacy delete FQNs onto fs_delete can produce a
        // duplicate; collapse string duplicates while preserving order.
        const seen = new Set<string>()
        assistantRecord.enabledToolNames = renamed.filter((name) => {
          if (typeof name !== 'string') {
            return true
          }
          if (seen.has(name)) {
            return false
          }
          seen.add(name)
          return true
        })
      }

      if (isRecord(assistantRecord.toolPreferences)) {
        assistantRecord.toolPreferences = remapToolPreferences(
          assistantRecord.toolPreferences,
        )
      }

      return assistantRecord
    })
  }

  if (isRecord(next.mcp)) {
    const mcpRecord = { ...next.mcp }
    if (isRecord(mcpRecord.builtinToolOptions)) {
      mcpRecord.builtinToolOptions = remapBuiltinToolOptions(
        mcpRecord.builtinToolOptions,
      )
    }
    next.mcp = mcpRecord
  }

  return next
}
