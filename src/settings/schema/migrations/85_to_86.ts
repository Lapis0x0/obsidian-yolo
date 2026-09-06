import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v85→v86: drop every trace of the retired `memory` capability.
 *
 * Memory v2 deletes the three dedicated memory tools (`memory_add` /
 * `memory_update` / `memory_delete`) and the `memory` capability that grouped
 * them: memory files are ordinary vault markdown now, written through the
 * generic file tools. Two persisted keys outlive the capability and are
 * removed here — `mcp.builtinCapabilityOptions.memory` (its approval mode)
 * and each assistant's `builtinCapabilityPreferences.memory` (its on/off
 * toggle). Neither would fail validation (both are open records), but leaving
 * them behind makes `default-assistant.ts`'s normalize comparison report a
 * spurious diff forever.
 *
 * Nothing is migrated into: reading and writing memory now follows the
 * generic file capabilities the assistant already has.
 */
export const migrateFrom85To86: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 86 }

  if (isRecord(next.mcp) && isRecord(next.mcp.builtinCapabilityOptions)) {
    const { memory: _memory, ...builtinCapabilityOptions } =
      next.mcp.builtinCapabilityOptions
    next.mcp = { ...next.mcp, builtinCapabilityOptions }
  }

  if (Array.isArray(next.assistants)) {
    next.assistants = next.assistants.map((assistant) => {
      if (
        !isRecord(assistant) ||
        !isRecord(assistant.builtinCapabilityPreferences)
      ) {
        return assistant
      }
      const { memory: _memory, ...builtinCapabilityPreferences } =
        assistant.builtinCapabilityPreferences
      return { ...assistant, builtinCapabilityPreferences }
    })
  }

  return next
}
