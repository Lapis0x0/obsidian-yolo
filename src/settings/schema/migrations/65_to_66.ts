import type { SettingMigration } from '../setting.types'

/**
 * v65→v66: time-awareness moves from system-prompt variables to per-message
 * `<current_time>` injection.
 *
 *   1. Strip leftover time placeholders from the user's system prompts. The old
 *      mechanism resolved `{{current_date}}` / `{{current_hour}}` /
 *      `{{current_minute}}` / `{{current_weekday}}` / `{{current_time:…}}` at
 *      request time; those variables no longer exist, so leaving them in would
 *      leak literal `{{…}}` text into every conversation. Cleared from both
 *      `settings.systemPrompt` and each `assistants[].systemPrompt`.
 *   2. Default `timeContextEnabled` to `true` when absent.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Matches the five legacy time placeholders (the `current_time:<granularity>`
// form is covered by the optional `:…` group). Case-insensitive, whitespace
// tolerant, matching the old resolver's pattern.
const TIME_PLACEHOLDER_PATTERN =
  /{{\s*(?:current_date|current_hour|current_minute|current_weekday|current_time(?::[a-z_]+)?)\s*}}/gi

const stripTimePlaceholders = (text: string): string =>
  text.replace(TIME_PLACEHOLDER_PATTERN, '')

export const migrateFrom65To66: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 66 }

  if (typeof next.systemPrompt === 'string') {
    next.systemPrompt = stripTimePlaceholders(next.systemPrompt)
  }

  if (Array.isArray(next.assistants)) {
    next.assistants = next.assistants.map((assistant: unknown) => {
      if (!isRecord(assistant)) {
        return assistant
      }
      if (typeof assistant.systemPrompt !== 'string') {
        return assistant
      }
      return {
        ...assistant,
        systemPrompt: stripTimePlaceholders(assistant.systemPrompt),
      }
    })
  }

  if (next.timeContextEnabled === undefined) {
    next.timeContextEnabled = true
  }

  return next
}
