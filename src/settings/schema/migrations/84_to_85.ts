import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v84→v85: drop `mcp.enableToolDisclosure`.
 *
 * The flag was a global opt-in for on-demand tool disclosure, defaulting off
 * (v59→v60 even force-reset it to false). Deferral is now the default and the
 * only mechanism: a deferred tool costs one catalog line instead of a whole
 * schema, so there is nothing left for a global switch to buy back. Users who
 * need a specific tool set loaded up front set that set's disclosure mode to
 * `always`, which is strictly finer-grained than the flag ever was.
 *
 * Nothing is migrated into: an install that had the flag off simply starts
 * deferring, which is the intended behaviour change.
 */
export const migrateFrom84To85: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 85 }
  if (isRecord(next.mcp)) {
    const { enableToolDisclosure: _enableToolDisclosure, ...mcp } = next.mcp
    next.mcp = mcp
  }
  return next
}
