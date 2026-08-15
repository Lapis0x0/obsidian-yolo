import {
  BUILTIN_TOOL_CATEGORY_I18N,
  BUILTIN_TOOL_CATEGORY_ORDER,
} from '../../../core/tools/categories'
import { getLegacyPersistenceKeysForCapability } from '../../../core/tools/legacy-persistence-keys'
import {
  type BuiltinCapabilityId,
  listCapabilities,
} from '../../../core/tools/registry'
import type { BuiltinToolCategory } from '../../../core/tools/types'
import type { YoloSettings } from '../../../settings/schema/setting.types'

/**
 * Shared row model for the settings-page built-in-capability list. Replaces
 * the three near-identical hand-written group-row constructions that used to
 * live in `AgentToolsModal.tsx`, `AgentSection.tsx`, and
 * `AgentsSectionContent.tsx` (docs/plans/2026-08-15-tool-registry/master.md
 * §3.7 / phase2-migration.md D7 — "同时消除基线 §五.3"). All three now
 * consume `buildBuiltinCapabilityRows` instead of separately reading
 * `getBuiltinToolUiMeta` / `getBuiltinToolCategory` / the three group-name
 * constants and re-deriving each capability's member tool list by hand.
 */
export type CapabilityRow = {
  id: BuiltinCapabilityId
  label: string
  description: string
  /**
   * Global enablement, computed from `settings.mcp.builtinToolOptions`
   * exactly the way the pre-D7 group-row construction did: none of this
   * capability's legacy persistence keys (the group key, if any, and every
   * member tool's own short name) may be `disabled`. Per-assistant
   * enablement is a separate concern (`AgentsSectionContent.tsx` reads it
   * from the draft assistant's own `toolPreferences`, not from this field).
   */
  enabled: boolean
  hasSettings: boolean
  category: BuiltinToolCategory
  memberToolNames: readonly string[]
  /**
   * This capability's keys in the pre-D9 persistence shape — see
   * `getLegacyPersistenceKeysForCapability`'s doc comment. Callers that need
   * to read/write `settings.mcp.builtinToolOptions` (or, for a group
   * capability, want its member tools' own FQNs) derive them from here
   * instead of hand-listing the group name + member names again.
   */
  legacyPersistenceKeys: readonly string[]
}

export type TranslateFn = (keyPath: string, fallback?: string) => string

/**
 * One row per registered capability, in `CAPABILITIES` registration order
 * (`core/tools/capabilities/index.ts` — display order is registration
 * order, see that file's doc comment). Does not filter by runtime
 * availability (platform, provider config, the `bash-engine` component,
 * ...) — capability authorization is a distinct concern from tool
 * availability (master.md decision 18); callers that need to replicate the
 * pre-D7 `getLocalFileTools()`-derived visibility (today only `bash`'s
 * `bash-engine` gate ever hides a row) filter the returned rows themselves.
 */
export function buildBuiltinCapabilityRows({
  toolOptions,
  t,
}: {
  toolOptions: YoloSettings['mcp']['builtinToolOptions']
  t: TranslateFn
}): readonly CapabilityRow[] {
  return listCapabilities().map((capability) => {
    const legacyPersistenceKeys = getLegacyPersistenceKeysForCapability(
      capability.id,
    )
    const enabled = legacyPersistenceKeys.every(
      (key) => !(toolOptions[key]?.disabled ?? false),
    )
    return {
      // `listCapabilities()` returns the widened `readonly
      // BuiltinCapabilityDefinition[]` view (registry.ts's own doc comment
      // on why: a heterogeneous tuple can't be `.map`/`.flatMap`ed without
      // widening first). Every element is still literally one of
      // `CAPABILITIES`'s entries, so its `id` is safely one of
      // `BuiltinCapabilityId`'s members — this cast recovers that, it does
      // not assert anything not already true at runtime.
      id: capability.id as BuiltinCapabilityId,
      label: t(capability.label.key, capability.label.fallback),
      description: capability.description
        ? t(capability.description.key, capability.description.fallback)
        : '',
      enabled,
      hasSettings: capability.hasSettings,
      category: capability.category,
      memberToolNames: capability.tools.map((tool) => tool.name),
      legacyPersistenceKeys,
    }
  })
}

export type CapabilityCategoryGroup = {
  category: BuiltinToolCategory
  title: string
  rows: readonly CapabilityRow[]
}

/**
 * Buckets rows by category in `BUILTIN_TOOL_CATEGORY_ORDER`, preserving each
 * bucket's incoming relative order (i.e. `CAPABILITIES` registration order).
 * Drops empty categories, matching the pre-D7
 * `.filter((group) => group.tools.length > 0)` behavior.
 */
export function groupCapabilityRowsByCategory(
  rows: readonly CapabilityRow[],
  t: TranslateFn,
): readonly CapabilityCategoryGroup[] {
  return BUILTIN_TOOL_CATEGORY_ORDER.map((category) => ({
    category,
    title: t(
      BUILTIN_TOOL_CATEGORY_I18N[category].key,
      BUILTIN_TOOL_CATEGORY_I18N[category].fallback,
    ),
    rows: rows.filter((row) => row.category === category),
  })).filter((group) => group.rows.length > 0)
}
