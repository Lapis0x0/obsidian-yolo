import { getLocalFileToolServerName } from '../../../core/mcp/localFileTools'
import { parseToolName } from '../../../core/mcp/tool-name-utils'
import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v61→v62: drop orphaned `toolPreferences` / `enabledToolNames` entries.
 *
 * Before this migration, deleting an MCP server only removed it from
 * `settings.mcp.servers` — per-assistant `toolPreferences` keyed by
 * `${serverName}__${toolName}` were left behind. Those zombie entries inflated
 * the "X tools" counter on the agent card (which reads `toolPreferences`
 * directly) while the editor's detail panel (which intersects with the live
 * tool registry) showed the real, smaller number. The cascade now happens at
 * delete time; this migration cleans state authored before that fix.
 *
 * Authoritative set of known servers: `yolo_local` plus every entry currently
 * in `settings.mcp.servers`. Anything else cannot be reached from the UI and
 * therefore cannot be re-enabled, so the preference is dead weight.
 */
export const migrateFrom61To62: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 62 }

  const mcp = isRecord(next.mcp) ? next.mcp : undefined
  const servers = Array.isArray(mcp?.servers) ? mcp.servers : []
  const knownServerNames = new Set<string>([getLocalFileToolServerName()])
  for (const server of servers) {
    if (isRecord(server) && typeof server.id === 'string') {
      knownServerNames.add(server.id)
    }
  }

  const isKnown = (fqn: unknown): boolean => {
    if (typeof fqn !== 'string') return false
    try {
      return knownServerNames.has(parseToolName(fqn).serverName)
    } catch {
      return false
    }
  }

  if (!Array.isArray(next.assistants)) {
    return next
  }

  next.assistants = next.assistants.map((assistant: unknown) => {
    if (!isRecord(assistant)) return assistant

    const result: Record<string, unknown> = { ...assistant }

    if (isRecord(assistant.toolPreferences)) {
      const filtered: Record<string, unknown> = {}
      for (const [fqn, value] of Object.entries(assistant.toolPreferences)) {
        if (isKnown(fqn)) filtered[fqn] = value
      }
      result.toolPreferences = filtered
    }

    if (Array.isArray(assistant.enabledToolNames)) {
      result.enabledToolNames = assistant.enabledToolNames.filter(isKnown)
    }

    return result
  })

  return next
}
