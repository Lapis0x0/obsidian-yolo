import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const FQN_PREFIX = 'yolo_local__'
const FILE_OPS_GROUP = 'fs_file_ops'
const WRITE_TOOL = 'fs_write'

const splitKey = (key: string): { prefix: string; shortName: string } => {
  if (key.startsWith(FQN_PREFIX)) {
    return { prefix: FQN_PREFIX, shortName: key.slice(FQN_PREFIX.length) }
  }
  return { prefix: '', shortName: key }
}

const appendUnique = (values: unknown[], value: string): void => {
  if (!values.includes(value)) values.push(value)
}

const preserveLegacyFileOpsWriteSelection = (names: unknown[]): unknown[] => {
  const next = [...names]
  const stringNames = names.filter(
    (name): name is string => typeof name === 'string',
  )

  for (const name of stringNames) {
    const { prefix, shortName } = splitKey(name)
    if (shortName === FILE_OPS_GROUP) {
      appendUnique(next, `${prefix}${WRITE_TOOL}`)
    }
  }

  return next
}

const preserveLegacyFileOpsWritePreference = (
  preferences: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...preferences }
  for (const [key, value] of Object.entries(preferences)) {
    const { prefix, shortName } = splitKey(key)
    if (shortName !== FILE_OPS_GROUP) continue
    const writeKey = `${prefix}${WRITE_TOOL}`
    if (next[writeKey] === undefined) {
      next[writeKey] = value
    }
  }
  return next
}

const preserveDisabledFileOpsWrite = (
  options: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...options }
  const fileOpsOption = options[FILE_OPS_GROUP]
  if (!isRecord(fileOpsOption) || fileOpsOption.disabled !== true) {
    return next
  }

  next[WRITE_TOOL] = {
    ...(isRecord(options[WRITE_TOOL]) ? options[WRITE_TOOL] : {}),
    disabled: true,
  }

  return next
}

/**
 * v73→v74: split full-file writes out of the file path operation group.
 *
 * `fs_file_ops` used to include `fs_write`. It now represents path operations
 * only (`fs_delete`, `fs_create_dir`, `fs_move`), while `fs_write` is grouped
 * with `fs_edit` in the UI. Preserve existing intent by carrying old
 * `fs_file_ops` selections onto `fs_write` specifically, without newly
 * disabling or enabling `fs_edit`.
 */
export const migrateFrom73To74: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 74 }

  if (Array.isArray(next.assistants)) {
    next.assistants = next.assistants.map((assistant: unknown) => {
      if (!isRecord(assistant)) return assistant
      const assistantRecord = { ...assistant }

      if (Array.isArray(assistantRecord.enabledToolNames)) {
        assistantRecord.enabledToolNames = preserveLegacyFileOpsWriteSelection(
          assistantRecord.enabledToolNames,
        )
      }

      if (isRecord(assistantRecord.toolPreferences)) {
        assistantRecord.toolPreferences = preserveLegacyFileOpsWritePreference(
          assistantRecord.toolPreferences,
        )
      }

      return assistantRecord
    })
  }

  if (isRecord(next.mcp)) {
    const mcpRecord = { ...next.mcp }
    if (isRecord(mcpRecord.builtinToolOptions)) {
      mcpRecord.builtinToolOptions = preserveDisabledFileOpsWrite(
        mcpRecord.builtinToolOptions,
      )
    }
    next.mcp = mcpRecord
  }

  return next
}
